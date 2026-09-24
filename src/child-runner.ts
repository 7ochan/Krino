import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { TestDefinition } from "./definition.js";
import { DEFAULT_BROWSER_MODE, type BrowserMode } from "./browser/port.js";
import type { IncompleteStep, RunResult, StepResult } from "./engine.js";
import { PROTOCOL_VERSION, type WorkerMessage } from "./protocol.js";

export const WORKER_STARTUP_TIMEOUT_MS = 30_000;
export const WORKER_CLEANUP_GRACE_MS = 15_000;

export function workerWatchdogTimeoutMs(runTimeoutMs: number): number {
  return WORKER_STARTUP_TIMEOUT_MS + runTimeoutMs + WORKER_CLEANUP_GRACE_MS;
}

export interface ChildRunOptions {
  runId?: string;
  definition: TestDefinition;
  browserMode?: BrowserMode;
  artifactsDirectory: string;
  workerPath: string;
  onMessage?: (message: WorkerMessage) => void;
}

function errorDetails(name: string, message: string): { name: string; message: string } {
  return { name, message };
}

async function existingArtifactPaths(directory: string): Promise<{ screenshotPath?: string; tracePath?: string }> {
  const artifacts: { screenshotPath?: string; tracePath?: string } = {};
  for (const [name, key] of [["screenshot.png", "screenshotPath"], ["trace.zip", "tracePath"]] as const) {
    const path = resolve(directory, name);
    try {
      await access(path, constants.F_OK);
      artifacts[key] = path;
    } catch {
      // Only report artifacts that demonstrably exist.
    }
  }
  return artifacts;
}

export function runInChild(options: ChildRunOptions): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date();
  const monotonicStartedAt = performance.now();
  const completedSteps = new Map<number, StepResult>();
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [options.workerPath], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    let finishedResult: RunResult | undefined;
    let workerFailure: string | undefined;
    let watchdogExpired = false;
    let resolved = false;
    const incompleteSteps = new Map<number, IncompleteStep>();
    let killTimer: NodeJS.Timeout | undefined;
    const watchdog = setTimeout(() => {
      watchdogExpired = true;
      workerFailure = `Execution worker exceeded its startup plus ${options.definition.target.runTimeoutMs}ms run budget`;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    }, workerWatchdogTimeoutMs(options.definition.target.runTimeoutMs));
    watchdog.unref();

    const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (resolved) return;
      resolved = true;
      clearTimeout(watchdog);
      if (killTimer) clearTimeout(killTimer);
      if (finishedResult && code === 0 && !watchdogExpired) {
        resolveResult(finishedResult);
        return;
      }

      const workerExit = watchdogExpired
        ? workerFailure ?? "Execution worker watchdog expired"
        : workerFailure ?? `Execution worker exited without a usable result (code ${String(code)}, signal ${String(signal)})`;
      const artifacts = await existingArtifactPaths(options.artifactsDirectory);
      resolveResult({
        protocolVersion: PROTOCOL_VERSION,
        runId,
        testId: options.definition.id,
        testName: options.definition.name,
        status: "error",
        startTime: startedAt.toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - monotonicStartedAt)),
        steps: [...completedSteps.entries()].sort(([left], [right]) => left - right).map(([, result]) => result),
        ...(incompleteSteps.size > 0 ? { incompleteSteps: [...incompleteSteps.values()].sort((left, right) => left.index - right.index) } : {}),
        ...(Object.keys(artifacts).length > 0 ? { artifacts: { ...artifacts, errors: [] } } : {}),
        error: errorDetails(watchdogExpired ? "WorkerTimeoutError" : "WorkerError", workerExit),
      });
    };

    const handleMessage = (line: string): void => {
      let message: WorkerMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || !("protocolVersion" in parsed) || parsed.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error("Invalid worker protocol envelope");
        }
        message = parsed as WorkerMessage;
        if ("runId" in message && message.runId !== runId && message.runId !== null) {
          throw new Error("Worker response runId did not match the requested run");
        }
      } catch (error) {
        workerFailure = `Invalid worker message: ${error instanceof Error ? error.message : String(error)}`;
        child.kill("SIGTERM");
        return;
      }

      options.onMessage?.(message);
      switch (message.type) {
        case "RUN_STARTED":
          break;
        case "STEP_STARTED":
          incompleteSteps.set(message.index, {
            stepId: message.stepId,
            action: message.action,
            index: message.index,
            startTime: message.startTime,
          });
          break;
        case "STEP_FINISHED":
          completedSteps.set(message.index, message.result);
          incompleteSteps.delete(message.index);
          break;
        case "RUN_FINISHED":
          if (message.result.runId !== runId) {
            workerFailure = "Worker final result runId did not match the requested run";
          } else {
            finishedResult = message.result;
          }
          break;
        case "RUN_ERROR":
          workerFailure = message.message;
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
      workerFailure = `Could not start execution worker: ${error.message}`;
    });
    child.on("close", (code, signal) => {
      if (buffer.trim()) handleMessage(buffer.trim());
      void finish(code, signal);
    });
    child.stdin.end(`${JSON.stringify({
      type: "RUN_REQUEST",
      protocolVersion: PROTOCOL_VERSION,
      runId,
      definition: options.definition,
      browserMode: options.browserMode ?? DEFAULT_BROWSER_MODE,
      artifactsDirectory: options.artifactsDirectory,
    })}\n`);
  });
}
