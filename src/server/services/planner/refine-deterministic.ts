import type { CatalogSnapshot } from "@/lib/catalog";
import {
  travelerPreferencesSchema,
  type PlannerNotice,
  type TravelerPreferences,
  type TripDay,
  type TripDocument,
  type TripItem,
} from "@/features/trips/schemas";
import { placeMatchesInterest } from "./categories";
import { createIdFactory, type IdFactory } from "./ids";
import { issue, zodIssues, type PlannerIssue } from "./issues";
import { isProtected, planningHeuristic, type PlanDraftResult } from "./policy";
import { rankScore } from "./prompt";
import type { RetrievalPlace, RetrievalSet } from "./retrieve";
import { parseTripDocument } from "./validate";

/**
 * Deterministic follow-ups. This does not call PlannerModel.
 * generateItinerary and refineItinerary keep their model behavior.
 * The submitted trip is untrusted. The catalog argument is a server snapshot.
 */

type Intent = "less_walking" | "more_food" | "replace_museum";

const intents: Readonly<Record<string, Intent>> = {
  "less walking": "less_walking",
  "more relaxed": "less_walking",
  "more cafés": "more_food",
  "more cafes": "more_food",
  "more food spots": "more_food",
  "replace a museum": "replace_museum",
};

export function refineDeterministicItinerary(input: {
  trip: unknown;
  instruction: unknown;
  catalog: CatalogSnapshot;
  ids?: IdFactory;
}): PlanDraftResult {
  const parsed = parseTripDocument(input.trip, input.catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: null };
  }

  const intent = interpret(input.instruction);
  if (!intent.ok) {
    return { ok: false, issues: intent.issues, trip: parsed.trip };
  }

  const ids = input.ids ?? createIdFactory("refine");
  if (intent.intent === "less_walking") {
    return relax(parsed.trip, parsed.retrieval, input.catalog);
  }
  if (intent.intent === "more_food") {
    return addDining(parsed.trip, parsed.retrieval, input.catalog, ids);
  }
  return replaceMuseum(parsed.trip, parsed.retrieval, input.catalog);
}

function interpret(instruction: unknown): { ok: true; intent: Intent } | { ok: false; issues: PlannerIssue[] } {
  if (typeof instruction !== "string") {
    return { ok: false, issues: [unsupported()] };
  }
  const normalized = instruction.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
  const intent = intents[normalized];
  if (!intent) {
    return { ok: false, issues: [unsupported()] };
  }
  return { ok: true, intent };
}

function unsupported(): PlannerIssue {
  return issue(
    "unsupported_refinement",
    "instruction",
    "This follow-up is not one of the supported requests: less walking, more food, or replace a museum.",
  );
}

function relax(
  trip: TripDocument,
  retrieval: RetrievalSet,
  catalog: CatalogSnapshot,
): PlanDraftResult {
  const relaxed = relaxedPreferences(trip.preferences);
  if (!relaxed.ok) {
    return { ok: false, issues: relaxed.issues, trip };
  }

  const days = cloneDays(trip.days);
  const unscheduled = trip.unscheduled.map((item) => ({ ...item }));
  trimToHeuristic(days, unscheduled, relaxed.preferences, retrieval);
  const candidate = withUndo(trip, {
    ...trip,
    preferences: relaxed.preferences,
    days,
    unscheduled,
    notices: [],
  });
  if (!keepsRequiredStops(trip, candidate)) {
    return {
      ok: false,
      issues: [
        issue(
          "protected_stop_missing",
          "items",
          "A locked, traveler-added, or must-see stop could not be kept. The previous plan was left unchanged.",
        ),
      ],
      trip,
    };
  }
  return finish(candidate, catalog, retrieval, trip);
}

