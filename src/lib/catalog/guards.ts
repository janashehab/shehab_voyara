import type {
  CatalogSnapshot,
  CatalogStatus,
  Destination,
  DestinationId,
  DynamicFact,
  Place,
  PlaceId,
  SampleItinerary,
  SampleItineraryId,
  SampleItineraryItem,
} from "./types";

export type CatalogIssueCode =
  | "duplicate_id"
  | "empty_text"
  | "missing_destination"
  | "missing_place"
  | "missing_itinerary"
  | "destination_not_on_itinerary"
  | "unapproved_reference"
  | "editorial_addition_has_day"
  | "core_item_missing_day"
  | "invalid_day_index"
  | "invalid_sort_order"
  | "duplicate_sort_order"
  | "invalid_duration"
  | "invalid_coordinates"
  | "fresh_fact_missing_verification"
  | "money_on_non_price"
  | "prohibited_content";

export type CatalogIssue = {
  code: CatalogIssueCode;
  recordId: string;
  message: string;
};

const PROHIBITED_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "clock time", pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/ },
  { label: "currency symbol", pattern: /[€$£]/ },
  { label: "PIN", pattern: /\bPIN\b/ },
  { label: "confirmation number", pattern: /confirmation number/i },
  { label: "booking reference", pattern: /booking reference/i },
  { label: "last train", pattern: /last train/i },
];

export function approvedDestinations(
  snapshot: CatalogSnapshot,
): readonly Destination[] {
  return snapshot.destinations.filter(isApproved);
}

export function approvedPlaces(snapshot: CatalogSnapshot): readonly Place[] {
  return snapshot.places.filter(isApproved);
}

export function approvedTips(snapshot: CatalogSnapshot) {
  return snapshot.tips.filter(isApproved);
}

export function approvedSampleItineraries(
  snapshot: CatalogSnapshot,
): readonly SampleItinerary[] {
  return snapshot.sampleItineraries.filter(isApproved);
}

export function approvedCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
  const destinations = approvedDestinations(snapshot);
  const places = approvedPlaces(snapshot);
  const destinationIds = new Set(destinations.map((destination) => destination.id));
  const placeIds = new Set(places.map((place) => place.id));
  const sampleItineraries = approvedSampleItineraries(snapshot).filter((itinerary) =>
    itinerary.destinationIds.every((id) => destinationIds.has(id)),
  );
  const itineraryIds = new Set(sampleItineraries.map((itinerary) => itinerary.id));

  return {
    destinations,
    places,
    tips: approvedTips(snapshot).filter((tip) =>
      containsSubject(tip.subject, destinationIds, placeIds),
    ),
    dynamicFacts: snapshot.dynamicFacts.filter((fact) =>
      containsSubject(fact.subject, destinationIds, placeIds),
    ),
    sampleItineraries,
    sampleItineraryItems: snapshot.sampleItineraryItems.filter(
      (item) => itineraryIds.has(item.itineraryId) && placeIds.has(item.placeId),
    ),
  };
}

export function coreItemsForDay(
  snapshot: CatalogSnapshot,
  itineraryId: SampleItineraryId,
  dayIndex: number,
): readonly SampleItineraryItem[] {
  return itemsWithRole(snapshot, itineraryId, dayIndex, "core");
}

export function alternativeItemsForDay(
  snapshot: CatalogSnapshot,
  itineraryId: SampleItineraryId,
  dayIndex: number,
): readonly SampleItineraryItem[] {
  return itemsWithRole(snapshot, itineraryId, dayIndex, "alternative");
}

export function editorialAdditionItems(
  snapshot: CatalogSnapshot,
  itineraryId: SampleItineraryId,
): readonly SampleItineraryItem[] {
  return snapshot.sampleItineraryItems
    .filter(
      (item) => item.itineraryId === itineraryId && item.role === "editorial_addition",
    )
    .sort(bySortOrder);
}

