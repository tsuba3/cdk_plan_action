import * as core from '@actions/core';
import {sh, sleep} from './shell';
import * as fs from 'fs';
import {diffTemplate, formatDifferences, ResourceImpact} from '@aws-cdk/cloudformation-diff';
import {PassThrough} from 'stream';
import {randomUUID} from 'crypto';

async function run(): Promise<void> {
  const prNumber = core.getInput('pr_number');
  const cdkCommand = core.getInput('cdk_command');
  const enableDriftDetection = core.getBooleanInput('enable_drift_detection');
  const awsRegion = core.getInput('aws_region');
  const replaceComments = core.getBooleanInput('replace_comments');

  // Synth templates
  sh(cdkCommand);

  // Read templates json files from files in cdk.out
  const cdkManifest = JSON.parse(fs.readFileSync('cdk.out/manifest.json').toString('utf-8'));
  const stackNames = Object.entries(cdkManifest.artifacts)
    // @ts-ignore
    .filter(([, v]) => v.type === 'aws:cloudformation:stack')
    .map(([k]) => k);
  const stackTemplates: {[k: string]: any} = {};
  for (const stackName of stackNames) {
    stackTemplates[stackName] = JSON.parse(fs.readFileSync(`cdk.out/${stackName}.template.json`).toString());
  }

  // Retrieve current templates from CloudFormation
  const cfnStacks: any = JSON.parse(sh(`aws cloudformation list-stacks`).stdout);
  const cfnStackNames = cfnStacks['StackSummaries']
    .filter((s: any) => s.StackStatus !== 'DELETE_COMPLETE')
    .filter((s: any) => s.StackStatus !== 'REVIEW_IN_PROGRESS')
    .map((x: any) => x['StackName'])
    .filter((x: any) => stackNames.includes(x));
  const cfnTemplates: {[k: string]: any} = {};
  for (const stackName of cfnStackNames) {
    const command = sh(`aws cloudformation get-template --stack-name ${stackName}`);
    cfnTemplates[stackName] = JSON.parse(command.stdout).TemplateBody;
  }

  // Diff templates
  const templateDiff: {[k: string]: any} = {};
  let editedStackCount = 0;
  for (const stackName of stackNames) {
    templateDiff[stackName] = diffTemplate(cfnTemplates[stackName] ?? {}, stackTemplates[stackName]);
    if (templateDiff[stackName].differenceCount) editedStackCount += 1;
  }

  // Detect Stack Drift
  let stackDriftDetected = false;
  if (enableDriftDetection) {
    stackDriftDetected = await detectStackDrift(cfnStackNames);
  }

  // Retrieve stack resources summaries from CloudFormation (including result of stack drift)
  const cfnStackResourcesSummaries = retrieveStackResources(cfnStackNames);

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
  await postComment(prNumber, message);
}

const detectStackDrift = async (stackNames: string[]): Promise<boolean> => {
  const driftDetectionStartTime = new Date().getTime();
  const STACK_DETECTION_TIMEOUT = 300 * 1000; // 300 sec
  let stackDriftDetected = false;
  const driftDetectionRequests = [];
  for (const stackName of stackNames) {
    // Start Stack Drift Detection
    const command = sh(`aws cloudformation detect-stack-drift --stack-name "${stackName}"`);
    const res = JSON.parse(command.stdout);
    const driftDetectionId = res['StackDriftDetectionId'];
    driftDetectionRequests.push({stackName, driftDetectionId});
  }
  for (const {driftDetectionId} of driftDetectionRequests) {
    // Wait drift detection end
    let detectRes;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const describeCommand = sh(
        `aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "${driftDetectionId}"`
      );
      detectRes = JSON.parse(describeCommand.stdout);
      if (detectRes['DetectionStatus'] !== 'DETECTION_IN_PROGRESS') {
        break;
      }
      if (new Date().getTime() - driftDetectionStartTime > STACK_DETECTION_TIMEOUT) {
        throw new Error('Stack Drift Detection Timeout');
      }
      await sleep(5000);
    }

    if (detectRes['StackDriftStatus'] === 'DRIFTED') {
      stackDriftDetected = true;
    }
  }
  return stackDriftDetected;
};

