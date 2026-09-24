import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { launchPlaywrightBrowser } from "./browser/playwright-adapter.js";
import { executeDefinition } from "./engine.js";
import { parseTestDefinition } from "./definition.js";
import { PROTOCOL_VERSION, runRequestSchema, type WorkerMessage } from "./protocol.js";

function send(message: WorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let acceptedRequest = false;

input.on("line", async (line) => {
  if (acceptedRequest) {
    send({ type: "RUN_ERROR", protocolVersion: PROTOCOL_VERSION, requestId: null, message: "Worker accepts exactly one request" });
    return;
  }
  acceptedRequest = true;
  let requestId: string | null = null;
  let browser: Awaited<ReturnType<typeof launchPlaywrightBrowser>> | undefined;
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw === "object" && raw !== null && "requestId" in raw && typeof raw.requestId === "string") requestId = raw.requestId;
    const request = runRequestSchema.parse(raw);
    const definition = parseTestDefinition(request.definition);
    const runId = randomUUID();
    send({ type: "RUN_STARTED", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, runId, testName: definition.name });
    browser = await launchPlaywrightBrowser(definition.target);
    const result = await executeDefinition({
      runId,
      definition,
      browser,
      artifactsDirectory: request.artifactsDirectory,
      onEvent(event) {
        if (event.type === "STEP_STARTED") {
          send({ ...event, protocolVersion: PROTOCOL_VERSION, requestId: request.requestId });
        } else {
          send({ ...event, protocolVersion: PROTOCOL_VERSION, requestId: request.requestId });
        }
      },
    });
    await browser.close();
    browser = undefined;
    send({ type: "RUN_FINISHED", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, result });
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "RUN_ERROR", protocolVersion: PROTOCOL_VERSION, requestId, message });
  } finally {
    input.close();
  }
});

input.on("close", () => {
  if (!acceptedRequest) process.exitCode = 2;
});
