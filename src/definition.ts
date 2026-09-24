import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const locatorRole = z.enum(["button", "heading", "link", "textbox"]);

const roleLocator = z.object({
  strategy: z.literal("role"),
  role: locatorRole,
  name: nonEmpty,
  exact: z.boolean().optional(),
}).strict();

const labelLocator = z.object({
  strategy: z.literal("label"),
  value: nonEmpty,
  exact: z.boolean().optional(),
}).strict();

const textLocator = z.object({
  strategy: z.literal("text"),
  value: nonEmpty,
  exact: z.boolean().optional(),
}).strict();

const testIdLocator = z.object({
  strategy: z.literal("testId"),
  value: nonEmpty,
}).strict();

const cssLocator = z.object({
  strategy: z.literal("css"),
  value: nonEmpty,
}).strict();

export const locatorSchema = z.discriminatedUnion("strategy", [
  roleLocator,
  labelLocator,
  textLocator,
  testIdLocator,
  cssLocator,
]);

const targetUrl = z.string().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  "Target baseUrl must use http or https",
);

export const targetSchema = z.object({
  baseUrl: targetUrl,
  allowedOrigins: z.array(targetUrl).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
}).strict();

const stepId = nonEmpty.max(120);

export const navigateStepSchema = z.object({
  id: stepId,
  action: z.literal("navigate"),
  url: nonEmpty,
}).strict();

const fillValueSchema = z.object({
  kind: z.literal("literal"),
  value: z.string(),
}).strict();

export const fillStepSchema = z.object({
  id: stepId,
  action: z.literal("fill"),
  target: locatorSchema,
  value: fillValueSchema,
}).strict();

export const clickStepSchema = z.object({
  id: stepId,
  action: z.literal("click"),
  target: locatorSchema,
}).strict();

export const assertVisibleStepSchema = z.object({
  id: stepId,
  action: z.literal("assertVisible"),
  target: locatorSchema,
}).strict();

export const assertTextStepSchema = z.object({
  id: stepId,
  action: z.literal("assertText"),
  target: locatorSchema,
  text: nonEmpty,
}).strict();

export const stepSchema = z.discriminatedUnion("action", [
  navigateStepSchema,
  fillStepSchema,
  clickStepSchema,
  assertVisibleStepSchema,
  assertTextStepSchema,
]);

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

export type LocatorDescriptor = z.infer<typeof locatorSchema>;
export type TargetDefinition = z.infer<typeof targetSchema>;
export type TestStep = z.infer<typeof stepSchema>;
export type TestDefinition = z.infer<typeof testDefinitionSchema>;

const ACTION_IDS = new Set([
  "navigate",
  "fill",
  "click",
  "assertVisible",
  "assertText",
]);

export class DefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionValidationError";
  }
}

export function parseTestDefinition(input: unknown): TestDefinition {
  if (typeof input === "object" && input !== null && "steps" in input && Array.isArray(input.steps)) {
    for (const [index, step] of input.steps.entries()) {
      if (typeof step === "object" && step !== null && "action" in step && typeof step.action === "string" && !ACTION_IDS.has(step.action)) {
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
