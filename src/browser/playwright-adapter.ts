import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { expect } from "playwright/test";
import type { LocatorDescriptor, TargetDefinition } from "../definition.js";
import type { BrowserPort, FailureArtifacts } from "./port.js";
import { DEFAULT_BROWSER_MODE, type BrowserMode } from "./port.js";

const DIAGNOSTIC_TIMEOUT_MS = 10_000;
// Let visible runs unfold at a pace a person can follow; headless runs stay unpaced.
export const HEADED_SLOW_MO_MS = 400;

function toLocator(page: Page, descriptor: LocatorDescriptor): Locator {
  switch (descriptor.strategy) {
    case "role":
      return page.getByRole(descriptor.role, {
        name: descriptor.name,
        ...(descriptor.exact === undefined ? {} : { exact: descriptor.exact }),
      });
    case "label":
      return page.getByLabel(descriptor.value, descriptor.exact === undefined ? {} : { exact: descriptor.exact });
    case "text":
      return page.getByText(descriptor.value, descriptor.exact === undefined ? {} : { exact: descriptor.exact });
    case "testId":
      return page.getByTestId(descriptor.value);
    case "css":
      return page.locator(descriptor.value);
  }
}

class PlaywrightBrowserPort implements BrowserPort {
  private traceActive = true;
  private closed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async navigate(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async fill(target: LocatorDescriptor, value: string, timeoutMs: number): Promise<void> {
    await toLocator(this.page, target).fill(value, { timeout: timeoutMs });
  }

  async click(target: LocatorDescriptor, timeoutMs: number): Promise<void> {
    await toLocator(this.page, target).click({ timeout: timeoutMs });
  }

  async assertVisible(target: LocatorDescriptor, timeoutMs: number): Promise<void> {
    await expect(toLocator(this.page, target)).toBeVisible({ timeout: timeoutMs });
  }

  async assertText(target: LocatorDescriptor, text: string, timeoutMs: number): Promise<void> {
    await expect(toLocator(this.page, target)).toContainText(text, { timeout: timeoutMs });
  }

  async captureFailureArtifacts(directory: string): Promise<FailureArtifacts> {
    const screenshotPath = resolve(directory, "screenshot.png");
    const tracePath = resolve(directory, "trace.zip");
    const errors: string[] = [];
    await mkdir(directory, { recursive: true });

    try {
      await this.page.screenshot({ path: screenshotPath, fullPage: true, timeout: DIAGNOSTIC_TIMEOUT_MS });
    } catch (error) {
      errors.push(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.traceActive) {
      try {
        await this.context.tracing.stop({ path: tracePath });
      } catch (error) {
        errors.push(`Trace capture failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Do not retry a failed trace finalization in close(); that can turn a
        // captured test failure into a browser-cleanup error and mask its result.
        this.traceActive = false;
      }
    }

    return {
      ...(errors.some((error) => error.startsWith("Screenshot")) ? {} : { screenshotPath }),
      ...(errors.some((error) => error.startsWith("Trace")) ? {} : { tracePath }),
      errors,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeErrors: unknown[] = [];
    if (this.traceActive) {
      try {
        await this.context.tracing.stop();
      } catch (error) {
        closeErrors.push(error);
      }
      this.traceActive = false;
    }
    for (const resource of [this.page, this.context, this.browser]) {
      try {
        await resource.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, "One or more Playwright resources could not be closed cleanly");
    }
  }
}

export function playwrightLaunchOptions(browserMode: BrowserMode = DEFAULT_BROWSER_MODE, slowMoMs = browserMode === "headed" ? HEADED_SLOW_MO_MS : 0) {
  return {
    headless: browserMode === "headless",
    timeout: 30_000,
    ...(slowMoMs > 0 ? { slowMo: slowMoMs } : {}),
  } as const;
}

interface PlaywrightPageSession { browser: Browser; context: BrowserContext; page: Page }

async function launchPlaywrightPage(baseUrl: string, extraAllowedOrigins: string[] = [], browserMode: BrowserMode = DEFAULT_BROWSER_MODE, slowMoMs?: number): Promise<PlaywrightPageSession> {
  const browser = await chromium.launch(slowMoMs === undefined ? playwrightLaunchOptions(browserMode) : playwrightLaunchOptions(browserMode, slowMoMs));
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const allowedOrigins = new Set([
      new URL(baseUrl).origin,
      ...extraAllowedOrigins.map((origin) => new URL(origin).origin),
    ]);
    await context.route("**/*", async (route) => {
      const origin = new URL(route.request().url()).origin;
      if (allowedOrigins.has(origin)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

export async function launchPlaywrightBrowser(target: TargetDefinition, browserMode: BrowserMode = DEFAULT_BROWSER_MODE): Promise<BrowserPort> {
  const session = await launchPlaywrightPage(target.baseUrl, target.allowedOrigins, browserMode);
  try {
    await session.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    return new PlaywrightBrowserPort(session.browser, session.context, session.page);
  } catch (error) {
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    throw error;
  }
}

export interface InspectionCandidate {
  strategy: "role" | "label" | "text" | "testId" | "css";
  value?: string;
  role?: string;
  name?: string;
}

export interface InspectedElement {
  schemaVersion: 1;
  tagName: string;
  text?: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  name?: string;
  id?: string;
  type?: string;
  href?: string;
  cssSelector: string;
  locatorCandidates: InspectionCandidate[];
}

export interface InspectionBrowser {
  navigate(url: string, timeoutMs?: number): Promise<void>;
  waitForSelection(onSelection: (element: InspectedElement) => void): Promise<void>;
  close(): Promise<void>;
}

const inspectionScript = (targetOrigin: string) => {
  if (location.origin !== targetOrigin) return;
  let current: Element | null = null;
  let originalOutline = "";
  const highlight = (element: Element | null) => {
    if (current && current instanceof HTMLElement) current.style.outline = originalOutline;
    current = element;
    if (current instanceof HTMLElement) {
      originalOutline = current.style.outline;
      current.style.outline = "2px solid #2f80ed";
    }
  };
  const roleFor = (element: Element, type: string) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "select") return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["hidden", "button", "submit", "reset", "image"].includes(type)) return undefined;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return undefined;
  };
  const capture = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    const input = element as HTMLInputElement;
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
    const type = input.type || "";
    const labels = "labels" in input && input.labels ? [...input.labels].map((label) => label.innerText.trim()).filter(Boolean) : [];
    const label = element.getAttribute("aria-label") || labels[0];
    const accessibleName = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.innerText.trim()).filter(Boolean).join(" ") || label || element.getAttribute("placeholder") || text || undefined;
    const role = roleFor(element, type);
    const id = element.id || undefined;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-qa") || undefined;
    let cssSelector = id ? `#${CSS.escape(id)}` : "";
    if (!cssSelector) {
      const path: string[] = [];
      let node: Element | null = element;
      while (node && node !== document.body && node !== document.documentElement) {
        const nodeTag = node.tagName.toLowerCase();
        const peers = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node!.tagName) : [];
        path.unshift(peers.length > 1 ? `${nodeTag}:nth-of-type(${peers.indexOf(node) + 1})` : nodeTag);
        node = node.parentElement;
      }
      cssSelector = path.join(" > ") || tagName;
    }
    const result: Record<string, unknown> = { schemaVersion: 1, tagName, cssSelector, locatorCandidates: [] };
    if (text) result.text = text;
    if (role) result.role = role;
    if (accessibleName) result.accessibleName = accessibleName;
    if (label) result.label = label;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.placeholder) result.placeholder = element.placeholder;
      if (element.name) result.name = element.name;
      if (element.type) result.type = element.type;
    }
    if (testId) result.testId = testId;
    if (id) result.id = id;
    if (element instanceof HTMLAnchorElement && element.href) result.href = element.href;
    const candidates: Array<Record<string, string>> = result.locatorCandidates as Array<Record<string, string>>;
    if (role && accessibleName && ["button", "heading", "link", "textbox"].includes(role)) candidates.push({ strategy: "role", role, name: accessibleName });
    if (label) candidates.push({ strategy: "label", value: label });
    if (text) candidates.push({ strategy: "text", value: text });
    if (testId) candidates.push({ strategy: "testId", value: testId });
    candidates.push({ strategy: "css", value: cssSelector });
    return result;
  };
  document.addEventListener("pointerover", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (element && element !== document.documentElement && element !== document.body) highlight(element);
  }, true);
  document.addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element === document.documentElement || element === document.body) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.postMessage({ source: "krino-inspector", payload: capture(element) }, location.origin);
  }, true);
};

