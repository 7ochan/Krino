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

  constructor(private readonly options: ExecutionServiceOptions) {
    this.workerPath = options.workerPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "worker.js");
    this.executeWorker = options.executeWorker ?? runInChild;
  }

  async runTest(testId: string, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<ExecutedRun> {
    const test = this.options.tests.get(testId);
    if (!test) throw new NotFoundError(`Test "${testId}" was not found`);
    return this.executeDefinition(test.definition, browserMode);
  }

  async runDefinition(input: unknown, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<ExecutedRun> {
    const definition = parseTestDefinition(input);
    this.options.tests.upsert(definition);
    return this.executeDefinition(definition, browserMode);
  }

  private async executeDefinition(definition: TestDefinition, browserMode: BrowserMode): Promise<ExecutedRun> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const runArtifactsDirectory = resolve(this.options.artifactsDirectory, runId);
    await mkdir(runArtifactsDirectory, { recursive: true });
    this.options.runs.create({ id: runId, testId: definition.id, testName: definition.name, definition, browserMode, startedAt });
    this.options.onRunCreated?.(runId, definition, runArtifactsDirectory);

    let result: RunResult;
    try {
      result = await this.executeWorker({
        runId,
        definition,
        browserMode,
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
        startTime: startedAt,
        endTime,
        durationMs: Math.max(0, Date.parse(endTime) - Date.parse(startedAt)),
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
    return { run, result };
  }
}