function relaxedPreferences(
  preferences: TravelerPreferences,
): { ok: true; preferences: TravelerPreferences } | { ok: false; issues: PlannerIssue[] } {
  let next: TravelerPreferences;
  if (preferences.pace === "full") {
    next = { ...preferences, pace: "steady" };
  } else if (preferences.pace === "steady") {
    next = { ...preferences, pace: "unhurried" };
  } else if (preferences.constraints.mobility === null) {
    next = {
      ...preferences,
      constraints: { ...preferences.constraints, mobility: "limited_walking" },
    };
  } else {
    return {
      ok: false,
      issues: [
        issue(
          "refinement_limit",
          "pace",
          "This plan is already at the most relaxed pace. Walking distance and accessibility stay unverified.",
        ),
      ],
    };
  }

  const parsed = travelerPreferencesSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }
  return { ok: true, preferences: parsed.data };
}

function addDining(
  trip: TripDocument,
  retrieval: RetrievalSet,
  catalog: CatalogSnapshot,
  ids: IdFactory,
): PlanDraftResult {
  if (trip.preferences.interests.includes("food") && diningCandidates(trip, retrieval).length === 0) {
    return {
      ok: false,
      issues: [
        issue(
          "insufficient_matches",
          "interests",
          "No further approved dining place is available. No café was added.",
        ),
      ],
      trip,
    };
  }

  const withFood = travelerPreferencesSchema.safeParse({
    ...trip.preferences,
    interests: trip.preferences.interests.includes("food")
      ? trip.preferences.interests
      : [...trip.preferences.interests, "food"],
  });
  if (!withFood.success) {
    return { ok: false, issues: zodIssues(withFood.error), trip };
  }

  const days = cloneDays(trip.days);
  const unscheduled = trip.unscheduled.map((item) => ({ ...item }));
  const candidates = diningCandidates(trip, retrieval);
  let added = 0;
  for (const place of candidates) {
    if (placeUsed(days, unscheduled, place.id)) {
      continue;
    }
    const day = openDay(days, place, withFood.data, retrieval);
    if (!day) {
      continue;
    }
    day.items.push({
      id: freshItemId(ids, trip),
      placeId: place.id,
      role: "core",
      lock: "unlocked",
      source: "planner",
    });
    added += 1;
  }

  const candidate = withUndo(trip, {
    ...trip,
    preferences: withFood.data,
    days,
    unscheduled,
    notices: [],
  });
  if (!keepsRequiredStops(trip, candidate)) {
    return {
      ok: false,
      issues: [
        issue(
          "protected_stop_missing",
          "items",
          "A locked or traveler-added stop could not be kept. The previous plan was left unchanged.",
        ),
      ],
      trip,
    };
  }

  const extra: PlannerNotice[] = [];
  if (added === 0) {
    extra.push({
      code: "thin_coverage",
      message: "The approved catalog has no further dining place that fits this plan. No café was added.",
      placeId: null,
      dayIndex: null,
    });
  } else if (added < candidates.length) {
    extra.push({
      code: "catalog_gap",
      message: "An approved dining place did not fit the pace heuristic, so it stayed off the plan.",
      placeId: null,
      dayIndex: null,
    });
  }
  return finish(candidate, catalog, retrieval, trip, extra);
}

function replaceMuseum(
  trip: TripDocument,
  retrieval: RetrievalSet,
  catalog: CatalogSnapshot,
): PlanDraftResult {
  const museums = museumStops(trip, retrieval);
  const replaceable = museums.filter((stop) => canReplace(stop.item, trip.preferences));
  if (replaceable.length === 0) {
    return { ok: false, issues: [museumBlocked(museums, trip.preferences)], trip };
  }
  if (replaceable.length > 1) {
    return {
      ok: false,
      issues: [
        issue(
          "ambiguous_museum",
          "instruction",
          "More than one unlocked museum is on this plan. Choose one to replace. Nothing was removed.",
        ),
      ],
      trip,
    };
  }

  const target = replaceable[0];
  if (!target) {
    return { ok: false, issues: [museumBlocked(museums, trip.preferences)], trip };
  }
  return applyMuseumReplacement(trip, retrieval, catalog, target);
}

