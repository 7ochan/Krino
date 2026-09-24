import { integer, sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tests = sqliteTable("tests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  definition: text("definition").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  testId: text("test_id").references(() => tests.id, { onDelete: "set null" }),
  testName: text("test_name").notNull(),
  definitionSnapshot: text("definition_snapshot").notNull(),
  browserMode: text("browser_mode", { enum: ["headless", "headed"] }).notNull().default("headless"),
  status: text("status", { enum: ["running", "passed", "failed", "error"] }).notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  error: text("error"),
  incompleteSteps: text("incomplete_steps").notNull().default("[]"),
}, (table) => [index("runs_test_started_idx").on(table.testId, table.startedAt)]);

export const stepResults = sqliteTable("step_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  action: text("action").notNull(),
  status: text("status", { enum: ["passed", "failed", "skipped"] }).notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  durationMs: integer("duration_ms").notNull(),
  error: text("error"),
  position: integer("position").notNull(),
}, (table) => [
  uniqueIndex("step_results_run_position_uq").on(table.runId, table.position),
  index("step_results_run_idx").on(table.runId),
]);

export const artifacts = sqliteTable("artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["screenshot", "trace", "result"] }).notNull(),
  status: text("status", { enum: ["created", "failed"] }).notNull(),
  relativePath: text("relative_path"),
  createdAt: text("created_at").notNull(),
  error: text("error"),
}, (table) => [index("artifacts_run_idx").on(table.runId)]);
