import { createInterface } from "node:readline";
import { launchInspectionBrowser } from "../browser/playwright-adapter.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { inspectionRequestSchema, inspectedElementSchema, inspectionCommandSchema, type InspectionWorkerMessage } from "./protocol.js";

const send = (message: InspectionWorkerMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let accepted = false;
let stopping = false;
let sessionId = "";
let browser: Awaited<ReturnType<typeof launchInspectionBrowser>> | undefined;

input.on("line", async (line) => {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { process.exitCode = 2; input.close(); return; }
  if (!accepted) {
    accepted = true;
    try {
      const request = inspectionRequestSchema.parse(raw);
      sessionId = request.sessionId;
      browser = await launchInspectionBrowser(request.targetUrl, request.browserMode);
      await browser.navigate(request.targetUrl);
      send({ type: "INSPECTION_STARTED", protocolVersion: PROTOCOL_VERSION, sessionId });
      await browser.waitForSelection((element) => {
        const parsed = inspectedElementSchema.parse(element);
        send({ type: "ELEMENT_SELECTED", protocolVersion: PROTOCOL_VERSION, sessionId, element: parsed });
      });
    } catch (error) {
      send({ type: "INSPECTION_ERROR", protocolVersion: PROTOCOL_VERSION, sessionId, message: error instanceof Error ? error.message : String(error) });
      await browser?.close().catch(() => undefined);
      process.exitCode = 1;
    }
    return;
  }
  try {
    const command = inspectionCommandSchema.parse(raw);
    if (command.sessionId !== sessionId) throw new Error("Inspection command session ID did not match");
    stopping = true;
    await browser?.close();
    browser = undefined;
    send({ type: "INSPECTION_STOPPED", protocolVersion: PROTOCOL_VERSION, sessionId });
    input.close();
  } catch (error) {
    send({ type: "INSPECTION_ERROR", protocolVersion: PROTOCOL_VERSION, sessionId, message: error instanceof Error ? error.message : String(error) });
  }
});

input.on("close", () => {
  if (!accepted) process.exitCode = 2;
  if (!stopping && browser) void browser.close();
});
process.once("SIGTERM", () => { void browser?.close().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void browser?.close().finally(() => process.exit(0)); });
