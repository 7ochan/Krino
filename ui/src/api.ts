import { API_BASE_URL } from "./config";

export type Locator =
  | { strategy: "role"; role: "button" | "heading" | "link" | "textbox"; name: string; exact?: boolean }
  | { strategy: "label" | "text"; value: string; exact?: boolean }
  | { strategy: "testId" | "css"; value: string };
export type Step =
  | { id: string; action: "navigate"; url: string }
  | { id: string; action: "fill"; target: Locator; value: { kind: "literal"; value: string } }
  | { id: string; action: "click" | "assertVisible"; target: Locator }
  | { id: string; action: "assertText"; target: Locator; text: string };
export interface Definition {
  schemaVersion: 1;
  id: string;
  name: string;
  target: { baseUrl: string; allowedOrigins?: string[]; stepTimeoutMs?: number; runTimeoutMs?: number };
  steps: Step[];
}
export interface TestSummary { id: string; name: string; schemaVersion: number; createdAt: string; updatedAt: string }
export interface TestRecord extends TestSummary { definition: Definition }
export interface StepResult {
  stepId: string; action: Step["action"]; status: "passed" | "failed" | "skipped"; startTime: string | null;
  endTime: string | null; durationMs: number; error?: { name: string; message: string };
}
export interface Artifact { type: "screenshot" | "trace" | "result"; status: "created" | "failed"; filename?: string; createdAt: string; error?: string }
export interface RunRecord {
  id: string; testId: string | null; testName: string; definition: Definition;
  status: "running" | "passed" | "failed" | "error"; startedAt: string; finishedAt: string | null;
  durationMs: number | null; steps: StepResult[]; incompleteSteps?: Array<{ stepId: string; action: string; index: number; startTime: string }>;
  artifacts: Artifact[]; error?: { name: string; message: string };
}
export interface ActionDescriptor { id: Step["action"]; displayName: string }

interface ApiErrorPayload { error?: { message?: string; code?: string } }
export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = "ApiError"; }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } }); }
  catch (error) { throw new ApiError(`Could not reach the Krino API. ${error instanceof Error ? error.message : "Check that the local API is running."}`); }
  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try { payload = await response.json() as ApiErrorPayload; } catch { /* use HTTP fallback */ }
    throw new ApiError(payload.error?.message ?? `Krino API request failed (${response.status})`, response.status, payload.error?.code);
  }
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; }
  catch { throw new ApiError("Krino API returned an unreadable response.", response.status); }
}
export const api = {
  async getTests() { return (await request<{ tests: TestSummary[] }>("/tests")).tests; },
  createTest(definition: Definition) { return request<TestRecord>("/tests", { method: "POST", body: JSON.stringify(definition) }); },
  getTest(id: string) { return request<TestRecord>(`/tests/${encodeURIComponent(id)}`); },
  updateTest(id: string, definition: Definition) { return request<TestRecord>(`/tests/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(definition) }); },
  deleteTest(id: string) { return request<void>(`/tests/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  runTest(id: string) { return request<RunRecord>(`/tests/${encodeURIComponent(id)}/runs`, { method: "POST", body: "{}" }); },
  getRun(id: string) { return request<RunRecord>(`/runs/${encodeURIComponent(id)}`); },
  async getTestRuns(id: string) { return (await request<{ runs: RunRecord[] }>(`/tests/${encodeURIComponent(id)}/runs`)).runs; },
  async getActions() { return (await request<{ actions: ActionDescriptor[] }>("/actions")).actions; },
};
