import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInChild } from "../child-runner.js";
import { parseTestDefinition } from "../definition.js";
import type { TestDefinition } from "../definition.js";
import type { RunResult } from "../engine.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import type { RunRepository, StoredRun, TestRepository } from "./models.js";
import type { WorkerMessage } from "../protocol.js";
import { DEFAULT_BROWSER_MODE, type BrowserMode } from "../browser/port.js";
import { WORKER_CLEANUP_GRACE_MS, WORKER_STARTUP_TIMEOUT_MS } from "../child-runner.js";
import { NotFoundError } from "./errors.js";

export interface ExecutionServiceOptions {
  tests: TestRepository;
  runs: RunRepository;
  artifactsDirectory: string;
  workerPath?: string;
  executeWorker?: typeof runInChild;
  onRunCreated?: (runId: string, definition: TestDefinition, artifactsDirectory: string) => void;
  onWorkerMessage?: (message: WorkerMessage) => void;
}

export interface ExecutedRun {
  run: StoredRun;
  result: RunResult;
}

export class ExecutionService {
  private readonly workerPath: string;
  private readonly executeWorker: typeof runInChild;
  private readonly owner = `local-${randomUUID()}`;
  private draining = false;
  private closed = false;
  private readonly completed = new Map<string, RunResult>();

  constructor(private readonly options: ExecutionServiceOptions) {
    this.workerPath = options.workerPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "worker.js");
    this.executeWorker = options.executeWorker ?? runInChild;
    this.options.runs.reconcileExpiredLeases(new Date().toISOString());
    queueMicrotask(() => { void this.drain(); });
  }

  async runTest(testId: string, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<ExecutedRun> {
    return this.waitForRun(await this.enqueueTest(testId, browserMode));
  }

  async enqueueTest(testId: string, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<StoredRun> {
    const test = this.options.tests.get(testId);
    if (!test) throw new NotFoundError(`Test "${testId}" was not found`);
    return this.enqueueDefinition(test.definition, browserMode);
  }

  async runDefinition(input: unknown, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<ExecutedRun> {
    return this.waitForRun(await this.enqueueDefinition(input, browserMode, true));
  }

  async enqueueDefinition(input: unknown, browserMode: BrowserMode = DEFAULT_BROWSER_MODE, upsert = false): Promise<StoredRun> {
    const definition = parseTestDefinition(input);
    if (upsert) this.options.tests.upsert(definition);
    return this.enqueueValidatedDefinition(definition, browserMode);
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.draining) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }

  private async enqueueValidatedDefinition(definition: TestDefinition, browserMode: BrowserMode): Promise<StoredRun> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const runArtifactsDirectory = resolve(this.options.artifactsDirectory, runId);
    await mkdir(runArtifactsDirectory, { recursive: true });
    this.options.runs.enqueue({ id: runId, testId: definition.id, testName: definition.name, definition, browserMode, startedAt });
    this.options.onRunCreated?.(runId, definition, runArtifactsDirectory);
    const run = this.options.runs.get(runId);
    if (!run) throw new Error(`Queued run "${runId}" disappeared after persistence`);
    void this.drain();
    return run;
  }

  private async waitForRun(queued: StoredRun): Promise<ExecutedRun> {
    while (true) {
      const result = this.completed.get(queued.id);
      const run = this.options.runs.get(queued.id);
      if (!run) throw new Error(`Run "${queued.id}" disappeared after persistence`);
      if (result) return { run, result };
      if (run.status === "passed" || run.status === "failed" || run.status === "error") {
        return { run, result: this.resultFromStoredRun(run) };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  private resultFromStoredRun(run: StoredRun): RunResult {
    if (run.status === "queued" || run.status === "running") throw new Error(`Run "${run.id}" is not terminal`);
    return {
      protocolVersion: PROTOCOL_VERSION,
      runId: run.id,
      testId: run.definition.id,
      testName: run.testName,
      status: run.status,
      startTime: run.startedAt,
      endTime: run.finishedAt ?? new Date().toISOString(),
      durationMs: run.durationMs ?? 0,
      steps: run.steps,
      ...(run.incompleteSteps?.length ? { incompleteSteps: run.incompleteSteps } : {}),
      ...(run.error ? { error: run.error } : {}),
    };
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed) {
        const now = new Date();
        this.options.runs.reconcileExpiredLeases(now.toISOString());
        const leaseExpiresAt = new Date(now.getTime() + WORKER_STARTUP_TIMEOUT_MS + 600_000 + WORKER_CLEANUP_GRACE_MS).toISOString();
        const claimed = this.options.runs.claimNext({ owner: this.owner, leaseExpiresAt, now: now.toISOString() });
        if (!claimed) break;
        await this.executeClaimedRun(claimed);
      }
    } finally {
      this.draining = false;
    }
  }

  private async executeClaimedRun(claimed: StoredRun): Promise<void> {
    const definition = claimed.definition;
    const runId = claimed.id;
    const runArtifactsDirectory = resolve(this.options.artifactsDirectory, runId);

    let result: RunResult;
    try {
      result = await this.executeWorker({
        runId,
        definition,
        browserMode: claimed.browserMode,
        artifactsDirectory: runArtifactsDirectory,
        workerPath: this.workerPath,
        ...(this.options.onWorkerMessage ? { onMessage: this.options.onWorkerMessage } : {}),
      });
    } catch (error) {
      const endTime = new Date().toISOString();
      result = {
        protocolVersion: PROTOCOL_VERSION,
        runId,
        testId: definition.id,
        testName: definition.name,
        status: "error",
        startTime: claimed.startedAt,
        endTime,
        durationMs: Math.max(0, Date.parse(endTime) - Date.parse(claimed.startedAt)),
        steps: [],
        error: { name: error instanceof Error ? error.name : "WorkerError", message: error instanceof Error ? error.message : String(error) },
      };
    }

    let resultArtifactError: string | undefined;
    try {
      await writeFile(resolve(runArtifactsDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch (error) {
      resultArtifactError = `Result artifact write failed: ${error instanceof Error ? error.message : String(error)}`;
      result = {
        ...result,
        artifacts: {
          ...(result.artifacts ?? {}),
          errors: [...(result.artifacts?.errors ?? []), resultArtifactError],
        },
      };
    }
    this.options.runs.finish(result, this.options.artifactsDirectory, resultArtifactError);
    const run = this.options.runs.get(runId);
    if (!run) throw new Error(`Run "${runId}" disappeared after persistence`);
    run.result = result;
    this.completed.set(runId, result);
  }
}
