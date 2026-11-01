import { readFileSync } from "node:fs";

import type { CatalogSnapshot } from "@/lib/catalog";
import { getPrototypeCatalog } from "@/lib/catalog";
import type { TravelCatalog } from "@/lib/catalog/travel/schema";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import {
  CATALOG_NORMALIZER_VERSION,
  PARIS_COUNTRY_ID,
  PARIS_FIXTURE_PATH,
  PARIS_REGION_ID,
  PARIS_STAY_BASE_ID,
  THAILAND_JSON_PATH,
  THAILAND_MARKDOWN_ALIAS_PATH,
  THAILAND_MARKDOWN_PATH,
  sha256,
} from "./constants";
import { decideField, mergeFields, type FieldHold } from "./field-ownership";
import { buildThailandPersistencePlan, stableFindingId, type ThailandPersistencePlan } from "./thailand-plan";

type CatalogTx = Prisma.TransactionClient;

export type ImportReport = {
  status: "applied" | "skipped";
  runId: string;
  holds: number;
  properties: number;
  rates: number;
  flights: number;
};

export async function importPersistentCatalog(
  prisma: PrismaClient,
  options?: { normalizerVersion?: string },
): Promise<ImportReport> {
  const version = options?.normalizerVersion ?? CATALOG_NORMALIZER_VERSION;
  const markdown = readFileSync(THAILAND_MARKDOWN_PATH, "utf8");
  const jsonText = readFileSync(THAILAND_JSON_PATH, "utf8");
  const parisSource = readFileSync(PARIS_FIXTURE_PATH, "utf8");
  let aliasChecksum: string | null = null;
  try {
    aliasChecksum = sha256(readFileSync(THAILAND_MARKDOWN_ALIAS_PATH, "utf8"));
  } catch {
    aliasChecksum = null;
  }
  const markdownChecksum = sha256(markdown);
  const jsonChecksum = sha256(jsonText);
  const parisChecksum = sha256(parisSource);
  const runId = `run_${version}_${markdownChecksum.slice(0, 8)}_${jsonChecksum.slice(0, 8)}_${parisChecksum.slice(0, 8)}`;

  const existingRun = await prisma.importRun.findUnique({
    where: {
      normalizerVersion_markdownChecksum_jsonChecksum_parisChecksum: {
        normalizerVersion: version,
        markdownChecksum,
        jsonChecksum,
        parisChecksum,
      },
    },
  });
  if (existingRun) {
    const [properties, rates, flights] = await Promise.all([
      prisma.stayProperty.count(),
      prisma.stayRate.count(),
      prisma.flightTemplate.count(),
    ]);
    return { status: "skipped", runId: existingRun.id, holds: 0, properties, rates, flights };
  }

  const plan = buildThailandPersistencePlan({
    markdown,
    jsonText,
    markdownChecksum,
    jsonChecksum,
    markdownAliasChecksum: aliasChecksum,
  });
  const paris = getPrototypeCatalog();

  const holds = await prisma.$transaction(
    async (tx) => {
      const written = await writeCatalog(tx, plan, paris);
      await tx.importRun.create({
        data: {
          id: runId,
          normalizerVersion: version,
          markdownChecksum,
          jsonChecksum,
          parisChecksum,
        },
      });
      return written;
    },
    { timeout: 120_000 },
  );

  return {
    status: "applied",
    runId,
    holds,
    properties: plan.catalog.properties.length,
    rates: plan.catalog.rates.length,
    flights: plan.catalog.flightTemplates.length,
  };
}

async function writeCatalog(tx: CatalogTx, plan: ThailandPersistencePlan, paris: CatalogSnapshot): Promise<number> {
  const attested = new Set(
    (await tx.identityAttestation.findMany({ where: { status: "active" }, select: { subjectType: true, subjectId: true } })).map(
      (row) => `${row.subjectType}:${row.subjectId}`,
    ),
  );
  const overrides = new Set(
    (await tx.qualityOverride.findMany({ select: { subjectId: true } })).map((row) => row.subjectId),
  );
  const holds: { subjectType: string; subjectId: string; field: string; reason: string }[] = [];

  await writeGeography(tx, plan.catalog, paris, attested, holds);
  await writeParisContent(tx, paris, attested, holds);
  await writeProperties(tx, plan, attested, overrides, holds);
  await writeFlights(tx, plan, attested, holds);
  await writeProfiles(tx, plan.catalog);
  await writeRecommendations(tx, plan.catalog, holds);
  await writeArtifacts(tx, plan);
  await writeFindings(tx, plan.catalog);
  await writeAmounts(tx, plan.catalog, holds);
  await writeHolds(tx, holds);
  return holds.length;
}

