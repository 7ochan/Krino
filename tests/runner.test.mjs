import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const { parseTestDefinition, DefinitionValidationError } = await import(pathToFileURL(join(repositoryRoot, 'dist', 'definition.js')));
const { executeDefinition } = await import(pathToFileURL(join(repositoryRoot, 'dist', 'engine.js')));
const { runInChild, workerWatchdogTimeoutMs, WORKER_STARTUP_TIMEOUT_MS, WORKER_CLEANUP_GRACE_MS } = await import(pathToFileURL(join(repositoryRoot, 'dist', 'child-runner.js')));
const { startFixtureServer } = await import(pathToFileURL(join(repositoryRoot, 'dist', 'fixture', 'server.js')));
let fixture;
let temporaryDirectory;

before(async () => {
  fixture = await startFixtureServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'krino-e2e-'));
});

after(async () => {
  await fixture?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

function sampleDefinition({ failing = false } = {}) {
  return {
    schemaVersion: 1,
    id: failing ? 'intentional-failure' : 'login-smoke',
    name: failing ? 'Intentional assertion failure' : 'Login smoke test',
    target: { baseUrl: fixture.url, stepTimeoutMs: 4_000, runTimeoutMs: 300_000 },
    steps: [
      { id: 'open', action: 'navigate', url: '/login' },
      { id: 'email', action: 'fill', target: { strategy: 'label', value: 'Email' }, value: { kind: 'literal', value: 'qa@example.test' } },
      { id: 'password', action: 'fill', target: { strategy: 'label', value: 'Password' }, value: { kind: 'literal', value: 'correct-horse' } },
      { id: 'sign-in', action: 'click', target: { strategy: 'role', role: 'button', name: 'Sign in' } },
      ...(failing
        ? [
            { id: 'bad-assertion', action: 'assertText', target: { strategy: 'role', role: 'heading', name: 'Dashboard' }, text: 'absent text' },
            { id: 'skipped', action: 'assertVisible', target: { strategy: 'role', role: 'heading', name: 'Dashboard' } },
          ]
        : [
            { id: 'dashboard', action: 'assertVisible', target: { strategy: 'role', role: 'heading', name: 'Dashboard' } },
            { id: 'welcome', action: 'assertText', target: { strategy: 'text', value: 'Welcome, qa@example.test', exact: true }, text: 'Welcome, qa@example.test' },
          ]),
    ],
  };
}

async function runCli(definition, name) {
  const definitionPath = join(temporaryDirectory, `${name}.json`);
  const artifactsDirectory = join(temporaryDirectory, `${name}-artifacts`);
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  const child = spawn(process.execPath, [join(repositoryRoot, 'dist', 'cli.js'), 'run', definitionPath, '--artifacts-dir', artifactsDirectory], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  return { ...exit, stdout, stderr, artifactsDirectory };
}

test('accepts a valid version 1 definition', () => {
  const parsed = parseTestDefinition(sampleDefinition());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.steps.length, 6);
});

test('rejects invalid definitions before browser execution', () => {
  assert.throws(() => parseTestDefinition({ schemaVersion: 2 }), DefinitionValidationError);
  assert.throws(() => parseTestDefinition({ ...sampleDefinition(), target: { baseUrl: 'file:///tmp/test' } }), DefinitionValidationError);
});

test('validates HTTP and HTTPS target URLs and reports malformed or unsupported URLs as definition errors', () => {
  assert.equal(parseTestDefinition({ ...sampleDefinition(), target: { ...sampleDefinition().target, baseUrl: 'http://127.0.0.1:3000' } }).target.baseUrl, 'http://127.0.0.1:3000');
  assert.equal(parseTestDefinition({ ...sampleDefinition(), target: { ...sampleDefinition().target, baseUrl: 'https://example.test/app' } }).target.baseUrl, 'https://example.test/app');
  assert.throws(() => parseTestDefinition({ ...sampleDefinition(), target: { ...sampleDefinition().target, baseUrl: 'not-a-url' } }), (error) => {
    assert.ok(error instanceof DefinitionValidationError);
    assert.match(error.message, /target\.baseUrl/);
    assert.doesNotMatch(error.message, /TypeError: Invalid URL/);
    return true;
  });
  assert.throws(() => parseTestDefinition({ ...sampleDefinition(), target: { ...sampleDefinition().target, baseUrl: 'file:///tmp/private' } }), /target\.baseUrl/);
  assert.throws(() => parseTestDefinition({ ...sampleDefinition(), target: { ...sampleDefinition().target, baseUrl: 'ftp://example.test/file' } }), /Target URL must use http or https/);
});

test('enforces a coherent step/run timeout contract and gives the process watchdog startup and cleanup grace', () => {
  const parsed = parseTestDefinition(sampleDefinition());
  assert.equal(parsed.target.stepTimeoutMs, 4_000);
  assert.equal(parsed.target.runTimeoutMs, 300_000);
  assert.throws(() => parseTestDefinition({
    ...sampleDefinition(),
    target: { ...sampleDefinition().target, stepTimeoutMs: 5_000, runTimeoutMs: 2_000 },
  }), /runTimeoutMs must be at least stepTimeoutMs/);
  assert.equal(workerWatchdogTimeoutMs(300_000), WORKER_STARTUP_TIMEOUT_MS + 300_000 + WORKER_CLEANUP_GRACE_MS);
  assert.ok(workerWatchdogTimeoutMs(600_000) > 600_000);
});

function fakeBrowser({ delayForUrl = () => 0, failAssertion = false, artifactResult = { errors: [] }, captureError } = {}) {
  return {
    async navigate(url, timeoutMs) {
      const duration = delayForUrl(url);
      if (duration > timeoutMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
        throw new Error(`Action timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, duration));
    },
    async fill() {},
    async click() {},
    async assertVisible() { if (failAssertion) throw new Error('Expected locator to be visible'); },
    async assertText() { if (failAssertion) throw new Error('Expected text to match'); },
    async captureFailureArtifacts() {
      if (captureError) throw captureError;
      return artifactResult;
    },
    async close() {},
  };
}

test('multi-step execution may legitimately exceed one step timeout within its whole-run budget', async () => {
  const definition = parseTestDefinition({
    ...sampleDefinition(),
    target: { ...sampleDefinition().target, stepTimeoutMs: 100, runTimeoutMs: 1_000 },
    steps: [1, 2, 3, 4].map((number) => ({ id: `step-${number}`, action: 'navigate', url: `/delay-${number}` })),
  });
  const started = Date.now();
  const result = await executeDefinition({
    runId: 'long-multi-step', definition, browser: fakeBrowser({ delayForUrl: () => 40 }), artifactsDirectory: temporaryDirectory,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.steps.length, 4);
  assert.ok(Date.now() - started > definition.target.stepTimeoutMs);
});

test('whole-run timeout is a structured error, preserves the timed-out step, and skips later steps', async () => {
  const definition = parseTestDefinition({
    ...sampleDefinition(),
    target: { ...sampleDefinition().target, stepTimeoutMs: 1_000, runTimeoutMs: 1_000 },
    steps: [
      { id: 'first', action: 'navigate', url: '/first' },
      { id: 'second', action: 'navigate', url: '/second' },
      { id: 'never-started', action: 'navigate', url: '/third' },
    ],
  });
  const result = await executeDefinition({
    runId: 'run-timeout', definition,
    browser: fakeBrowser({ delayForUrl: (url) => url.endsWith('first') ? 750 : 500 }),
    artifactsDirectory: temporaryDirectory,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error.name, 'RunTimeoutError');
  assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'failed', 'skipped']);
  assert.match(result.steps[1].error.message, /timed out/);
});

test('artifact capture failures remain separate from the recorded assertion failure', async (t) => {
  const scenarios = [
    { name: 'successful artifacts', result: { screenshotPath: '/tmp/screenshot.png', tracePath: '/tmp/trace.zip', errors: [] }, expectedErrors: [] },
    { name: 'screenshot capture failure', result: { tracePath: '/tmp/trace.zip', errors: ['Screenshot capture failed: disk full'] }, expectedErrors: ['Screenshot capture failed: disk full'] },
    { name: 'trace finalization failure', result: { screenshotPath: '/tmp/screenshot.png', errors: ['Trace capture failed: trace stop rejected'] }, expectedErrors: ['Trace capture failed: trace stop rejected'] },
    { name: 'artifact adapter rejection', captureError: new Error('artifact directory is unavailable'), expectedErrors: ['Failure artifact capture failed: artifact directory is unavailable'] },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const definition = parseTestDefinition({
        ...sampleDefinition(),
        steps: [
          { id: 'bad-assertion', action: 'assertVisible', target: { strategy: 'role', role: 'heading', name: 'Missing' } },
          { id: 'skipped', action: 'click', target: { strategy: 'role', role: 'button', name: 'Not reached' } },
        ],
      });
      const result = await executeDefinition({
        runId: `artifact-${scenario.name.replaceAll(' ', '-')}`,
        definition,
        browser: fakeBrowser({ failAssertion: true, artifactResult: scenario.result, captureError: scenario.captureError }),
        artifactsDirectory: temporaryDirectory,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.steps[0].status, 'failed');
      assert.equal(result.steps[0].stepId, 'bad-assertion');
      assert.equal(result.steps[1].status, 'skipped');
      assert.deepEqual(result.artifacts.errors, scenario.expectedErrors);
    });
  }
});

test('rejects an unsupported action with its location', () => {
  const definition = sampleDefinition();
  definition.steps[0].action = 'hover';
  assert.throws(() => parseTestDefinition(definition), /Unknown action "hover" at steps\[0\]\.action/);
});

test('rejects malformed locator descriptors', () => {
  const definition = sampleDefinition();
  definition.steps[1].target = { strategy: 'role', role: '', name: 'Email' };
  assert.throws(() => parseTestDefinition(definition), /steps\.1\.target\.role/);
  definition.steps[1].target = { strategy: 'xpath', value: '//input' };
  assert.throws(() => parseTestDefinition(definition), /steps\.1\.target\.strategy/);
});

test('executes the genuine browser path, reports ordered passed steps, and exits zero', async () => {
  const run = await runCli(sampleDefinition(), 'passing-run');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(run.signal, null);
  assert.match(run.stdout, /RESULT: PASSED/);
  const printedRunId = run.stdout.match(/RUNNING: .* \(([0-9a-f-]+)\)/)?.[1];
  const [runDirectory] = await readdir(run.artifactsDirectory);
  assert.equal(printedRunId, runDirectory);
  const result = JSON.parse(await readFile(join(run.artifactsDirectory, runDirectory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed');
  assert.equal(result.runId, runDirectory);
  assert.deepEqual(result.steps.map((step) => step.stepId), ['open', 'email', 'password', 'sign-in', 'dashboard', 'welcome']);
  assert.ok(result.steps.every((step) => step.status === 'passed'));
});

test('failed assertion stops execution, skips remaining steps, captures screenshot and trace, exits nonzero, and cleans up child', async () => {
  const run = await runCli(sampleDefinition({ failing: true }), 'failing-run');
  assert.equal(run.code, 1, run.stderr + run.stdout);
  assert.equal(run.signal, null);
  assert.match(run.stdout, /RESULT: FAILED/);
  assert.match(run.stdout, /Screenshot:/);
  assert.match(run.stdout, /Trace:/);
  const [runDirectory] = await readdir(run.artifactsDirectory);
  const directory = join(run.artifactsDirectory, runDirectory);
  const files = await readdir(directory);
  assert.ok(files.includes('screenshot.png'));
  assert.ok(files.includes('trace.zip'));
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.runId, runDirectory);
  assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'passed', 'passed', 'passed', 'failed', 'skipped']);
  assert.equal(result.steps[5].startTime, null);
});

test('unexpected worker exit preserves completed step events, run ID, and existing artifacts', async () => {
  const definition = parseTestDefinition({
    ...sampleDefinition(),
    steps: [
      { id: 'completed-before-crash', action: 'navigate', url: '/login' },
      { id: 'not-reached', action: 'navigate', url: '/dashboard' },
    ],
  });
  const runId = 'partial-worker-run';
  const artifactsDirectory = join(temporaryDirectory, runId);
  await mkdir(artifactsDirectory, { recursive: true });
  const result = await runInChild({
    runId,
    definition,
    artifactsDirectory,
    workerPath: join(repositoryRoot, 'tests', 'fixtures', 'worker-exit-after-step.mjs'),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.runId, runId);
  assert.deepEqual(result.steps.map((step) => step.stepId), ['completed-before-crash']);
  assert.equal(result.steps[0].status, 'passed');
  assert.deepEqual(result.incompleteSteps.map((step) => step.stepId), ['not-reached']);
  assert.equal(result.incompleteSteps[0].index, 1);
  assert.equal(result.artifacts.screenshotPath, join(artifactsDirectory, 'screenshot.png'));
  assert.match(result.error.message, /exited without a usable result/);
});

test('malformed target URL exits through validation without starting the worker', async () => {
  const definition = sampleDefinition();
  definition.target.baseUrl = 'not-a-url';
  const run = await runCli(definition, 'malformed-url');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /target\.baseUrl/);
  assert.doesNotMatch(run.stdout, /RUNNING:|Worker started/);
});

test('invalid JSON definition exits without launching the browser worker', async () => {
  const run = await runCli({ schemaVersion: 99 }, 'invalid-run');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Cannot load test definition/);
  assert.doesNotMatch(run.stdout, /Worker started/);
});
