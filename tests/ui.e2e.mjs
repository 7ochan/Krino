import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repositoryRoot = resolve(import.meta.dirname, '..');
const moduleAt = (path) => import(pathToFileURL(join(repositoryRoot, 'dist', path)));
const [{ createApplication }, { startApiServer }, { startFixtureServer }] = await Promise.all([
  moduleAt('application/create-application.js'), moduleAt('api/server.js'), moduleAt('fixture/server.js'),
]);

let dataDirectory;
let fixture;
let application;
let apiServer;
let viteProcess;
let browser;
let page;
let frontendUrl;
let viteOutput = '';

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForFrontend(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited unexpectedly (${viteProcess.exitCode}):\n${viteOutput}`);
    try { const response = await fetch(url); if (response.ok) return; } catch { /* wait until Vite is listening */ }
    await delay(100);
  }
  throw new Error(`Vite did not become ready at ${url}:\n${viteOutput}`);
}

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'krino-ui-e2e-'));
  fixture = await startFixtureServer();
  application = createApplication({ dataDirectory });
  const apiPort = await availablePort();
  apiServer = await startApiServer(application, apiPort);
  const vitePort = await availablePort();
  const viteBin = join(repositoryRoot, 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
  viteProcess = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: join(repositoryRoot, 'ui'),
    env: { ...process.env, KRINO_PORT: String(apiPort), CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteProcess.stdout.setEncoding('utf8'); viteProcess.stderr.setEncoding('utf8');
  viteProcess.stdout.on('data', (chunk) => { viteOutput += chunk; });
  viteProcess.stderr.on('data', (chunk) => { viteOutput += chunk; });
  frontendUrl = `http://127.0.0.1:${vitePort}`;
  await waitForFrontend(frontendUrl);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(8_000);
}, { timeout: 45_000 });

after(async () => {
  const cleanupErrors = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  if (viteProcess && viteProcess.exitCode === null) {
    const waitForExit = () => Promise.race([new Promise((resolveExit) => viteProcess.once('exit', resolveExit)), delay(5_000)]);
    viteProcess.kill('SIGTERM');
    await waitForExit();
    if (viteProcess.exitCode === null) { viteProcess.kill('SIGKILL'); await waitForExit(); }
  }
  try { await apiServer?.close(); } catch (error) { cleanupErrors.push(error); }
  try { application?.close(); } catch (error) { cleanupErrors.push(error); }
  try { await fixture?.close(); } catch (error) { cleanupErrors.push(error); }
  try { if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'E2E services did not close cleanly');
});

async function addStep(action, index) {
  await page.locator('#add-action').selectOption(action);
  await page.getByRole('button', { name: '＋ Add step' }).click();
  const card = page.locator('.step-card').nth(index);
  await card.getByLabel(`Step ${index + 1} action`).waitFor();
  return card;
}

async function selectLocatorRole(card, role) {
  await card.locator('.locator-fields > label').nth(1).locator('select').selectOption(role);
}

async function configureLoginDefinition(name, testId, failing = false) {
  await page.getByLabel('Test name').fill(name);
  await page.getByLabel('Test ID').fill(testId);
  await page.getByLabel('Target base URL').fill(fixture.url);
  await page.getByLabel('Step timeout (ms)').fill('1500');
  await page.locator('.step-card').nth(0).getByLabel('URL or path').fill('/login');

  let card = await addStep('fill', 1);
  await card.getByLabel('Step 2 ID').fill(`${testId}-email`);
  await card.getByLabel('Locator strategy').selectOption('label');
  await card.getByLabel('Label', { exact: true }).fill('Email');
  await card.getByLabel('Literal value').fill('qa@example.test');

  card = await addStep('fill', 2);
  await card.getByLabel('Step 3 ID').fill(`${testId}-password`);
  await card.getByLabel('Locator strategy').selectOption('label');
  await card.getByLabel('Label', { exact: true }).fill('Password');
  await card.getByLabel('Literal value').fill('correct-horse');

  card = await addStep('click', 3);
  await card.getByLabel('Step 4 ID').fill(`${testId}-sign-in`);
  await selectLocatorRole(card, 'button');
  await card.getByLabel('Accessible name', { exact: true }).fill('Sign in');

  card = await addStep(failing ? 'assertText' : 'assertVisible', 4);
  await card.getByLabel('Step 5 ID').fill(`${testId}-assert`);
  await selectLocatorRole(card, 'heading');
  await card.getByLabel('Accessible name', { exact: true }).fill('Dashboard');
  if (failing) await card.getByLabel('Expected text').fill('This text is intentionally missing');

  if (!failing) {
    card = await addStep('assertText', 5);
    await card.getByLabel('Step 6 ID').fill(`${testId}-text`);
    await selectLocatorRole(card, 'heading');
    await card.getByLabel('Accessible name', { exact: true }).fill('Dashboard');
    await card.getByLabel('Expected text').fill('Dashboard');
  }
}