async function writeGeography(
  tx: CatalogTx,
  catalog: TravelCatalog,
  paris: CatalogSnapshot,
  attested: Set<string>,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const destination = paris.destinations.find((item) => item.id === PARIS_STAY_BASE_ID);
  if (!destination) {
    throw new Error("The Paris fixture is missing dst_paris.");
  }
  const countries = [
    ...catalog.countries.map((row) => ({
      id: row.id,
      approval: row.approval,
      name: row.name,
      countryCode: row.countryCode,
    })),
    {
      id: PARIS_COUNTRY_ID,
      approval: "approved" as const,
      name: "France",
      countryCode: "FR",
    },
  ];
  const existingCountries = await existingMap(tx.country.findMany());
  for (const row of countries) {
    const merged = mergeRow(existingCountries.get(row.id) ?? null, row, ["name", "countryCode"], ["name", "countryCode"], false);
    holds.push(...namedHolds("country", row.id, merged.holds));
    await tx.country.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        approval: row.approval,
        name: String(merged.values.name),
        countryCode: String(merged.values.countryCode),
        adminLockedFields: lockList(merged.values),
      },
      update: {
        approval: merged.values.approval as typeof row.approval,
        name: String(merged.values.name),
        countryCode: String(merged.values.countryCode),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  const regions = [
    ...catalog.regions.map((row) => ({
      id: row.id,
      countryId: row.countryId,
      approval: row.approval,
      name: row.name,
    })),
    {
      id: PARIS_REGION_ID,
      countryId: PARIS_COUNTRY_ID,
      approval: "approved" as const,
      name: "Île-de-France",
    },
  ];
  const existingRegions = await existingMap(tx.region.findMany());
  for (const row of regions) {
    const merged = mergeRow(
      existingRegions.get(row.id) ?? null,
      row,
      ["name", "countryId"],
      ["name", "countryId"],
      attested.has(`region:${row.id}`),
    );
    holds.push(...namedHolds("region", row.id, merged.holds));
    await tx.region.upsert({
      where: { id: row.id },
      create: { ...row, adminLockedFields: lockList(merged.values) },
      update: {
        approval: merged.values.approval as typeof row.approval,
        name: String(merged.values.name),
        countryId: String(merged.values.countryId),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  const stayBases = [
    ...catalog.stayBases.map((row) => ({
      id: row.id,
      countryId: row.countryId,
      regionId: row.regionId,
      approval: row.approval,
      name: row.name,
      slug: row.slug,
      summary: row.summary,
      aliases: [...row.aliases],
      vibeTags: [] as string[],
    })),
    {
      id: destination.id,
      countryId: PARIS_COUNTRY_ID,
      regionId: PARIS_REGION_ID,
      approval: destination.status,
      name: destination.name,
      slug: destination.slug,
      summary: destination.editorialSummary,
      aliases: [] as string[],
      vibeTags: [...destination.vibeTags],
    },
  ];
  const existingBases = await existingMap(tx.stayBase.findMany());
  for (const row of stayBases) {
    const merged = mergeRow(
      existingBases.get(row.id) ?? null,
      row,
      ["name", "countryId", "regionId", "slug", "summary", "aliases", "vibeTags"],
      ["name", "countryId", "regionId", "slug"],
      attested.has(`stay_base:${row.id}`),
    );
    holds.push(...namedHolds("stay_base", row.id, merged.holds));
    await tx.stayBase.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        countryId: String(merged.values.countryId),
        regionId: String(merged.values.regionId),
        approval: row.approval,
        name: String(merged.values.name),
        slug: String(merged.values.slug),
        summary: String(merged.values.summary),
        aliases: stringList(merged.values.aliases),
        vibeTags: stringList(merged.values.vibeTags),
        adminLockedFields: lockList(merged.values),
      },
      update: {
        approval: merged.values.approval as typeof row.approval,
        countryId: String(merged.values.countryId),
        regionId: String(merged.values.regionId),
        name: String(merged.values.name),
        slug: String(merged.values.slug),
        summary: String(merged.values.summary),
        aliases: stringList(merged.values.aliases),
        vibeTags: stringList(merged.values.vibeTags),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  const existingAreas = await existingMap(tx.area.findMany());
  for (const row of catalog.areas) {
    const merged = mergeRow(
      existingAreas.get(row.id) ?? null,
      row,
      ["name", "slug", "stayBaseId"],
      ["name", "stayBaseId"],
      false,
    );
    holds.push(...namedHolds("area", row.id, merged.holds));
    await tx.area.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        stayBaseId: row.stayBaseId,
        approval: row.approval,
        name: String(merged.values.name),
        slug: String(merged.values.slug),
        adminLockedFields: lockList(merged.values),
      },
      update: {
        approval: merged.values.approval as typeof row.approval,
        stayBaseId: String(merged.values.stayBaseId),
        name: String(merged.values.name),
        slug: String(merged.values.slug),
        adminLockedFields: lockList(merged.values),
      },
    });
  }
}

async function writeParisContent(
  tx: CatalogTx,
  paris: CatalogSnapshot,
  attested: Set<string>,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const existingPlaces = await existingMap(tx.place.findMany());
  for (const place of paris.places) {
    const incoming = {
      id: place.id,
      stayBaseId: place.destinationId,
      approval: place.status,
      name: place.name,
      kind: place.kind,
      editorialSummary: place.editorialSummary,
      vibeTags: [...place.vibeTags],
      areaLabel: place.areaLabel,
      latitude: place.approximateCoordinates?.latitude ?? null,
      longitude: place.approximateCoordinates?.longitude ?? null,
      approximateDurationMinutes: place.approximateDurationMinutes,
    };
    const merged = mergeRow(
      existingPlaces.get(place.id) ?? null,
      incoming,
      ["stayBaseId", "name", "kind", "editorialSummary", "vibeTags", "areaLabel", "latitude", "longitude", "approximateDurationMinutes"],
      ["name", "stayBaseId"],
      attested.has(`place:${place.id}`),
    );
    holds.push(...namedHolds("place", place.id, merged.holds));
    await tx.place.upsert({
      where: { id: place.id },
      create: {
        id: place.id,
        stayBaseId: String(merged.values.stayBaseId),
        approval: place.status,
        name: String(merged.values.name),
        kind: place.kind,
        editorialSummary: String(merged.values.editorialSummary),
        vibeTags: stringList(merged.values.vibeTags),
        areaLabel: nullableString(merged.values.areaLabel),
        latitude: nullableNumber(merged.values.latitude),
        longitude: nullableNumber(merged.values.longitude),
        approximateDurationMinutes: nullableNumber(merged.values.approximateDurationMinutes),
        adminLockedFields: lockList(merged.values),
      },
      update: {
        approval: merged.values.approval as typeof place.status,
        stayBaseId: String(merged.values.stayBaseId),
        name: String(merged.values.name),
        kind: place.kind,
        editorialSummary: String(merged.values.editorialSummary),
        vibeTags: stringList(merged.values.vibeTags),
        areaLabel: nullableString(merged.values.areaLabel),
        latitude: nullableNumber(merged.values.latitude),
        longitude: nullableNumber(merged.values.longitude),
        approximateDurationMinutes: nullableNumber(merged.values.approximateDurationMinutes),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  const existingTips = await existingMap(tx.curatedTip.findMany());
  for (const tip of paris.tips) {
    const subjectType = tip.subject.type === "destination" ? "stay_base" : "place";
    const incoming = {
      id: tip.id,
      approval: tip.status,
      body: tip.body,
      subjectType,
      subjectId: tip.subject.id,
    };
    const merged = mergeRow(existingTips.get(tip.id) ?? null, incoming, ["body", "subjectType", "subjectId"], ["body"], false);
    holds.push(...namedHolds("curated_tip", tip.id, merged.holds));
    await tx.curatedTip.upsert({
      where: { id: tip.id },
      create: {
        id: tip.id,
        approval: tip.status,
        body: String(merged.values.body),
        subjectType: String(merged.values.subjectType),
        subjectId: String(merged.values.subjectId),
        adminLockedFields: lockList(merged.values),
      },
      update: {
        approval: merged.values.approval as typeof tip.status,
        body: String(merged.values.body),
        subjectType: String(merged.values.subjectType),
        subjectId: String(merged.values.subjectId),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  for (const itinerary of paris.sampleItineraries) {
    await tx.sampleItinerary.upsert({
      where: { id: itinerary.id },
      create: {
        id: itinerary.id,
        approval: itinerary.status,
        title: itinerary.title,
        editorialNote: itinerary.editorialNote,
        stayBaseIds: [...itinerary.destinationIds],
      },
      update: {
        title: itinerary.title,
        editorialNote: itinerary.editorialNote,
        stayBaseIds: [...itinerary.destinationIds],
      },
    });
  }
  for (const item of paris.sampleItineraryItems) {
    await tx.sampleItineraryItem.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        itineraryId: item.itineraryId,
        dayIndex: item.dayIndex,
        sortOrder: item.sortOrder,
        placeId: item.placeId,
        role: item.role,
        editorialNote: item.editorialNote,
      },
      update: {
        dayIndex: item.dayIndex,
        sortOrder: item.sortOrder,
        placeId: item.placeId,
        role: item.role,
        editorialNote: item.editorialNote,
      },
    });
  }
}

async function writeProperties(
  tx: CatalogTx,
  plan: ThailandPersistencePlan,
  attested: Set<string>,
  overrides: Set<string>,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const existing = await existingMap(tx.stayProperty.findMany());
  for (const row of plan.catalog.properties) {
    const current = existing.get(row.id) ?? null;
    const extraLocks = overrides.has(row.id) ? ["qualityReview"] : [];
    const merged = mergeFields({
      existing: current ? { ...current } : null,
      incoming: {
        ...row,
        sourceIds: [...row.sourceIds],
        editorialShortlistBands: [...row.editorialShortlistBands],
      },
      sourceOwned: ["name", "sourceIds", "countryId", "regionId", "stayBaseId", "areaId", "qualityReview", "editorialShortlistBands"],
      identityFields: ["name", "sourceIds", "countryId", "regionId", "stayBaseId", "areaId"],
      adminLockedFields: [...(current?.adminLockedFields ?? []), ...extraLocks],
      hasActiveAttestation: attested.has(`stay_property:${row.id}`),
    });
    holds.push(...namedHolds("stay_property", row.id, merged.holds));
    await tx.stayProperty.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        countryId: row.countryId,
        regionId: row.regionId,
        stayBaseId: row.stayBaseId,
        areaId: row.areaId,
        approval: "draft",
        name: row.name,
        sourceIds: [...row.sourceIds],
        qualityReview: row.qualityReview,
        editorialShortlistBands: [...row.editorialShortlistBands],
      },
      update: {
        approval: (merged.values.approval ?? "draft") as typeof row.approval,
        name: String(merged.values.name),
        sourceIds: stringList(merged.values.sourceIds),
        countryId: String(merged.values.countryId),
        regionId: String(merged.values.regionId),
        stayBaseId: nullableString(merged.values.stayBaseId),
        areaId: nullableString(merged.values.areaId),
        qualityReview: Boolean(merged.values.qualityReview),
        editorialShortlistBands: stringList(merged.values.editorialShortlistBands),
        adminLockedFields: lockList(merged.values),
      },
    });
  }

  const existingRates = await existingMap(tx.stayRate.findMany());
  for (const row of plan.catalog.rates) {
    const current = existingRates.get(row.id) ?? null;
    const merged = mergeFields({
      existing: current ? { ...current } : null,
      incoming: { ...row },
      sourceOwned: ["sourceId", "breakfast", "roomSizeSquareMeters", "roomCategory", "suppliedLabel", "occupancyKnown", "taxesKnown", "cancellationKnown", "stayDatesKnown"],
      identityFields: ["sourceId"],
      adminLockedFields: current?.adminLockedFields ?? [],
      hasActiveAttestation: attested.has(`stay_property:${row.propertyId}`),
    });
    holds.push(...namedHolds("stay_rate", row.id, merged.holds));
    await tx.stayRate.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        propertyId: row.propertyId,
        approval: "draft",
        sourceId: row.sourceId,
        rateKey: row.rateKey,
        suppliedLabel: row.suppliedLabel,
        roomSizeSquareMeters: row.roomSizeSquareMeters,
        roomCategory: row.roomCategory,
        breakfast: row.breakfast,
        occupancyKnown: false,
        taxesKnown: row.taxesKnown,
        cancellationKnown: row.cancellationKnown,
        stayDatesKnown: row.stayDatesKnown,
      },
      update: {
        approval: (merged.values.approval ?? "draft") as typeof row.approval,
        sourceId: String(merged.values.sourceId),
        breakfast: merged.values.breakfast as typeof row.breakfast,
        roomSizeSquareMeters: nullableNumber(merged.values.roomSizeSquareMeters),
        roomCategory: nullableString(merged.values.roomCategory),
        suppliedLabel: nullableString(merged.values.suppliedLabel),
        occupancyKnown: false,
        taxesKnown: Boolean(merged.values.taxesKnown),
        cancellationKnown: Boolean(merged.values.cancellationKnown),
        stayDatesKnown: Boolean(merged.values.stayDatesKnown),
        adminLockedFields: lockList(merged.values),
      },
    });
  }
}

async function writeFlights(
  tx: CatalogTx,
  plan: ThailandPersistencePlan,
  attested: Set<string>,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const existing = await existingMap(tx.flightTemplate.findMany());
  for (const row of plan.catalog.flightTemplates) {
    const current = existing.get(row.id) ?? null;
    const merged = mergeFields({
      existing: current ? { ...current } : null,
      incoming: { ...row, carriers: [...row.carriers] },
      sourceOwned: ["sourceId", "journey", "carriers", "carrierUnresolved", "optionLabel"],
      identityFields: ["sourceId"],
      adminLockedFields: current?.adminLockedFields ?? [],
      hasActiveAttestation: attested.has(`flight_template:${row.id}`),
    });
    holds.push(...namedHolds("flight_template", row.id, merged.holds));
    await tx.flightTemplate.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        approval: "draft",
        sourceId: row.sourceId,
        journey: row.journey,
        carriers: [...row.carriers],
        carrierUnresolved: row.carrierUnresolved,
        optionLabel: row.optionLabel,
      },
      update: {
        approval: (merged.values.approval ?? "draft") as typeof row.approval,
        sourceId: String(merged.values.sourceId),
        journey: merged.values.journey as typeof row.journey,
        carriers: stringList(merged.values.carriers),
        carrierUnresolved: Boolean(merged.values.carrierUnresolved),
        optionLabel: merged.values.optionLabel as typeof row.optionLabel,
        adminLockedFields: lockList(merged.values),
      },
    });

    const active = attested.has(`flight_template:${row.id}`);
    const locks = current?.adminLockedFields ?? [];
    for (const leg of row.legs) {
      const codes = plan.legCodes[row.id]?.find((item) => item.sequence === leg.sequence);
      const legId = `${row.id}_leg_${leg.sequence}`;
      const stored = await tx.flightLeg.findUnique({ where: { id: legId } });
      const routeChanged = stored !== null && (
        stored.origin !== leg.origin ||
        stored.destination !== leg.destination ||
        stored.endpointStayBaseId !== leg.endpointStayBaseId
      );
      const decision = stored === null
        ? "apply"
        : decideField({
            changed: routeChanged,
            identityCritical: true,
            adminLocked: locks.includes("route"),
            hasActiveAttestation: active,
            approval: current?.approval ?? "draft",
          });
      if (decision === "hold") {
        holds.push({
          subjectType: "flight_template",
          subjectId: row.id,
          field: `leg_${leg.sequence}`,
          reason: "Held the flight route for review. The import did not replace an admin-verified route.",
        });
      }
      const origin = decision === "hold" && stored ? stored.origin : leg.origin;
      const destination = decision === "hold" && stored ? stored.destination : leg.destination;
      const endpointStayBaseId = decision === "hold" && stored ? stored.endpointStayBaseId : leg.endpointStayBaseId;
      await tx.flightLeg.upsert({
        where: { id: legId },
        create: {
          id: legId,
          templateId: row.id,
          sequence: leg.sequence,
          origin,
          destination,
          originCode: codes?.originCode ?? null,
          destinationCode: codes?.destinationCode ?? null,
          endpointStayBaseId,
        },
        update: {
          origin,
          destination,
          originCode: codes?.originCode ?? null,
          destinationCode: codes?.destinationCode ?? null,
          endpointStayBaseId,
        },
      });
    }
  }
}

