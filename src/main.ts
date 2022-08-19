import * as core from '@actions/core';
import {removeEscapeCharacters, sh, sleep} from './shell';
import * as fs from 'fs';
import {diffTemplate, formatDifferences, ResourceImpact, TemplateDiff} from '@aws-cdk/cloudformation-diff';
import {PassThrough} from 'stream';
import {randomUUID} from 'crypto';
import {
  CloudFormationClient,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackDriftDetectionStatusCommandOutput,
  DetectStackDriftCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  ListStacksCommandOutput,
  StackDriftDetectionStatus,
  StackDriftStatus,
  StackResourceDriftStatus,
  StackResourceSummary,
  StackStatus
} from '@aws-sdk/client-cloudformation';

const prNumber = core.getInput('pr-number');
const cdkCommand = core.getInput('cdk-command');
const cdkOutDir = core.getInput('cdk-out-dir');
const enableDriftDetection = core.getBooleanInput('enable-drift-detection');
const awsRegion = core.getInput('aws-region');
const replaceComments = core.getBooleanInput('replace-comments');
const commentTitle = core.getInput('comment-title');

const cfnClient = new CloudFormationClient({region: awsRegion});

async function run(): Promise<void> {
  // Synth templates
  sh(cdkCommand);

  // Read templates json files from files in cdk.out
  const cdkManifest = JSON.parse(fs.readFileSync(`${cdkOutDir}/manifest.json`).toString('utf-8'));
  const stackNames = Object.entries(cdkManifest.artifacts)
    // @ts-ignore
    .filter(([, v]) => v.type === 'aws:cloudformation:stack')
    .map(([k]) => k);
  const stackTemplates: {[k: string]: any} = {};
  for (const stackName of stackNames) {
    stackTemplates[stackName] = JSON.parse(fs.readFileSync(`${cdkOutDir}/${stackName}.template.json`).toString());
  }

  // Retrieve current templates from CloudFormation
  const cfnStacks = await cfnClient.send(new ListStacksCommand({}));
  const cfnStackNames = cfnStacks
    .StackSummaries!.filter((s: any) => s.StackStatus !== StackStatus.DELETE_COMPLETE)
    .filter(s => s.StackStatus !== StackStatus.REVIEW_IN_PROGRESS)
    .map(x => x.StackName)
    .filter(x => x && stackNames.includes(x))
    .map(x => x as string);
  const cfnTemplates: {[k: string]: any} = {};
  for (const stackName of cfnStackNames) {
    const res = await cfnClient.send(new GetTemplateCommand({StackName: stackName}));
    cfnTemplates[stackName] = JSON.parse(res.TemplateBody ?? '{}');
  }

  // Diff templates
  const templateDiff: {[k: string]: TemplateDiff} = {};
  let editedStackCount = 0;
  for (const stackName of stackNames) {
    templateDiff[stackName] = diffTemplate(cfnTemplates[stackName] ?? {}, stackTemplates[stackName]);
    if (templateDiff[stackName].differenceCount) editedStackCount += 1;
  }
  core.setOutput('edited-stack-count', editedStackCount);

  // Detect Stack Drift
  let stackDriftDetected = false;
  if (enableDriftDetection) {
    stackDriftDetected = await detectStackDrift(cfnStackNames);
    core.setOutput('stack-drift-detected', stackDriftDetected);
  }

  // Retrieve stack resources summaries from CloudFormation (including result of stack drift)
  const cfnStackResourcesSummaries = await retrieveStackResources(cfnStackNames);

  const message = makeDiffMessage({
    stackNames,
    stackTemplates,
    cfnStackNames,
    editedStackCount,
    stackDriftDetected,
    templateDiff,
    cfnStacks,
    cfnStackResourcesSummaries,
    awsRegion
  });

  if (replaceComments) await removeOldComment();
  await postComment(message);
}

const detectStackDrift = async (stackNames: string[]): Promise<boolean> => {
  const driftDetectionStartTime = new Date().getTime();
  const STACK_DETECTION_TIMEOUT = 300 * 1000; // 300 sec
  let stackDriftDetected = false;
  const driftDetectionRequests = [];
  for (const stackName of stackNames) {
    // Start Stack Drift Detection
    const res = await cfnClient.send(new DetectStackDriftCommand({StackName: stackName}));
    const driftDetectionId = res.StackDriftDetectionId;
    driftDetectionRequests.push({stackName, driftDetectionId});
  }
  for (const {driftDetectionId} of driftDetectionRequests) {
    // Wait drift detection end
    let detectRes: DescribeStackDriftDetectionStatusCommandOutput;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      detectRes = await cfnClient.send(
        new DescribeStackDriftDetectionStatusCommand({
          StackDriftDetectionId: driftDetectionId
        })
      );
      if (detectRes.DetectionStatus !== StackDriftDetectionStatus.DETECTION_IN_PROGRESS) {
        break;
      }
      if (new Date().getTime() - driftDetectionStartTime > STACK_DETECTION_TIMEOUT) {
        throw new Error('Stack Drift Detection Timeout');
      }
      await sleep(5000);
    }

    if (detectRes.StackDriftStatus === StackDriftStatus.DRIFTED) {
      stackDriftDetected = true;
    }
  }
  return stackDriftDetected;
};

