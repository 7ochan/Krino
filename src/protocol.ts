import { z } from "zod";
import { testDefinitionSchema } from "./definition.js";
import type { RunResult, StepResult } from "./engine.js";

export const PROTOCOL_VERSION = 1 as const;

export const runRequestSchema = z.object({
  type: z.literal("RUN_REQUEST"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  definition: testDefinitionSchema,
  artifactsDirectory: z.string().min(1),
}).strict();

export type RunRequest = z.infer<typeof runRequestSchema>;

export type WorkerMessage =
  | { type: "RUN_STARTED"; protocolVersion: 1; requestId: string; runId: string; testName: string }
  | { type: "STEP_STARTED"; protocolVersion: 1; requestId: string; stepId: string; action: string; index: number; total: number }
  | { type: "STEP_FINISHED"; protocolVersion: 1; requestId: string; result: StepResult; index: number; total: number }
  | { type: "RUN_FINISHED"; protocolVersion: 1; requestId: string; result: RunResult }
  | { type: "RUN_ERROR"; protocolVersion: 1; requestId: string | null; message: string };