async function writeProfiles(tx: CatalogTx, catalog: TravelCatalog): Promise<void> {
  for (const row of catalog.referenceProfiles) {
    await tx.referenceProfile.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        propertyId: row.propertyId,
        sourceId: row.sourceId,
        statedStarRating: row.statedStarRating,
        guestScore: row.guestScore,
        guestScoreScale: row.guestScoreScale,
        provenance: "manual_import",
        verified: false,
      },
      update: {
        statedStarRating: row.statedStarRating,
        guestScore: row.guestScore,
        guestScoreScale: row.guestScoreScale,
        verified: false,
      },
    });
  }
}

async function writeRecommendations(
  tx: CatalogTx,
  catalog: TravelCatalog,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const existing = await existingMap(tx.editorialRecommendation.findMany());
  for (const row of catalog.recommendations) {
    const current = existing.get(row.id) ?? null;
    const merged = mergeFields({
      existing: current ? { ...current } : null,
      incoming: { ...row, propertyIds: [...row.propertyIds], sourceIds: [...row.sourceIds] },
      sourceOwned: ["body", "stance", "tier", "qualityReview", "propertyIds", "stayBaseId", "regionId", "sourceIds", "verified"],
      identityFields: ["body"],
      adminLockedFields: current?.adminLockedFields ?? [],
      hasActiveAttestation: false,
    });
    holds.push(...namedHolds("editorial_recommendation", row.id, merged.holds));
    await tx.editorialRecommendation.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        approval: "draft",
        verified: false,
        tier: row.tier,
        qualityReview: row.qualityReview,
        stance: row.stance,
        body: row.body,
        propertyIds: [...row.propertyIds],
        stayBaseId: row.stayBaseId,
        regionId: row.regionId,
        sourceIds: [...row.sourceIds],
      },
      update: {
        approval: (merged.values.approval ?? "draft") as typeof row.approval,
        verified: false,
        tier: (merged.values.tier ?? null) as typeof row.tier,
        qualityReview: Boolean(merged.values.qualityReview),
        stance: nullableString(merged.values.stance),
        body: String(merged.values.body),
        propertyIds: stringList(merged.values.propertyIds),
        stayBaseId: nullableString(merged.values.stayBaseId),
        regionId: nullableString(merged.values.regionId),
        sourceIds: stringList(merged.values.sourceIds),
        adminLockedFields: lockList(merged.values),
      },
    });
  }
}

