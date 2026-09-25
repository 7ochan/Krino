import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./main";
import { api, type ActionDescriptor, type Definition, type RunRecord, type TestRecord } from "./api";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: {
  getTests: vi.fn(), getTest: vi.fn(), getTestRuns: vi.fn(), getActions: vi.fn(), createTest: vi.fn(), updateTest: vi.fn(), deleteTest: vi.fn(), runTest: vi.fn(), getRun: vi.fn(), startInspection: vi.fn(), getInspection: vi.fn(), stopInspection: vi.fn(),
} }));

const def = (name = "Login flow"): Definition => ({ schemaVersion: 1, id: "login-flow", name, target: { baseUrl: "http://127.0.0.1:4173", stepTimeoutMs: 10000, runTimeoutMs: 300000 }, steps: [{ id: "open-login", action: "navigate", url: "/login" }] });
const record = (definition = def()): TestRecord => ({ ...definition, definition, schemaVersion: 1, createdAt: "2026-09-24T08:00:00.000Z", updatedAt: "2026-09-24T08:00:00.000Z" });
const run: RunRecord = { id: "run-1", testId: "login-flow", testName: "Login flow", definition: def(), browserMode: "headless", status: "passed", startedAt: "2026-09-24T08:00:00.000Z", finishedAt: "2026-09-24T08:00:01.000Z", durationMs: 990, steps: [{ stepId: "open-login", action: "navigate", status: "passed", startTime: "2026-09-24T08:00:00.000Z", endTime: "2026-09-24T08:00:01.000Z", durationMs: 990 }], artifacts: [{ type: "result", status: "created", filename: "result.json", createdAt: "2026-09-24T08:00:01.000Z" }] };

