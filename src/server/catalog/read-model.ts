import type { TravelCatalog } from "@/lib/catalog/travel/schema";
import { travelCatalogSchema } from "@/lib/catalog/travel/schema";
import type { PrismaClient } from "@/generated/prisma/client";
import { fingerprintFor } from "@/server/services/catalog-approval/identity";
import type { ApprovalLedger, IdentityFingerprint } from "@/server/services/catalog-approval/types";

import type { Prisma } from "@/generated/prisma/client";

type CatalogTx = Prisma.TransactionClient | PrismaClient;

export type TravelState = {
  catalog: TravelCatalog;
  ledger: ApprovalLedger;
};

export async function readTravelState(db: CatalogTx): Promise<TravelState> {
  const [
    countries,
    regions,
    stayBases,
    areas,
    properties,
    rates,
    flights,
    legs,
    profiles,
    recommendations,
    records,
    findings,
    amounts,
    attestations,
    resolutions,
    overrides,
    audits,
  ] = await Promise.all([
    db.country.findMany({ orderBy: { id: "asc" } }),
    db.region.findMany({ orderBy: { id: "asc" } }),
    db.stayBase.findMany({ orderBy: { id: "asc" } }),
    db.area.findMany({ orderBy: { id: "asc" } }),
    db.stayProperty.findMany({ orderBy: { id: "asc" } }),
    db.stayRate.findMany({ orderBy: { id: "asc" } }),
    db.flightTemplate.findMany({ orderBy: { id: "asc" } }),
    db.flightLeg.findMany({ orderBy: [{ templateId: "asc" }, { sequence: "asc" }] }),
    db.referenceProfile.findMany({ orderBy: { id: "asc" } }),
    db.editorialRecommendation.findMany({ orderBy: { id: "asc" } }),
    db.sourceRecord.findMany({ orderBy: { id: "asc" } }),
    db.importFinding.findMany({ orderBy: { id: "asc" } }),
    db.historicalAmount.findMany({ orderBy: { id: "asc" } }),
    db.identityAttestation.findMany({ orderBy: { attestedAt: "asc" } }),
    db.findingResolution.findMany({ orderBy: { resolvedAt: "asc" } }),
    db.qualityOverride.findMany({ orderBy: { overriddenAt: "asc" } }),
    db.approvalAudit.findMany({ orderBy: { occurredAt: "asc" } }),
  ]);

  const thailandCountries = countries.filter((row) => row.countryCode === "TH");
  const thailandCountryIds = new Set(thailandCountries.map((row) => row.id));
  const legsByTemplate = new Map<string, typeof legs>();
  for (const leg of legs) {
    const group = legsByTemplate.get(leg.templateId) ?? [];
    group.push(leg);
    legsByTemplate.set(leg.templateId, group);
  }
  const provenanceBySource = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const current = provenanceBySource.get(record.sourceId);
    if (!current || record.sourceSystem === "thailand_markdown") {
      provenanceBySource.set(record.sourceId, record);
    }
  }

  const findingIds = findings.map((finding) => finding.id);
  const catalog = travelCatalogSchema.parse({
    countries: thailandCountries.map(countryRow),
    regions: regions.filter((row) => thailandCountryIds.has(row.countryId)).map(regionRow),
    stayBases: stayBases.filter((row) => thailandCountryIds.has(row.countryId)).map(stayBaseRow),
    areas: areas
      .filter((row) => stayBases.some((base) => base.id === row.stayBaseId && thailandCountryIds.has(base.countryId)))
      .map(areaRow),
    properties: properties.filter((row) => thailandCountryIds.has(row.countryId)).map(propertyRow),
    rates: rates
      .filter((row) => properties.some((property) => property.id === row.propertyId && thailandCountryIds.has(property.countryId)))
      .map(rateRow),
    flightTemplates: flights.map((flight) => ({
      id: flight.id,
      approval: flight.approval,
      sourceId: flight.sourceId,
      journey: flight.journey,
      legs: (legsByTemplate.get(flight.id) ?? []).map((leg) => ({
        sequence: leg.sequence,
        origin: leg.origin,
        destination: leg.destination,
        endpointStayBaseId: leg.endpointStayBaseId,
      })),
      carriers: flight.carriers,
      carrierUnresolved: flight.carrierUnresolved,
      optionLabel: flight.optionLabel,
    })),
    amounts: amounts.map((amount) => {
      if (amount.liveQuote || amount.freshness !== "unverified" || amount.presentation !== "historical_reference" || amount.lastVerifiedAt !== null) {
        throw new Error(`Historical amount ${amount.id} cannot be read as a current price.`);
      }
      return {
        id: amount.id,
        approval: amount.approval,
        sourceId: amount.sourceId,
        presentation: "historical_reference" as const,
        liveQuote: false as const,
        freshness: "unverified" as const,
        amountMinor: amount.amountMinor,
        currency: amount.currency === "USD" ? "USD" as const : null,
        unit: amount.unit,
        lastCheckedAt: null,
        lastVerifiedAt: null,
        expiresAt: null,
        note: amount.note,
        subject:
          amount.subjectType === "stay_rate"
            ? { type: "stay_rate" as const, id: amount.subjectId }
            : { type: "flight_template" as const, id: amount.subjectId },
        source: {
          providerKey: "thailand_markdown",
          externalId: amount.externalId,
          retrievedBy: "manual" as const,
        },
      };
    }),
    referenceProfiles: profiles.map((profile) => ({
      id: profile.id,
      propertyId: profile.propertyId,
      sourceId: profile.sourceId,
      statedStarRating: profile.statedStarRating,
      guestScore: profile.guestScore,
      guestScoreScale: profile.guestScoreScale,
      provenance: "manual_import" as const,
      verified: false as const,
    })),
    recommendations: recommendations.map((row) => ({
      id: row.id,
      approval: row.approval,
      verified: false as const,
      tier: row.tier,
      qualityReview: row.qualityReview,
      stance: row.stance,
      body: row.body,
      propertyIds: row.propertyIds,
      stayBaseId: row.stayBaseId,
      regionId: row.regionId,
      sourceIds: row.sourceIds,
    })),
    provenance: [...provenanceBySource.values()].map((record) => ({
      id: record.id,
      sourceSystem: record.sourceSystem === "thailand_json" ? "thailand_json" as const : "thailand_markdown" as const,
      sourcePath:
        record.sourceSystem === "thailand_json"
          ? "docs/inventory/voyara_thailand_master_database.json" as const
          : "docs/inventory/thailand.md" as const,
      sourceId: record.sourceId,
      excerpt: record.excerpt,
    })),
    supplierLinks: [],
    dynamicUpdates: [],
    suggestions: [],
    findings: findings.map((finding) => ({
      kind: finding.kind,
      sourceId: finding.sourceId,
      field: finding.field,
      message: finding.message,
    })),
    totals: {
      sourceRecords: provenanceBySource.size,
      flightTemplates: flights.length,
      accommodationSourceRecords: rates.length,
      properties: properties.filter((row) => thailandCountryIds.has(row.countryId)).length,
      rateVariants: rates.filter((row) => properties.some((property) => property.id === row.propertyId && thailandCountryIds.has(property.countryId))).length,
      statedDocumentTotal: null,
    },
  });

  const ledger: ApprovalLedger = {
    attestations: attestations.map((row) => ({
      subjectType: row.subjectType as "stay_property" | "flight_template",
      subjectId: row.subjectId,
      actorId: row.actorId,
      at: row.attestedAt.toISOString(),
      reason: row.reason,
      status: row.status,
      fingerprint: fingerprintValue(row.fingerprint),
      invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
    })),
    resolutions: resolutions.flatMap((row) => {
      const findingIndex = findingIds.indexOf(row.findingId);
      if (findingIndex < 0) {
        return [];
      }
      return [{
        findingIndex,
        field: findings[findingIndex]?.field ?? "finding",
        sourceId: findings[findingIndex]?.sourceId ?? null,
        actorId: row.actorId,
        at: row.resolvedAt.toISOString(),
        reason: row.reason,
      }];
    }),
    qualityOverrides: overrides.map((row) => ({
      subjectType: "stay_property" as const,
      subjectId: row.subjectId,
      actorId: row.actorId,
      at: row.overriddenAt.toISOString(),
      reason: row.reason,
    })),
    audits: audits.map((row) => ({
      id: row.id,
      kind: row.kind as ApprovalLedger["audits"][number]["kind"],
      at: row.occurredAt.toISOString(),
      actorId: row.actorId,
      actorRole: row.actorRole,
      subjectType: row.subjectType as ApprovalLedger["audits"][number]["subjectType"],
      subjectId: row.subjectId,
      from: row.fromState,
      to: row.toState,
      reason: row.reason,
      errorCode: row.errorCode as ApprovalLedger["audits"][number]["errorCode"],
    })),
  };

  return { catalog, ledger };
}