async function writeArtifacts(tx: CatalogTx, plan: ThailandPersistencePlan): Promise<void> {
  for (const artifact of plan.artifacts) {
    await tx.sourceArtifact.upsert({
      where: { sourcePath: artifact.sourcePath },
      create: {
        id: artifact.id,
        sourceSystem: artifact.sourceSystem,
        sourcePath: artifact.sourcePath,
        checksum: artifact.checksum,
        role: artifact.role,
        normalizerVersion: CATALOG_NORMALIZER_VERSION,
        metadata: artifact.metadata as Prisma.InputJsonValue,
      },
      update: {
        checksum: artifact.checksum,
        role: artifact.role,
        normalizerVersion: CATALOG_NORMALIZER_VERSION,
        metadata: artifact.metadata as Prisma.InputJsonValue,
      },
    });
  }
  const artifactIdBySystem = new Map(plan.artifacts.map((artifact) => [artifact.sourceSystem, artifact.id]));
  for (const record of plan.sourceRecords) {
    const artifactId = artifactIdBySystem.get(record.sourceSystem);
    if (!artifactId) {
      throw new Error(`No artifact for ${record.sourceSystem}.`);
    }
    await tx.sourceRecord.upsert({
      where: { sourceSystem_sourceId: { sourceSystem: record.sourceSystem, sourceId: record.sourceId } },
      create: {
        id: record.id,
        artifactId,
        sourceSystem: record.sourceSystem,
        sourceId: record.sourceId,
        excerpt: record.excerpt,
      },
      update: { excerpt: record.excerpt, artifactId },
    });
  }
}

