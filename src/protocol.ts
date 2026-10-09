import { z } from "zod";
import { testDefinitionSchema } from "./definition.js";
import { actionIdSchema } from "./actions.js";
import { DEFAULT_BROWSER_MODE, type BrowserMode } from "./browser/port.js";

export const PROTOCOL_VERSION = 1 as const;
export const browserModeSchema = z.enum(["headless", "headed"]).default(DEFAULT_BROWSER_MODE);

export const runRequestSchema = z.object({
  type: z.literal("RUN_REQUEST"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: z.string().min(1),
  definition: testDefinitionSchema,
  browserMode: browserModeSchema,
  artifactsDirectory: z.string().min(1),
}).strict();

export type RunRequest = z.infer<typeof runRequestSchema>;
export type { BrowserMode };

const errorDetailsSchema = z.object({ name: z.string().min(1), message: z.string() }).strict();
export const stepResultSchema = z.object({
  stepId: z.string().min(1),
  action: actionIdSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  startTime: z.string().datetime().nullable(),
  endTime: z.string().datetime().nullable(),
  durationMs: z.number().int().min(0),
  error: errorDetailsSchema.optional(),
}).strict();

export const incompleteStepSchema = z.object({
  stepId: z.string().min(1),
  action: actionIdSchema,
  index: z.number().int().min(0),
  startTime: z.string().datetime(),
}).strict();

const failureArtifactsSchema = z.object({
  screenshotPath: z.string().min(1).optional(),
  tracePath: z.string().min(1).optional(),
  errors: z.array(z.string()),
}).strict();

export const runResultSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: z.string().min(1),
  testId: z.string().min(1),
  testName: z.string().min(1),
  status: z.enum(["passed", "failed", "error"]),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  durationMs: z.number().int().min(0),
  steps: z.array(stepResultSchema),
  incompleteSteps: z.array(incompleteStepSchema).optional(),
  artifacts: failureArtifactsSchema.optional(),
  error: errorDetailsSchema.optional(),
}).strict();

export const workerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RUN_STARTED"), protocolVersion: z.literal(PROTOCOL_VERSION), runId: z.string().min(1), testName: z.string().min(1), browserMode: browserModeSchema }).strict(),
  z.object({ type: z.literal("STEP_STARTED"), protocolVersion: z.literal(PROTOCOL_VERSION), runId: z.string().min(1), stepId: z.string().min(1), action: actionIdSchema, startTime: z.string().datetime(), index: z.number().int().min(0), total: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal("STEP_FINISHED"), protocolVersion: z.literal(PROTOCOL_VERSION), runId: z.string().min(1), result: stepResultSchema, index: z.number().int().min(0), total: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal("RUN_FINISHED"), protocolVersion: z.literal(PROTOCOL_VERSION), runId: z.string().min(1), result: runResultSchema }).strict(),
  z.object({ type: z.literal("RUN_ERROR"), protocolVersion: z.literal(PROTOCOL_VERSION), runId: z.string().min(1).nullable(), message: z.string().min(1) }).strict(),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
