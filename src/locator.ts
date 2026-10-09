import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
export const locatorRoleSchema = z.enum(["button", "heading", "link", "textbox"]);

const roleLocator = z.object({
  strategy: z.literal("role"),
  role: locatorRoleSchema,
  name: nonEmpty,
  exact: z.boolean().optional(),
}).strict();

const labelLocator = z.object({ strategy: z.literal("label"), value: nonEmpty, exact: z.boolean().optional() }).strict();
const textLocator = z.object({ strategy: z.literal("text"), value: nonEmpty, exact: z.boolean().optional() }).strict();
const testIdLocator = z.object({ strategy: z.literal("testId"), value: nonEmpty }).strict();
const cssLocator = z.object({ strategy: z.literal("css"), value: nonEmpty }).strict();

/** Serializable locator used by test definitions and interpreted only by the browser adapter. */
export const locatorSchema = z.discriminatedUnion("strategy", [roleLocator, labelLocator, textLocator, testIdLocator, cssLocator]);
export type LocatorDescriptor = z.infer<typeof locatorSchema>;

export const locatorProvenanceSchema = z.enum(["authored", "recorded", "suggested"]);
export type LocatorProvenance = z.infer<typeof locatorProvenanceSchema>;

/** An ordered, inspectable locator option. V1 execution always uses one primary descriptor only. */
export const locatorCandidateSchema = z.discriminatedUnion("strategy", [
  roleLocator.extend({ provenance: locatorProvenanceSchema.optional() }),
  labelLocator.extend({ provenance: locatorProvenanceSchema.optional() }),
  textLocator.extend({ provenance: locatorProvenanceSchema.optional() }),
  testIdLocator.extend({ provenance: locatorProvenanceSchema.optional() }),
  cssLocator.extend({ provenance: locatorProvenanceSchema.optional() }),
]);
export type LocatorCandidate = z.infer<typeof locatorCandidateSchema>;

/** Deterministic Recorder bridge: the first ordered candidate becomes the primary test locator. */
export function primaryLocatorFromCandidate(candidate: LocatorCandidate): LocatorDescriptor {
  const parsed = locatorCandidateSchema.parse(candidate);
  const { provenance: _provenance, ...locator } = parsed;
  return locator;
}

export function primaryLocatorFromCandidates(candidates: readonly LocatorCandidate[]): LocatorDescriptor {
  const first = candidates[0];
  if (!first) throw new Error("At least one locator candidate is required");
  return primaryLocatorFromCandidate(first);
}
