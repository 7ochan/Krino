import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const moduleAt = (path) => import(pathToFileURL(join(repositoryRoot, 'dist', path)));
const [{ createApplication }, { createApiServer }, { ExecutionService }, { SqliteTestRepository }, { SqliteRunRepository }, { startFixtureServer }] = await Promise.all([
  moduleAt('application/create-application.js'),
  moduleAt('api/server.js'),
  moduleAt('application/execution-service.js'),
  moduleAt('db/test-repository.js'),
  moduleAt('db/run-repository.js'),
  moduleAt('fixture/server.js'),
]);

let temporaryDirectory;
let fixture;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'krino-m2-'));
  fixture = await startFixtureServer();
});

after(async () => {
  await fixture?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

function definition(id = 'api-login', name = 'API login test') {
  return {
    schemaVersion: 1,
    id,
    name,
    target: { baseUrl: fixture.url, stepTimeoutMs: 4_000, runTimeoutMs: 30_000 },
    steps: [
      { id: 'open', action: 'navigate', url: '/login' },
      { id: 'email', action: 'fill', target: { strategy: 'label', value: 'Email' }, value: { kind: 'literal', value: 'qa@example.test' } },
      { id: 'password', action: 'fill', target: { strategy: 'label', value: 'Password' }, value: { kind: 'literal', value: 'correct-horse' } },
      { id: 'sign-in', action: 'click', target: { strategy: 'role', role: 'button', name: 'Sign in' } },
      { id: 'dashboard', action: 'assertVisible', target: { strategy: 'role', role: 'heading', name: 'Dashboard' } },
    ],
  };
}

function openApplication(name) {
  return createApplication({ dataDirectory: join(temporaryDirectory, name) });
}

test('clean SQLite initialization migrates schema and test CRUD validates definitions', () => {
  const app = openApplication('crud');
  try {
    const tableNames = app.database.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tableNames.includes('tests'));
    assert.ok(tableNames.includes('runs'));
    assert.ok(tableNames.includes('step_results'));
    assert.ok(tableNames.includes('artifacts'));

    const created = app.tests.create(definition('crud-test'));
    assert.equal(app.tests.get('crud-test').definition.name, 'API login test');
    assert.deepEqual(app.tests.list().map((test) => test.id), ['crud-test']);
    const updated = app.tests.update('crud-test', { ...created.definition, name: 'Updated test' });
    assert.equal(updated.name, 'Updated test');
    assert.ok(updated.updatedAt >= created.updatedAt);
    assert.throws(() => app.tests.create({ ...definition('invalid-test'), target: { baseUrl: 'not a URL' } }), /target\.baseUrl/);
    assert.equal(app.tests.list().length, 1);
    app.tests.delete('crud-test');
    assert.throws(() => app.tests.get('crud-test'), /was not found/);
  } finally {
    app.close();
  }
});

test('application execution persists passed, failed, and partial error runs with ordered steps and artifact metadata', async () => {
  const app = openApplication('runs');
  try {
    let runNumber = 0;
    const service = new ExecutionService({
      tests: new SqliteTestRepository(app.database),
      runs: new SqliteRunRepository(app.database),
      artifactsDirectory: app.database.artifactsDirectory,
      executeWorker: async ({ runId, definition: testDefinition }) => {
        runNumber += 1;
        const startTime = new Date().toISOString();
        const steps = [{ stepId: 'step-one', action: 'navigate', status: 'passed', startTime, endTime: startTime, durationMs: 3 }];
        if (runNumber === 1) return {
          protocolVersion: 1, runId, testId: testDefinition.id, testName: testDefinition.name, status: 'passed',
          startTime, endTime: startTime, durationMs: 3, steps,
        };
        if (runNumber === 2) return {
          protocolVersion: 1, runId, testId: testDefinition.id, testName: testDefinition.name, status: 'failed',
          startTime, endTime: startTime, durationMs: 7,
          steps: [...steps, { stepId: 'step-two', action: 'assertVisible', status: 'failed', startTime, endTime: startTime, durationMs: 4, error: { name: 'AssertionError', message: 'missing' } }],
          artifacts: { screenshotPath: join(app.database.artifactsDirectory, runId, 'screenshot.png'), errors: ['Trace capture failed: unavailable'] },
        };
        return {
          protocolVersion: 1, runId, testId: testDefinition.id, testName: testDefinition.name, status: 'error',
          startTime, endTime: startTime, durationMs: 10, steps,
          incompleteSteps: [{ stepId: 'step-two', action: 'click', index: 1, startTime }],
          error: { name: 'WorkerError', message: 'worker stopped' },
        };
      },
    });

    const passed = await service.runDefinition(definition('persist-test'));
    assert.equal(passed.run.status, 'passed');
    assert.deepEqual(passed.run.steps.map((step) => step.stepId), ['step-one']);
    assert.equal(passed.run.artifacts.find((artifact) => artifact.type === 'result').status, 'created');

    const failed = await service.runTest('persist-test');
    assert.equal(failed.run.status, 'failed');
    assert.deepEqual(failed.run.steps.map((step) => step.status), ['passed', 'failed']);
    assert.ok(failed.run.artifacts.some((artifact) => artifact.type === 'screenshot' && artifact.status === 'created'));
    assert.ok(failed.run.artifacts.some((artifact) => artifact.type === 'trace' && artifact.status === 'failed'));

    const partial = await service.runTest('persist-test');
    assert.equal(partial.run.status, 'error');
    assert.equal(partial.run.error.message, 'worker stopped');
    assert.deepEqual(partial.run.steps.map((step) => step.stepId), ['step-one']);
    assert.equal(partial.run.incompleteSteps[0].stepId, 'step-two');
    assert.equal(app.runs.get(partial.run.id).incompleteSteps[0].index, 1);
    assert.equal(app.runs.listForTest('persist-test').length, 3);
  } finally {
    app.close();
  }
});

test('local API CRUD and synchronous real-browser execution return persisted results without filesystem paths', async () => {
  const app = openApplication('api');
  const server = createApiServer(app);
  try {
    const health = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    assert.deepEqual((await server.inject({ method: 'GET', url: '/actions' })).json().actions.map((action) => action.id), ['navigate', 'fill', 'click', 'assertVisible', 'assertText']);

    const invalid = await server.inject({ method: 'POST', url: '/tests', payload: { ...definition(), target: { baseUrl: 'bad' } } });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error.message, /target\.baseUrl/);
    const malformedJson = await server.inject({ method: 'POST', url: '/tests', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(malformedJson.statusCode, 400);

    const created = await server.inject({ method: 'POST', url: '/tests', payload: definition() });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().id, 'api-login');
    assert.equal((await server.inject({ method: 'GET', url: '/tests' })).json().tests.length, 1);
    assert.equal((await server.inject({ method: 'GET', url: '/tests/api-login' })).json().name, 'API login test');

    const updatedDefinition = { ...definition(), name: 'API edited login test' };
    assert.equal((await server.inject({ method: 'PUT', url: '/tests/api-login', payload: updatedDefinition })).json().name, 'API edited login test');
    const runResponse = await server.inject({ method: 'POST', url: '/tests/api-login/runs', payload: {} });
    assert.equal(runResponse.statusCode, 200, runResponse.body);
    const run = runResponse.json();
    assert.equal(run.status, 'passed');
    assert.deepEqual(run.steps.map((step) => step.stepId), ['open', 'email', 'password', 'sign-in', 'dashboard']);
    assert.ok(run.finishedAt);
    assert.ok(run.durationMs >= 0);
    assert.ok(run.artifacts.some((artifact) => artifact.type === 'result' && artifact.filename === 'result.json'));
    assert.equal(JSON.stringify(run).includes(temporaryDirectory), false);

    const persisted = await server.inject({ method: 'GET', url: `/runs/${run.id}` });
    assert.equal(persisted.statusCode, 200);
    assert.equal(persisted.json().status, 'passed');
    assert.equal(persisted.json().definition.name, 'API edited login test');
    assert.equal(persisted.json().steps.at(-1).stepId, 'dashboard');
    const history = await server.inject({ method: 'GET', url: '/tests/api-login/runs' });
    assert.equal(history.json().runs[0].id, run.id);

    await server.inject({ method: 'PUT', url: '/tests/api-login', payload: { ...updatedDefinition, name: 'Edited after run' } });
    assert.equal((await server.inject({ method: 'GET', url: `/runs/${run.id}` })).json().definition.name, 'API edited login test');

    const failingDefinition = {
      ...definition(),
      name: 'API failure diagnostics',
      steps: [...definition().steps, {
        id: 'deliberate-failure', action: 'assertText',
        target: { strategy: 'role', role: 'heading', name: 'Dashboard' }, text: 'missing on purpose',
      }],
    };
    assert.equal((await server.inject({ method: 'PUT', url: '/tests/api-login', payload: failingDefinition })).statusCode, 200);
    const failedResponse = await server.inject({ method: 'POST', url: '/tests/api-login/runs', payload: {} });
    assert.equal(failedResponse.statusCode, 200);
    const failedRun = failedResponse.json();
    assert.equal(failedRun.status, 'failed');
    assert.deepEqual(failedRun.steps.map((step) => step.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'failed']);
    assert.ok(failedRun.artifacts.some((artifact) => artifact.type === 'screenshot' && artifact.status === 'created'));
    assert.ok(failedRun.artifacts.some((artifact) => artifact.type === 'trace' && artifact.status === 'created'));
    const failedDirectory = join(app.database.artifactsDirectory, failedRun.id);
    assert.deepEqual((await readdir(failedDirectory)).sort(), ['result.json', 'screenshot.png', 'trace.zip']);

    const runDirectory = join(app.database.artifactsDirectory, run.id);
    assert.deepEqual((await readdir(runDirectory)).sort(), ['result.json']);
    const resultFile = JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8'));
    assert.equal(resultFile.runId, run.id);
    assert.equal(resultFile.status, 'passed');

    assert.equal((await server.inject({ method: 'DELETE', url: '/tests/api-login' })).statusCode, 204);
    assert.equal((await server.inject({ method: 'GET', url: '/tests/api-login' })).statusCode, 404);
    const retainedHistory = await server.inject({ method: 'GET', url: `/runs/${run.id}` });
    assert.equal(retainedHistory.statusCode, 200);
    assert.equal(retainedHistory.json().testId, null);
    assert.equal(retainedHistory.json().status, 'passed');
    assert.equal(app.runs.get(failedRun.id).status, 'failed');
  } finally {
    await server.close();
    app.close();
  }
});
