import type { LocatorDescriptor } from "../definition.js";

export interface FailureArtifacts {
  screenshotPath?: string;
  tracePath?: string;
  errors: string[];
}

export interface BrowserPort {
  navigate(url: string): Promise<void>;
  fill(target: LocatorDescriptor, value: string): Promise<void>;
  click(target: LocatorDescriptor): Promise<void>;
  assertVisible(target: LocatorDescriptor): Promise<void>;
  assertText(target: LocatorDescriptor, text: string): Promise<void>;
  captureFailureArtifacts(directory: string): Promise<FailureArtifacts>;
  close(): Promise<void>;
}