export function isVerifiedDynamicFact(fact: DynamicFact): boolean {
  return (
    fact.freshness === "fresh" &&
    fact.lastCheckedAt !== null &&
    fact.lastVerifiedAt !== null
  );
}

export function verifiedAmountMinor(fact: DynamicFact): number | null {
  if (!isVerifiedDynamicFact(fact) || fact.kind !== "price" || fact.amountMinor === null) {
    return null;
  }

  return fact.amountMinor;
}

export function checkCatalogIntegrity(snapshot: CatalogSnapshot): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  issues.push(
    ...duplicateIds(
      snapshot.destinations.map((destination) => destination.id),
      "destination",
    ),
    ...duplicateIds(
      snapshot.places.map((place) => place.id),
      "place",
    ),
    ...duplicateIds(
      snapshot.tips.map((tip) => tip.id),
      "tip",
    ),
    ...duplicateIds(
      snapshot.dynamicFacts.map((fact) => fact.id),
      "dynamic fact",
    ),
    ...duplicateIds(
      snapshot.sampleItineraries.map((itinerary) => itinerary.id),
      "itinerary",
    ),
    ...duplicateIds(
      snapshot.sampleItineraryItems.map((item) => item.id),
      "itinerary item",
    ),
  );

  const destinations = indexById(snapshot.destinations);
  const places = indexById(snapshot.places);
  const itineraries = indexById(snapshot.sampleItineraries);
  const sortKeys = new Set<string>();

  for (const destination of snapshot.destinations) {
    issues.push(
      ...requireText(destination.id, "Destination name", destination.name),
      ...requireText(destination.id, "Destination summary", destination.editorialSummary),
      ...requireText(destination.id, "Destination slug", destination.slug),
      ...prohibitedText(destination.id, [
        destination.name,
        destination.editorialSummary,
        destination.slug,
        ...destination.vibeTags,
      ]),
    );
  }

  for (const place of snapshot.places) {
    issues.push(
      ...requireText(place.id, "Place name", place.name),
      ...requireText(place.id, "Place summary", place.editorialSummary),
      ...coordinateIssues(place),
      ...durationIssues(place),
      ...prohibitedText(place.id, [
        place.name,
        place.editorialSummary,
        place.areaLabel,
        ...place.vibeTags,
      ]),
    );

    if (!destinations.has(place.destinationId)) {
      issues.push({
        code: "missing_destination",
        recordId: place.id,
        message: `Place references missing destination ${place.destinationId}.`,
      });
    }
  }

  for (const tip of snapshot.tips) {
    issues.push(
      ...requireText(tip.id, "Tip body", tip.body),
      ...prohibitedText(tip.id, [tip.body]),
      ...subjectIssues(tip.id, tip.subject, tip.status, destinations, places),
    );
  }

  for (const fact of snapshot.dynamicFacts) {
    issues.push(
      ...requireText(fact.id, "Historical note", fact.historicalNote),
      ...prohibitedText(fact.id, [
        fact.historicalNote,
        fact.source.providerKey,
        fact.source.externalId,
        fact.currency,
      ]),
      ...subjectIssues(fact.id, fact.subject, "approved", destinations, places),
    );

    if (
      fact.freshness === "fresh" &&
      (fact.lastCheckedAt === null || fact.lastVerifiedAt === null)
    ) {
      issues.push({
        code: "fresh_fact_missing_verification",
        recordId: fact.id,
        message: "A fresh fact needs lastCheckedAt and lastVerifiedAt.",
      });
    }

    if (fact.kind !== "price" && (fact.amountMinor !== null || fact.currency !== null)) {
      issues.push({
        code: "money_on_non_price",
        recordId: fact.id,
        message: "Only price facts may carry monetary fields.",
      });
    }
  }

  for (const itinerary of snapshot.sampleItineraries) {
    issues.push(
      ...requireText(itinerary.id, "Itinerary title", itinerary.title),
      ...prohibitedText(itinerary.id, [itinerary.title, itinerary.editorialNote]),
    );

    if (itinerary.destinationIds.length === 0) {
      issues.push({
        code: "missing_destination",
        recordId: itinerary.id,
        message: "Sample itinerary has no destinations.",
      });
    }

    for (const destinationId of itinerary.destinationIds) {
      const destination = destinations.get(destinationId);
      if (!destination) {
        issues.push({
          code: "missing_destination",
          recordId: itinerary.id,
          message: `Itinerary references missing destination ${destinationId}.`,
        });
      } else if (itinerary.status === "approved" && destination.status !== "approved") {
        issues.push({
          code: "unapproved_reference",
          recordId: itinerary.id,
          message: `Approved itinerary references draft destination ${destinationId}.`,
        });
      }
    }
  }

  for (const item of snapshot.sampleItineraryItems) {
    issues.push(...prohibitedText(item.id, [item.editorialNote]));

    const itinerary = itineraries.get(item.itineraryId);
    if (!itinerary) {
      issues.push({
        code: "missing_itinerary",
        recordId: item.id,
        message: `Item references missing itinerary ${item.itineraryId}.`,
      });
    }

    const place = places.get(item.placeId);
    if (!place) {
      issues.push({
        code: "missing_place",
        recordId: item.id,
        message: `Item references missing place ${item.placeId}.`,
      });
    }

    if (place && itinerary?.status === "approved" && place.status !== "approved") {
      issues.push({
        code: "unapproved_reference",
        recordId: item.id,
        message: `Approved itinerary references draft place ${item.placeId}.`,
      });
    }

    if (place && itinerary && !itinerary.destinationIds.includes(place.destinationId)) {
      issues.push({
        code: "destination_not_on_itinerary",
        recordId: item.id,
        message: `Place ${item.placeId} belongs to a destination outside this itinerary.`,
      });
    }

    issues.push(...itemShapeIssues(item));

    if (Number.isInteger(item.sortOrder) && item.sortOrder > 0) {
      const sortKey = `${item.itineraryId}:${item.dayIndex ?? "none"}:${item.role}:${item.sortOrder}`;
      if (sortKeys.has(sortKey)) {
        issues.push({
          code: "duplicate_sort_order",
          recordId: item.id,
          message: "Two items share a sort order in the same group.",
        });
      }
      sortKeys.add(sortKey);
    }
  }

  return issues;
}