const retrieveStackResources = async (stackNames: string[]): Promise<{[stackName: string]: any}> => {
  const cfnStackResourcesSummaries: {[stackName: string]: any} = {};
  for (const stackName of stackNames) {
    const listStackResources = sh(`aws cloudformation list-stack-resources --stack-name ${stackName}`);
    cfnStackResourcesSummaries[stackName] = {};
    for (const resource of JSON.parse(listStackResources.stdout).StackResourceSummaries) {
      cfnStackResourcesSummaries[stackName][resource.LogicalResourceId] = resource;
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
  templateDiff: {[s: string]: any};
  cfnStackResourcesSummaries: {[s: string]: any};
  cfnStacks: any;
  awsRegion: string;
}

const messageHeading = `## 🌎 Cloudformation Stack Diff`;

const makeDiffMessage = (option: MakeDiffMessageOption): string => {
  const {
    stackNames,
    stackTemplates,
    cfnStackNames,
    editedStackCount,
    stackDriftDetected,
    templateDiff,
    cfnStackResourcesSummaries,
    cfnStacks,
    awsRegion
  } = option;

  let comment = `${messageHeading}\n\n\n`;
  comment += '[View GitHub Action]';
  comment += `(${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n\n`;

  comment +=
    '<details>\n' +
    '<summary>表や絵文字の意味</summary>\n' +
    '\n' +
    '> ### 差分の絵文字の意味\n' +
    '> - 🈚 変更なし\n' +
    '> - 🆕 新規追加\n' +
    '> - ✏️ 変更あり\n' +
    '> - ♻️ 変更あり（置換 : CFnによってリソースが一旦削除され再作成される）\n' +
    '> - 🗑 削除 (DeletionPolicy が Retain のもの、実際のリソースは削除されない)\n' +
    '> - 🔥 削除 (DeletionPolicy が Retain 以外、CFn によってリソースが削除される) \n' +
    '> \n' +
    '> ### Drift の意味\n' +
    '> - ︎ ⚠ NOT_CHECKED （未対応等でドリフト検知できない）\n' +
    '> - 🚨 MODIFIED （実際のリソースと CFn テンプレートに差異がある）\n' +
    '> - ✅ IN_SYNC（ドリフトがない）\n' +
    '> - 空欄（未作成のリソースなど）\n' +
    '> ### タイプ\n' +
    '> リソースの種類。 `AWS::CDK::Metadata` や `Custom::*` は CDK 上のメタデータで CFn 以外にリソースが作成されることはない。\n' +
    '> よってそれらのリソースはドリフトが NOT_CHECKED になる\n' +
    '\n' +
    '</details>\n\n';

  // 差分とドリフトの有無を表にして出力
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
    const stackNamePrefix = {
      new: '🆕',
      diff: '✏️',
      not_changed: '🈚'
    }[status];
    if (status !== 'new') {
      const stackId = cfnStacks.StackSummaries.find((s: any) => s.StackName === stackName).StackId;
      const stackUrl = `https://${awsRegion}.console.aws.amazon.com/cloudformation/home?region=${awsRegion}#/stacks/stackinfo?stackId=${encodeURI(
        stackId
      )}`;
      const driftUrl = `https://${awsRegion}.console.aws.amazon.com/cloudformation/home?region=${awsRegion}#/stacks/drifts?stackId=${encodeURI(
        stackName
      )}`;
      comment += `#### ${stackNamePrefix} [${stackName}](${stackUrl}) [ドリフト検知](${driftUrl})\n`;
    } else {
      comment += `#### ${stackNamePrefix} ${stackName}\n`;
    }

    // cdk diff 結果
    let formattedDiff;
    if (templateDiff[stackName].isEnmpty) {
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
    comment += formattedDiff.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><]/g,
      '' // Remove Ansi escapes
    );
    comment += '\n```\n\n';
    comment += '</details>\n\n';

    // リソースの表
    comment += '|差分|Drift|タイプ|論理ID|\n';
    comment += '|---|---|---|---|\n';

    const cfnResources = cfnStackResourcesSummaries[stackName] ?? {};

    // 差分が全くないと templateDiff[stackName].resources.diffs は空になる
    const logicalIds = Object.keys(status === 'not_changed' ? cfnResources : templateDiff[stackName].resources.diffs);
    for (const logicalId of logicalIds) {
      const change = templateDiff[stackName].resources.diffs[logicalId];
      let diffMsg;
      let driftMsg;

      switch (change?.changeImpact) {
        case ResourceImpact.WILL_UPDATE:
          diffMsg = '✏️ Update'; // 変更
          break;
        case ResourceImpact.WILL_CREATE:
          diffMsg = '🆕 Create'; // 追加
          break;
        case ResourceImpact.WILL_REPLACE:
          diffMsg = '♻️ Replace';
          break;
        case ResourceImpact.MAY_REPLACE:
          diffMsg = '♻️ May Replace';
          break;
        case ResourceImpact.WILL_DESTROY:
          diffMsg = '🔥 Destroy'; // 実際のリソースも削除
          break;
        case ResourceImpact.WILL_ORPHAN:
          diffMsg = '🗑 Remove'; // スタックから削除
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
        driftMsg = '🚨 MODIFIED';
      } else if (driftStatus === 'IN_SYNC') {
        driftMsg = '✅ IN_SYNC';
      } else {
        driftMsg = driftStatus ?? '';
      }

      const type = change?.resourceTypes?.newType ?? stackTemplates[stackName].Resources[logicalId]?.Type ?? '';

      comment += `|${diffMsg}|${driftMsg}|${type}|${logicalId}|\n`;
    }
    comment += '\n\n\n';
  }

  return comment;
};

const removeOldComment = async (): Promise<void> => {
  // 過去のコメントを削除する。
  const gh = sh('gh api "/repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments"');
  const comments = JSON.parse(gh.stdout);
  const commentsIdToDelete = comments
    .filter((x: any) => x.user.login === 'github-actions[bot]')
    .filter((x: any) => x.body.includes(messageHeading))
    .map((x: any) => x.id);
  for (const id of commentsIdToDelete) {
    sh(`gh api --method DELETE "/repos/$GITHUB_REPOSITORY/issues/comments/${id}"`);
  }
};

const postComment = async (prNumber: string, comment: string): Promise<void> => {
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
