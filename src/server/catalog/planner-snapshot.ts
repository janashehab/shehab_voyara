import {
  getPrototypeCatalog,
  type CatalogSnapshot,
  type CatalogStatus,
  type DestinationId,
  type PlaceId,
} from "@/lib/catalog";
import type { PrismaClient } from "@/generated/prisma/client";

import type { PlannerCatalogRepository } from "@/server/services/planner/catalog-repository";

/**
 * Reads the persisted catalog into the snapshot the planner already accepts.
 * Historical amounts are not copied into dynamic facts.
 */
export function prismaPlannerRepository(prisma: PrismaClient): PlannerCatalogRepository {
  return {
    async loadPlannerSnapshot() {
      return loadPlannerSnapshot(prisma);
    },
  };
}

export async function loadPlannerSnapshot(prisma: PrismaClient): Promise<CatalogSnapshot> {
  const [countries, stayBases, places, tips, itineraries, items] = await Promise.all([
    prisma.country.findMany(),
    prisma.stayBase.findMany(),
    prisma.place.findMany(),
    prisma.curatedTip.findMany(),
    prisma.sampleItinerary.findMany(),
    prisma.sampleItineraryItem.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);
  const countryById = new Map(countries.map((country) => [country.id, country]));

  return {
    destinations: stayBases.map((base) =>
      toDestination(base, countryById.get(base.countryId)?.countryCode ?? ""),
    ),
    places: places.map((place) => toPlace(place)),
    tips: tips.map((tip) => toTip(tip)),
    dynamicFacts: [],
    sampleItineraries: itineraries.map((itinerary) => toItinerary(itinerary)),
    sampleItineraryItems: items.map((item) => toItem(item)),
  };
}

/**
 * Approved editorial rows for the public catalog snapshot.
 * Stay bases must themselves be approved and belong to an approved country
 * and an approved region in that country. Historical amounts are not read.
 */
export async function loadApprovedEditorialCatalog(prisma: PrismaClient): Promise<CatalogSnapshot> {
  const fixture = getPrototypeCatalog();
  const approvedHierarchy = {
    approval: "approved" as const,
    country: { approval: "approved" as const },
    region: { approval: "approved" as const },
  };
  const stayBases = (
    await prisma.stayBase.findMany({
      where: approvedHierarchy,
      include: { country: true, region: true },
    })
  ).filter((base) => base.region.countryId === base.countryId);
  const stayBaseIds = stayBases.map((base) => base.id);
  const places =
    stayBaseIds.length === 0
      ? []
      : await prisma.place.findMany({
          where: {
            approval: "approved",
            stayBaseId: { in: stayBaseIds },
            stayBase: approvedHierarchy,
          },
        });
  const placeIds = places.map((place) => place.id);
  const tipFilters: { subjectType: string; subjectId: { in: string[] } }[] = [];
  if (stayBaseIds.length > 0) {
    tipFilters.push({ subjectType: "stay_base", subjectId: { in: stayBaseIds } });
  }
  if (placeIds.length > 0) {
    tipFilters.push({ subjectType: "place", subjectId: { in: placeIds } });
  }
  const tips =
    tipFilters.length === 0
      ? []
      : await prisma.curatedTip.findMany({
          where: { approval: "approved", OR: tipFilters },
        });
  const approvedStayBaseIds = new Set(stayBaseIds);
  const itineraries = (
    await prisma.sampleItinerary.findMany({ where: { approval: "approved" } })
  ).filter(
    (itinerary) =>
      itinerary.stayBaseIds.length > 0 &&
      itinerary.stayBaseIds.every((id) => approvedStayBaseIds.has(id)),
  );
  const itineraryIds = itineraries.map((itinerary) => itinerary.id);
  const items =
    itineraryIds.length === 0 || placeIds.length === 0
      ? []
      : await prisma.sampleItineraryItem.findMany({
          where: {
            itineraryId: { in: itineraryIds },
            placeId: { in: placeIds },
            place: { approval: "approved", stayBase: approvedHierarchy },
          },
        });

  return {
    destinations: orderLikeFixture(
      stayBases.map((base) => toDestination(base, base.country.countryCode)),
      fixture.destinations.map((destination) => destination.id),
    ),
    places: orderLikeFixture(
      places.map((place) => toPlace(place)),
      fixture.places.map((place) => place.id),
    ),
    tips: orderLikeFixture(
      tips.map((tip) => toTip(tip)),
      fixture.tips.map((tip) => tip.id),
    ),
    dynamicFacts: [],
    sampleItineraries: orderLikeFixture(
      itineraries.map((itinerary) => toItinerary(itinerary)),
      fixture.sampleItineraries.map((itinerary) => itinerary.id),
    ),
    sampleItineraryItems: orderLikeFixture(
      items.map((item) => toItem(item)),
      fixture.sampleItineraryItems.map((item) => item.id),
    ),
  };
}

type StayBaseRow = {
  id: string;
  approval: string;
  slug: string;
  name: string;
  summary: string;
  vibeTags: string[];
};

type PlaceRow = {
  id: string;
  stayBaseId: string;
  approval: string;
  name: string;
  kind: CatalogSnapshot["places"][number]["kind"];
  editorialSummary: string;
  vibeTags: string[];
  areaLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  approximateDurationMinutes: number | null;
};

type TipRow = {
  id: string;
  approval: string;
  subjectType: string;
  subjectId: string;
  body: string;
};

type ItineraryRow = {
  id: string;
  approval: string;
  title: string;
  stayBaseIds: string[];
  editorialNote: string | null;
};

type ItemRow = {
  id: string;
  itineraryId: string;
  dayIndex: number | null;
  sortOrder: number;
  placeId: string;
  role: CatalogSnapshot["sampleItineraryItems"][number]["role"];
  editorialNote: string | null;
};

function toDestination(base: StayBaseRow, countryCode: string): CatalogSnapshot["destinations"][number] {
  return {
    id: base.id as DestinationId,
    status: plannerStatus(base.approval),
    slug: base.slug,
    name: base.name,
    countryCode,
    editorialSummary: base.summary,
    vibeTags: base.vibeTags,
  };
}

function toPlace(place: PlaceRow): CatalogSnapshot["places"][number] {
  return {
    id: place.id as PlaceId,
    destinationId: place.stayBaseId as DestinationId,
    status: plannerStatus(place.approval),
    name: place.name,
    kind: place.kind,
    editorialSummary: place.editorialSummary,
    vibeTags: place.vibeTags,
    areaLabel: place.areaLabel,
    approximateCoordinates:
      place.latitude === null || place.longitude === null
        ? null
        : { latitude: place.latitude, longitude: place.longitude },
    approximateDurationMinutes: place.approximateDurationMinutes,
  };
}

function toTip(tip: TipRow): CatalogSnapshot["tips"][number] {
  return {
    id: tip.id as CatalogSnapshot["tips"][number]["id"],
    status: plannerStatus(tip.approval),
    subject:
      tip.subjectType === "place"
        ? { type: "place" as const, id: tip.subjectId as PlaceId }
        : { type: "destination" as const, id: tip.subjectId as DestinationId },
    body: tip.body,
  };
}

function toItinerary(itinerary: ItineraryRow): CatalogSnapshot["sampleItineraries"][number] {
  return {
    id: itinerary.id as CatalogSnapshot["sampleItineraries"][number]["id"],
    status: plannerStatus(itinerary.approval),
    title: itinerary.title,
    destinationIds: itinerary.stayBaseIds as DestinationId[],
    editorialNote: itinerary.editorialNote,
  };
}

function toItem(item: ItemRow): CatalogSnapshot["sampleItineraryItems"][number] {
  return {
    id: item.id as CatalogSnapshot["sampleItineraryItems"][number]["id"],
    itineraryId: item.itineraryId as CatalogSnapshot["sampleItineraries"][number]["id"],
    dayIndex: item.dayIndex,
    sortOrder: item.sortOrder,
    placeId: item.placeId as PlaceId,
    role: item.role,
    editorialNote: item.editorialNote,
  };
}

function plannerStatus(approval: string): CatalogStatus {
  return approval === "approved" ? "approved" : "draft";
}

function orderLikeFixture<T extends { id: string }>(rows: readonly T[], fixtureIds: readonly string[]): T[] {
  const rank = new Map(fixtureIds.map((id, index) => [id, index]));
  return [...rows].sort((left, right) => compareFixtureOrder(left.id, right.id, rank));
}

function compareFixtureOrder(leftId: string, rightId: string, rank: ReadonlyMap<string, number>): number {
  const leftRank = rank.get(leftId);
  const rightRank = rank.get(rightId);
  if (leftRank !== undefined && rightRank !== undefined) {
    return leftRank - rightRank;
  }
  if (leftRank !== undefined) {
    return -1;
  }
  if (rightRank !== undefined) {
    return 1;
  }
  if (leftId < rightId) {
    return -1;
  }
  if (leftId > rightId) {
    return 1;
  }
  return 0;
}
