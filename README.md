# Krino

Krino is a private, local-first web test automation application. The local React/TypeScript UI manages versioned definitions and run history through the loopback-only Fastify API. Browser execution remains local in the existing Playwright child process; there is no remote agent or hosted service.

## Prerequisites

- Node.js 22.13 or newer (Node 22/24 LTS lines are supported)
- pnpm 11.13.1 (pinned by `packageManager` in `package.json`)
- Chromium dependencies supported by Playwright on your operating system
- Native build tools required by `better-sqlite3` on platforms without a compatible prebuilt binary

## Install

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
```

The SQLite file is created at `.krino/krino.sqlite`; run artifacts remain under `.krino/artifacts/<run-id>/`. Both are ignored by Git. Set `KRINO_DATA_DIR` to move the local data directory, or `KRINO_DB_PATH` to override only the database file path.

## Run the fixture and tests

In one terminal, start the fixture application:

```sh
pnpm fixture
```

It listens at `http://127.0.0.1:4173`. In another terminal, run the passing example:

```sh
pnpm krino run examples/login.json
```

To exercise failure reporting, run the deliberately failing example:

```sh
pnpm krino run examples/login-failing.json
```

The CLI uses the same application execution service as the API. It persists/updates the test definition by its test ID and records each run in SQLite while keeping the existing exit codes and artifact output.

The test suite starts an ephemeral local fixture automatically. It also starts an isolated API and Vite server and drives a real headless Chromium session through the UI:

```sh
pnpm test
```

Run only the browser acceptance flow with `pnpm e2e`.

Each CLI execution receives one run ID, shared by the worker, result, and its directory: `.krino/artifacts/<run-id>/` (or the directory passed with `--artifacts-dir`). `result.json` is written for every run; failed runs also attempt `screenshot.png` and `trace.zip`. The CLI prints the run ID and any available artifact paths. Artifact-capture errors are reported separately and do not replace the failed test result. Open a trace with `pnpm exec playwright show-trace <path-to-trace.zip>`.

`target.stepTimeoutMs` (default 10 seconds, maximum 120 seconds) bounds an individual action. `target.runTimeoutMs` (default 5 minutes, maximum 10 minutes) bounds sequential step execution and must be at least as large as `stepTimeoutMs`. Each action receives the smaller of the remaining run budget and its step timeout. Browser startup has a 30-second ceiling; the parent worker watchdog allows that startup window, the configured run budget, and a 15-second cleanup grace, so it does not expire before a valid configured run budget.

The worker's browser accesses localhost and private-network targets directly from this machine. The current browser origin filter is a convenience guard for ordinary requests, not a complete network/security sandbox (for example, it does not establish a trust boundary for service workers or WebSockets). Only trusted local test definitions should be run.

## Local API and persistence

Start only the API with:

```sh
pnpm api
```

It binds only to `127.0.0.1` (port `4174` by default; override with `KRINO_PORT`). It does not fetch test target URLs itself: the child browser worker accesses localhost/private targets directly from this machine. The API is a local single-user interface, not an authenticated or network-exposed service.

For the full development environment, run `pnpm dev`. The API stays bound to `127.0.0.1:4174`; Vite serves the UI at `http://127.0.0.1:5173` and proxies `/api` requests to the API. To run only the UI, use `pnpm --dir ui dev` while the API is running. `VITE_API_BASE_URL` can override the request base path, for example when a local deployment provides its own same-origin proxy.

Available endpoints:

```text
GET    /health
GET    /actions
GET    /tests
POST   /tests
GET    /tests/:id
PUT    /tests/:id
DELETE /tests/:id
POST   /tests/:id/runs
GET    /runs/:id
GET    /tests/:id/runs
```

`POST /tests` and `PUT /tests/:id` accept the same versioned JSON definition used by the CLI. A synchronous `POST /tests/:id/runs` response includes the persisted run and ordered step results. Test definitions are stored as validated JSON; SQLite separately stores test metadata, immutable run definition snapshots, ordered step outcomes, errors, and artifact metadata. Deleting a test keeps its run history; historical runs then have a null `testId`.

Example:

```sh
curl -sS http://127.0.0.1:4174/health
curl -sS -X POST http://127.0.0.1:4174/tests \
  -H 'content-type: application/json' \
  --data-binary @examples/login.json
curl -sS -X POST http://127.0.0.1:4174/tests/login-smoke/runs
curl -sS http://127.0.0.1:4174/runs/<run-id>
```

Artifact responses expose metadata/filenames, not arbitrary filesystem paths. There is no generic file-serving endpoint. The on-disk run directory and `result.json` behavior are unchanged.

The UI is available at `http://127.0.0.1:5173` while `pnpm dev` is running. It supports test list/create/edit/delete, the current registered actions and locators, synchronous runs, history, and run reports. `pnpm test` covers backend, frontend, and local Chromium UI E2E tests; `pnpm typecheck` and `pnpm build` cover backend and frontend. UI-only commands are also available as `pnpm ui:test`, `pnpm ui:typecheck`, and `pnpm ui:build`.

## Browser execution modes

Headless is the default and runs the browser invisibly. Select Visible before running to launch a visible Chromium window on this desktop, useful for debugging and watching tests execute. Visible runs are intended for local desktop execution and are recorded in the run report.

## Current limits

This milestone supports only the registered actions (`navigate`, `fill`, `click`, `assertVisible`, and `assertText`); one Chromium run at a time; and versioned JSON definitions authored through a small form. There is no background queue, remote agent, CI integration, custom addons, AI, or locator healing.