export async function launchInspectionBrowser(targetUrl: string, browserMode: BrowserMode = "headed"): Promise<InspectionBrowser> {
  const { browser, context, page } = await launchPlaywrightPage(targetUrl, [], browserMode, 0);
  try {
    await context.addInitScript(inspectionScript, new URL(targetUrl).origin);
    const inspection: InspectionBrowser = {
      navigate: async (url, timeoutMs = 30_000) => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }); },
      waitForSelection: async (onSelection) => {
        await page.exposeBinding("__krinoSelected", (_source, payload: unknown) => {
          // Payload originated in our fixed inspection script. Validate its JSON shape before forwarding.
          if (payload && typeof payload === "object") onSelection(payload as InspectedElement);
        });
        await page.addInitScript(() => window.addEventListener("message", (event) => {
          if (event.source === window && event.origin === location.origin && event.data?.source === "krino-inspector") {
            void (window as unknown as { __krinoSelected: (value: unknown) => Promise<void> }).__krinoSelected(event.data.payload);
          }
        }));
        // The listener also applies to the already loaded document.
        await page.evaluate(() => window.addEventListener("message", (event) => {
          if (event.source === window && event.origin === location.origin && event.data?.source === "krino-inspector") {
            void (window as unknown as { __krinoSelected: (value: unknown) => Promise<void> }).__krinoSelected(event.data.payload);
          }
        }));
      },
      close: async () => { await context?.close().catch(() => undefined); await browser.close().catch(() => undefined); },
    };
    return inspection;
  } catch (error) {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}