export function attestationStillMatches(state: TravelState, subjectType: "stay_property" | "flight_template", subjectId: string): boolean {
  const current = fingerprintFor(state.catalog, subjectType, subjectId);
  if (!current) {
    return false;
  }
  return state.ledger.attestations.some(
    (item) => item.status === "active" && item.subjectId === subjectId && item.subjectType === subjectType,
  );
}

function countryRow(row: { id: string; approval: TravelCatalog["countries"][number]["approval"]; name: string; countryCode: string }) {
  return { id: row.id, approval: row.approval, name: row.name, countryCode: row.countryCode };
}

function regionRow(row: { id: string; countryId: string; approval: TravelCatalog["regions"][number]["approval"]; name: string }) {
  return { id: row.id, countryId: row.countryId, approval: row.approval, name: row.name };
}

function stayBaseRow(row: {
  id: string;
  countryId: string;
  regionId: string;
  approval: TravelCatalog["stayBases"][number]["approval"];
  name: string;
  slug: string;
  summary: string;
  aliases: string[];
}) {
  return {
    id: row.id,
    countryId: row.countryId,
    regionId: row.regionId,
    approval: row.approval,
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    aliases: row.aliases,
  };
}

function areaRow(row: { id: string; stayBaseId: string; approval: TravelCatalog["areas"][number]["approval"]; name: string; slug: string }) {
  return { id: row.id, stayBaseId: row.stayBaseId, approval: row.approval, name: row.name, slug: row.slug };
}

