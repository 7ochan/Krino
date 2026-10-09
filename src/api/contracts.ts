import type { StoredRun, StoredTest, TestSummary } from "../application/models.js";
import type { RunResult } from "../engine.js";

export interface TestResponse extends Omit<StoredTest, "definition"> {
  definition: StoredTest["definition"];
}

export interface TestListResponse { tests: TestSummary[] }

export interface RunResponse {
  id: string;
  testId: string | null;
  testName: string;
  definition: StoredRun["definition"];
  browserMode: StoredRun["browserMode"];
  status: RunResult["status"] | "queued" | "running";
  startedAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  steps: StoredRun["steps"];
  incompleteSteps?: NonNullable<StoredRun["incompleteSteps"]>;
  artifacts: StoredRun["artifacts"];
  error?: { name: string; message: string };
}

export interface RunListResponse { runs: RunResponse[] }

export function toTestResponse(test: StoredTest): TestResponse { return test; }

export function toRunResponse(run: StoredRun): RunResponse {
  return {
    id: run.id,
    testId: run.testId,
    testName: run.testName,
    definition: run.definition,
    browserMode: run.browserMode,
    status: run.status,
    startedAt: run.startedAt,
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    steps: run.steps,
    ...(run.incompleteSteps?.length ? { incompleteSteps: run.incompleteSteps } : {}),
    artifacts: run.artifacts,
    ...(run.error ? { error: run.error } : {}),
  };
}