async function writeFindings(tx: CatalogTx, catalog: TravelCatalog): Promise<void> {
  for (const finding of catalog.findings) {
    const id = stableFindingId(finding);
    await tx.importFinding.upsert({
      where: { id },
      create: {
        id,
        kind: finding.kind,
        sourceId: finding.sourceId,
        field: finding.field,
        message: finding.message,
      },
      update: {
        kind: finding.kind,
        sourceId: finding.sourceId,
        field: finding.field,
        message: finding.message,
      },
    });
  }
}

async function writeAmounts(
  tx: CatalogTx,
  catalog: TravelCatalog,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  const existing = await existingMap(tx.historicalAmount.findMany());
  for (const row of catalog.amounts) {
    const current = existing.get(row.id) ?? null;
    const incoming = {
      id: row.id,
      approval: current?.approval ?? "draft",
      sourceId: row.sourceId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      note: row.note,
      subjectType: row.subject.type,
      subjectId: row.subject.id,
    };
    const merged = mergeFields({
      existing: current ? { ...current } : null,
      incoming,
      sourceOwned: ["sourceId", "amountMinor", "currency", "note", "subjectType", "subjectId"],
      identityFields: [],
      adminLockedFields: current?.adminLockedFields ?? [],
      hasActiveAttestation: false,
    });
    holds.push(...namedHolds("historical_amount", row.id, merged.holds));
    await tx.historicalAmount.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        approval: "draft",
        sourceId: row.sourceId,
        presentation: "historical_reference",
        liveQuote: false,
        freshness: "unverified",
        amountMinor: row.amountMinor,
        currency: row.currency,
        unit: row.unit,
        lastCheckedAt: null,
        lastVerifiedAt: null,
        expiresAt: null,
        note: row.note,
        subjectType: row.subject.type,
        subjectId: row.subject.id,
        providerKey: "thailand_markdown",
        externalId: row.source.externalId,
        retrievedBy: "manual",
      },
      update: {
        approval: (current?.approval ?? "draft") as "draft",
        sourceId: String(merged.values.sourceId),
        presentation: "historical_reference",
        liveQuote: false,
        freshness: "unverified",
        amountMinor: nullableNumber(merged.values.amountMinor),
        currency: nullableString(merged.values.currency),
        note: String(merged.values.note),
        lastVerifiedAt: null,
        expiresAt: null,
        adminLockedFields: lockList(merged.values),
      },
    });
  }
}

