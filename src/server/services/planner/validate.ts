import type { CatalogSnapshot } from "@/lib/catalog";
import {
  plannerDraftSchema,
  shiftIsoDate,
  travelerPreferencesSchema,
  tripDocumentSchema,
  type PlannerDraft,
  type TravelerPreferences,
  type TripDocument,
  type TripItem,
} from "@/features/trips/schemas";
import { issue, zodIssues, type PlannerIssue } from "./issues";
import { recomputeNotices } from "./policy";
import { retrieveDestination, type RetrievalSet } from "./retrieve";
import { acceptableCopy } from "./text";

export type ParsedPreferences =
  | { ok: true; preferences: TravelerPreferences; retrieval: RetrievalSet }
  | { ok: false; issues: PlannerIssue[] };

export type ParsedTrip =
  | { ok: true; trip: TripDocument; retrieval: RetrievalSet }
  | { ok: false; issues: PlannerIssue[] };

export function parseTravelerPreferences(input: unknown, catalog: CatalogSnapshot): ParsedPreferences {
  const parsed = travelerPreferencesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }

  const retrieval = approvedRetrieval(catalog, parsed.data.destinationId);
  if (!retrieval) {
    return {
      ok: false,
      issues: [
        issue(
          "unapproved_destination",
          "destinationId",
          "The destination is not an approved catalog record.",
        ),
      ],
    };
  }

  const placeIssues = placeListIssues(
    [
      ...parsed.data.constraints.mustSeePlaceIds.map((placeId) => ({
        placeId,
        path: "constraints.mustSeePlaceIds",
      })),
      ...parsed.data.exclusions.placeIds.map((placeId) => ({
        placeId,
        path: "exclusions.placeIds",
      })),
    ],
    retrieval,
  );

  if (placeIssues.length > 0) {
    return { ok: false, issues: placeIssues };
  }

  return { ok: true, preferences: parsed.data, retrieval };
}

export function parsePlannerDraft(input: unknown): { ok: true; draft: PlannerDraft } | { ok: false; issues: PlannerIssue[] } {
  const parsed = plannerDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }
  return { ok: true, draft: parsed.data };
}

/**
 * Client trip documents are untrusted. Shape, locks, roles, sources, place
 * ids, and copy are checked here. Notices are then rebuilt from the catalog
 * so a browser-supplied sentence is not kept as a fact.
 */
export function parseTripDocument(input: unknown, catalog: CatalogSnapshot): ParsedTrip {
  const parsed = tripDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }

  const structural = structuralIssues(parsed.data);
  if (structural.length > 0) {
    return { ok: false, issues: structural };
  }

  const retrieval = approvedRetrieval(catalog, parsed.data.destinationId);
  if (!retrieval) {
    return {
      ok: false,
      issues: [
        issue(
          "unapproved_destination",
          "destinationId",
          "The destination is not an approved catalog record.",
        ),
      ],
    };
  }

  const catalogIssues = [
    ...referencedPlaceIssues(parsed.data, retrieval),
    ...placeListIssues(
      [
        ...parsed.data.preferences.constraints.mustSeePlaceIds.map((placeId) => ({
          placeId,
          path: "preferences.constraints.mustSeePlaceIds",
        })),
        ...parsed.data.preferences.exclusions.placeIds.map((placeId) => ({
          placeId,
          path: "preferences.exclusions.placeIds",
        })),
      ],
      retrieval,
    ),
  ];
  if (catalogIssues.length > 0) {
    return { ok: false, issues: catalogIssues };
  }

  const copyIssues = copyIssuesFor(parsed.data);
  if (copyIssues.length > 0) {
    return { ok: false, issues: copyIssues };
  }

  return { ok: true, trip: recomputeNotices(parsed.data, catalog), retrieval };
}

function approvedRetrieval(catalog: CatalogSnapshot, destinationId: string): RetrievalSet | null {
  return retrieveDestination(catalog, destinationId);
}

function structuralIssues(trip: TripDocument): PlannerIssue[] {
  const issues: PlannerIssue[] = [];
  if (trip.destinationId !== trip.preferences.destinationId) {
    issues.push(
      issue(
        "destination_mismatch",
        "destinationId",
        "The trip destination and the preference destination have to match.",
      ),
    );
  }

  issues.push(...bodyIssues(trip.days, trip.unscheduled, trip.preferences, "days"));
  if (trip.undoAi) {
    issues.push(
      ...bodyIssues(trip.undoAi.days, trip.undoAi.unscheduled, trip.preferences, "undoAi.days"),
    );
  }
  return issues;
}