function propertyRow(row: {
  id: string;
  countryId: string;
  regionId: string;
  stayBaseId: string | null;
  areaId: string | null;
  approval: TravelCatalog["properties"][number]["approval"];
  name: string;
  sourceIds: string[];
  qualityReview: boolean;
  editorialShortlistBands: string[];
}) {
  return {
    id: row.id,
    countryId: row.countryId,
    regionId: row.regionId,
    stayBaseId: row.stayBaseId,
    areaId: row.areaId,
    approval: row.approval,
    name: row.name,
    sourceIds: row.sourceIds,
    qualityReview: row.qualityReview,
    editorialShortlistBands: row.editorialShortlistBands,
  };
}

function rateRow(row: {
  id: string;
  propertyId: string;
  approval: TravelCatalog["rates"][number]["approval"];
  sourceId: string;
  rateKey: string;
  suppliedLabel: string | null;
  roomSizeSquareMeters: number | null;
  roomCategory: string | null;
  breakfast: TravelCatalog["rates"][number]["breakfast"];
  occupancyKnown: boolean;
  taxesKnown: boolean;
  cancellationKnown: boolean;
  stayDatesKnown: boolean;
}) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    approval: row.approval,
    sourceId: row.sourceId,
    rateKey: row.rateKey,
    suppliedLabel: row.suppliedLabel,
    roomSizeSquareMeters: row.roomSizeSquareMeters,
    roomCategory: row.roomCategory,
    breakfast: row.breakfast,
    occupancyKnown: row.occupancyKnown,
    taxesKnown: row.taxesKnown,
    cancellationKnown: row.cancellationKnown,
    stayDatesKnown: row.stayDatesKnown,
  };
}

function fingerprintValue(value: unknown): IdentityFingerprint {
  if (typeof value !== "object" || value === null) {
    throw new Error("An identity attestation is missing its fingerprint.");
  }
  return value as IdentityFingerprint;
}
