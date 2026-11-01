import type { FlightTemplate, TravelCatalog } from "@/lib/catalog/travel/schema";

import type { ApprovalSubjectType, IdentityFingerprint } from "./types";

/**
 * Carriers are omitted. A missing or alternate airline is unresolved metadata,
 * not a change of route identity. Stay-base ids are omitted from flight
 * fingerprints because an airport is not an accommodation base.
 */
export function fingerprintFor(
  catalog: TravelCatalog,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): IdentityFingerprint | null {
  if (subjectType === "stay_property") {
    const property = catalog.properties.find((item) => item.id === subjectId);
    if (!property) {
      return null;
    }
    return {
      kind: "stay_property",
      name: property.name,
      sourceIds: [...property.sourceIds].sort(),
      countryId: property.countryId,
      regionId: property.regionId,
      stayBaseId: property.stayBaseId,
      areaId: property.areaId,
      route: [],
    };
  }

  if (subjectType !== "flight_template") {
    return null;
  }

  const flight = catalog.flightTemplates.find((item) => item.id === subjectId);
  if (!flight || !routeIsValid(flight)) {
    return null;
  }
  return {
    kind: "flight_template",
    name: flight.legs.map((leg) => `${leg.origin}→${leg.destination}`).join(" / "),
    sourceIds: [flight.sourceId],
    countryId: null,
    regionId: null,
    stayBaseId: null,
    areaId: null,
    route: flight.legs.map((leg) => ({
      sequence: leg.sequence,
      origin: leg.origin,
      destination: leg.destination,
    })),
  };
}

export function routeIsValid(flight: FlightTemplate): boolean {
  if (flight.legs.length === 0) {
    return false;
  }
  return flight.legs.every((leg) => {
    const origin = leg.origin.trim();
    const destination = leg.destination.trim();
    return origin.length > 0 && destination.length > 0 && origin !== destination;
  });
}

export function sameFingerprint(left: IdentityFingerprint, right: IdentityFingerprint): boolean {
  if (left.kind !== right.kind || left.name !== right.name) {
    return false;
  }
  if (
    left.countryId !== right.countryId ||
    left.regionId !== right.regionId ||
    left.stayBaseId !== right.stayBaseId ||
    left.areaId !== right.areaId
  ) {
    return false;
  }
  if (left.sourceIds.length !== right.sourceIds.length) {
    return false;
  }
  if (left.sourceIds.some((sourceId, index) => sourceId !== right.sourceIds[index])) {
    return false;
  }
  if (left.route.length !== right.route.length) {
    return false;
  }
  return left.route.every((leg, index) => {
    const other = right.route[index];
    return (
      other !== undefined &&
      leg.sequence === other.sequence &&
      leg.origin === other.origin &&
      leg.destination === other.destination
    );
  });
}
