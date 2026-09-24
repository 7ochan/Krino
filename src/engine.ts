import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { BrowserPort, FailureArtifacts } from "./browser/port.js";
import { executeAction } from "./actions.js";
import type { TargetDefinition, TestDefinition, TestStep } from "./definition.js";

export type StepStatus = "passed" | "failed" | "skipped";
export type RunStatus = "passed" | "failed" | "error";

export interface StepResult {
  stepId: string;
  action: TestStep["action"];
  status: StepStatus;
  startTime: string | null;
  endTime: string | null;
  durationMs: number;
  error?: { name: string; message: string };
}

export interface RunResult {
  protocolVersion: 1;
  runId: string;
  testId: string;
  testName: string;
  status: RunStatus;
  startTime: string;
  endTime: string;
  durationMs: number;
  steps: StepResult[];
  artifacts?: FailureArtifacts;
  error?: { name: string; message: string };
}

export type ExecutionEvent =
  | { type: "STEP_STARTED"; stepId: string; action: TestStep["action"]; index: number; total: number }
  | { type: "STEP_FINISHED"; result: StepResult; index: number; total: number };

export interface ExecuteOptions {
  runId: string;
  definition: TestDefinition;
  browser: BrowserPort;
  artifactsDirectory: string;
  onEvent?: (event: ExecutionEvent) => void;
}

function errorDetails(value: unknown): { name: string; message: string } {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return { name: "Error", message: String(value) };
}

function skippedResult(step: TestStep): StepResult {
  return {
    stepId: step.id,
    action: step.action,
    status: "skipped",
    startTime: null,
    endTime: null,
    durationMs: 0,
  };
}

export async function executeDefinition(options: ExecuteOptions): Promise<RunResult> {
  const { definition, browser, runId, artifactsDirectory, onEvent } = options;
  const startTime = new Date().toISOString();
  const startedAt = performance.now();
  const steps: StepResult[] = [];
  let failed = false;
  let failureArtifacts: FailureArtifacts | undefined;
  let failure: { name: string; message: string } | undefined;

  for (const [index, step] of definition.steps.entries()) {
    if (failed) {
      const result = skippedResult(step);
      steps.push(result);
      onEvent?.({ type: "STEP_FINISHED", result, index, total: definition.steps.length });
      continue;
    }

    const stepStartedAt = performance.now();
    const stepStartTime = new Date().toISOString();
    onEvent?.({ type: "STEP_STARTED", stepId: step.id, action: step.action, index, total: definition.steps.length });
    let result: StepResult;
    try {
      await executeAction(step, { browser, target: definition.target });
      const endTime = new Date().toISOString();
      result = {
        stepId: step.id,
        action: step.action,
        status: "passed",
        startTime: stepStartTime,
        endTime,
        durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
      };
    } catch (error) {
      failed = true;
      failure = errorDetails(error);
      const endTime = new Date().toISOString();
      result = {
        stepId: step.id,
        action: step.action,
        status: "failed",
        startTime: stepStartTime,
        endTime,
        durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
        error: failure,
      };
      await mkdir(artifactsDirectory, { recursive: true });
      failureArtifacts = await browser.captureFailureArtifacts(artifactsDirectory);
    }
    steps.push(result);
    onEvent?.({ type: "STEP_FINISHED", result, index, total: definition.steps.length });
  }

  const endTime = new Date().toISOString();
  return {
    protocolVersion: 1,
    runId,
    testId: definition.id,
    testName: definition.name,
    status: failed ? "failed" : "passed",
    startTime,
    endTime,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    steps,
    ...(failureArtifacts ? { artifacts: failureArtifacts } : {}),
    ...(failure ? { error: failure } : {}),
  };
}