function itemsWithRole(
  snapshot: CatalogSnapshot,
  itineraryId: SampleItineraryId,
  dayIndex: number,
  role: SampleItineraryItem["role"],
): readonly SampleItineraryItem[] {
  return snapshot.sampleItineraryItems
    .filter(
      (item) =>
        item.itineraryId === itineraryId &&
        item.dayIndex === dayIndex &&
        item.role === role,
    )
    .sort(bySortOrder);
}

function itemShapeIssues(item: SampleItineraryItem): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  if (!Number.isInteger(item.sortOrder) || item.sortOrder <= 0) {
    issues.push({
      code: "invalid_sort_order",
      recordId: item.id,
      message: "Sort order must be a positive integer.",
    });
  }

  if (item.role === "editorial_addition") {
    if (item.dayIndex !== null) {
      issues.push({
        code: "editorial_addition_has_day",
        recordId: item.id,
        message: "Editorial additions stay off the day sequence.",
      });
    }
    return issues;
  }

  if (item.role === "core" && item.dayIndex === null) {
    issues.push({
      code: "core_item_missing_day",
      recordId: item.id,
      message: "Core items belong to a day.",
    });
    return issues;
  }

  if (
    item.dayIndex !== null &&
    (!Number.isInteger(item.dayIndex) || item.dayIndex < 1)
  ) {
    issues.push({
      code: "invalid_day_index",
      recordId: item.id,
      message: "Day index must be a positive integer.",
    });
  }

  return issues;
}

