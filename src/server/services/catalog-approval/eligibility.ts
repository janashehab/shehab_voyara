import type { StayProperty, TravelCatalog } from "@/lib/catalog/travel/schema";

import { unresolvedIdentityOrGeography } from "./findings";
import { fingerprintFor, sameFingerprint } from "./identity";
import type { ApprovalLedger, ApprovalSubjectType } from "./types";

export type ApprovalBlocker =
  | "unverified_identity"
  | "insufficient_geography"
  | "hierarchy_not_approved"
  | "blocking_finding"
  | "quality_blocked";

/**
 * Editorial approval is separate from freshness and from live prices.
 * A flight template does not need a carrier or an accommodation stay base.
 */
export function approvalBlocker(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): ApprovalBlocker | null {
  if (subjectType === "country") {
    return countryBlocker(catalog, subjectId);
  }
  if (subjectType === "region") {
    return regionBlocker(catalog, subjectId);
  }
  if (subjectType === "stay_base") {
    return stayBaseBlocker(catalog, subjectId);
  }
  if (subjectType === "flight_template") {
    return flightBlocker(catalog, ledger, subjectId);
  }

  const property = catalog.properties.find((item) => item.id === subjectId);
  if (!property) {
    return "unverified_identity";
  }
  return propertyBlocker(catalog, ledger, property);
}

function countryBlocker(catalog: TravelCatalog, subjectId: string): ApprovalBlocker | null {
  return catalog.countries.some((country) => country.id === subjectId) ? null : "unverified_identity";
}

function regionBlocker(catalog: TravelCatalog, subjectId: string): ApprovalBlocker | null {
  const region = catalog.regions.find((item) => item.id === subjectId);
  if (!region) {
    return "unverified_identity";
  }
  const country = catalog.countries.find((item) => item.id === region.countryId);
  if (!country) {
    return "insufficient_geography";
  }
  if (country.approval !== "approved") {
    return "hierarchy_not_approved";
  }
  return null;
}

function stayBaseBlocker(catalog: TravelCatalog, subjectId: string): ApprovalBlocker | null {
  const stayBase = catalog.stayBases.find((item) => item.id === subjectId);
  if (!stayBase) {
    return "unverified_identity";
  }
  const region = catalog.regions.find((item) => item.id === stayBase.regionId);
  const country = catalog.countries.find((item) => item.id === stayBase.countryId);
  if (!region || !country || region.countryId !== country.id) {
    return "insufficient_geography";
  }
  if (country.approval !== "approved" || region.approval !== "approved") {
    return "hierarchy_not_approved";
  }
  return null;
}

function flightBlocker(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectId: string,
): ApprovalBlocker | null {
  const flight = catalog.flightTemplates.find((item) => item.id === subjectId);
  if (!flight) {
    return "unverified_identity";
  }
  const fingerprint = fingerprintFor(catalog, "flight_template", flight.id);
  if (!fingerprint) {
    return "unverified_identity";
  }
  const provenance = catalog.provenance.some((item) => item.sourceId === flight.sourceId);
  if (!provenance || !activeAttestation(ledger, "flight_template", flight.id, fingerprint)) {
    return "unverified_identity";
  }
  return null;
}

function propertyBlocker(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  property: StayProperty,
): ApprovalBlocker | null {
  const fingerprint = fingerprintFor(catalog, "stay_property", property.id);
  if (
    !fingerprint ||
    property.name.trim().length === 0 ||
    property.sourceIds.length === 0 ||
    new Set(property.sourceIds).size !== property.sourceIds.length
  ) {
    return "unverified_identity";
  }
  for (const sourceId of property.sourceIds) {
    const provenance = catalog.provenance.some((item) => item.sourceId === sourceId);
    const shared = catalog.properties.some(
      (item) => item.id !== property.id && item.sourceIds.includes(sourceId),
    );
    if (!provenance || shared) {
      return "unverified_identity";
    }
  }
  if (!activeAttestation(ledger, "stay_property", property.id, fingerprint)) {
    return "unverified_identity";
  }
  if (!propertyLinksResolve(catalog, property)) {
    return "insufficient_geography";
  }
  if (!hierarchyApproved(catalog, property)) {
    return "hierarchy_not_approved";
  }
  if (unresolvedIdentityOrGeography(catalog, ledger, property)) {
    return "blocking_finding";
  }
  const overridden = ledger.qualityOverrides.some(
    (item) => item.subjectType === "stay_property" && item.subjectId === property.id,
  );
  if (property.qualityReview && !overridden) {
    return "quality_blocked";
  }
  return null;
}

function propertyLinksResolve(catalog: TravelCatalog, property: StayProperty): boolean {
  const country = catalog.countries.find((item) => item.id === property.countryId);
  const region = catalog.regions.find((item) => item.id === property.regionId);
  if (!country || !region || region.countryId !== country.id || property.stayBaseId === null) {
    return false;
  }
  const stayBase = catalog.stayBases.find((item) => item.id === property.stayBaseId);
  if (!stayBase || stayBase.countryId !== country.id || stayBase.regionId !== region.id) {
    return false;
  }
  if (property.areaId === null) {
    return true;
  }
  const area = catalog.areas.find((item) => item.id === property.areaId);
  return area !== undefined && area.stayBaseId === stayBase.id;
}

function hierarchyApproved(catalog: TravelCatalog, property: StayProperty): boolean {
  const country = catalog.countries.find((item) => item.id === property.countryId);
  const region = catalog.regions.find((item) => item.id === property.regionId);
  const stayBase = catalog.stayBases.find((item) => item.id === property.stayBaseId);
  return (
    country?.approval === "approved" &&
    region?.approval === "approved" &&
    stayBase?.approval === "approved"
  );
}

function activeAttestation(
  ledger: ApprovalLedger,
  subjectType: "stay_property" | "flight_template",
  subjectId: string,
  fingerprint: NonNullable<ReturnType<typeof fingerprintFor>>,
): boolean {
  return ledger.attestations.some(
    (item) =>
      item.status === "active" &&
      item.subjectType === subjectType &&
      item.subjectId === subjectId &&
      sameFingerprint(item.fingerprint, fingerprint),
  );
}