async function writeHolds(
  tx: CatalogTx,
  holds: { subjectType: string; subjectId: string; field: string; reason: string }[],
): Promise<void> {
  for (const hold of holds) {
    const id = `hold_${sha256(`${hold.subjectType}|${hold.subjectId}|${hold.field}`).slice(0, 24)}`;
    await tx.importHold.upsert({
      where: { subjectType_subjectId_field: { subjectType: hold.subjectType, subjectId: hold.subjectId, field: hold.field } },
      create: { id, ...hold },
      update: { reason: hold.reason },
    });
  }
}

async function existingMap<T extends { id: string }>(query: Promise<T[]>): Promise<Map<string, T>> {
  return new Map((await query).map((row) => [row.id, row]));
}

function mergeRow(
  existing: { approval: string; adminLockedFields?: string[] } | null,
  incoming: Record<string, unknown>,
  sourceOwned: readonly string[],
  identityFields: readonly string[],
  hasActiveAttestation: boolean,
): { values: Record<string, unknown>; holds: FieldHold[] } {
  return mergeFields({
    existing: existing ? { ...(existing as Record<string, unknown>) } : null,
    incoming,
    sourceOwned,
    identityFields,
    adminLockedFields: existing?.adminLockedFields ?? [],
    hasActiveAttestation,
  });
}

function namedHolds(
  subjectType: string,
  subjectId: string,
  holds: FieldHold[],
): { subjectType: string; subjectId: string; field: string; reason: string }[] {
  return holds.map((hold) => ({ subjectType, subjectId, field: hold.field, reason: hold.reason }));
}

function lockList(values: Record<string, unknown>): string[] {
  return Array.isArray(values.adminLockedFields) ? values.adminLockedFields.filter((item) => typeof item === "string") : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
