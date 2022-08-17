import * as core from '@actions/core';
import {sh} from './shell';

async function run(): Promise<void> {
  core.info('ls');
  sh('ls');
  sh('npx cdk synth');
}

// noinspection JSIgnoredPromiseFromCall
(async () => {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) core.setFailed(e.message);
  }
})();