function subjectIssues(
  recordId: string,
  subject: DynamicFact["subject"],
  status: CatalogStatus,
  destinations: ReadonlyMap<DestinationId, Destination>,
  places: ReadonlyMap<PlaceId, Place>,
): CatalogIssue[] {
  if (subject.type === "destination") {
    const destination = destinations.get(subject.id);
    if (!destination) {
      return [
        {
          code: "missing_destination",
          recordId,
          message: `Record references missing destination ${subject.id}.`,
        },
      ];
    }
    if (status === "approved" && destination.status !== "approved") {
      return [
        {
          code: "unapproved_reference",
          recordId,
          message: `Approved record references draft destination ${subject.id}.`,
        },
      ];
    }
    return [];
  }

  const place = places.get(subject.id);
  if (!place) {
    return [
      {
        code: "missing_place",
        recordId,
        message: `Record references missing place ${subject.id}.`,
      },
    ];
  }
  if (status === "approved" && place.status !== "approved") {
    return [
      {
        code: "unapproved_reference",
        recordId,
        message: `Approved record references draft place ${subject.id}.`,
      },
    ];
  }
  return [];
}

function coordinateIssues(place: Place): CatalogIssue[] {
  const coordinates = place.approximateCoordinates;
  if (coordinates === null) {
    return [];
  }

  const latitudeOk = coordinates.latitude >= -90 && coordinates.latitude <= 90;
  const longitudeOk = coordinates.longitude >= -180 && coordinates.longitude <= 180;
  if (latitudeOk && longitudeOk) {
    return [];
  }

  return [
    {
      code: "invalid_coordinates",
      recordId: place.id,
      message: "Approximate coordinates are out of range.",
    },
  ];
}

function durationIssues(place: Place): CatalogIssue[] {
  const minutes = place.approximateDurationMinutes;
  if (minutes === null) {
    return [];
  }
  if (Number.isInteger(minutes) && minutes > 0) {
    return [];
  }

  return [
    {
      code: "invalid_duration",
      recordId: place.id,
      message: "Approximate duration must be a positive number of minutes.",
    },
  ];
}

function prohibitedText(
  recordId: string,
  values: readonly (string | null)[],
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];

  for (const value of values) {
    if (value === null) {
      continue;
    }
    for (const rule of PROHIBITED_PATTERNS) {
      if (rule.pattern.test(value)) {
        issues.push({
          code: "prohibited_content",
          recordId,
          message: `Text includes a ${rule.label}.`,
        });
      }
    }
  }

  return issues;
}

function requireText(
  recordId: string,
  label: string,
  value: string,
): CatalogIssue[] {
  if (value.trim().length > 0) {
    return [];
  }

  return [
    {
      code: "empty_text",
      recordId,
      message: `${label} is empty.`,
    },
  ];
}

function duplicateIds(ids: readonly string[], label: string): CatalogIssue[] {
  const seen = new Set<string>();
  const issues: CatalogIssue[] = [];

  for (const id of ids) {
    if (seen.has(id)) {
      issues.push({
        code: "duplicate_id",
        recordId: id,
        message: `Duplicate ${label} id.`,
      });
    }
    seen.add(id);
  }

  return issues;
}

function indexById<T extends { id: string }>(records: readonly T[]): Map<T["id"], T> {
  return new Map(records.map((record) => [record.id, record]));
}

function containsSubject(
  subject: DynamicFact["subject"],
  destinationIds: ReadonlySet<string>,
  placeIds: ReadonlySet<string>,
): boolean {
  return subject.type === "destination"
    ? destinationIds.has(subject.id)
    : placeIds.has(subject.id);
}

function isApproved<T extends { status: CatalogStatus }>(record: T): boolean {
  return record.status === "approved";
}

function bySortOrder(left: SampleItineraryItem, right: SampleItineraryItem): number {
  return left.sortOrder - right.sortOrder;
}
