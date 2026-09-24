#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInChild } from "./child-runner.js";
import { parseTestDefinition } from "./definition.js";
import type { RunResult } from "./engine.js";

const defaultArtifactsRoot = resolve(process.cwd(), ".krino", "artifacts");
const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "worker.js");

function usage(): never {
  process.stderr.write("Usage: krino run <test-definition.json> [--artifacts-dir <directory>]\n");
  process.exit(2);
}

function printResult(result: RunResult, artifactDirectory: string): void {
  process.stdout.write(`\nRESULT: ${result.status.toUpperCase()}\n`);
  if (result.error) process.stdout.write(`Error: ${result.error.message}\n`);
  const artifacts = result.artifacts;
  if (artifacts?.screenshotPath) process.stdout.write(`Screenshot: ${artifacts.screenshotPath}\n`);
  if (artifacts?.tracePath) process.stdout.write(`Trace: ${artifacts.tracePath}\n`);
  for (const error of artifacts?.errors ?? []) process.stdout.write(`Artifact warning: ${error}\n`);
  if (result.status !== "passed" && !artifacts?.screenshotPath && !artifacts?.tracePath) {
    process.stdout.write(`Artifacts directory: ${artifactDirectory}\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "run" || !args[1]) usage();
  const definitionPath = resolve(args[1]);
  let artifactsRoot = defaultArtifactsRoot;
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--artifacts-dir" && args[index + 1]) {
      artifactsRoot = resolve(args[index + 1]!);
      index += 1;
    } else {
      usage();
    }
  }

  let definition;
  try {
    const text = await readFile(definitionPath, "utf8");
    definition = parseTestDefinition(JSON.parse(text) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cannot load test definition: ${message}\n`);
    process.exitCode = 2;
    return;
  }

  const runId = randomUUID();
  const artifactsDirectory = resolve(artifactsRoot, runId);
  await mkdir(artifactsDirectory, { recursive: true });
  process.stdout.write(`RUNNING: ${definition.name} (${runId})\n`);

  const result = await runInChild({
    runId,
    definition,
    artifactsDirectory,
    workerPath,
    onMessage(message) {
      if (message.type === "STEP_FINISHED") {
        const marker = message.result.status === "passed" ? "✓" : message.result.status === "failed" ? "✗" : "–";
        process.stdout.write(`${marker} ${message.result.stepId}\n`);
      }
    },
  });
  await writeFile(resolve(artifactsDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printResult(result, artifactsDirectory);
  process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`Krino error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 2;
});
