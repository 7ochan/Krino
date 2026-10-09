import { z } from "zod";
import type { BrowserPort } from "./browser/port.js";
import { locatorSchema } from "./locator.js";
import type { TargetDefinition } from "./definition.js";

export interface ActionContext {
  browser: BrowserPort;
  target: TargetDefinition;
  timeoutMs: number;
}

const stepIdSchema = z.string().trim().min(1).max(120);
export const actionIdSchema = z.enum(["navigate", "fill", "click", "assertVisible", "assertText"]);
const navigateStepSchema = z.object({ id: stepIdSchema, action: z.literal("navigate"), url: z.string().trim().min(1) }).strict();
const fillStepSchema = z.object({ id: stepIdSchema, action: z.literal("fill"), target: locatorSchema, value: z.object({ kind: z.literal("literal"), value: z.string() }).strict() }).strict();
const clickStepSchema = z.object({ id: stepIdSchema, action: z.literal("click"), target: locatorSchema }).strict();
const assertVisibleStepSchema = z.object({ id: stepIdSchema, action: z.literal("assertVisible"), target: locatorSchema }).strict();
const assertTextStepSchema = z.object({ id: stepIdSchema, action: z.literal("assertText"), target: locatorSchema, text: z.string().trim().min(1) }).strict();

export const actionStepSchema = z.discriminatedUnion("action", [navigateStepSchema, fillStepSchema, clickStepSchema, assertVisibleStepSchema, assertTextStepSchema]);
export type TestStep = z.infer<typeof actionStepSchema>;
type ActionId = TestStep["action"];

export interface ActionEditorMetadata {
  kind: "navigate" | "target" | "targetWithValue" | "targetWithText";
}

interface ActionDefinition<K extends ActionId> {
  id: K;
  displayName: string;
  inputSchema: z.ZodType<Extract<TestStep, { action: K }>>;
  editor: ActionEditorMetadata;
  execute(step: Extract<TestStep, { action: K }>, context: ActionContext): Promise<void>;
}

export interface RegisteredAction {
  id: ActionId;
  displayName: string;
  editor: ActionEditorMetadata;
  execute(input: unknown, context: ActionContext): Promise<void>;
}

function defineAction<K extends TestStep["action"]>(
  definition: ActionDefinition<K>,
): RegisteredAction {
  return {
    id: definition.id,
    displayName: definition.displayName,
    editor: definition.editor,
    async execute(input, context) {
      const validated = definition.inputSchema.parse(input);
      await definition.execute(validated, context);
    },
  };
}

export const actionDefinitions = [
  defineAction({
    id: "navigate",
    displayName: "Navigate to URL",
    editor: { kind: "navigate" },
    inputSchema: navigateStepSchema,
    async execute(step, { browser, target, timeoutMs }) {
      const resolved = new URL(step.url, target.baseUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) {
        throw new Error("Navigation URL must use http or https");
      }
      const allowed = new Set([new URL(target.baseUrl).origin, ...(target.allowedOrigins ?? []).map((origin) => new URL(origin).origin)]);
      if (!allowed.has(resolved.origin)) {
        throw new Error(`Navigation origin ${resolved.origin} is not in the target's allowedOrigins`);
      }
      await browser.navigate(resolved.toString(), timeoutMs);
    },
  }),
  defineAction({
    id: "fill",
    displayName: "Fill field",
    editor: { kind: "targetWithValue" },
    inputSchema: fillStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.fill(step.target, step.value.value, timeoutMs),
  }),
  defineAction({
    id: "click",
    displayName: "Click element",
    editor: { kind: "target" },
    inputSchema: clickStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.click(step.target, timeoutMs),
  }),
  defineAction({
    id: "assertVisible",
    displayName: "Assert visible",
    editor: { kind: "target" },
    inputSchema: assertVisibleStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.assertVisible(step.target, timeoutMs),
  }),
  defineAction({
    id: "assertText",
    displayName: "Assert text",
    editor: { kind: "targetWithText" },
    inputSchema: assertTextStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.assertText(step.target, step.text, timeoutMs),
  }),
] as const;

export const actionRegistry = new Map(actionDefinitions.map((definition) => [definition.id, definition]));
export const actionIds = new Set<string>(actionDefinitions.map((definition) => definition.id));

/** Small, stable discovery contract for clients that author versioned definitions. */
export const actionCatalog = actionDefinitions.map(({ id, displayName, editor }) => ({ id, displayName, editor }));

export async function executeAction(step: TestStep, context: ActionContext): Promise<void> {
  const definition = actionRegistry.get(step.action);
  if (!definition) throw new Error(`No handler registered for action "${step.action}"`);
  await definition.execute(step, context);
}
