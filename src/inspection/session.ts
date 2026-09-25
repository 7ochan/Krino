import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetSchema } from "../definition.js";
import type { BrowserMode } from "../browser/port.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { NotFoundError } from "../application/errors.js";
import { inspectionWorkerMessageSchema, type InspectedElement, type InspectionWorkerMessage } from "./protocol.js";

export type InspectionStatus = "starting" | "running" | "stopped" | "error";
export interface InspectionSessionSnapshot {
  id: string;
  targetUrl: string;
  browserMode: BrowserMode;
  status: InspectionStatus;
  createdAt: string;
  selectedElement?: InspectedElement;
  error?: string;
}

class InspectionSession {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  status: InspectionStatus = "starting";
  selectedElement?: InspectedElement;
  error?: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolveReady, rejectReady) => { this.readyResolve = resolveReady; this.readyReject = rejectReady; });
  private stopping = false;
  private startupTimer: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;
  private expiryTimer: NodeJS.Timeout;

  constructor(readonly targetUrl: string, readonly browserMode: BrowserMode, workerPath: string, private readonly onUpdate: () => void) {
    this.child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.on("error", (error) => this.fail(`Could not start inspection worker: ${error.message}`));
    this.child.on("close", (code, signal) => {
      clearTimeout(this.startupTimer); clearTimeout(this.stopTimer); clearTimeout(this.expiryTimer);
      if (!this.stopping && this.status !== "error") this.fail(`Inspection worker exited unexpectedly (code ${String(code)}, signal ${String(signal)})`);
      if (this.stopping) this.status = "stopped";
      this.onUpdate();
    });
    this.startupTimer = setTimeout(() => this.fail("Inspection worker did not start within 30 seconds"), 30_000);
    this.startupTimer.unref();
    // Long sessions are allowed. The idle limit protects against abandoned windows.
    this.expiryTimer = setTimeout(() => { void this.stop(); }, 60 * 60 * 1000);
    this.expiryTimer.unref();
    this.child.stdin.write(`${JSON.stringify({ type: "INSPECT_REQUEST", protocolVersion: PROTOCOL_VERSION, sessionId: this.id, targetUrl, browserMode })}\n`);
  }

  async waitUntilStarted(): Promise<void> { await this.ready; }

  snapshot(): InspectionSessionSnapshot {
    return { id: this.id, targetUrl: this.targetUrl, browserMode: this.browserMode, status: this.status, createdAt: this.createdAt,
      ...(this.selectedElement ? { selectedElement: this.selectedElement } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  stop(): Promise<void> {
    if (this.status === "stopped") return Promise.resolve();
    if (this.child.exitCode !== null) { this.status = "stopped"; return Promise.resolve(); }
    this.stopping = true;
    if (this.status === "error") {
      this.child.kill("SIGTERM");
      return new Promise((resolveStop) => {
        const timeout = setTimeout(() => { this.child.kill("SIGKILL"); resolveStop(); }, 5_000);
        timeout.unref();
        this.child.once("close", () => { clearTimeout(timeout); resolveStop(); });
      });
    }
    this.child.stdin.write(`${JSON.stringify({ type: "STOP_INSPECTION", protocolVersion: PROTOCOL_VERSION, sessionId: this.id })}\n`);
    return new Promise((resolveStop) => {
      this.stopTimer = setTimeout(() => { this.child.kill("SIGTERM"); setTimeout(() => this.child.kill("SIGKILL"), 1_000).unref(); resolveStop(); }, 5_000);
      this.stopTimer.unref();
      this.child.once("close", () => resolveStop());
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      try {
        const message: InspectionWorkerMessage = inspectionWorkerMessageSchema.parse(JSON.parse(line));
        if (message.sessionId !== this.id) throw new Error("Inspection worker session ID did not match");
        if (message.type === "INSPECTION_STARTED") {
          clearTimeout(this.startupTimer); this.status = "running"; this.readyResolve(); this.onUpdate();
        } else if (message.type === "ELEMENT_SELECTED") {
          this.selectedElement = message.element; this.onUpdate();
        } else if (message.type === "INSPECTION_ERROR") {
          this.fail(message.message);
        } else if (message.type === "INSPECTION_STOPPED") {
          this.status = "stopped"; this.onUpdate();
        }
      } catch (error) {
        this.fail(`Invalid inspection worker message: ${error instanceof Error ? error.message : String(error)}`);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private fail(message: string): void {
    if (this.status === "error") return;
    clearTimeout(this.startupTimer);
    this.status = "error"; this.error = message;
    this.readyReject(new Error(message));
    this.child.kill("SIGTERM");
    this.onUpdate();
  }
}

export interface StartInspectionInput { targetUrl: string; browserMode: BrowserMode }
export class InspectionService {
  private readonly sessions = new Map<string, InspectionSession>();
  private readonly workerPath: string;
  constructor(workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "worker.js")) { this.workerPath = workerPath; }

  async start(input: StartInspectionInput): Promise<InspectionSessionSnapshot> {
    const target = targetSchema.parse({ baseUrl: input.targetUrl });
    const targetUrl = new URL(target.baseUrl).toString();
    const session = new InspectionSession(targetUrl, input.browserMode, this.workerPath, () => undefined);
    this.sessions.set(session.id, session);
    try { await session.waitUntilStarted(); return session.snapshot(); }
    catch (error) { this.sessions.delete(session.id); await session.stop(); throw error; }
  }

  get(id: string): InspectionSessionSnapshot {
    const session = this.sessions.get(id); if (!session) throw new NotFoundError(`Inspection "${id}" was not found`); return session.snapshot();
  }

  async stop(id: string): Promise<InspectionSessionSnapshot> {
    const session = this.sessions.get(id); if (!session) throw new NotFoundError(`Inspection "${id}" was not found`);
    await session.stop(); return session.snapshot();
  }

  async close(): Promise<void> { await Promise.all([...this.sessions.values()].map((session) => session.stop())); this.sessions.clear(); }
}
