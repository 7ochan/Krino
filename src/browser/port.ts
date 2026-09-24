import type { LocatorDescriptor } from "../definition.js";

export const BROWSER_MODES = ["headless", "headed"] as const;
export type BrowserMode = typeof BROWSER_MODES[number];
export const DEFAULT_BROWSER_MODE: BrowserMode = "headless";

export interface FailureArtifacts {
  screenshotPath?: string;
  tracePath?: string;
  errors: string[];
}

export interface BrowserPort {
  navigate(url: string, timeoutMs: number): Promise<void>;
  fill(target: LocatorDescriptor, value: string, timeoutMs: number): Promise<void>;
  click(target: LocatorDescriptor, timeoutMs: number): Promise<void>;
  assertVisible(target: LocatorDescriptor, timeoutMs: number): Promise<void>;
  assertText(target: LocatorDescriptor, text: string, timeoutMs: number): Promise<void>;
  captureFailureArtifacts(directory: string): Promise<FailureArtifacts>;
  close(): Promise<void>;
}
