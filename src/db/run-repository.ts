import { desc, eq } from "drizzle-orm";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseTestDefinition, type TestDefinition } from "../definition.js";
import type { RunResult, StepResult } from "../engine.js";
import type { ArtifactRecord, RunRepository, StoredRun } from "../application/models.js";
import type { KrinoDatabase } from "./open.js";
import { artifacts, runs, stepResults } from "./schema.js";

function parseJson<T>(value: string | null | undefined): T | undefined {
  return value == null ? undefined : JSON.parse(value) as T;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..");
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly database: KrinoDatabase) {}

  create(input: { id: string; testId: string; testName: string; definition: TestDefinition; browserMode: StoredRun["browserMode"]; startedAt: string }): void {
    this.database.orm.insert(runs).values({
      id: input.id,
      testId: input.testId,
      testName: input.testName,
      definitionSnapshot: JSON.stringify(input.definition),
      browserMode: input.browserMode,
      status: "running",
      startedAt: input.startedAt,
      finishedAt: null,
      durationMs: null,
      error: null,
      incompleteSteps: "[]",
    }).run();
  }

  finish(result: RunResult, artifactRoot: string, resultArtifactError?: string): RunResult {
    const base = resolve(artifactRoot);
    const now = new Date().toISOString();
    const artifactRows: Array<typeof artifacts.$inferInsert> = [];
    const addArtifact = (type: "screenshot" | "trace" | "result", path: string | undefined, error?: string): void => {
      const absolute = path ? resolve(path) : undefined;
      const safeRelative = absolute && isWithin(base, absolute) ? relative(base, absolute) : undefined;
      artifactRows.push({
        runId: result.runId,
        type,
        status: safeRelative ? "created" : "failed",
        relativePath: safeRelative ?? null,
        createdAt: now,
        error: error ?? (path && !safeRelative ? "Artifact path was outside the configured artifact directory" : null),
      });
    };
    const shouldRecordDiagnostics = result.status !== "passed";
    if (result.artifacts?.screenshotPath || shouldRecordDiagnostics && result.artifacts?.errors.some((error) => error.toLowerCase().includes("screenshot"))) {
      addArtifact("screenshot", result.artifacts?.screenshotPath, result.artifacts?.errors.find((error) => error.toLowerCase().includes("screenshot")));
    }
    if (result.artifacts?.tracePath || shouldRecordDiagnostics && result.artifacts?.errors.some((error) => error.toLowerCase().includes("trace"))) {
      addArtifact("trace", result.artifacts?.tracePath, result.artifacts?.errors.find((error) => error.toLowerCase().includes("trace")));
    }
    const resultPath = resolve(base, result.runId, "result.json");
    if (resultArtifactError) {
      artifactRows.push({ runId: result.runId, type: "result", status: "failed", relativePath: null, createdAt: now, error: resultArtifactError });
    } else {
      addArtifact("result", resultPath);
    }
    for (const error of result.artifacts?.errors ?? []) {
      const assigned = error.toLowerCase().includes("screenshot") ? "screenshot" : error.toLowerCase().includes("trace") ? "trace" : undefined;
      if (!assigned && !error.startsWith("Result artifact write failed:")) artifactRows.push({ runId: result.runId, type: "result", status: "failed", relativePath: null, createdAt: now, error });
    }

    this.database.raw.transaction(() => {
      this.database.orm.update(runs).set({
        status: result.status,
        finishedAt: result.endTime,
        durationMs: result.durationMs,
        error: result.error ? JSON.stringify(result.error) : null,
        incompleteSteps: JSON.stringify(result.incompleteSteps ?? []),
      }).where(eq(runs.id, result.runId)).run();

      this.database.orm.delete(stepResults).where(eq(stepResults.runId, result.runId)).run();
      if (result.steps.length > 0) {
        this.database.orm.insert(stepResults).values(result.steps.map((step, position) => ({
          runId: result.runId,
          stepId: step.stepId,
          action: step.action,
          status: step.status,
          startTime: step.startTime,
          endTime: step.endTime,
          durationMs: step.durationMs,
          error: step.error ? JSON.stringify(step.error) : null,
          position,
        }))).run();
      }
      this.database.orm.delete(artifacts).where(eq(artifacts.runId, result.runId)).run();
      this.database.orm.insert(artifacts).values(artifactRows).run();
    })();
    return result;
  }

  get(id: string): StoredRun | null {
    const row = this.database.orm.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) return null;
    return this.toStored(row);
  }

  listForTest(testId: string, limit = 50): StoredRun[] {
    const rows = this.database.orm.select().from(runs)
      .where(eq(runs.testId, testId))
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .all();
    return rows.map((row) => this.toStored(row));
  }

  private toStored(row: typeof runs.$inferSelect): StoredRun {
    const steps = this.database.orm.select().from(stepResults)
      .where(eq(stepResults.runId, row.id))
      .orderBy(stepResults.position)
      .all()
      .map((step): StepResult => ({
        stepId: step.stepId,
        action: step.action as StepResult["action"],
        status: step.status,
        startTime: step.startTime,
        endTime: step.endTime,
        durationMs: step.durationMs,
        ...(step.error ? { error: JSON.parse(step.error) as { name: string; message: string } } : {}),
      }));
    const artifactList = this.database.orm.select().from(artifacts).where(eq(artifacts.runId, row.id)).all();
    const artifactRecords: ArtifactRecord[] = artifactList.map((artifact) => ({
      type: artifact.type,
      status: artifact.status,
      ...(artifact.relativePath ? { filename: artifact.relativePath.split(/[\\/]/).at(-1)! } : {}),
      createdAt: artifact.createdAt,
      ...(artifact.error ? { error: artifact.error } : {}),
    }));
    const incompleteSteps = parseJson<NonNullable<RunResult["incompleteSteps"]>>(row.incompleteSteps);
    const error = parseJson<{ name: string; message: string }>(row.error);
    const definition = parseTestDefinition(JSON.parse(row.definitionSnapshot) as unknown);
    return {
      id: row.id,
      testId: row.testId,
      testName: row.testName,
      definition,
      browserMode: row.browserMode,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      ...(error ? { error } : {}),
      steps,
      incompleteSteps,
      artifacts: artifactRecords,
    };
  }
}
