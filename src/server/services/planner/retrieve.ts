import {
  approvedCatalog,
  type CatalogSnapshot,
  type Destination,
  type DestinationId,
  type ItemRole,
  type Place,
  type PlaceId,
  type SampleItineraryId,
} from "@/lib/catalog";

/**
 * Marne-la-Vallée is Disneyland Paris and the rides catalogued with it.
 * Those places are one full-day commitment, not a string of short city stops.
 * Another approved destination can add an area label here later. This list
 * does not change the catalog.
 */
export const MAJOR_DAY_AREA_LABELS = ["Marne-la-Vallée"] as const;

export function isMajorDayArea(areaLabel: string | null): boolean {
  if (areaLabel === null) {
    return false;
  }

  return MAJOR_DAY_AREA_LABELS.some((label) => label === areaLabel);
}

export type RetrievalPlace = {
  id: PlaceId;
  name: string;
  kind: Place["kind"];
  areaLabel: string | null;
  vibeTags: readonly string[];
  approximateDurationMinutes: number | null;
  coordinates: { latitude: number; longitude: number } | null;
  majorDayCommitment: boolean;
};

export type RetrievalExampleStop = {
  dayIndex: number | null;
  placeId: PlaceId;
  role: ItemRole;
};

export type RetrievalSet = {
  destination: Destination;
  places: readonly RetrievalPlace[];
  placeById: ReadonlyMap<string, RetrievalPlace>;
  exampleRoute: {
    itineraryId: SampleItineraryId;
    label: "editorial example, not a required route";
    stops: readonly RetrievalExampleStop[];
  } | null;
};

export function isDestinationId(value: string): value is DestinationId {
  return /^dst_[a-z0-9_]+$/.test(value);
}

export function isPlaceId(value: string): value is PlaceId {
  return /^plc_[a-z0-9_]+$/.test(value);
}

export function retrieveDestination(
  snapshot: CatalogSnapshot,
  destinationId: string,
): RetrievalSet | null {
  if (!isDestinationId(destinationId)) {
    return null;
  }

  const catalog = approvedCatalog(snapshot);
  const destination = catalog.destinations.find((item) => item.id === destinationId);

  if (!destination) {
    return null;
  }

  const places = catalog.places
    .filter((place) => place.destinationId === destination.id)
    .map(toRetrievalPlace);
  const example = catalog.sampleItineraries.find((itinerary) =>
    itinerary.destinationIds.includes(destination.id),
  );

  return {
    destination,
    places,
    placeById: new Map(places.map((place) => [place.id, place])),
    exampleRoute: example
      ? {
          itineraryId: example.id,
          label: "editorial example, not a required route",
          stops: catalog.sampleItineraryItems
            .filter((item) => item.itineraryId === example.id)
            .map((item) => ({
              dayIndex: item.dayIndex,
              placeId: item.placeId,
              role: item.role,
            })),
        }
      : null,
  };
}

function toRetrievalPlace(place: Place): RetrievalPlace {
  return {
    id: place.id,
    name: place.name,
    kind: place.kind,
    areaLabel: place.areaLabel,
    vibeTags: place.vibeTags,
    approximateDurationMinutes: place.approximateDurationMinutes,
    coordinates: place.approximateCoordinates,
    majorDayCommitment: isMajorDayArea(place.areaLabel),
  };
}
