import type { ImportFinding, StayProperty, TravelCatalog } from "@/lib/catalog/travel/schema";

import type { ApprovalLedger } from "./types";

/**
 * Identity and a missing stay base block approval and cannot be overridden.
 * Serious quality can be overridden with an audit. Missing details, including
 * an unresolved airline or a Krabi airport that does not choose a stay base,
 * do not block approval. Catalog-wide notes have no source id and do not
 * block one property.
 */
export type FindingClass =
  | "blocking_identity"
  | "blocking_geography"
  | "blocking_quality"
  | "missing_detail";

const IDENTITY_FIELDS = new Set(["listing", "property_location"]);
const GEOGRAPHY_FIELDS = new Set(["stay_base"]);
const QUALITY_FIELDS = new Set(["quality_review"]);

export function findingClass(finding: ImportFinding): FindingClass {
  if (IDENTITY_FIELDS.has(finding.field)) {
    return "blocking_identity";
  }
  if (GEOGRAPHY_FIELDS.has(finding.field)) {
    return "blocking_geography";
  }
  if (QUALITY_FIELDS.has(finding.field)) {
    return "blocking_quality";
  }
  return "missing_detail";
}

export function unresolvedIdentityOrGeography(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  property: StayProperty,
): boolean {
  return indexedPropertyFindings(catalog, property).some(({ finding, index }) => {
    const classification = findingClass(finding);
    if (classification !== "blocking_identity" && classification !== "blocking_geography") {
      return false;
    }
    return !ledger.resolutions.some((resolution) => resolution.findingIndex === index);
  });
}

export function indexedPropertyFindings(
  catalog: TravelCatalog,
  property: StayProperty,
): { finding: ImportFinding; index: number }[] {
  return catalog.findings.flatMap((finding, index) => {
    if (finding.sourceId === null || !property.sourceIds.includes(finding.sourceId)) {
      return [];
    }
    return [{ finding, index }];
  });
}
