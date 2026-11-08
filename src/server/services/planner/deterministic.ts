import type { CatalogSnapshot } from "@/lib/catalog";
import type { PlannerDraft, TravelerPreferences } from "@/features/trips/schemas";
import { placeMatchesInterest } from "./categories";
import { createIdFactory, type IdFactory } from "./ids";
import { planFromDraft, planningHeuristic, type PlanDraftResult } from "./policy";
import { rankScore } from "./prompt";
import type { RetrievalPlace, RetrievalSet } from "./retrieve";
import { SAFE_SUMMARY } from "./text";
import { parseTravelerPreferences } from "./validate";

/**
 * Builds a plan from approved catalog places and traveler preferences.
 * This entry does not call PlannerModel. generateItinerary still asks its
 * model and still keeps the must-see fallback when that model fails.
 * Pass a server catalog snapshot. The database entry loads that snapshot
 * itself and does not take a catalog from the browser.
 */

type DraftItem = { placeId: RetrievalPlace["id"]; role: "core" };
type DraftDay = { dayIndex: number; items: DraftItem[] };

export function generateDeterministicItinerary(input: {
  preferences: unknown;
  catalog: CatalogSnapshot;
  ids?: IdFactory;
}): PlanDraftResult {
  const parsed = parseTravelerPreferences(input.preferences, input.catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: null };
  }

  return planFromDraft({
    preferences: parsed.preferences,
    draft: buildDeterministicDraft({
      retrieval: parsed.retrieval,
      preferences: parsed.preferences,
    }),
    previous: null,
    catalog: input.catalog,
    ids: input.ids ?? createIdFactory("deterministic"),
    draftRejected: false,
  });
}

export function buildDeterministicDraft(input: {
  retrieval: RetrievalSet;
  preferences: TravelerPreferences;
}): PlannerDraft {
  const mustSee = new Set(input.preferences.constraints.mustSeePlaceIds);
  const chosen = rankedCandidates(input.retrieval, input.preferences);
  const commitment = chosen.filter((place) => place.majorDayCommitment);
  const regular = chosen.filter((place) => !place.majorDayCommitment);
  const days = emptyDays(input.preferences.dayCount);
  const used = new Set<string>();
  const commitmentDay = commitment.length > 0 ? days[days.length - 1] : undefined;
  const cityDays = commitmentDay && days.length > 1 ? days.slice(0, -1) : commitmentDay ? [] : days;

  assignPlaces(
    cityDays.length > 0 ? regular : regular.filter((place) => mustSee.has(place.id)),
    cityDays.length > 0 ? cityDays : commitmentDay ? [commitmentDay] : [],
    input.retrieval,
    input.preferences,
    used,
  );
  if (commitmentDay) {
    assignPlaces(commitment, [commitmentDay], input.retrieval, input.preferences, used);
  }

  return {
    summary: SAFE_SUMMARY,
    days: days
      .filter((day) => day.items.length > 0)
      .map((day) => ({ dayIndex: day.dayIndex, items: day.items })),
    unscheduledPlaceIds: [],
  };
}

function rankedCandidates(
  retrieval: RetrievalSet,
  preferences: TravelerPreferences,
): RetrievalPlace[] {
  const mustSee = new Set(preferences.constraints.mustSeePlaceIds);
  return retrieval.places
    .filter((place) => {
      if (mustSee.has(place.id)) {
        return true;
      }
      if (placeExcluded(place, preferences)) {
        return false;
      }
      return preferences.interests.some((interest) => placeMatchesInterest(place, interest));
    })
    .sort((left, right) => {
      const score = rankScore(right, preferences) - rankScore(left, preferences);
      if (score !== 0) {
        return score;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}

function placeExcluded(place: RetrievalPlace, preferences: TravelerPreferences): boolean {
  if (preferences.exclusions.placeIds.includes(place.id)) {
    return true;
  }
  return preferences.exclusions.avoid.some((interest) => placeMatchesInterest(place, interest));
}

function emptyDays(dayCount: number): DraftDay[] {
  return Array.from({ length: dayCount }, (_, index) => ({
    dayIndex: index + 1,
    items: [],
  }));
}

function assignPlaces(
  places: readonly RetrievalPlace[],
  days: readonly DraftDay[],
  retrieval: RetrievalSet,
  preferences: TravelerPreferences,
  used: Set<string>,
) {
  if (days.length === 0) {
    return;
  }

  const heuristic = planningHeuristic(preferences);
  const mustSee = new Set(preferences.constraints.mustSeePlaceIds);

  for (const place of places) {
    if (used.has(place.id)) {
      continue;
    }
    const ordered = [...days].sort((left, right) => {
      if (left.items.length !== right.items.length) {
        return left.items.length - right.items.length;
      }
      return left.dayIndex - right.dayIndex;
    });
    const open = ordered.find((day) => withinCapacity(day, place, heuristic, retrieval));
    const target = open ?? (mustSee.has(place.id) ? ordered[0] : undefined);
    if (!target || target.items.some((item) => item.placeId === place.id)) {
      continue;
    }
    target.items.push({ placeId: place.id, role: "core" });
    used.add(place.id);
  }
}

function withinCapacity(
  day: DraftDay,
  place: RetrievalPlace,
  heuristic: { coreStops: number; knownMinutes: number },
  retrieval: RetrievalSet,
): boolean {
  const coreCount = day.items.filter((item) => item.role === "core").length;
  if (coreCount >= heuristic.coreStops) {
    return false;
  }
  if (place.approximateDurationMinutes === null) {
    return true;
  }
  return knownMinutes(day, retrieval) + place.approximateDurationMinutes <= heuristic.knownMinutes;
}

function knownMinutes(day: DraftDay, retrieval: RetrievalSet): number {
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
