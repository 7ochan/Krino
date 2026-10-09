import { z } from "zod";
import { actionStepSchema, actionIds, type TestStep } from "./actions.js";
import { locatorSchema, type LocatorDescriptor } from "./locator.js";

const nonEmpty = z.string().trim().min(1);
export { locatorSchema } from "./locator.js";

const targetUrl = z.string().url().refine((value) => {
  // z.string().url() reports malformed input. Keep this refinement safe because
  // URL() throws for some strings that Zod rejects, and refinements must not leak it.
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return true;
  }
}, "Target URL must use http or https");

export const targetSchema = z.object({
  baseUrl: targetUrl,
  allowedOrigins: z.array(targetUrl).optional(),
  stepTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  runTimeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
}).strict().superRefine((target, context) => {
  if (target.runTimeoutMs < target.stepTimeoutMs) {
    context.addIssue({
      code: "custom",
      path: ["runTimeoutMs"],
      message: "runTimeoutMs must be at least stepTimeoutMs",
    });
  }
});

const stepId = nonEmpty.max(120);

export const stepSchema = actionStepSchema;

export const testDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty.max(120),
  name: nonEmpty.max(240),
  target: targetSchema,
  steps: z.array(stepSchema).min(1),
}).strict().superRefine((definition, context) => {
  const ids = new Set<string>();
  definition.steps.forEach((step, index) => {
    if (ids.has(step.id)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: `Duplicate step id "${step.id}"`,
      });
    }
    ids.add(step.id);
  });
});

export type { LocatorDescriptor } from "./locator.js";
export type TargetDefinition = z.infer<typeof targetSchema>;
export type { TestStep } from "./actions.js";
export type TestDefinition = z.infer<typeof testDefinitionSchema>;

export class DefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionValidationError";
  }
}

export function parseTestDefinition(input: unknown): TestDefinition {
  if (typeof input === "object" && input !== null && "steps" in input && Array.isArray(input.steps)) {
    for (const [index, step] of input.steps.entries()) {
      if (typeof step === "object" && step !== null && "action" in step && typeof step.action === "string" && !actionIds.has(step.action)) {
        throw new DefinitionValidationError(`Unknown action "${step.action}" at steps[${index}].action`);
      }
    }
  }

  const parsed = testDefinitionSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "definition";
    return `${path}: ${issue.message}`;
  });
  throw new DefinitionValidationError(`Invalid test definition:\n- ${details.join("\n- ")}`);
}
