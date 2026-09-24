# Krino

Krino is a private, local-first web test runner. This first milestone provides a versioned JSON test definition, a TypeScript CLI, a child-process Playwright worker, and a tiny local fixture application. Browser execution is local; no UI, database, remote agent, or hosted service is included.

## Prerequisites

- Node.js 20 or newer
- pnpm
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

Failed runs write `screenshot.png`, `trace.zip`, and `result.json` to `.krino/artifacts/<run-id>/` (or the directory passed with `--artifacts-dir`). The CLI prints absolute artifact paths. Open a trace with `pnpm exec playwright show-trace <path-to-trace.zip>`.

## Current limits

This milestone supports only `navigate`, `fill`, `click`, `assertVisible`, and `assertText`; one Chromium run at a time; and JSON-authored tests. It does not include a management UI, database, persistent queue, remote agent, CI integration, custom addons, AI, or locator healing.
