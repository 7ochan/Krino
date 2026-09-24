# Krino

Krino is a private, local-first web test runner. This first milestone provides a versioned JSON test definition, a TypeScript CLI, a child-process Playwright worker, and a tiny local fixture application. Browser execution is local; no UI, database, remote agent, or hosted service is included.

## Prerequisites

- Node.js 22.13 or newer (Node 22/24 LTS lines are supported)
- pnpm 11.13.1 (pinned by `packageManager` in `package.json`)
- Chromium dependencies supported by Playwright on your operating system

## Install

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build
```

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

The test suite starts an ephemeral local fixture automatically:

```sh
pnpm test
```

Each CLI execution receives one run ID, shared by the worker, result, and its directory: `.krino/artifacts/<run-id>/` (or the directory passed with `--artifacts-dir`). `result.json` is written for every run; failed runs also attempt `screenshot.png` and `trace.zip`. The CLI prints the run ID and any available artifact paths. Artifact-capture errors are reported separately and do not replace the failed test result. Open a trace with `pnpm exec playwright show-trace <path-to-trace.zip>`.

`target.stepTimeoutMs` (default 10 seconds, maximum 120 seconds) bounds an individual action. `target.runTimeoutMs` (default 5 minutes, maximum 10 minutes) bounds sequential step execution and must be at least as large as `stepTimeoutMs`. Each action receives the smaller of the remaining run budget and its step timeout. Browser startup has a 30-second ceiling; the parent worker watchdog allows that startup window, the configured run budget, and a 15-second cleanup grace, so it does not expire before a valid configured run budget.

The worker's browser accesses localhost and private-network targets directly from this machine. The current browser origin filter is a convenience guard for ordinary requests, not a complete network/security sandbox (for example, it does not establish a trust boundary for service workers or WebSockets). Only trusted local test definitions should be run.

## Current limits

This milestone supports only `navigate`, `fill`, `click`, `assertVisible`, and `assertText`; one Chromium run at a time; and JSON-authored tests. It does not include a management UI, database, persistent queue, remote agent, CI integration, custom addons, AI, or locator healing.
