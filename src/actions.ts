import { z } from "zod";
import type { BrowserPort } from "./browser/port.js";
import {
  assertTextStepSchema,
  assertVisibleStepSchema,
  clickStepSchema,
  fillStepSchema,
  navigateStepSchema,
  type TargetDefinition,
  type TestStep,
} from "./definition.js";

export interface ActionContext {
  browser: BrowserPort;
  target: TargetDefinition;
  timeoutMs: number;
}

interface ActionDefinition<K extends TestStep["action"]> {
  id: K;
  displayName: string;
  inputSchema: z.ZodType<Extract<TestStep, { action: K }>>;
  execute(step: Extract<TestStep, { action: K }>, context: ActionContext): Promise<void>;
}

interface RegisteredAction {
  id: TestStep["action"];
  displayName: string;
  execute(input: unknown, context: ActionContext): Promise<void>;
}

function defineAction<K extends TestStep["action"]>(
  definition: ActionDefinition<K>,
): RegisteredAction {
  return {
    id: definition.id,
    displayName: definition.displayName,
    async execute(input, context) {
      const validated = definition.inputSchema.parse(input);
      await definition.execute(validated, context);
    },
  };
}

const definitions = [
  defineAction({
    id: "navigate",
    displayName: "Navigate to URL",
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
    inputSchema: fillStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.fill(step.target, step.value.value, timeoutMs),
  }),
  defineAction({
    id: "click",
    displayName: "Click element",
    inputSchema: clickStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.click(step.target, timeoutMs),
  }),
  defineAction({
    id: "assertVisible",
    displayName: "Assert visible",
    inputSchema: assertVisibleStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.assertVisible(step.target, timeoutMs),
  }),
  defineAction({
    id: "assertText",
    displayName: "Assert text",
    inputSchema: assertTextStepSchema,
    execute: (step, { browser, timeoutMs }) => browser.assertText(step.target, step.text, timeoutMs),
  }),
] as const;

export const actionRegistry = new Map(definitions.map((definition) => [definition.id, definition]));

/** Small, stable discovery contract for clients that author versioned definitions. */
export const actionCatalog = definitions.map(({ id, displayName }) => ({ id, displayName }));

export async function executeAction(step: TestStep, context: ActionContext): Promise<void> {
  const definition = actionRegistry.get(step.action);
  if (!definition) throw new Error(`No handler registered for action "${step.action}"`);
  await definition.execute(step, context);
}
