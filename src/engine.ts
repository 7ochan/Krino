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

export interface IncompleteStep {
  stepId: string;
  action: TestStep["action"];
  index: number;
  startTime: string;
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
  incompleteSteps?: IncompleteStep[];
  artifacts?: FailureArtifacts;
  error?: { name: string; message: string };
}

export type ExecutionEvent =
  | { type: "STEP_STARTED"; stepId: string; action: TestStep["action"]; startTime: string; index: number; total: number }
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
  let runTimedOut = false;
  let failureArtifacts: FailureArtifacts | undefined;
  let failure: { name: string; message: string } | undefined;

  for (const [index, step] of definition.steps.entries()) {
    if (failed || runTimedOut) {
      const result = skippedResult(step);
      steps.push(result);
      onEvent?.({ type: "STEP_FINISHED", result, index, total: definition.steps.length });
      continue;
    }

    const remainingRunMs = definition.target.runTimeoutMs - (performance.now() - startedAt);
    if (remainingRunMs <= 0) {
      runTimedOut = true;
      failure = {
        name: "RunTimeoutError",
        message: `Run exceeded its ${definition.target.runTimeoutMs}ms whole-run timeout before step "${step.id}" started`,
      };
      for (const [skippedIndex, skippedStep] of definition.steps.entries()) {
        if (skippedIndex < index) continue;
        const skipped = skippedResult(skippedStep);
        steps.push(skipped);
        onEvent?.({ type: "STEP_FINISHED", result: skipped, index: skippedIndex, total: definition.steps.length });
      }
      break;
    }

    const stepStartedAt = performance.now();
    const stepStartTime = new Date().toISOString();
    const actionTimeoutMs = Math.max(1, Math.min(definition.target.stepTimeoutMs, Math.ceil(remainingRunMs)));
    onEvent?.({ type: "STEP_STARTED", stepId: step.id, action: step.action, startTime: stepStartTime, index, total: definition.steps.length });
    let result: StepResult;
    try {
      await executeAction(step, { browser, target: definition.target, timeoutMs: actionTimeoutMs });
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
      const actionError = errorDetails(error);
      const endTime = new Date().toISOString();
      result = {
        stepId: step.id,
        action: step.action,
        status: "failed",
        startTime: stepStartTime,
        endTime,
        durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
        error: actionError,
      };
      failure = actionError;
      const stepDurationMs = Math.max(0, Math.round(performance.now() - stepStartedAt));
      const timeoutWasRunLimited = actionTimeoutMs < definition.target.stepTimeoutMs;
      const likelyReachedRunDeadline = stepDurationMs >= Math.max(actionTimeoutMs * 0.8, actionTimeoutMs - 50);
      if (timeoutWasRunLimited && likelyReachedRunDeadline) {
        runTimedOut = true;
        failure = {
          name: "RunTimeoutError",
          message: `Run exceeded its ${definition.target.runTimeoutMs}ms whole-run timeout while executing step "${step.id}"`,
        };
      }
    }
    steps.push(result);
    onEvent?.({ type: "STEP_FINISHED", result, index, total: definition.steps.length });

    if (result.status === "failed") {
      // Preserve the observed test failure before performing best-effort diagnostics.
      // Artifact IO must never replace the actual failed step with a generic run error.
      try {
        await mkdir(artifactsDirectory, { recursive: true });
        failureArtifacts = await browser.captureFailureArtifacts(artifactsDirectory);
      } catch (error) {
        failureArtifacts = {
          errors: [`Failure artifact capture failed: ${error instanceof Error ? error.message : String(error)}`],
        };
      }
    }
  }

  const endTime = new Date().toISOString();
  return {
    protocolVersion: 1,
    runId,
    testId: definition.id,
    testName: definition.name,
    status: runTimedOut ? "error" : failed ? "failed" : "passed",
    startTime,
    endTime,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    steps,
    ...(failureArtifacts ? { artifacts: failureArtifacts } : {}),
    ...(failure ? { error: failure } : {}),
  };
}
