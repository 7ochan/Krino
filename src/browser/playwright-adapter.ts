import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { expect } from "playwright/test";
import type { LocatorDescriptor, TargetDefinition } from "../definition.js";
import type { BrowserPort, FailureArtifacts } from "./port.js";

const DIAGNOSTIC_TIMEOUT_MS = 10_000;

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

export async function launchPlaywrightBrowser(target: TargetDefinition): Promise<BrowserPort> {
  const browser = await chromium.launch({ headless: true, timeout: 30_000 });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const allowedOrigins = new Set([
      new URL(target.baseUrl).origin,
      ...(target.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
    ]);
    await context.route("**/*", async (route) => {
      const origin = new URL(route.request().url()).origin;
      if (allowedOrigins.has(origin)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    return new PlaywrightBrowserPort(browser, context, page);
  } catch (error) {
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}
