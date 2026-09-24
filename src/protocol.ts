import { z } from "zod";
import { testDefinitionSchema, type TestStep } from "./definition.js";
import type { RunResult, StepResult } from "./engine.js";

export const PROTOCOL_VERSION = 1 as const;

export const runRequestSchema = z.object({
  type: z.literal("RUN_REQUEST"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: z.string().min(1),
  definition: testDefinitionSchema,
  artifactsDirectory: z.string().min(1),
}).strict();

export type RunRequest = z.infer<typeof runRequestSchema>;

export type WorkerMessage =
  | { type: "RUN_STARTED"; protocolVersion: 1; runId: string; testName: string }
  | { type: "STEP_STARTED"; protocolVersion: 1; runId: string; stepId: string; action: TestStep["action"]; startTime: string; index: number; total: number }
  | { type: "STEP_FINISHED"; protocolVersion: 1; runId: string; result: StepResult; index: number; total: number }
  | { type: "RUN_FINISHED"; protocolVersion: 1; runId: string; result: RunResult }
  | { type: "RUN_ERROR"; protocolVersion: 1; runId: string | null; message: string };
