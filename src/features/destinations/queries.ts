import {
  alternativeItemsForDay,
  approvedCatalog,
  coreItemsForDay,
  editorialAdditionItems,
  type CatalogSnapshot,
  type CuratedTip,
  type Destination,
  type DestinationId,
  type Place,
  type PlaceId,
  type SampleItinerary,
  type SampleItineraryId,
  type SampleItineraryItem,
} from "@/lib/catalog";
import {
  destinationCovers,
  editorialPhotographs,
  placePhotos,
  type EditorialPhoto,
  type TravelPhoto,
} from "@/lib/media/travel-photos";

export type PlaceRowView = {
  key: string;
  placeId: PlaceId;
  name: string;
  summary: string;
  areaLabel: string | null;
  durationMinutes: number | null;
  note: string | null;
  photo: TravelPhoto | null;
};

export type DayView = {
  dayIndex: number;
  stops: PlaceRowView[];
  optional: PlaceRowView[];
};

export type HighlightView = {
  rowKey: string;
  dayIndex: number;
  name: string;
  areaLabel: string | null;
  photo: TravelPhoto;
};

export type DestinationPageData = {
  destination: Destination;
  itinerary: SampleItinerary | null;
  days: DayView[];
  additions: PlaceRowView[];
  tips: CuratedTip[];
  highlights: HighlightView[];
  cover: TravelPhoto | null;
  editorial: readonly EditorialPhoto[];
};

export type HomeFeature = {
  destinations: readonly {
    destination: Destination;
    itineraryTitle: string | null;
    sampleDayCount: number | null;
    cover: TravelPhoto | null;
  }[];
};

function scheduledDayIndexes(
  catalog: CatalogSnapshot,
  itineraryId: SampleItineraryId,
): number[] {
  return [
    ...new Set(
      catalog.sampleItineraryItems.flatMap((item) =>
        item.itineraryId === itineraryId && item.dayIndex !== null ? [item.dayIndex] : [],
      ),
    ),
  ].sort((left, right) => left - right);
}

function placeMap(places: readonly Place[]): Map<PlaceId, Place> {
  return new Map(places.map((place) => [place.id, place]));
}

function toRow(
  item: SampleItineraryItem,
  places: Map<PlaceId, Place>,
): PlaceRowView | null {
  const place = places.get(item.placeId);

  if (!place) {
    return null;
  }

  return {
    key: item.id,
    placeId: place.id,
    name: place.name,
    summary: place.editorialSummary,
    areaLabel: place.areaLabel,
    durationMinutes: place.approximateDurationMinutes,
    note: item.editorialNote,
    photo: placePhotos[place.id] ?? null,
  };
}

function rows(items: readonly SampleItineraryItem[], places: Map<PlaceId, Place>): PlaceRowView[] {
  return items.flatMap((item) => {
    const row = toRow(item, places);
    return row ? [row] : [];
  });
}

/**
 * Distinct scheduled days on the approved sample itinerary.
 * Editorial additions have no day index and stay out of the count.
 */
export function approvedSampleDayCount(
  snapshot: CatalogSnapshot,
  destinationId: DestinationId,
): number | null {
  const catalog = approvedCatalog(snapshot);
  const itinerary =
    catalog.sampleItineraries.find((item) => item.destinationIds.includes(destinationId)) ?? null;

  if (!itinerary) {
    return null;
  }

  const count = scheduledDayIndexes(catalog, itinerary.id).length;
  return count === 0 ? null : count;
}

export function getHomeFeature(snapshot: CatalogSnapshot): HomeFeature {
  const catalog = approvedCatalog(snapshot);

  return {
    destinations: [...catalog.destinations].sort(bySlug).map((destination) => ({
      destination,
      itineraryTitle:
        catalog.sampleItineraries.find((itinerary) =>
          itinerary.destinationIds.includes(destination.id),
        )?.title ?? null,
      sampleDayCount: approvedSampleDayCount(snapshot, destination.id),
      cover: destinationCovers[destination.id] ?? null,
    })),
  };
}

export function getDestinationPage(
  snapshot: CatalogSnapshot,
  slug: string,
): DestinationPageData | null {
  const catalog = approvedCatalog(snapshot);
  const destination = catalog.destinations.find((item) => item.slug === slug);

  if (!destination) {
    return null;
  }

  const places = placeMap(
    catalog.places.filter((place) => place.destinationId === destination.id),
  );
  const placeIds = new Set(places.keys());
  const itinerary =
    catalog.sampleItineraries.find((item) => item.destinationIds.includes(destination.id)) ??
    null;

  const dayIndexes = itinerary ? scheduledDayIndexes(catalog, itinerary.id) : [];

  const days: DayView[] = itinerary
    ? dayIndexes.map((dayIndex) => ({
        dayIndex,
        stops: rows(coreItemsForDay(catalog, itinerary.id, dayIndex), places),
        optional: rows(alternativeItemsForDay(catalog, itinerary.id, dayIndex), places),
      }))
    : [];

  const additions = itinerary
    ? rows(editorialAdditionItems(catalog, itinerary.id), places)
    : [];

  const highlights: HighlightView[] = [];
  const seenPlaces = new Set<PlaceId>();

  for (const day of days) {
    for (const stop of day.stops) {
      if (!stop.photo || seenPlaces.has(stop.placeId)) {
        continue;
      }

      seenPlaces.add(stop.placeId);
      highlights.push({
        rowKey: stop.key,
        dayIndex: day.dayIndex,
        name: stop.name,
        areaLabel: stop.areaLabel,
        photo: stop.photo,
      });
    }
  }

  const tips = catalog.tips.filter((tip) => {
    if (tip.subject.type === "destination") {
      return tip.subject.id === destination.id;
    }

    return placeIds.has(tip.subject.id);
  });

  return {
    destination,
    itinerary,
    days,
    additions,
    tips,
    highlights,
    cover: destinationCovers[destination.id] ?? null,
    editorial: editorialPhotographs[destination.id] ?? [],
  };
}

function bySlug(left: { slug: string }, right: { slug: string }): number {
  if (left.slug < right.slug) {
    return -1;
  }
  if (left.slug > right.slug) {
    return 1;
  }
  return 0;
}