function bodyIssues(
  days: TripDocument["days"],
  unscheduled: TripItem[],
  preferences: TravelerPreferences,
  path: string,
): PlannerIssue[] {
  const issues: PlannerIssue[] = [];
  if (days.length !== preferences.dayCount) {
    issues.push(
      issue("day_count_mismatch", path, "The itinerary days have to match the trip length."),
    );
  }

  days.forEach((day, index) => {
    const expectedIndex = index + 1;
    if (day.dayIndex !== expectedIndex) {
      issues.push(
        issue("day_index_order", `${path}.${index}.dayIndex`, "Days have to run in order from day 1."),
      );
    }
    const expectedDate = preferences.startDate
      ? shiftIsoDate(preferences.startDate, expectedIndex - 1)
      : null;
    if (day.date !== expectedDate) {
      issues.push(
        issue(
          "date_mismatch",
          `${path}.${index}.date`,
          "Each day date has to follow the trip start date.",
        ),
      );
    }

    const places = new Set<string>();
    for (const item of day.items) {
      if (places.has(item.placeId)) {
        issues.push(
          issue(
            "duplicate_place",
            `${path}.${index}.${item.placeId}`,
            "A place cannot appear twice on the same day.",
          ),
        );
      }
      places.add(item.placeId);
    }
  });

  const ids = new Set<string>();
  for (const item of [...days.flatMap((day) => day.items), ...unscheduled]) {
    if (ids.has(item.id)) {
      issues.push(issue("duplicate_item", item.id, "Each stop needs its own id."));
    }
    ids.add(item.id);
  }

  const unscheduledPlaces = new Set<string>();
  for (const item of unscheduled) {
    if (unscheduledPlaces.has(item.placeId)) {
      issues.push(
        issue("duplicate_place", `unscheduled.${item.placeId}`, "The unscheduled list repeats a place."),
      );
    }
    unscheduledPlaces.add(item.placeId);
    if (days.some((day) => day.items.some((scheduled) => scheduled.placeId === item.placeId))) {
      issues.push(
        issue(
          "duplicate_place",
          `unscheduled.${item.placeId}`,
          "A place cannot be on a day and on the unscheduled list at the same time.",
        ),
      );
    }
  }

  for (const placeId of preferences.constraints.mustSeePlaceIds) {
    const present =
      days.some((day) => day.items.some((item) => item.placeId === placeId)) ||
      unscheduled.some((item) => item.placeId === placeId);
    if (!present) {
      issues.push(
        issue(
          "must_see_missing",
          placeId,
          "A must-see place has to stay on a day or on the unscheduled list. It cannot be dropped.",
        ),
      );
    }
  }

  return issues;
}

function referencedPlaceIssues(trip: TripDocument, retrieval: RetrievalSet): PlannerIssue[] {
  const items = [
    ...trip.days.flatMap((day) => day.items),
    ...trip.unscheduled,
    ...(trip.undoAi?.days.flatMap((day) => day.items) ?? []),
    ...(trip.undoAi?.unscheduled ?? []),
  ];
  return placeListIssues(
    items.map((item) => ({ placeId: item.placeId, path: `items.${item.id}.placeId` })),
    retrieval,
  );
}

function placeListIssues(
  entries: readonly { placeId: string; path: string }[],
  retrieval: RetrievalSet,
): PlannerIssue[] {
  const issues: PlannerIssue[] = [];
  for (const entry of entries) {
    if (!retrieval.placeById.has(entry.placeId)) {
      issues.push(
        issue(
          "unapproved_place",
          entry.path,
          "This place is not an approved catalog id for the destination.",
        ),
      );
    }
  }
  return issues;
}

function copyIssuesFor(trip: TripDocument): PlannerIssue[] {
  const issues: PlannerIssue[] = [];
  if (!acceptableCopy(trip.summary)) {
    issues.push(
      issue(
        "prohibited_content",
        "summary",
        "The summary cannot include a time, a price, a duration, or a booking claim.",
      ),
    );
  }
  if (trip.undoAi && !acceptableCopy(trip.undoAi.summary)) {
    issues.push(
      issue(
        "prohibited_content",
        "undoAi.summary",
        "The saved summary cannot include a time, a price, a duration, or a booking claim.",
      ),
    );
  }
  trip.notices.forEach((notice, index) => {
    if (!acceptableCopy(notice.message)) {
      issues.push(
        issue(
          "prohibited_content",
          `notices.${index}.message`,
          "A notice cannot include a time, a price, a duration, or a booking claim.",
        ),
      );
    }
  });
  return issues;
}
