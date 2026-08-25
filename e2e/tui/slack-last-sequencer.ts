/**
 * Run the Slack spec last, so the rest of the suite's ~8 minutes separates it
 * from any earlier Socket Mode connection on the same app token. CI keeps that
 * exclusive already; this covers running both suites locally back to back.
 */

import { BaseSequencer, type TestSpecification } from 'vitest/node';

const RUN_LAST = 'bedrock-mantle-slack.test.ts';

export default class SlackLastSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const isSlack = (f: TestSpecification): boolean => f.moduleId.endsWith(RUN_LAST);
    return [...sorted.filter((f) => !isSlack(f)), ...sorted.filter(isSlack)];
  }
}