const retrieveStackResources = async (
  stackNames: string[]
): Promise<{[stackName: string]: {[id: string]: StackResourceSummary}}> => {
  const cfnStackResourcesSummaries: {[stackName: string]: any} = {};
  for (const stackName of stackNames) {
    const res = await cfnClient.send(new ListStackResourcesCommand({StackName: stackName}));
    cfnStackResourcesSummaries[stackName] = {};
    for (const resource of res.StackResourceSummaries!) {
      cfnStackResourcesSummaries[stackName][resource.LogicalResourceId!] = resource;
    }
  }
  return cfnStackResourcesSummaries;
};

interface MakeDiffMessageOption {
  stackNames: string[];
  stackTemplates: {[s: string]: any};
  cfnStackNames: string[];
  editedStackCount: number;
  stackDriftDetected: boolean;
  templateDiff: {[k: string]: TemplateDiff};
  cfnStackResourcesSummaries: {[stackName: string]: {[id: string]: StackResourceSummary}};
  cfnStacks: ListStacksCommandOutput;
  awsRegion: string;
}

const makeDiffMessage = (option: MakeDiffMessageOption): string => {
  const {
    stackNames,
    stackTemplates,
    cfnStackNames,
    editedStackCount,
    stackDriftDetected,
    templateDiff,
    cfnStackResourcesSummaries,
    cfnStacks
  } = option;

  let comment = `${commentTitle}\n\n\n`;
  comment += '[View GitHub Action]';
  comment += `(${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n\n`;

  comment +=
    '<details>\n' +
    '<summary>Legends</summary>\n' +
    '\n' +
    '> ### Emojis\n' +
    '> - 🈚 No Change\n' +
    '> - 🆕 New Resource\n' +
    '> - ✏️ Update Resource\n' +
    '> - ♻️ Replace Reosurce (CFn recreate the resource)\n' +
    '> - 🗑 Logical Remove\n' +
    '> - 🔥 Destory Physical Resource\n' +
    '> \n' +
    '> ### Drift\n' +
    '> - ︎ ⚠ NOT_CHECKED （Not compatible resources）\n' +
    "> - 🚨 MODIFIED （Stack's actual configuration differs, or has drifted）\n" +
    '> - ✅ IN_SYNC（No drift detected）\n' +
    '> - Empty（Resources is not yet created）\n' +
    '\n' +
    '</details>\n\n';

  // Print diff and drifts as Markdown table format
  comment += `### Stacks ${editedStackCount >= 0 ? '' : '(No Changes) '} ${
    stackDriftDetected ? '🚨 **Stack Drift Detected** 🚨' : ''
  }\n\n`;
  for (const stackName of stackNames) {
    let status;
    if (cfnStackNames.includes(stackName)) {
      status = templateDiff[stackName].differenceCount > 0 ? 'diff' : 'not_changed';
    } else {
      status = 'new';
    }

    const cfnResources = cfnStackResourcesSummaries[stackName] ?? {};
    const hasStackDrift =
      Object.keys(cfnResources).filter(
        s => cfnResources[s].DriftInformation?.StackResourceDriftStatus === StackResourceDriftStatus.MODIFIED
      ).length > 0;
    if (status === 'not_checked' && hasStackDrift) {
      continue;
    }

    const stackNamePrefix = {
      new: '🆕',
      diff: '✏️',
      not_changed: '🈚'
    }[status];
    if (status !== 'new') {
      const stackId = cfnStacks.StackSummaries!.find((s: any) => s.StackName === stackName)!.StackId!;
      const stackUrl = `https://${awsRegion}.console.aws.amazon.com/cloudformation/home?region=${awsRegion}#/stacks/stackinfo?stackId=${encodeURI(
        stackId
      )}`;
      const driftUrl = `https://${awsRegion}.console.aws.amazon.com/cloudformation/home?region=${awsRegion}#/stacks/drifts?stackId=${encodeURI(
        stackName
      )}`;
      comment += `#### ${stackNamePrefix} [${stackName}](${stackUrl}) [(Drift Detection)](${driftUrl})\n`;
    } else {
      comment += `#### ${stackNamePrefix} ${stackName}\n`;
    }

    // cdk diff message
    let formattedDiff;
    if (templateDiff[stackName].isEmpty) {
      formattedDiff = 'There were no differences';
    } else {
      const stream = new PassThrough();
      const streamChunks: Buffer[] = [];
      stream.on('data', chunk => streamChunks.push(Buffer.from(chunk)));
      formatDifferences(stream, templateDiff[stackName], {});
      formattedDiff = Buffer.concat(streamChunks).toString('utf8');
    }
    core.startGroup(`Stack ${stackName} diff`);
    core.info(formattedDiff);
    core.endGroup();

    comment += '<details>\n';
    comment += `<summary>cdk diff</summary>\n\n`;
    comment += '```\n';
    comment += removeEscapeCharacters(formattedDiff);
    comment += '\n```\n\n';
    comment += '</details>\n\n';

    // リソースの表
    if (enableDriftDetection) {
      comment += '|Diff|Drift|Type|Logical ID|\n';
      comment += '|---|---|---|---|\n';
    } else {
      comment += '|Diff|Type|Logical ID|\n';
      comment += '|---|---|---|\n';
    }

    for (const logicalId of Object.keys(cfnResources)) {
      const change = templateDiff[stackName].resources.get(logicalId);
      if (cfnResources[logicalId].ResourceType === 'AWS::CDK::Metadata') continue;

      let diffMsg;
      let driftMsg;

      switch (change?.changeImpact) {
        case ResourceImpact.WILL_UPDATE:
          diffMsg = '✏️ Update';
          break;
        case ResourceImpact.WILL_CREATE:
          diffMsg = '🆕 Create';
          break;
        case ResourceImpact.WILL_REPLACE:
          diffMsg = '♻️ Replace';
          break;
        case ResourceImpact.MAY_REPLACE:
          diffMsg = '♻️ May Replace';
          break;
        case ResourceImpact.WILL_DESTROY:
          diffMsg = '🔥 Destroy'; // Destroy actual resource
          break;
        case ResourceImpact.WILL_ORPHAN:
          diffMsg = '🗑 Remove'; // Remove from stack
          break;
        case ResourceImpact.NO_CHANGE:
        default:
          diffMsg = '';
          break;
      }

      const driftStatus = cfnResources[logicalId]?.DriftInformation?.StackResourceDriftStatus;
      if (driftStatus === 'NOT_CHECKED') {
        driftMsg = '⚠ NOT_CHECKED';
      } else if (driftStatus === 'MODIFIED') {
        const stackId = cfnStacks.StackSummaries!.find((s: any) => s.StackName === stackName)!.StackId!;
        //https://ap-northeast-1.console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/drifts/info?stackId=arn%3Aaws%3Acloudformation%3Aap-northeast-1%3A693586505932%3Astack%2FRdsStack%2F1bec6510-13bc-11ed-b224-0e324b310e67&logicalResourceId=rdscluster9D572005
        const url = `https://${awsRegion}.console.aws.amazon.com/cloudformation/home?region=${awsRegion}#/stacks/drifts/info?stackId=${encodeURI(
          stackId
        )}&logicalResourceId=${encodeURI(logicalId)}`;
        driftMsg = `[🚨 MODIFIED](${url})`;
      } else if (driftStatus === 'IN_SYNC') {
        driftMsg = '✅ IN_SYNC';
      } else {
        driftMsg = driftStatus ?? '';
      }

      const type =
        change?.newResourceType ?? change?.resourceType ?? stackTemplates[stackName].Resources[logicalId]?.Type ?? '';

      if (enableDriftDetection) {
        comment += `|${diffMsg}|${driftMsg}|${type}|${logicalId}|\n`;
      } else {
        comment += `|${diffMsg}|${type}|${logicalId}|\n`;
      }
    }
    comment += '\n\n\n';
  }

  return comment;
};

const removeOldComment = async (): Promise<void> => {
  // 過去のコメントを削除する。
  const gh = sh(`gh api "/repos/${process.env.GITHUB_REPOSITORY}/issues/${prNumber}/comments"`);
  const comments = JSON.parse(gh.stdout);
  const commentsIdToDelete = comments
    .filter((x: any) => x.user.login === 'github-actions[bot]')
    .filter((x: any) => x.body.includes(commentTitle))
    .map((x: any) => x.id);
  for (const id of commentsIdToDelete) {
    sh(`gh api --method DELETE "/repos/${process.env.GITHUB_REPOSITORY}/issues/comments/${id}"`);
  }
};

const postComment = async (comment: string): Promise<void> => {
  const path = `/tmp/comment-${randomUUID()}`;
  fs.writeFileSync(path, comment);
  sh(`gh pr comment  ${prNumber} -F ${path}`);
};

// noinspection JSIgnoredPromiseFromCall
(async () => {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) core.setFailed(e.message);
  }
})();