/**
 * Replaces one stop the server has already accepted as an unlocked museum.
 * The caller supplies the stop id. The replacement place is chosen here.
 */
export function replaceDeterministicMuseumStop(input: {
  trip: unknown;
  itemId: unknown;
  catalog: CatalogSnapshot;
}): PlanDraftResult {
  const parsed = parseTripDocument(input.trip, input.catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: null };
  }
  if (typeof input.itemId !== "string" || !/^itm_[a-z0-9_]+$/.test(input.itemId)) {
    return {
      ok: false,
      issues: [issue("unknown_item", "itemId", "Choose one of the unlocked museums on this plan.")],
      trip: parsed.trip,
    };
  }

  const target = museumStops(parsed.trip, parsed.retrieval).find((stop) => stop.item.id === input.itemId);
  if (!target) {
    return {
      ok: false,
      issues: [issue("unknown_item", input.itemId, "That stop is not an unlocked museum on this plan.")],
      trip: parsed.trip,
    };
  }
  if (!canReplace(target.item, parsed.trip.preferences)) {
    return { ok: false, issues: [museumBlocked([target], parsed.trip.preferences)], trip: parsed.trip };
  }
  return applyMuseumReplacement(parsed.trip, parsed.retrieval, input.catalog, target);
}

export function replaceableMuseumStops(
  trip: TripDocument,
  retrieval: RetrievalSet,
): { itemId: string; placeId: string; dayIndex: number | null }[] {
  return museumStops(trip, retrieval)
    .filter((stop) => canReplace(stop.item, trip.preferences))
    .map((stop) => ({ itemId: stop.item.id, placeId: stop.item.placeId, dayIndex: stop.dayIndex }));
}

function applyMuseumReplacement(
  trip: TripDocument,
  retrieval: RetrievalSet,
  catalog: CatalogSnapshot,
  target: { item: TripItem },
): PlanDraftResult {
  const replacement = replacementFor(target.item.placeId, trip, retrieval);
  if (!replacement) {
    return {
      ok: false,
      issues: [
        issue(
          "no_replacement",
          target.item.placeId,
          "No other approved museum is available to take this stop. The museum stays.",
        ),
      ],
      trip,
    };
  }

  const days = cloneDays(trip.days);
  const unscheduled = trip.unscheduled.map((item) => ({ ...item }));
  const swapped = swapPlace(days, unscheduled, target.item.id, replacement.id);
  if (!swapped) {
    return {
      ok: false,
      issues: [issue("unknown_item", target.item.id, "That museum stop is no longer on the plan.")],
      trip,
    };
  }
  const candidate = withUndo(trip, { ...trip, days, unscheduled, notices: [] });
  if (!keepsRequiredStops(trip, candidate)) {
    return {
      ok: false,
      issues: [
        issue(
          "protected_stop_missing",
          target.item.id,
          "A locked or must-see stop could not be kept. The previous plan was left unchanged.",
        ),
      ],
      trip,
    };
  }
  return finish(candidate, catalog, retrieval, trip);
}

function diningCandidates(trip: TripDocument, retrieval: RetrievalSet): RetrievalPlace[] {
  const used = usedPlaceIds(trip);
  const ranking = withInterest(trip.preferences, "food");
  return retrieval.places
    .filter(
      (place) =>
        placeMatchesInterest(place, "food") &&
        !used.has(place.id) &&
        !placeExcluded(place, trip.preferences),
    )
    .sort((left, right) => compareRank(left, right, ranking));
}

function replacementFor(
  placeId: string,
  trip: TripDocument,
  retrieval: RetrievalSet,
): RetrievalPlace | undefined {
  const used = usedPlaceIds(trip);
  const ranking = withInterest(trip.preferences, "museums");
  return retrieval.places
    .filter(
      (place) =>
        place.id !== placeId &&
        !used.has(place.id) &&
        placeMatchesInterest(place, "museums") &&
        !placeExcluded(place, trip.preferences),
    )
    .sort((left, right) => compareRank(left, right, ranking))[0];
}

