import { z } from "zod";
import { testDefinitionSchema, type TestStep } from "./definition.js";
import type { RunResult, StepResult } from "./engine.js";
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

export type WorkerMessage =
  | { type: "RUN_STARTED"; protocolVersion: 1; runId: string; testName: string; browserMode: BrowserMode }
  | { type: "STEP_STARTED"; protocolVersion: 1; runId: string; stepId: string; action: TestStep["action"]; startTime: string; index: number; total: number }
  | { type: "STEP_FINISHED"; protocolVersion: 1; runId: string; result: StepResult; index: number; total: number }
  | { type: "RUN_FINISHED"; protocolVersion: 1; runId: string; result: RunResult }
  | { type: "RUN_ERROR"; protocolVersion: 1; runId: string | null; message: string };
