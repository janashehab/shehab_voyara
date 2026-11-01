import {
  alternativeItemsForDay,
  approvedCatalog,
  coreItemsForDay,
  editorialAdditionItems,
  getPrototypeCatalog,
  type CatalogSnapshot,
  type CuratedTip,
  type Destination,
  type Place,
  type PlaceId,
  type SampleItinerary,
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
    cover: TravelPhoto | null;
  }[];
};

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

export function getHomeFeature(snapshot: CatalogSnapshot): HomeFeature {
  const catalog = approvedCatalog(snapshot);

  return {
    destinations: catalog.destinations.map((destination) => ({
      destination,
      itineraryTitle:
        catalog.sampleItineraries.find((itinerary) =>
          itinerary.destinationIds.includes(destination.id),
        )?.title ?? null,
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

  const dayIndexes = itinerary
    ? [
        ...new Set(
          catalog.sampleItineraryItems
            .filter((item) => item.itineraryId === itinerary.id && item.dayIndex !== null)
            .map((item) => item.dayIndex as number),
        ),
      ].sort((left, right) => left - right)
    : [];

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

/** Synchronous slug list for the proxy and generateStaticParams. It does not open the database. */
export function approvedDestinationSlugs(): string[] {
  return approvedCatalog(getPrototypeCatalog()).destinations.map(
    (destination) => destination.slug,
  );
}
