import { z } from "zod";
import { browserModeSchema, PROTOCOL_VERSION } from "../protocol.js";

const candidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1), name: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("label"), value: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("text"), value: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("testId"), value: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("css"), value: z.string().min(1) }).strict(),
]);

export const inspectedElementSchema = z.object({
  schemaVersion: z.literal(1), tagName: z.string().min(1), text: z.string().optional(), role: z.string().optional(),
  accessibleName: z.string().optional(), label: z.string().optional(), placeholder: z.string().optional(), testId: z.string().optional(),
  name: z.string().optional(), id: z.string().optional(), type: z.string().optional(), href: z.string().url().optional(),
  cssSelector: z.string().min(1), locatorCandidates: z.array(candidateSchema),
}).strict();
export type InspectedElement = z.infer<typeof inspectedElementSchema>;

export const inspectionRequestSchema = z.object({
  type: z.literal("INSPECT_REQUEST"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1), targetUrl: z.string().url(), browserMode: browserModeSchema,
}).strict();
export const inspectionCommandSchema = z.object({ type: z.literal("STOP_INSPECTION"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1) }).strict();
export type InspectionWorkerMessage =
  | { type: "INSPECTION_STARTED"; protocolVersion: 1; sessionId: string }
  | { type: "ELEMENT_SELECTED"; protocolVersion: 1; sessionId: string; element: InspectedElement }
  | { type: "INSPECTION_ERROR"; protocolVersion: 1; sessionId: string; message: string }
  | { type: "INSPECTION_STOPPED"; protocolVersion: 1; sessionId: string };

export const inspectionWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INSPECTION_STARTED"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("ELEMENT_SELECTED"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1), element: inspectedElementSchema }).strict(),
  z.object({ type: z.literal("INSPECTION_ERROR"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1), message: z.string() }).strict(),
  z.object({ type: z.literal("INSPECTION_STOPPED"), protocolVersion: z.literal(PROTOCOL_VERSION), sessionId: z.string().min(1) }).strict(),
]);
