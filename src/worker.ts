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
    send({ type: "RUN_ERROR", protocolVersion: PROTOCOL_VERSION, runId: null, message: "Worker accepts exactly one request" });
    return;
  }
  acceptedRequest = true;
  let runId: string | null = null;
  let browser: Awaited<ReturnType<typeof launchPlaywrightBrowser>> | undefined;
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw === "object" && raw !== null && "runId" in raw && typeof raw.runId === "string") runId = raw.runId;
    const request = runRequestSchema.parse(raw);
    const definition = parseTestDefinition(request.definition);
    const activeRunId = request.runId;
    runId = activeRunId;
    send({ type: "RUN_STARTED", protocolVersion: PROTOCOL_VERSION, runId: activeRunId, testName: definition.name, browserMode: request.browserMode });
    browser = await launchPlaywrightBrowser(definition.target, request.browserMode);
    let result = await executeDefinition({
      runId: activeRunId,
      definition,
      browser,
      artifactsDirectory: request.artifactsDirectory,
      onEvent(event) {
        if (event.type === "STEP_STARTED") {
          send({ ...event, protocolVersion: PROTOCOL_VERSION, runId: activeRunId });
        } else {
          send({ ...event, protocolVersion: PROTOCOL_VERSION, runId: activeRunId });
        }
      },
    });
    try {
      await browser.close();
    } catch (error) {
      result = {
        ...result,
        status: "error",
        error: { name: "BrowserCleanupError", message: error instanceof Error ? error.message : String(error) },
      };
    }
    browser = undefined;
    send({ type: "RUN_FINISHED", protocolVersion: PROTOCOL_VERSION, runId: activeRunId, result });
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "RUN_ERROR", protocolVersion: PROTOCOL_VERSION, runId, message });
  } finally {
    input.close();
  }
});

input.on("close", () => {
  if (!acceptedRequest) process.exitCode = 2;
});
