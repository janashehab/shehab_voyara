import { z } from "zod";

import { importThailandCatalog } from "@/lib/catalog/imports/thailand";
import {
  checkThailandImport,
  checkTravelCatalog,
} from "@/lib/catalog/travel/guards";
import type { TravelCatalog } from "@/lib/catalog/travel/schema";

import { findingKey } from "./constants";

const codeSchema = z
  .union([z.string(), z.null()])
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

const flightSchema = z
  .object({
    id: z.string().min(1),
    departure: z.string().min(1),
    departure_code: codeSchema,
    destination: z.string().min(1),
    destination_code: codeSchema,
    return_destination: z.string().nullable().optional(),
    return_code: codeSchema.optional(),
  })
  .passthrough();

const staySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    price: z.number().nullable(),
    breakfast_included: z.boolean().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

const databaseSchema = z
  .object({
    currency: z.literal("USD"),
    accommodation_price_basis: z
      .object({
        unit: z.literal("per_room_per_night"),
        occupancy: z.literal(2),
        adults: z.literal(2),
      })
      .strict(),
    data_notes: z.array(z.string()),
    flights: z.array(flightSchema),
    accommodations: z.record(z.string(), z.array(staySchema)),
  })
  .passthrough();

export type FlightLegCode = {
  sequence: number;
  originCode: string | null;
  destinationCode: string | null;
};

export type SourceRecordDraft = {
  id: string;
  sourceSystem: "thailand_markdown" | "thailand_json";
  sourceId: string;
  excerpt: string;
};

export type ThailandArtifactDraft = {
  id: string;
  sourceSystem: string;
  sourcePath: string;
  checksum: string;
  role: string;
  metadata: Record<string, unknown>;
};

export type ThailandPersistencePlan = {
  catalog: TravelCatalog;
  artifacts: ThailandArtifactDraft[];
  sourceRecords: SourceRecordDraft[];
  legCodes: Record<string, FlightLegCode[]>;
};

type JsonFlight = z.infer<typeof flightSchema>;