const mocked = vi.mocked(api);
beforeEach(() => { window.history.replaceState({}, "", "/tests"); mocked.getTests.mockResolvedValue([]); mocked.getTestRuns.mockResolvedValue([]); mocked.getActions.mockResolvedValue(((["navigate", "fill", "click", "assertVisible", "assertText"].map((id) => ({ id, displayName: id }))) as ActionDescriptor[])); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Krino UI", () => {
  it("renders loading, empty, list and API error states", async () => {
    mocked.getTests.mockReturnValueOnce(new Promise(() => {}));
    render(<App />); expect(screen.getByText("Loading tests…")).toBeInTheDocument(); cleanup();
    mocked.getTests.mockResolvedValueOnce([]); render(<App />); expect(await screen.findByText("No tests yet")).toBeInTheDocument(); cleanup();
    mocked.getTests.mockResolvedValueOnce([{ id: "login-flow", name: "Login flow", schemaVersion: 1, createdAt: "2026-09-24", updatedAt: "2026-09-24" }]);
    mocked.getTestRuns.mockResolvedValueOnce([run]); render(<App />); expect(await screen.findByText("Login flow")).toBeInTheDocument(); expect(screen.getByText("PASSED")).toBeInTheDocument(); cleanup();
    mocked.getTests.mockRejectedValueOnce(new Error("API offline")); render(<App />); expect(await screen.findByRole("alert")).toHaveTextContent("API offline");
  });

  it("creates and edits a definition through the editor and surfaces validation errors", async () => {
    window.history.replaceState({}, "", "/tests/new"); const user = userEvent.setup();
    const created = record(def()); mocked.createTest.mockResolvedValue(created); mocked.updateTest.mockResolvedValue(record(def("Updated login")));
    render(<App />); await user.clear(screen.getByLabelText("Test name")); await user.type(screen.getByLabelText("Test name"), "Login flow");
    await user.clear(screen.getByLabelText("Target base URL")); await user.type(screen.getByLabelText("Target base URL"), "http://127.0.0.1:4173");
    await user.selectOptions(screen.getByLabelText("Add an action"), "fill"); await user.click(screen.getByRole("button", { name: "＋ Add step" }));
    expect(screen.getByLabelText("Step 2 action")).toHaveValue("fill");
    await user.click(screen.getByRole("button", { name: "Save test" })); await waitFor(() => expect(mocked.createTest).toHaveBeenCalled());
    expect(mocked.createTest.mock.calls[0]![0].schemaVersion).toBe(1); expect(mocked.createTest.mock.calls[0]![0].steps).toHaveLength(2);
    cleanup(); window.history.replaceState({}, "", "/tests/login-flow/edit"); mocked.getTest.mockResolvedValue(created); mocked.getTestRuns.mockResolvedValue([]); mocked.updateTest.mockRejectedValueOnce(new Error("Invalid test definition:\n- target.baseUrl: Invalid URL"));
    render(<App />); await screen.findByDisplayValue("Login flow"); await user.clear(screen.getByLabelText("Test name")); await user.type(screen.getByLabelText("Test name"), "Updated login"); await user.click(screen.getByRole("button", { name: "Save test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("target.baseUrl: Invalid URL");
  });

  it("saves, runs, and displays run status, ordered results, history and artifacts", async () => {
    window.history.replaceState({}, "", "/tests/login-flow/edit"); const user = userEvent.setup();
    mocked.getTest.mockResolvedValue(record()); mocked.getTestRuns.mockResolvedValue([run]); mocked.updateTest.mockResolvedValue(record()); mocked.runTest.mockResolvedValue(run); mocked.getRun.mockResolvedValue(run);
    render(<App />); expect(await screen.findByText("Run history")).toBeInTheDocument(); expect(screen.getByText("run-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "▶ Save & run" })); await waitFor(() => expect(mocked.runTest).toHaveBeenCalledWith("login-flow", "headless"));
    await waitFor(() => expect(mocked.getRun).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByText("Step results")).toBeInTheDocument(); expect(screen.getAllByText("PASSED")).toHaveLength(2);
    expect(screen.getByText("open-login")).toBeInTheDocument(); expect(screen.getByText("result.json")).toBeInTheDocument();
  });

  it("sends headed mode when Visible is selected and identifies it in the run report", async () => {
    window.history.replaceState({}, "", "/tests/login-flow/edit"); const user = userEvent.setup();
    const visibleRun = { ...run, browserMode: "headed" as const };
    mocked.getTest.mockResolvedValue(record()); mocked.getTestRuns.mockResolvedValue([]); mocked.updateTest.mockResolvedValue(record()); mocked.runTest.mockResolvedValue(visibleRun); mocked.getRun.mockResolvedValue(visibleRun);
    render(<App />); await screen.findByText("Run history");
    await user.selectOptions(screen.getByLabelText("Browser mode"), "headed");
    expect(screen.getByText("A Chromium window will open on this desktop.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "▶ Save & run" }));
    await waitFor(() => expect(mocked.runTest).toHaveBeenCalledWith("login-flow", "headed"));
    expect(await screen.findByText("Visible")).toBeInTheDocument();
  });

  it("shows failed run and step diagnostics", async () => {
    window.history.replaceState({}, "", "/runs/run-1"); const failed: RunRecord = { ...run, status: "failed", steps: [{ ...run.steps[0]!, status: "failed", error: { name: "AssertionError", message: "Expected heading to be visible" } }], artifacts: [{ type: "screenshot", status: "created", filename: "screenshot.png", createdAt: run.startedAt }, { type: "trace", status: "created", filename: "trace.zip", createdAt: run.startedAt }] };
    mocked.getRun.mockResolvedValue(failed); render(<App />);
    expect(await screen.findAllByText("FAILED")).toHaveLength(2); expect(screen.getByText(/Expected heading to be visible/)).toBeInTheDocument();
    expect(screen.getByText("screenshot.png")).toBeInTheDocument(); expect(screen.getByText("trace.zip")).toBeInTheDocument();
  });

  it("confirms deletion with history retention and refreshes the list", async () => {
    window.history.replaceState({}, "", "/tests/login-flow/edit"); const user = userEvent.setup();
    mocked.getTest.mockResolvedValue(record()); mocked.getTestRuns.mockResolvedValue([run]); mocked.deleteTest.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); render(<App />); await screen.findByText("Run history"); await user.click(screen.getByRole("button", { name: "Delete test" }));
    expect(confirm).toHaveBeenCalledWith("Delete this test? Its existing run history will be retained."); expect(mocked.deleteTest).toHaveBeenCalledWith("login-flow");
  });

  it("starts an inspection, displays selected element data, and stops the session", async () => {
    window.history.replaceState({}, "", "/inspector"); const user = userEvent.setup();
    const running = { id: "inspection-1", targetUrl: "http://127.0.0.1:4173/inspect", browserMode: "headed" as const, status: "running" as const, createdAt: "2026-09-25T00:00:00Z" };
    mocked.startInspection.mockResolvedValue(running);
    mocked.getInspection.mockResolvedValue({ ...running, selectedElement: { schemaVersion: 1, tagName: "input", role: "textbox", label: "Email", accessibleName: "Email", placeholder: "Enter email", testId: "email", cssSelector: "#email", locatorCandidates: [{ strategy: "label", value: "Email" }, { strategy: "role", role: "textbox", name: "Email" }, { strategy: "testId", value: "email" }, { strategy: "css", value: "#email" }] } });
    mocked.stopInspection.mockResolvedValue({ ...running, status: "stopped" });
    render(<App />); await screen.findByRole("heading", { name: "Element Inspector" });
    await user.type(screen.getByLabelText("Target URL"), "http://127.0.0.1:4173/inspect");
    await user.click(screen.getByRole("button", { name: "Start inspection" }));
    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(await screen.findByText("Selected element")).toBeInTheDocument();
    expect(screen.getByText("textbox / Email")).toBeInTheDocument();
    expect(screen.getByText("Enter email")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop inspection" }));
    await waitFor(() => expect(mocked.stopInspection).toHaveBeenCalledWith("inspection-1"));
    expect(await screen.findByText("Start an inspection")).toBeInTheDocument();
  });

  it("shows an inspector start error", async () => {
    window.history.replaceState({}, "", "/inspector"); const user = userEvent.setup();
    mocked.startInspection.mockRejectedValueOnce(new Error("Target URL must use http or https"));
    render(<App />); await screen.findByRole("heading", { name: "Element Inspector" });
    await user.type(screen.getByLabelText("Target URL"), "file:///etc/passwd");
    await user.click(screen.getByRole("button", { name: "Start inspection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Target URL must use http or https");
  });
});
