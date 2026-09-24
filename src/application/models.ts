import type { RunResult, StepResult } from "../engine.js";
import type { TestDefinition } from "../definition.js";
import type { BrowserMode } from "../browser/port.js";

export interface TestSummary {
  id: string;
  name: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTest extends TestSummary {
  definition: TestDefinition;
}

export interface ArtifactRecord {
  type: "screenshot" | "trace" | "result";
  status: "created" | "failed";
  filename?: string;
  createdAt: string;
  error?: string;
}

export interface StoredRun {
  id: string;
  testId: string | null;
  testName: string;
  definition: TestDefinition;
  browserMode: BrowserMode;
  status: RunResult["status"] | "running";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error?: { name: string; message: string };
  steps: StepResult[];
  incompleteSteps: RunResult["incompleteSteps"];
  artifacts: ArtifactRecord[];
  result?: RunResult;
}

export interface TestRepository {
  create(definition: TestDefinition): StoredTest;
  upsert(definition: TestDefinition): StoredTest;
  get(id: string): StoredTest | null;
  list(): TestSummary[];
  update(id: string, definition: TestDefinition): StoredTest | null;
  delete(id: string): boolean;
}

export interface RunRepository {
  create(input: { id: string; testId: string; testName: string; definition: TestDefinition; browserMode: BrowserMode; startedAt: string }): void;
  finish(result: RunResult, artifactRoot: string, resultArtifactError?: string): RunResult;
  get(id: string): StoredRun | null;
  listForTest(testId: string, limit?: number): StoredRun[];
}
