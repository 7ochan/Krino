import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once('line', async (line) => {
  const request = JSON.parse(line);
  const common = { protocolVersion: 1, runId: request.runId };
  await writeFile(`${request.artifactsDirectory}/screenshot.png`, 'partial screenshot artifact');
  process.stdout.write(`${JSON.stringify({ type: 'RUN_STARTED', ...common, testName: request.definition.name })}\n`);
  const now = new Date().toISOString();
  process.stdout.write(`${JSON.stringify({
    type: 'STEP_STARTED',
    ...common,
    index: 0,
    total: request.definition.steps.length,
    stepId: request.definition.steps[0].id,
    action: request.definition.steps[0].action,
    startTime: now,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'STEP_FINISHED',
    ...common,
    index: 0,
    total: request.definition.steps.length,
    result: {
      stepId: request.definition.steps[0].id,
      action: request.definition.steps[0].action,
      status: 'passed',
      startTime: now,
      endTime: now,
      durationMs: 3,
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'STEP_STARTED',
    ...common,
    index: 1,
    total: request.definition.steps.length,
    stepId: request.definition.steps[1].id,
    action: request.definition.steps[1].action,
    startTime: now,
  })}\n`, () => process.exit(23));
});
