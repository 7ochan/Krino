import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type ActionDescriptor, type Definition, type Locator, type RunRecord, type Step, type TestRecord, type TestSummary } from "./api";
import "./style.css";
import "./editor.css";

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "An unexpected error occurred."; }
function date(value: string | null): string { return value ? new Date(value).toLocaleString() : "—"; }
function duration(value: number | null): string { return value == null ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`; }
function Status({ value }: { value: string }) { return <span className={`status status-${value.toLowerCase()}`}>{value.toUpperCase()}</span>; }

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell"><header className="topbar"><Link className="brand" to="/tests"><span className="brand-mark">K</span><span>Krino</span></Link><span className="local-label"><i /> Local workspace</span></header><div className="layout"><aside className="sidebar"><div className="side-label">WORKSPACE</div><Link className="nav-link active" to="/tests">▦ <span>Tests</span></Link><div className="side-note">Local runs · Chromium</div></aside><main>{children}</main></div></div>;
}
function PageTitle({ eyebrow, title, children }: { eyebrow?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="page-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1></div>{children && <div>{children}</div>}</div>;
}
function InlineError({ children }: { children: string }) { return <div className="error-box" role="alert">{children}</div>; }

export function TestList() {
  const [tests, setTests] = useState<TestSummary[]>([]); const [latest, setLatest] = useState<Record<string, RunRecord | undefined>>({});
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [running, setRunning] = useState(""); const navigate = useNavigate();
  const refresh = async () => { setLoading(true); setError(""); try { const result = await api.getTests(); setTests(result); const histories = await Promise.all(result.map(async (test) => [test.id, (await api.getTestRuns(test.id))[0]] as const)); setLatest(Object.fromEntries(histories)); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); }, []);
  const run = async (id: string) => { setRunning(id); setError(""); try { const result = await api.runTest(id); await refresh(); navigate(`/runs/${result.id}`); } catch (e) { setError(errorMessage(e)); setRunning(""); } };
  return <Shell><div className="content"><PageTitle eyebrow="WORKSPACE" title="Tests"><Link className="button primary" to="/tests/new">＋ Create test</Link></PageTitle>
    {error && <InlineError>{error}</InlineError>}
    {loading ? <div className="panel muted">Loading tests…</div> : tests.length === 0 ? <div className="empty panel"><div className="empty-icon">＋</div><h2>No tests yet</h2><p>Create a test definition and run it against your local application.</p><Link className="button primary" to="/tests/new">Create your first test</Link></div> : <div className="panel table-panel"><div className="table-heading"><span>Test</span><span>Last run</span><span>Updated</span><span>Actions</span></div>{tests.map((test) => <div className="test-row" key={test.id}><div className="test-identity"><span className="test-glyph">▤</span><div><strong>{test.name}</strong><code>{test.id}</code></div></div><div className="last-run">{latest[test.id] ? <><Status value={latest[test.id]!.status} /><span>{date(latest[test.id]!.startedAt)}</span></> : <span className="muted">Never run</span>}</div><div className="muted">{date(test.updatedAt)}</div><div className="row-actions"><Link className="button small" to={`/tests/${encodeURIComponent(test.id)}/edit`}>Edit</Link><button className="button small run-button" disabled={running === test.id} onClick={() => void run(test.id)}>{running === test.id ? "Running…" : "▶ Run"}</button></div></div>)}</div>}
  </div></Shell>;
}

const blankDefinition = (): Definition => ({ schemaVersion: 1, id: "", name: "", target: { baseUrl: "http://127.0.0.1:4173", stepTimeoutMs: 10000, runTimeoutMs: 300000 }, steps: [{ id: "navigate", action: "navigate", url: "/" }] });
function makeStep(action: Step["action"], index: number): Step {
  const id = `${action}-${index + 1}`;
  if (action === "navigate") return { id, action, url: "/" };
  const target: Locator = { strategy: "role", role: "button", name: "" };
  if (action === "fill") return { id, action, target, value: { kind: "literal", value: "" } };
  if (action === "assertText") return { id, action, target, text: "" };
  return { id, action, target };
}
const actionNames: Record<Step["action"], string> = { navigate: "Navigate", fill: "Fill", click: "Click", assertVisible: "Assert visible", assertText: "Assert text" };
const roles = ["button", "heading", "link", "textbox"] as const;

function LocatorFields({ locator, onChange }: { locator: Locator; onChange: (value: Locator) => void }) {
  const change = (key: string, value: string | boolean) => onChange({ ...locator, [key]: value } as Locator);
  return <div className="locator-fields"><label>Locator strategy<select value={locator.strategy} onChange={(e) => { const selected = e.target.value; if (selected === "role") onChange({ strategy: "role", role: "button", name: "" }); else if (selected === "label" || selected === "text") onChange({ strategy: selected, value: "" }); else if (selected === "testId" || selected === "css") onChange({ strategy: selected, value: "" }); }}><option value="role">Role</option><option value="label">Label</option><option value="text">Text</option><option value="testId">Test ID</option><option value="css">CSS</option></select></label>
    {locator.strategy === "role" ? <><label>Role<select value={locator.role} onChange={(e) => change("role", e.target.value)}>{roles.map((role) => <option key={role}>{role}</option>)}</select></label><label>Accessible name<input value={locator.name} onChange={(e) => change("name", e.target.value)} placeholder="e.g. Sign in" /></label><label className="check-field"><input type="checkbox" checked={locator.exact ?? false} onChange={(e) => change("exact", e.target.checked)} /> Exact match</label></> : <><label className="wide">{locator.strategy === "label" ? "Label" : locator.strategy === "text" ? "Text" : locator.strategy === "testId" ? "Test ID" : "CSS selector"}<input value={locator.value} onChange={(e) => change("value", e.target.value)} placeholder={locator.strategy === "css" ? "button.primary" : "Value"} /></label>{"exact" in locator && <label className="check-field"><input type="checkbox" checked={locator.exact ?? false} onChange={(e) => change("exact", e.target.checked)} /> Exact match</label>}</>}
  </div>;
}
function StepCard({ step, index, count, actions, onChange, onRemove, onMove }: { step: Step; index: number; count: number; actions: ActionDescriptor[]; onChange: (step: Step) => void; onRemove: () => void; onMove: (direction: -1 | 1) => void }) {
  const target = "target" in step ? step.target : undefined;
  const setTarget = (value: Locator) => onChange({ ...step, target: value } as Step);
  return <section className="step-card"><div className="step-head"><span className="step-number">{String(index + 1).padStart(2, "0")}</span><label className="step-action">Action<select aria-label={`Step ${index + 1} action`} value={step.action} onChange={(e) => onChange(makeStep(e.target.value as Step["action"], index))}>{actions.map((action) => <option key={action.id} value={action.id}>{action.displayName}</option>)}</select></label><label className="step-id">Step ID<input aria-label={`Step ${index + 1} ID`} value={step.id} onChange={(e) => onChange({ ...step, id: e.target.value } as Step)} /></label><div className="step-controls"><button className="icon-button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button><button className="icon-button" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>↓</button><button className="icon-button remove" title="Remove step" onClick={onRemove}>×</button></div></div>
    <div className="step-fields">{step.action === "navigate" ? <label className="wide">URL or path<input value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value })} placeholder="/login" /></label> : <>{target && <LocatorFields locator={target} onChange={setTarget} />}{step.action === "fill" && <label className="wide">Literal value<input value={step.value.value} onChange={(e) => onChange({ ...step, value: { kind: "literal", value: e.target.value } })} /></label>}{step.action === "assertText" && <label className="wide">Expected text<input value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} /></label>}</>}</div>
  </section>;
}

export function Editor() {
  const { id } = useParams(); const isNew = !id; const navigate = useNavigate();
  const [definition, setDefinition] = useState<Definition>(blankDefinition); const [loading, setLoading] = useState(!isNew); const [saving, setSaving] = useState(false); const [running, setRunning] = useState(false); const [browserMode, setBrowserMode] = useState<"headless" | "headed">("headless"); const [error, setError] = useState(""); const [history, setHistory] = useState<RunRecord[]>([]); const [actions, setActions] = useState<ActionDescriptor[]>(Object.entries(actionNames).map(([id, displayName]) => ({ id: id as Step["action"], displayName })));
  useEffect(() => { void api.getActions().then(setActions).catch(() => {}); if (id) void Promise.all([api.getTest(id), api.getTestRuns(id)]).then(([test, runs]) => { setDefinition(test.definition); setHistory(runs); }).catch((e) => setError(errorMessage(e))).finally(() => setLoading(false)); }, [id]);
  const update = (changes: Partial<Definition>) => setDefinition((current) => ({ ...current, ...changes }));
  const setSteps = (steps: Step[]) => update({ steps });
  const save = async (): Promise<TestRecord | undefined> => {
    setSaving(true); setError("");
    try { const next = { ...definition, id: definition.id.trim() || definition.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }; const saved = isNew ? await api.createTest(next) : await api.updateTest(id!, next); setDefinition(saved.definition); return saved; }
    catch (e) { setError(errorMessage(e)); return undefined; } finally { setSaving(false); }
  };
  const saveTest = async () => { const saved = await save(); if (saved) navigate(`/tests/${encodeURIComponent(saved.id)}/edit`, { replace: isNew }); };
  const run = async () => { const saved = await save(); if (!saved) return; setRunning(true); setError(""); try { const result = await api.runTest(saved.id, browserMode); navigate(`/runs/${result.id}`); } catch (e) { setError(errorMessage(e)); setRunning(false); } };
  const remove = async () => { if (!id || !window.confirm("Delete this test? Its existing run history will be retained.")) return; try { await api.deleteTest(id); navigate("/tests"); } catch (e) { setError(errorMessage(e)); } };
  if (loading) return <Shell><div className="content"><div className="panel muted">Loading test…</div></div></Shell>;
  return <Shell><div className="content editor-content"><PageTitle eyebrow={<Link to="/tests">Tests</Link>} title={isNew ? "Create test" : "Edit test"}><Link className="button" to="/tests">← All tests</Link></PageTitle>
    {error && <InlineError>{error}</InlineError>}
    <div className="editor-layout"><div className="editor-main"><section className="panel form-panel"><div className="section-heading"><div><h2>Test definition</h2><p>Versioned test definition · API validated</p></div><span className="version-badge">v1</span></div><div className="form-grid"><label>Test name<input required value={definition.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. User can sign in" /></label><label>Test ID<input value={definition.id} onChange={(e) => update({ id: e.target.value })} placeholder="Generated from name" disabled={!isNew} /></label><label className="span-2">Target base URL<input required value={definition.target.baseUrl} onChange={(e) => update({ target: { ...definition.target, baseUrl: e.target.value } })} placeholder="http://127.0.0.1:4173" /></label><label className="span-2">Allowed origins (optional, one URL per line)<textarea rows={2} value={(definition.target.allowedOrigins ?? []).join("\n")} onChange={(e) => { const origins = e.target.value.split("\n").map((origin) => origin.trim()).filter(Boolean); const target = { ...definition.target }; if (origins.length) target.allowedOrigins = origins; else delete target.allowedOrigins; update({ target }); }} placeholder="https://auth.local.test" /></label><label>Step timeout (ms)<input type="number" min="100" max="120000" value={definition.target.stepTimeoutMs ?? 10000} onChange={(e) => update({ target: { ...definition.target, stepTimeoutMs: Number(e.target.value) } })} /></label><label>Run timeout (ms)<input type="number" min="1000" max="600000" value={definition.target.runTimeoutMs ?? 300000} onChange={(e) => update({ target: { ...definition.target, runTimeoutMs: Number(e.target.value) } })} /></label></div></section>
      <div className="steps-title"><div><h2>Steps</h2><p>Actions run in this order.</p></div><span>{definition.steps.length} step{definition.steps.length === 1 ? "" : "s"}</span></div>
      <div className="steps-list">{definition.steps.map((step, index) => <StepCard key={`${step.id}-${index}`} step={step} index={index} count={definition.steps.length} actions={actions} onChange={(next) => setSteps(definition.steps.map((item, i) => i === index ? next : item))} onRemove={() => setSteps(definition.steps.filter((_, i) => i !== index))} onMove={(direction) => { const next = [...definition.steps]; const dest = index + direction; [next[index], next[dest]] = [next[dest]!, next[index]!]; setSteps(next); }} />)}</div>
      <div className="add-step"><label htmlFor="add-action">Add an action</label><select id="add-action" defaultValue="navigate">{actions.map((action) => <option key={action.id} value={action.id}>{action.displayName}</option>)}</select><button className="button" onClick={() => { const select = document.querySelector<HTMLSelectElement>("#add-action"); if (select) setSteps([...definition.steps, makeStep(select.value as Step["action"], definition.steps.length)]); }}>＋ Add step</button></div>
      <div className="editor-footer"><div>{!isNew && <button className="button danger-text" onClick={() => void remove()}>Delete test</button>}</div><div className="footer-actions"><label className="browser-mode-control">Browser mode<select aria-label="Browser mode" value={browserMode} onChange={(event) => setBrowserMode(event.target.value as "headless" | "headed")} disabled={saving || running}><option value="headless">Headless</option><option value="headed">Visible</option></select>{browserMode === "headed" && <small>A Chromium window will open on this desktop.</small>}</label><Link className="button" to="/tests">Cancel</Link><button className="button" disabled={saving || running} onClick={() => void saveTest()}>{saving ? "Saving…" : "Save test"}</button><button className="button primary" disabled={saving || running} onClick={() => void run()}>{running ? browserMode === "headed" ? "Opening visible browser…" : "Running…" : "▶ Save & run"}</button></div></div>
      </div>
      {!isNew && <aside className="history-column"><section className="panel history-panel"><div className="section-heading"><div><h2>Run history</h2><p>Most recent runs</p></div><span className="history-count">{history.length}</span></div>{history.length === 0 ? <p className="muted">No runs yet.</p> : history.map((run) => <Link className="history-item" key={run.id} to={`/runs/${run.id}`}><div><Status value={run.status} /><span>{duration(run.durationMs)}</span></div><time>{date(run.startedAt)}</time><code>{run.id.slice(0, 8)}</code></Link>)}</section></aside>}
    </div>
  </div></Shell>;
}

export function RunDetail() {
  const { id = "" } = useParams(); const [run, setRun] = useState<RunRecord | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { void api.getRun(id).then(setRun).catch((e) => setError(errorMessage(e))).finally(() => setLoading(false)); }, [id]);
  if (loading) return <Shell><div className="content"><div className="panel muted">Loading run…</div></div></Shell>;
  if (!run) return <Shell><div className="content"><PageTitle title="Run unavailable" /><InlineError>{error}</InlineError><Link className="button" to="/tests">Back to tests</Link></div></Shell>;
  return <Shell><div className="content"><PageTitle eyebrow="RUN REPORT" title={run.testName}><Link className="button" to={run.testId ? `/tests/${encodeURIComponent(run.testId)}/edit` : "/tests"}>← {run.testId ? "Back to test" : "All tests"}</Link></PageTitle>
    <section className="panel run-summary"><div className="run-status-block"><span className="eyebrow">STATUS</span><Status value={run.status} /></div><div><span className="eyebrow">BROWSER MODE</span><strong>{run.browserMode === "headed" ? "Visible" : "Headless"}</strong></div><div><span className="eyebrow">STARTED</span><strong>{date(run.startedAt)}</strong></div><div><span className="eyebrow">DURATION</span><strong>{duration(run.durationMs)}</strong></div><div><span className="eyebrow">TEST ID</span><code>{run.definition.id}</code></div></section>
    {run.error && <div className="error-box run-error"><strong>{run.error.name}</strong><p>{run.error.message}</p></div>}
    <section className="panel results-panel"><div className="section-heading"><div><h2>Step results</h2><p>Execution order from the saved definition</p></div><span>{run.steps.length} completed</span></div>{run.definition.steps.map((step, i) => { const result = run.steps.find((entry) => entry.stepId === step.id); const incomplete = run.incompleteSteps?.find((entry) => entry.stepId === step.id); const status = result?.status ?? (incomplete ? "running" : "skipped"); return <div className={`result-row ${status}`} key={`${step.id}-${i}`}><span className="result-index">{String(i + 1).padStart(2, "0")}</span><div className="result-main"><div><strong>{actionNames[step.action]}</strong><code>{step.id}</code></div>{step.action === "navigate" ? <span className="result-detail">{step.url}</span> : <span className="result-detail">{"target" in step ? locatorSummary(step.target) : ""}</span>}{result?.error && <div className="step-error"><strong>{result.error.name}</strong>: {result.error.message}</div>}</div><span className="result-time">{result ? duration(result.durationMs) : "—"}</span><Status value={status} /></div>; })}</section>
    <div className="detail-grid"><section className="panel"><div className="section-heading"><div><h2>Definition snapshot</h2><p>Definition used for this run</p></div></div><div className="snapshot"><p><span>Name</span>{run.definition.name}</p><p><span>Target</span><code>{run.definition.target.baseUrl}</code></p><p><span>Steps</span>{run.definition.steps.length}</p></div></section><section className="panel"><div className="section-heading"><div><h2>Artifacts</h2><p>Metadata only; files remain in local run storage</p></div></div>{run.artifacts.map((artifact, i) => <div className="artifact-item" key={`${artifact.type}-${i}`}><span className={`artifact-dot ${artifact.status}`} /><div><strong>{artifact.type}</strong><small>{artifact.filename ?? artifact.error ?? "No file recorded"}</small></div><span className="muted">{artifact.status}</span></div>)}</section></div>
  </div></Shell>;
}
function locatorSummary(locator: Locator): string { return locator.strategy === "role" ? `${locator.role} “${locator.name}”` : `${locator.strategy}: ${locator.value}`; }
function NotFound() { return <Shell><div className="content"><PageTitle title="Page not found" /><Link className="button" to="/tests">Go to tests</Link></div></Shell>; }

export function App() { return <BrowserRouter><Routes><Route path="/" element={<TestList />} /><Route path="/tests" element={<TestList />} /><Route path="/tests/new" element={<Editor />} /><Route path="/tests/:id/edit" element={<Editor />} /><Route path="/runs/:id" element={<RunDetail />} /><Route path="*" element={<NotFound />} /></Routes></BrowserRouter>; }

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);
