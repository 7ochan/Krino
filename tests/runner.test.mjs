import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const { parseTestDefinition, DefinitionValidationError } = await import(pathToFileURL(join(repositoryRoot, 'dist', 'definition.js')));
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
    target: { baseUrl: fixture.url, timeoutMs: 4_000 },
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
  const [runDirectory] = await readdir(run.artifactsDirectory);
  const result = JSON.parse(await readFile(join(run.artifactsDirectory, runDirectory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed');
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
  assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'passed', 'passed', 'passed', 'failed', 'skipped']);
  assert.equal(result.steps[5].startTime, null);
});

test('invalid JSON definition exits without launching the browser worker', async () => {
  const run = await runCli({ schemaVersion: 99 }, 'invalid-run');
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Cannot load test definition/);
  assert.doesNotMatch(run.stdout, /Worker started/);
});