export function buildThailandPersistencePlan(input: {
  markdown: string;
  jsonText: string;
  markdownChecksum: string;
  jsonChecksum: string;
  markdownAliasChecksum: string | null;
}): ThailandPersistencePlan {
  const parsed = databaseSchema.parse(JSON.parse(input.jsonText) as unknown);
  const catalog = draftCatalog(importThailandCatalog(input.markdown));
  const stays = Object.values(parsed.accommodations).flat();
  const stayById = new Map(stays.map((stay) => [stay.id, stay]));
  const flightById = new Map(parsed.flights.map((flight) => [flight.id, flight]));

  attachDusitSource(catalog, stayById.get("CM-H068B"));
  keepMaziBreakfastUnknown(catalog, stayById.get("PH-H014A"));
  const issues = [...checkTravelCatalog(catalog), ...checkThailandImport(catalog)];
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.code} ${issue.recordId}: ${issue.message}`).join("\n"));
  }

  const metadata = {
    currency: "USD" as const,
    accommodationPriceBasis: "per_room_per_night" as const,
    occupancy: 2,
    occupancyAdults: 2,
    occupancyVerified: false,
    dataNotes: parsed.data_notes,
  };

  const artifacts: ThailandArtifactDraft[] = [
    {
      id: `art_md_${input.markdownChecksum.slice(0, 12)}`,
      sourceSystem: "thailand_markdown",
      sourcePath: "docs/inventory/thailand.md",
      checksum: input.markdownChecksum,
      role: "canonical_markdown",
      metadata: {},
    },
    {
      id: `art_json_${input.jsonChecksum.slice(0, 12)}`,
      sourceSystem: "thailand_json",
      sourcePath: "docs/inventory/voyara_thailand_master_database.json",
      checksum: input.jsonChecksum,
      role: "authoritative_json",
      metadata,
    },
  ];
  if (input.markdownAliasChecksum === input.markdownChecksum) {
    artifacts.push({
      id: `art_md_alias_${input.markdownChecksum.slice(0, 12)}`,
      sourceSystem: "thailand_markdown_alias",
      sourcePath: "docs/inventory/✈️ 1. FLIGHTS.md",
      checksum: input.markdownChecksum,
      role: "markdown_alias",
      metadata: {},
    });
  }

  const sourceRecords = dedupeRecords([
    ...catalog.provenance.map((record) => ({
      id: record.id,
      sourceSystem: record.sourceSystem,
      sourceId: record.sourceId,
      excerpt: record.excerpt,
    })),
    ...parsed.flights.map((flight) => jsonRecord(flight.id, flight)),
    ...stays.map((stay) => jsonRecord(stay.id, stay)),
  ]);

  const legCodes: Record<string, FlightLegCode[]> = {};
  for (const flight of catalog.flightTemplates) {
    const jsonFlight = flightById.get(flight.sourceId);
    if (!jsonFlight) {
      continue;
    }
    legCodes[flight.id] = flight.legs.map((leg) => ({
      sequence: leg.sequence,
      originCode: codeForPlace(jsonFlight, leg.origin),
      destinationCode: codeForPlace(jsonFlight, leg.destination),
    }));
  }

  return { catalog, artifacts, sourceRecords, legCodes };
}

function draftCatalog(catalog: TravelCatalog): TravelCatalog {
  return {
    ...catalog,
    countries: catalog.countries.map((row) => ({ ...row, approval: "draft" })),
    regions: catalog.regions.map((row) => ({ ...row, approval: "draft" })),
    stayBases: catalog.stayBases.map((row) => ({ ...row, approval: "draft" })),
    areas: catalog.areas.map((row) => ({ ...row, approval: "draft" })),
    properties: catalog.properties.map((row) => ({ ...row, approval: "draft" })),
    rates: catalog.rates.map((row) => ({ ...row, approval: "draft", occupancyKnown: false })),
    flightTemplates: catalog.flightTemplates.map((row) => ({ ...row, approval: "draft" })),
    amounts: catalog.amounts.map((row) => ({
      ...row,
      approval: "draft",
      presentation: "historical_reference",
      liveQuote: false,
      freshness: "unverified",
      lastCheckedAt: null,
      lastVerifiedAt: null,
      expiresAt: null,
    })),
    recommendations: catalog.recommendations.map((row) => ({ ...row, approval: "draft", verified: false })),
  };
}

function attachDusitSource(
  catalog: TravelCatalog,
  jsonStay: z.infer<typeof staySchema> | undefined,
): void {
  if (!jsonStay) {
    throw new Error("CM-H068B is missing from the JSON source.");
  }
  const property = catalog.properties.find((item) => item.sourceIds.includes("CM-H068"));
  const rate = catalog.rates.find(
    (item) => item.propertyId === property?.id && item.rateKey === "with_breakfast",
  );
  if (!property || !rate || property.name !== jsonStay.name) {
    throw new Error("CM-H068B could not be attached to the Dusit Princess property.");
  }
  if (!property.sourceIds.includes("CM-H068B")) {
    property.sourceIds = [...property.sourceIds, "CM-H068B"];
  }
  rate.sourceId = "CM-H068B";
  catalog.provenance.push({
    id: "prv_json_cm_h068b",
    sourceSystem: "thailand_json",
    sourcePath: "docs/inventory/voyara_thailand_master_database.json",
    sourceId: "CM-H068B",
    excerpt: JSON.stringify(jsonStay),
  });
  const amount = catalog.amounts.find(
    (item) => item.subject.type === "stay_rate" && item.subject.id === rate.id,
  );
  if (!amount) {
    throw new Error("The Dusit breakfast rate has no historical amount.");
  }
  amount.sourceId = "CM-H068B";
  amount.source = { ...amount.source, externalId: "CM-H068B" };
  if (jsonStay.price !== null && amount.amountMinor !== null && jsonStay.price * 100 !== amount.amountMinor) {
    catalog.findings.push({
      kind: "ambiguous",
      sourceId: "CM-H068B",
      field: "price",
      message: "The JSON price and the markdown historical amount differ. The markdown amount was kept.",
    });
  }
}

function keepMaziBreakfastUnknown(
  catalog: TravelCatalog,
  jsonStay: z.infer<typeof staySchema> | undefined,
): void {
  const rate = catalog.rates.find((item) => item.sourceId === "PH-H014A");
  if (!rate) {
    throw new Error("PH-H014A is missing from the markdown import.");
  }
  rate.breakfast = "unknown";
  if (jsonStay?.breakfast_included === false) {
    const message =
      "The JSON marks breakfast as not included, and its note says breakfast was not specified. The stored value stays unknown.";
    const exists = catalog.findings.some(
      (finding) => finding.sourceId === "PH-H014A" && finding.field === "breakfast" && finding.message === message,
    );
    if (!exists) {
      catalog.findings.push({
        kind: "ambiguous",
        sourceId: "PH-H014A",
        field: "breakfast",
        message,
      });
    }
  }
}

function dedupeRecords(records: SourceRecordDraft[]): SourceRecordDraft[] {
  const byKey = new Map<string, SourceRecordDraft>();
  for (const record of records) {
    byKey.set(`${record.sourceSystem}:${record.sourceId}`, record);
  }
  return [...byKey.values()];
}

function jsonRecord(sourceId: string, value: unknown): SourceRecordDraft {
  return {
    id: `prv_json_${sourceId.toLowerCase().replace(/-/g, "_")}`,
    sourceSystem: "thailand_json",
    sourceId,
    excerpt: JSON.stringify(value),
  };
}

function codeForPlace(flight: JsonFlight, place: string): string | null {
  const name = place.trim().toLowerCase();
  if (name === flight.departure.trim().toLowerCase()) {
    return flight.departure_code;
  }
  if (name === flight.destination.trim().toLowerCase()) {
    return flight.destination_code;
  }
  if (flight.return_destination && name === flight.return_destination.trim().toLowerCase()) {
    return flight.return_code ?? null;
  }
  return null;
}

export function stableFindingId(finding: TravelCatalog["findings"][number]): string {
  return findingKey(finding);
}
