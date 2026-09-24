#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestDefinition } from "./definition.js";
import type { RunResult } from "./engine.js";
import { PROTOCOL_VERSION, type WorkerMessage } from "./protocol.js";

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

  const requestId = randomUUID();
  const artifactsDirectory = resolve(artifactsRoot, requestId);
  await mkdir(artifactsDirectory, { recursive: true });
  process.stdout.write(`RUNNING: ${definition.name}\n`);

  const result = await runInChild({
    requestId,
    definition,
    artifactsDirectory,
  });
  await writeFile(resolve(artifactsDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printResult(result, artifactsDirectory);
  process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}

interface ChildRunOptions {
  requestId: string;
  definition: ReturnType<typeof parseTestDefinition>;
  artifactsDirectory: string;
}

function runInChild(options: ChildRunOptions): Promise<RunResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    let runId = options.requestId;
    let finishedResult: RunResult | undefined;
    let protocolFailure: string | undefined;
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      protocolFailure = "Execution worker exceeded the 90 second limit";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, 90_000);
    watchdog.unref();

    const handleMessage = (line: string): void => {
      let message: WorkerMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || !("protocolVersion" in parsed) || parsed.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error("Invalid worker protocol envelope");
        }
        message = parsed as WorkerMessage;
      } catch (error) {
        protocolFailure = `Invalid worker message: ${error instanceof Error ? error.message : String(error)}`;
        child.kill("SIGTERM");
        return;
      }

      if ("requestId" in message && message.requestId !== options.requestId && message.requestId !== null) {
        protocolFailure = "Worker response requestId did not match";
        child.kill("SIGTERM");
        return;
      }
      switch (message.type) {
        case "RUN_STARTED":
          runId = message.runId;
          process.stdout.write(`Worker started (${message.runId})\n`);
          break;
        case "STEP_STARTED":
          break;
        case "STEP_FINISHED": {
          const marker = message.result.status === "passed" ? "✓" : message.result.status === "failed" ? "✗" : "–";
          process.stdout.write(`${marker} ${message.result.stepId}\n`);
          break;
        }
        case "RUN_FINISHED":
          finishedResult = message.result;
          break;
        case "RUN_ERROR":
          protocolFailure = message.message;
          break;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleMessage(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      protocolFailure = `Could not start execution worker: ${error.message}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      if (buffer.trim()) handleMessage(buffer.trim());
      if (finishedResult) {
        resolveResult(finishedResult);
        return;
      }
      const message = timedOut
        ? "Execution worker exceeded the 90 second limit"
        : protocolFailure ?? `Execution worker exited without a result (code ${String(code)}, signal ${String(signal)})`;
      resolveResult({
        protocolVersion: 1,
        runId,
        testId: options.definition.id,
        testName: options.definition.name,
        status: "error",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 0,
        steps: [],
        error: { name: "WorkerError", message },
      });
    });
    child.stdin.end(`${JSON.stringify({
      type: "RUN_REQUEST",
      protocolVersion: PROTOCOL_VERSION,
      requestId: options.requestId,
      definition: options.definition,
      artifactsDirectory: options.artifactsDirectory,
    })}\n`);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Krino error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 2;
});