test('local UI creates, edits, runs, reports, retains run history on deletion, and shows failure diagnostics', { timeout: 120_000 }, async () => {
  await page.goto(`${frontendUrl}/tests`);
  await page.getByRole('heading', { name: 'No tests yet' }).waitFor();

  await page.getByRole('link', { name: 'Create your first test' }).click();
  await configureLoginDefinition('Krino UI E2E login', 'ui-login-e2e');
  await page.getByRole('button', { name: 'Save test' }).click();
  await page.getByRole('heading', { name: 'Edit test' }).waitFor();
  await page.getByRole('link', { name: '← All tests' }).click();
  const passingRow = page.locator('.test-row').filter({ hasText: 'Krino UI E2E login' });
  await passingRow.waitFor();

  await passingRow.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Test name').fill('Krino UI E2E login edited');
  await page.getByRole('button', { name: 'Save test' }).click();
  await page.getByRole('link', { name: '← All tests' }).click();
  const editedRow = page.locator('.test-row').filter({ hasText: 'Krino UI E2E login edited' });
  await editedRow.waitFor();
  await editedRow.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Test name').waitFor({ state: 'visible' });
  assert.equal(await page.getByLabel('Test name').inputValue(), 'Krino UI E2E login edited');
  assert.equal(await page.getByLabel('Step 6 ID').inputValue(), 'ui-login-e2e-text');
  await page.getByRole('link', { name: '← All tests' }).click();

  await page.locator('.test-row').filter({ hasText: 'Krino UI E2E login edited' }).getByRole('button', { name: '▶ Run' }).click();
  await page.getByRole('heading', { name: 'Krino UI E2E login edited' }).waitFor();
  await page.locator('.run-status-block').getByText('PASSED').waitFor();
  const runUrl = page.url();
  const passingRunId = runUrl.split('/').at(-1);
  const resultStepIds = await page.locator('.result-main code').allTextContents();
  assert.deepEqual(resultStepIds, ['navigate', 'ui-login-e2e-email', 'ui-login-e2e-password', 'ui-login-e2e-sign-in', 'ui-login-e2e-assert', 'ui-login-e2e-text']);
  await page.getByRole('link', { name: '← Back to test' }).click();
  const passingHistoryItem = page.locator('.history-item').filter({ hasText: passingRunId.slice(0, 8) });
  await passingHistoryItem.waitFor();

  await page.getByRole('link', { name: '← All tests' }).click();
  await page.locator('.test-row').filter({ hasText: 'Krino UI E2E login edited' }).locator('.status-passed').waitFor();
  await page.getByRole('link', { name: '＋ Create test' }).click();
  await configureLoginDefinition('Krino UI E2E intentional failure', 'ui-failing-e2e', true);
  await page.getByRole('button', { name: 'Save test' }).click();
  await page.getByRole('link', { name: '← All tests' }).click();
  const failingRow = page.locator('.test-row').filter({ hasText: 'Krino UI E2E intentional failure' });
  await failingRow.getByRole('button', { name: '▶ Run' }).click();
  await page.getByRole('heading', { name: 'Krino UI E2E intentional failure' }).waitFor();
  await page.locator('.run-status-block').getByText('FAILED').waitFor();
  await page.locator('.step-error').waitFor();
  assert.match(await page.locator('.step-error').textContent(), /This text is intentionally missing/);
  const failingRunId = page.url().split('/').at(-1);
  assert.match(await page.locator('.step-error').textContent(), /expect\(locator\)|Expected|toContainText/i);
  assert.ok(await page.getByText('screenshot.png').count() > 0);
  assert.ok(await page.getByText('trace.zip').count() > 0);

  await page.getByRole('link', { name: '← Back to test' }).click();
  const failingHistoryItem = page.locator('.history-item').filter({ hasText: failingRunId.slice(0, 8) });
  await failingHistoryItem.waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete test' }).click();
  await page.getByRole('heading', { name: 'Tests' }).waitFor();
  assert.equal(await page.locator('.test-row').filter({ hasText: 'Krino UI E2E intentional failure' }).count(), 0);
  await page.goto(`${frontendUrl}/runs/${failingRunId}`);
  await page.locator('.run-status-block').getByText('FAILED').waitFor();
  await page.locator('.step-error').waitFor();
  assert.match(await page.locator('.step-error').textContent(), /This text is intentionally missing/);
  assert.equal(await page.locator('.run-summary').getByText('ui-failing-e2e').count(), 1);
  assert.ok(passingRunId);
});
