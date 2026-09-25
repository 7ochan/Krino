import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const moduleAt = (path) => import(pathToFileURL(join(root, 'dist', path)));
const [{ createApplication }, { createApiServer }, { startFixtureServer }] = await Promise.all([
  moduleAt('application/create-application.js'), moduleAt('api/server.js'), moduleAt('fixture/server.js'),
]);
const hasDisplay = process.platform === 'darwin' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
let directory;
let fixture;

before(async () => { directory = await mkdtemp(join(tmpdir(), 'krino-inspection-')); fixture = await startFixtureServer(); });
after(async () => { await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('inspection API validates target URL and browser mode', async () => {
  const app = createApplication({ dataDirectory: join(directory, 'validation') });
  const server = createApiServer(app);
  try {
    assert.equal((await server.inject({ method: 'POST', url: '/inspections', payload: { targetUrl: 'file:///etc/passwd', browserMode: 'headed' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/inspections', payload: { targetUrl: fixture.url, browserMode: 'remote' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/inspections', payload: { targetUrl: fixture.url } })).statusCode, 400);
  } finally { await server.close(); await app.close(); }
});

test('headed inspection captures input and button metadata and stops its worker', { skip: hasDisplay ? false : 'No desktop display is available for headed Chromium', timeout: 60_000 }, async () => {
  const app = createApplication({ dataDirectory: join(directory, 'session') });
  const server = createApiServer(app);
  const waitForElement = async (id) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const response = await server.inject({ method: 'GET', url: `/inspections/${id}` });
      const session = response.json();
      if (session.selectedElement) return session;
      await delay(100);
    }
    throw new Error('Inspector did not report a selected element');
  };
  try {
    for (const [elementId, expected] of [['email', { tagName: 'input', role: 'textbox', label: 'Email', placeholder: 'Enter email', testId: 'email' }], ['save', { tagName: 'button', role: 'button', accessibleName: 'Save changes' }]]) {
      const started = await server.inject({ method: 'POST', url: '/inspections', payload: { targetUrl: `${fixture.url}/inspect?select=${elementId}`, browserMode: 'headed' } });
      assert.equal(started.statusCode, 201, started.body);
      const initial = started.json();
      assert.equal(initial.status, 'running');
      assert.equal(initial.browserMode, 'headed');
      const result = (await waitForElement(initial.id)).selectedElement;
      for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${elementId}.${key}`);
      assert.ok(result.locatorCandidates.some((candidate) => candidate.strategy === 'css'));
      if (elementId === 'email') {
        assert.ok(result.locatorCandidates.some((candidate) => candidate.strategy === 'label' && candidate.value === 'Email'));
        assert.ok(result.locatorCandidates.some((candidate) => candidate.strategy === 'role' && candidate.role === 'textbox' && candidate.name === 'Email'));
      }
      const stopped = await server.inject({ method: 'POST', url: `/inspections/${initial.id}/stop` });
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopped.json().status, 'stopped');
    }
  } finally { await server.close(); await app.close(); }
});