function withInterest(preferences: TravelerPreferences, interest: "food" | "museums"): TravelerPreferences {
  if (preferences.interests.includes(interest)) {
    return preferences;
  }
  return { ...preferences, interests: [...preferences.interests, interest] };
}

function compareRank(left: RetrievalPlace, right: RetrievalPlace, preferences: TravelerPreferences): number {
  const score = rankScore(right, preferences) - rankScore(left, preferences);
  if (score !== 0) {
    return score;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function museumStops(
  trip: TripDocument,
  retrieval: RetrievalSet,
): { item: TripItem; dayIndex: number | null }[] {
  const stops: { item: TripItem; dayIndex: number | null }[] = [];
  for (const day of trip.days) {
    for (const item of day.items) {
      const place = retrieval.placeById.get(item.placeId);
      if (place && placeMatchesInterest(place, "museums")) {
        stops.push({ item, dayIndex: day.dayIndex });
      }
    }
  }
  for (const item of trip.unscheduled) {
    const place = retrieval.placeById.get(item.placeId);
    if (place && placeMatchesInterest(place, "museums")) {
      stops.push({ item, dayIndex: null });
    }
  }
  return stops;
}

function canReplace(item: TripItem, preferences: TravelerPreferences): boolean {
  return !isProtected(item) && !preferences.constraints.mustSeePlaceIds.includes(item.placeId);
}

function museumBlocked(
  museums: readonly { item: TripItem }[],
  preferences: TravelerPreferences,
): PlannerIssue {
  if (museums.length === 0) {
    return issue("museum_not_found", "instruction", "This plan has no museum stop to replace.");
  }
  if (museums.some((stop) => stop.item.lock === "locked" || stop.item.source === "traveler")) {
    return issue("locked_stop", museums[0]?.item.id ?? "items", "The museum stop is locked. It stays until it is unlocked.");
  }
  if (museums.some((stop) => preferences.constraints.mustSeePlaceIds.includes(stop.item.placeId))) {
    return issue(
      "must_see_kept",
      museums[0]?.item.placeId ?? "constraints.mustSeePlaceIds",
      "This museum is a must-see, so it stays on the plan.",
    );
  }
  return issue("museum_not_found", "instruction", "This plan has no museum stop to replace.");
}

function finish(
  candidate: TripDocument,
  catalog: CatalogSnapshot,
  retrieval: RetrievalSet,
  fallback: TripDocument,
  extra: readonly PlannerNotice[] = [],
): PlanDraftResult {
  const parsed = parseTripDocument(candidate, catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: fallback };
  }
  return {
    ok: true,
    trip: appendNotices(parsed.trip, [...coverageNotices(parsed.trip, retrieval), ...extra]),
  };
}

export function coverageNotices(trip: TripDocument, retrieval: RetrievalSet): PlannerNotice[] {
  const notices: PlannerNotice[] = [];
  const heuristic = planningHeuristic(trip.preferences);
  const used = new Set(allItems(trip).map((item) => item.placeId));
  const remainingMatch = retrieval.places.some(
    (place) =>
      !used.has(place.id) &&
      !placeExcluded(place, trip.preferences) &&
      trip.preferences.interests.some((interest) => placeMatchesInterest(place, interest)),
  );
  for (const day of trip.days) {
    if (day.items.length === 0) {
      notices.push({
        code: "catalog_gap",
        message:
          "This day has no stops. Nothing unrelated was added. Walking distance and accessibility are not verified.",
        placeId: null,
        dayIndex: day.dayIndex,
      });
      continue;
    }
    const coreCount = day.items.filter((item) => item.role === "core").length;
    if (!remainingMatch && coreCount < heuristic.coreStops) {
      notices.push({
        code: "catalog_gap",
        message:
          "This day is below the pace heuristic. No further approved place matched the request, so nothing unrelated was added.",
        placeId: null,
        dayIndex: day.dayIndex,
      });
    }
  }
  return notices;
}

function appendNotices(trip: TripDocument, extra: readonly PlannerNotice[]): TripDocument {
  const notices = [...trip.notices];
  for (const notice of extra) {
    if (
      notices.some(
        (existing) =>
          existing.code === notice.code &&
          existing.dayIndex === notice.dayIndex &&
          existing.message === notice.message,
      )
    ) {
      continue;
    }
    notices.push(notice);
  }
  return { ...trip, notices };
}

function keepsRequiredStops(before: TripDocument, after: TripDocument): boolean {
  const afterIds = new Set(allItems(after).map((item) => item.id));
  for (const item of allItems(before)) {
    if (isProtected(item) && !afterIds.has(item.id)) {
      return false;
    }
    if (before.preferences.constraints.mustSeePlaceIds.includes(item.placeId) && !afterIds.has(item.id)) {
      return false;
    }
  }
  for (const placeId of before.preferences.constraints.mustSeePlaceIds) {
    if (!allItems(after).some((item) => item.placeId === placeId)) {
      return false;
    }
  }
  return true;
}

function withUndo(previous: TripDocument, next: TripDocument): TripDocument {
  return {
    ...next,
    undoAi: {
      days: cloneDays(previous.days),
      unscheduled: previous.unscheduled.map((item) => ({ ...item })),
      summary: previous.summary,
    },
  };
}

function trimToHeuristic(
  days: TripDay[],
  unscheduled: TripItem[],
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
) {
  const heuristic = planningHeuristic(preferences);
  const mustSee = new Set(preferences.constraints.mustSeePlaceIds);
  for (const day of days) {
    const commitmentDay = day.items.some(
      (item) => retrieval.placeById.get(item.placeId)?.majorDayCommitment === true,
    );
    trimCoreStops(day, heuristic.coreStops, mustSee, commitmentDay, unscheduled);
    trimKnownMinutes(day, heuristic.knownMinutes, retrieval, mustSee, unscheduled, commitmentDay);
  }
  for (let index = unscheduled.length - 1; index >= 0; index -= 1) {
    const item = unscheduled[index];
    if (item && days.some((day) => day.items.some((scheduled) => scheduled.placeId === item.placeId))) {
      unscheduled.splice(index, 1);
    }
  }
}

function trimCoreStops(
  day: TripDay,
  cap: number,
  mustSee: ReadonlySet<string>,
  commitmentDay: boolean,
  unscheduled: TripItem[],
) {
  let coreCount = day.items.filter((item) => item.role === "core").length;
  for (let index = day.items.length - 1; index >= 0 && coreCount > cap; index -= 1) {
    const item = day.items[index];
    if (!item || item.role !== "core" || isProtected(item) || mustSee.has(item.placeId)) {
      continue;
    }
    if (commitmentDay) {
      day.items[index] = { ...item, role: "optional" };
    } else {
      const [taken] = day.items.splice(index, 1);
      if (taken && !unscheduled.some((existing) => existing.placeId === taken.placeId)) {
        unscheduled.push(taken);
      }
    }
    coreCount -= 1;
  }
}

function trimKnownMinutes(
  day: TripDay,
  cap: number,
  retrieval: RetrievalSet,
  mustSee: ReadonlySet<string>,
  unscheduled: TripItem[],
  commitmentDay: boolean,
) {
  while (knownMinutes(day, retrieval) > cap) {
    const index = lastDemotableWithDuration(day, retrieval, mustSee);
    if (index === null) {
      return;
    }
    const item = day.items[index];
    if (!item) {
      return;
    }
    if (commitmentDay) {
      day.items[index] = { ...item, role: "optional" };
    } else {
      const [taken] = day.items.splice(index, 1);
      if (taken && !unscheduled.some((existing) => existing.placeId === taken.placeId)) {
        unscheduled.push(taken);
      }
    }
  }
}

function lastDemotableWithDuration(
  day: TripDay,
  retrieval: RetrievalSet,
  mustSee: ReadonlySet<string>,
): number | null {
  for (let index = day.items.length - 1; index >= 0; index -= 1) {
    const item = day.items[index];
    if (!item || item.role !== "core" || isProtected(item) || mustSee.has(item.placeId)) {
      continue;
    }
    const minutes = retrieval.placeById.get(item.placeId)?.approximateDurationMinutes;
    if (typeof minutes === "number") {
      return index;
    }
  }
  return null;
}

function knownMinutes(day: TripDay, retrieval: RetrievalSet): number {
  let total = 0;
  for (const item of day.items) {
    if (item.role !== "core") {
      continue;
    }
    const minutes = retrieval.placeById.get(item.placeId)?.approximateDurationMinutes;
    if (typeof minutes === "number") {
      total += minutes;
    }
  }
  return total;
}

function openDay(
  days: TripDay[],
  place: RetrievalPlace,
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
): TripDay | undefined {
  const heuristic = planningHeuristic(preferences);
  return [...days]
    .sort((left, right) => {
      if (left.items.length !== right.items.length) {
        return left.items.length - right.items.length;
      }
      return left.dayIndex - right.dayIndex;
    })
    .find((day) => {
      if (day.items.some((item) => item.placeId === place.id)) {
        return false;
      }
      const coreCount = day.items.filter((item) => item.role === "core").length;
      if (coreCount >= heuristic.coreStops) {
        return false;
      }
      if (place.approximateDurationMinutes === null) {
        return true;
      }
      return knownMinutes(day, retrieval) + place.approximateDurationMinutes <= heuristic.knownMinutes;
    });
}

function swapPlace(days: TripDay[], unscheduled: TripItem[], itemId: string, placeId: string): boolean {
  if (placeUsed(days, unscheduled, placeId)) {
    return false;
  }
  for (const day of days) {
    const index = day.items.findIndex((item) => item.id === itemId);
    const item = day.items[index];
    if (item && index >= 0) {
      day.items[index] = { ...item, placeId };
      return true;
    }
  }
  const index = unscheduled.findIndex((item) => item.id === itemId);
  const item = unscheduled[index];
  if (!item || index < 0) {
    return false;
  }
  unscheduled[index] = { ...item, placeId };
  return true;
}

function freshItemId(ids: IdFactory, trip: TripDocument): string {
  const taken = new Set(allItems(trip).map((item) => item.id));
  let next = ids.itemId();
  while (taken.has(next)) {
    next = ids.itemId();
  }
  return next;
}

function placeExcluded(place: RetrievalPlace, preferences: TravelerPreferences): boolean {
  if (preferences.exclusions.placeIds.includes(place.id)) {
    return true;
  }
  return preferences.exclusions.avoid.some((interest) => placeMatchesInterest(place, interest));
}

function placeUsed(days: readonly TripDay[], unscheduled: readonly TripItem[], placeId: string): boolean {
  return (
    days.some((day) => day.items.some((item) => item.placeId === placeId)) ||
    unscheduled.some((item) => item.placeId === placeId)
  );
}

function usedPlaceIds(trip: TripDocument): Set<string> {
  return new Set(allItems(trip).map((item) => item.placeId));
}

function allItems(trip: TripDocument): TripItem[] {
  return [...trip.days.flatMap((day) => day.items), ...trip.unscheduled];
}

function cloneDays(days: readonly TripDay[]): TripDay[] {
  return days.map((day) => ({
    dayIndex: day.dayIndex,
    date: day.date,
    items: day.items.map((item) => ({ ...item })),
  }));
}
