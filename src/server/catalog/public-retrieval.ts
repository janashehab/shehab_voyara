import type { FlightTemplate, StayProperty, TravelCatalog } from "@/lib/catalog/travel/schema";
import { fingerprintFor, sameFingerprint } from "@/server/services/catalog-approval/identity";
import { findingClass, unresolvedIdentityOrGeography } from "@/server/services/catalog-approval/findings";
import type { ApprovalLedger } from "@/server/services/catalog-approval/types";

export type PublicPropertyRecord = {
  record: StayProperty;
  presentation: "approved_property";
};

export type PublicRouteTemplate = {
  record: FlightTemplate;
  presentation: "route_template";
  confirmedFlight: false;
  liveFare: false;
};

/**
 * Draft, in-review, and archived rows stay out. An approved property also
 * needs a matching active attestation, an approved country, region, and stay
 * base, and no unresolved blocking finding. Historical amounts are not read.
 */
export function listPublicTravel(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
): { properties: PublicPropertyRecord[]; flightTemplates: PublicRouteTemplate[] } {
  return {
    properties: catalog.properties.filter((property) => propertyIsPublic(catalog, ledger, property)).map((record) => ({
      record,
      presentation: "approved_property" as const,
    })),
    flightTemplates: catalog.flightTemplates
      .filter((flight) => flightIsPublic(catalog, ledger, flight))
      .map((record) => ({
        record,
        presentation: "route_template" as const,
        confirmedFlight: false as const,
        liveFare: false as const,
      })),
  };
}

function propertyIsPublic(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  property: StayProperty,
): boolean {
  if (property.approval !== "approved" || !hierarchyIsApproved(catalog, property)) {
    return false;
  }
  if (!attestationMatches(catalog, ledger, "stay_property", property.id)) {
    return false;
  }
  if (unresolvedIdentityOrGeography(catalog, ledger, property)) {
    return false;
  }
  if (property.qualityReview && !hasQualityOverride(ledger, property.id)) {
    return false;
  }
  return !hasUnresolvedBlockingFinding(catalog, ledger, property.sourceIds);
}

function flightIsPublic(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  flight: FlightTemplate,
): boolean {
  if (flight.approval !== "approved") {
    return false;
  }
  if (!attestationMatches(catalog, ledger, "flight_template", flight.id)) {
    return false;
  }
  return !hasUnresolvedBlockingFinding(catalog, ledger, [flight.sourceId]);
}

function hierarchyIsApproved(catalog: TravelCatalog, property: StayProperty): boolean {
  if (property.stayBaseId === null) {
    return false;
  }
  const country = catalog.countries.find((item) => item.id === property.countryId);
  const region = catalog.regions.find((item) => item.id === property.regionId);
  const stayBase = catalog.stayBases.find((item) => item.id === property.stayBaseId);
  return (
    country?.approval === "approved" &&
    region?.approval === "approved" &&
    region.countryId === property.countryId &&
    stayBase?.approval === "approved" &&
    stayBase.regionId === property.regionId
  );
}

function attestationMatches(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectType: "stay_property" | "flight_template",
  subjectId: string,
): boolean {
  const current = fingerprintFor(catalog, subjectType, subjectId);
  if (!current) {
    return false;
  }
  return ledger.attestations.some(
    (attestation) =>
      attestation.status === "active" &&
      attestation.subjectType === subjectType &&
      attestation.subjectId === subjectId &&
      sameFingerprint(attestation.fingerprint, current),
  );
}

function hasQualityOverride(ledger: ApprovalLedger, subjectId: string): boolean {
  return ledger.qualityOverrides.some((override) => override.subjectId === subjectId);
}

function hasUnresolvedBlockingFinding(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  sourceIds: readonly string[],
): boolean {
  return catalog.findings.some((finding, index) => {
    if (finding.sourceId === null || !sourceIds.includes(finding.sourceId)) {
      return false;
    }
    const classification = findingClass(finding);
    if (classification === "missing_detail") {
      return false;
    }
    return !ledger.resolutions.some((resolution) => resolution.findingIndex === index);
  });
}
