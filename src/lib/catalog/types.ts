export type CatalogStatus = "draft" | "approved";

export type DestinationId = `dst_${string}`;
export type PlaceId = `plc_${string}`;
export type CuratedTipId = `tip_${string}`;
export type SampleItineraryId = `itn_${string}`;
export type SampleItineraryItemId = `iti_${string}`;
export type DynamicFactId = `dyn_${string}`;

export type Freshness =
  | "unverified"
  | "fresh"
  | "stale"
  | "expired"
  | "refresh_failed";

export type PlaceKind =
  | "poi"
  | "food"
  | "neighborhood"
  | "hotel"
  | "activity"
  | "transport";

export type ApproximateCoordinates = {
  latitude: number;
  longitude: number;
};

export type FactSubject =
  | { type: "destination"; id: DestinationId }
  | { type: "place"; id: PlaceId };

export type FactSource = {
  providerKey: string;
  externalId: string | null;
  retrievedBy: "manual" | "sync" | "revalidation";
};

/**
 * Core stops are the day sequence. Alternatives and editorial additions are
 * optional and are not a claim that every stop fits in one day.
 */
export type ItemRole = "core" | "alternative" | "editorial_addition";

export type Destination = {
  id: DestinationId;
  status: CatalogStatus;
  slug: string;
  name: string;
  countryCode: string;
  editorialSummary: string;
  vibeTags: readonly string[];
};

export type Place = {
  id: PlaceId;
  destinationId: DestinationId;
  status: CatalogStatus;
  name: string;
  kind: PlaceKind;
  editorialSummary: string;
  vibeTags: readonly string[];
  areaLabel: string | null;
  approximateCoordinates: ApproximateCoordinates | null;
  approximateDurationMinutes: number | null;
};

export type CuratedTip = {
  id: CuratedTipId;
  status: CatalogStatus;
  subject: FactSubject;
  body: string;
};

export type SampleItinerary = {
  id: SampleItineraryId;
  status: CatalogStatus;
  title: string;
  destinationIds: readonly DestinationId[];
  editorialNote: string | null;
};

export type SampleItineraryItem = {
  id: SampleItineraryItemId;
  itineraryId: SampleItineraryId;
  dayIndex: number | null;
  sortOrder: number;
  placeId: PlaceId;
  role: ItemRole;
  editorialNote: string | null;
};

/**
 * Operational notes such as historical prices, opening times, and transport.
 * amountMinor is the smallest currency unit. A non-null amount is still
 * unverified until freshness is fresh and lastVerifiedAt is set.
 */
export type DynamicFact = {
  id: DynamicFactId;
  subject: FactSubject;
  kind: "price" | "opening_hours" | "transport_schedule";
  freshness: Freshness;
  source: FactSource;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  historicalNote: string;
  amountMinor: number | null;
  currency: string | null;
};

export type CatalogSnapshot = {
  destinations: readonly Destination[];
  places: readonly Place[];
  tips: readonly CuratedTip[];
  dynamicFacts: readonly DynamicFact[];
  sampleItineraries: readonly SampleItinerary[];
  sampleItineraryItems: readonly SampleItineraryItem[];
};
