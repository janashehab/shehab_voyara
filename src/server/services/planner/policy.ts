import type { CatalogSnapshot } from "@/lib/catalog";
import type {
  PlannerDraft,
  PlannerNotice,
  TravelerPreferences,
  TripDay,
  TripDocument,
  TripItem,
} from "@/features/trips/schemas";
import { shiftIsoDate } from "@/features/trips/schemas";
import { placeMatchesInterest } from "./categories";
import type { IdFactory } from "./ids";
import { issue, type PlannerIssue } from "./issues";
import { retrieveDestination, type RetrievalPlace, type RetrievalSet } from "./retrieve";
import { acceptableCopy, SAFE_SUMMARY } from "./text";

/**
 * Pace caps are planning heuristics. They are not a claim that a day can be
 * walked, opened, or finished. Known minutes count only where the catalog
 * already stores an approximate duration. Missing durations stay on the plan.
 */
export const PACE_HEURISTICS = {
  unhurried: { coreStops: 3, knownMinutes: 120 },
  steady: { coreStops: 4, knownMinutes: 180 },
  full: { coreStops: 5, knownMinutes: 240 },
} as const;

export const LONG_GAP_KM = 8;

export type PlanningHeuristic = {
  coreStops: number;
  knownMinutes: number;
};

export function planningHeuristic(preferences: TravelerPreferences): PlanningHeuristic {
  const base = PACE_HEURISTICS[preferences.pace];
  if (preferences.constraints.mobility === null) {
    return { coreStops: base.coreStops, knownMinutes: base.knownMinutes };
  }

  return {
    coreStops: Math.max(2, base.coreStops - 1),
    knownMinutes: Math.max(60, base.knownMinutes - 60),
  };
}

type PlanDraftInput = {
  preferences: TravelerPreferences;
  draft: PlannerDraft;
  previous: TripDocument | null;
  catalog: CatalogSnapshot;
  ids: IdFactory;
  draftRejected: boolean;
};

export type PlanDraftResult =
  | { ok: true; trip: TripDocument }
  | { ok: false; issues: PlannerIssue[]; trip: TripDocument | null };

export function assessPlannerDraft(
  draft: PlannerDraft,
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
): { ok: true } | { ok: false; issues: PlannerIssue[] } {
  const issues: PlannerIssue[] = [];
  const seenDays = new Set<number>();

  for (const day of draft.days) {
    if (day.dayIndex > preferences.dayCount) {
      issues.push(
        issue(
          "invalid_day",
          `days.${day.dayIndex}`,
          "The draft names a day outside this trip.",
        ),
      );
    }
    if (seenDays.has(day.dayIndex)) {
      issues.push(
        issue("duplicate_day", `days.${day.dayIndex}`, "The draft repeats a day."),
      );
    }
    seenDays.add(day.dayIndex);

    const places = new Set<string>();
    for (const item of day.items) {
      if (!retrieval.placeById.has(item.placeId)) {
        issues.push(
          issue(
            "unapproved_place",
            `days.${day.dayIndex}.${item.placeId}`,
            "The draft names a place that is not an approved catalog id for this destination.",
          ),
        );
      }
      if (places.has(item.placeId)) {
        issues.push(
          issue(
            "duplicate_place",
            `days.${day.dayIndex}.${item.placeId}`,
            "The draft lists the same place twice on one day.",
          ),
        );
      }
      places.add(item.placeId);
    }
  }

  for (const placeId of draft.unscheduledPlaceIds) {
    if (!retrieval.placeById.has(placeId)) {
      issues.push(
        issue(
          "unapproved_place",
          `unscheduled.${placeId}`,
          "The draft names an unscheduled place that is not an approved catalog id.",
        ),
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true };
}

export function planFromDraft(input: PlanDraftInput): PlanDraftResult {
  const retrieval = retrieveDestination(input.catalog, input.preferences.destinationId);
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
      trip: input.previous,
    };
  }

  const assessed = assessPlannerDraft(input.draft, input.preferences, retrieval);
  if (!assessed.ok) {
    return { ok: false, issues: assessed.issues, trip: input.previous };
  }

  const protectedItems = collectItems(input.previous);
  for (const item of protectedItems.filter(isProtected)) {
    if (!retrieval.placeById.has(item.placeId)) {
      return {
        ok: false,
        issues: [
          issue(
            "unapproved_place",
            `items.${item.id}.placeId`,
            "A locked or traveler-added stop is not in the approved catalog. The plan was left unchanged.",
          ),
        ],
        trip: input.previous,
      };
    }
  }

  const undoAi = input.previous
    ? {
        days: cloneDays(input.previous.days),
        unscheduled: input.previous.unscheduled.map(cloneItem),
        summary: input.previous.summary,
      }
    : baselineSnapshot(input.preferences, input.ids);

  const laid = layoutDraft({
    preferences: input.preferences,
    draft: input.draft,
    previous: input.previous,
    retrieval,
    ids: input.ids,
  });

  const summary = input.draftRejected || !acceptableCopy(input.draft.summary) || input.draft.summary.trim() === ""
    ? SAFE_SUMMARY
    : input.draft.summary.trim();

  const trip: TripDocument = {
    id: input.previous?.id ?? input.ids.tripId(),
    destinationId: input.preferences.destinationId,
    preferences: input.preferences,
    days: laid.days,
    unscheduled: laid.unscheduled,
    notices: [],
    summary,
    undoAi,
  };

  return {
    ok: true,
    trip: {
      ...trip,
      notices: noticesFor(trip, retrieval, {
        omittedPlaceIds: laid.omittedPlaceIds,
        draftRejected: input.draftRejected,
      }),
    },
  };
}

export function recomputeNotices(trip: TripDocument, catalog: CatalogSnapshot): TripDocument {
  const retrieval = retrieveDestination(catalog, trip.preferences.destinationId);
  if (!retrieval) {
    return trip;
  }

  return {
    ...trip,
    notices: noticesFor(trip, retrieval, { omittedPlaceIds: [], draftRejected: false }),
  };
}

export function dayShells(preferences: TravelerPreferences): TripDay[] {
  const days: TripDay[] = [];
  for (let dayIndex = 1; dayIndex <= preferences.dayCount; dayIndex += 1) {
    days.push({
      dayIndex,
      date: preferences.startDate ? shiftIsoDate(preferences.startDate, dayIndex - 1) : null,
      items: [],
    });
  }
  return days;
}

function baselineSnapshot(preferences: TravelerPreferences, ids: IdFactory) {
  const mustSee = preferences.constraints.mustSeePlaceIds;
  return {
    days: dayShells(preferences),
    unscheduled: mustSee.map((placeId) => createItem(ids, placeId, "core", "unlocked", "planner")),
    summary: "Must-see places are unscheduled until a plan is applied.",
  };
}

function layoutDraft(input: {
  preferences: TravelerPreferences;
  draft: PlannerDraft;
  previous: TripDocument | null;
  retrieval: RetrievalSet;
  ids: IdFactory;
}): { days: TripDay[]; unscheduled: TripItem[]; omittedPlaceIds: string[] } {
  const days = dayShells(input.preferences);
  const unscheduled: TripItem[] = [];
  const omittedPlaceIds: string[] = [];
  const mustSee = new Set(input.preferences.constraints.mustSeePlaceIds);
  const commitmentIds = new Set<string>(
    input.retrieval.places.filter((place) => place.majorDayCommitment).map((place) => place.id),
  );

  if (input.previous) {
    for (const day of input.previous.days) {
      const target = days.find((candidate) => candidate.dayIndex === day.dayIndex);
      if (!target) {
        continue;
      }
      for (const item of day.items) {
        if (isProtected(item)) {
          target.items.push(cloneItem(item));
        }
      }
    }
    for (const item of input.previous.unscheduled) {
      if (isProtected(item)) {
        unscheduled.push(cloneItem(item));
      }
    }
  }

  for (const day of input.draft.days) {
    const target = days.find((candidate) => candidate.dayIndex === day.dayIndex);
    if (!target) {
      continue;
    }
    for (const entry of day.items) {
      if (target.items.some((item) => item.placeId === entry.placeId)) {
        continue;
      }
      if (isExcluded(input.preferences, input.retrieval, entry.placeId) && !mustSee.has(entry.placeId)) {
        omittedPlaceIds.push(entry.placeId);
        continue;
      }
      target.items.push(createItem(input.ids, entry.placeId, entry.role, "unlocked", "planner"));
    }
  }

  for (const placeId of input.preferences.constraints.mustSeePlaceIds) {
    if (containsPlace(days, unscheduled, placeId)) {
      continue;
    }
    days[0]?.items.push(createItem(input.ids, placeId, "core", "unlocked", "planner"));
  }

  clusterCommitment(days, unscheduled, commitmentIds, mustSee);
  applyCaps(days, unscheduled, input.preferences, input.retrieval, mustSee, commitmentIds);
  ensureMustSee(days, unscheduled, input.preferences, input.ids);
  dedupeUnscheduled(days, unscheduled);

  return { days, unscheduled, omittedPlaceIds: uniqueIds(omittedPlaceIds) };
}

function clusterCommitment(
  days: TripDay[],
  unscheduled: TripItem[],
  commitmentIds: ReadonlySet<string>,
  mustSee: ReadonlySet<string>,
) {
  const hasCommitment = [...days, { items: unscheduled }].some((group) =>
    group.items.some((item) => commitmentIds.has(item.placeId)),
  );
  if (!hasCommitment) {
    return;
  }

  const target = selectCommitmentDay(days, commitmentIds);
  if (!target) {
    parkToUnscheduled(days, unscheduled, commitmentIds);
    return;
  }

  for (const day of days) {
    if (day.dayIndex === target.dayIndex) {
      continue;
    }
    const moving = day.items.filter((item) => commitmentIds.has(item.placeId) && !isProtected(item));
    for (const item of moving) {
      moveItem(day, target, unscheduled, item.id, mustSee);
    }
  }

  const waiting = unscheduled.filter((item) => commitmentIds.has(item.placeId) && !isProtected(item));
  for (const item of waiting) {
    if (target.items.some((existing) => existing.placeId === item.placeId)) {
      continue;
    }
    const index = unscheduled.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) {
      const [moved] = unscheduled.splice(index, 1);
      if (moved) {
        target.items.push(moved);
      }
    }
  }

  const leaving = target.items.filter((item) => !commitmentIds.has(item.placeId) && !isProtected(item));
  for (const item of leaving) {
    const elsewhere = days.find(
      (day) =>
        day.dayIndex !== target.dayIndex &&
        !day.items.some((existing) => existing.placeId === item.placeId),
    );
    if (elsewhere) {
      moveItem(target, elsewhere, unscheduled, item.id, mustSee);
    } else {
      moveItem(target, null, unscheduled, item.id, mustSee);
    }
  }
}

function selectCommitmentDay(days: readonly TripDay[], commitmentIds: ReadonlySet<string>): TripDay | null {
  const reserved = days.filter((day) =>
    day.items.some((item) => commitmentIds.has(item.placeId) && isProtected(item)),
  );
  const firstReserved = reserved.reduce<TripDay | null>(
    (best, day) => (best === null || day.dayIndex < best.dayIndex ? day : best),
    null,
  );
  if (firstReserved) {
    return firstReserved;
  }

  const openHosts = days.filter(
    (day) =>
      day.items.some((item) => commitmentIds.has(item.placeId)) && !dayIsBlocked(day, commitmentIds),
  );
  const busiestHost = openHosts.reduce<TripDay | null>((best, day) => {
    if (best === null) {
      return day;
    }
    const bestCount = best.items.filter((item) => commitmentIds.has(item.placeId)).length;
    const dayCount = day.items.filter((item) => commitmentIds.has(item.placeId)).length;
    if (dayCount !== bestCount) {
      return dayCount > bestCount ? day : best;
    }
    return day.dayIndex < best.dayIndex ? day : best;
  }, null);
  if (busiestHost) {
    return busiestHost;
  }

  return days.reduce<TripDay | null>((best, day) => {
    if (dayIsBlocked(day, commitmentIds)) {
      return best;
    }
    if (best === null || day.dayIndex < best.dayIndex) {
      return day;
    }
    return best;
  }, null);
}

function dayIsBlocked(day: TripDay, commitmentIds: ReadonlySet<string>): boolean {
  return day.items.some((item) => !commitmentIds.has(item.placeId) && isProtected(item));
}

function parkToUnscheduled(days: TripDay[], unscheduled: TripItem[], commitmentIds: ReadonlySet<string>) {
  for (const day of days) {
    const moving = day.items.filter((item) => commitmentIds.has(item.placeId) && !isProtected(item));
    for (const item of moving) {
      const index = day.items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) {
        continue;
      }
      const [removed] = day.items.splice(index, 1);
      if (removed && !unscheduled.some((existing) => existing.placeId === removed.placeId)) {
        unscheduled.push(removed);
      }
    }
  }
}

function moveItem(
  from: TripDay,
  to: TripDay | null,
  unscheduled: TripItem[],
  itemId: string,
  mustSee: ReadonlySet<string>,
) {
  const index = from.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return;
  }
  const [item] = from.items.splice(index, 1);
  if (!item) {
    return;
  }
  if (to && !to.items.some((existing) => existing.placeId === item.placeId)) {
    to.items.push(item);
    return;
  }
  if (!containsPlace([], unscheduled, item.placeId) && (mustSee.has(item.placeId) || isProtected(item) || to === null)) {
    unscheduled.push(item);
  }
}

function applyCaps(
  days: TripDay[],
  unscheduled: TripItem[],
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
  mustSee: ReadonlySet<string>,
  commitmentIds: ReadonlySet<string>,
) {
  const heuristic = planningHeuristic(preferences);

  for (const day of days) {
    const commitmentDay = day.items.some((item) => commitmentIds.has(item.placeId));
    const overflow = trimCoreStops(day, heuristic.coreStops, mustSee, commitmentDay);
    for (const item of overflow) {
      if (!unscheduled.some((existing) => existing.placeId === item.placeId)) {
        unscheduled.push(item);
      }
    }
    trimKnownMinutes(day, heuristic.knownMinutes, retrieval, mustSee, unscheduled, commitmentDay);
  }
}

function trimCoreStops(
  day: TripDay,
  cap: number,
  mustSee: ReadonlySet<string>,
  commitmentDay: boolean,
): TripItem[] {
  const removed: TripItem[] = [];
  let coreCount = day.items.filter((item) => item.role === "core").length;

  for (let index = day.items.length - 1; index >= 0 && coreCount > cap; index -= 1) {
    const item = day.items[index];
    if (!item || item.role !== "core" || !canDemote(item, mustSee)) {
      continue;
    }
    if (commitmentDay) {
      day.items[index] = { ...item, role: "optional" };
    } else {
      const [taken] = day.items.splice(index, 1);
      if (taken) {
        removed.push(taken);
      }
    }
    coreCount -= 1;
  }

  return removed;
}

function trimKnownMinutes(
  day: TripDay,
  cap: number,
  retrieval: RetrievalSet,
  mustSee: ReadonlySet<string>,
  unscheduled: TripItem[],
  commitmentDay: boolean,
) {
  while (knownCoreMinutes(day, retrieval) > cap) {
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
    if (!item || item.role !== "core" || !canDemote(item, mustSee)) {
      continue;
    }
    const minutes = retrieval.placeById.get(item.placeId)?.approximateDurationMinutes;
    if (typeof minutes === "number") {
      return index;
    }
  }
  return null;
}

function canDemote(item: TripItem, mustSee: ReadonlySet<string>): boolean {
  return !isProtected(item) && !mustSee.has(item.placeId);
}

function knownCoreMinutes(day: TripDay, retrieval: RetrievalSet): number {
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

function ensureMustSee(
  days: TripDay[],
  unscheduled: TripItem[],
  preferences: TravelerPreferences,
  ids: IdFactory,
) {
  for (const placeId of preferences.constraints.mustSeePlaceIds) {
    if (containsPlace(days, unscheduled, placeId)) {
      continue;
    }
    unscheduled.push(createItem(ids, placeId, "core", "unlocked", "planner"));
  }
}

function dedupeUnscheduled(days: TripDay[], unscheduled: TripItem[]) {
  for (let index = unscheduled.length - 1; index >= 0; index -= 1) {
    const item = unscheduled[index];
    if (item && containsPlace(days, [], item.placeId)) {
      unscheduled.splice(index, 1);
    }
  }
}

function noticesFor(
  trip: TripDocument,
  retrieval: RetrievalSet,
  extra: { omittedPlaceIds: readonly string[]; draftRejected: boolean },
): PlannerNotice[] {
  const notices: PlannerNotice[] = [];
  const mustSee = new Set(trip.preferences.constraints.mustSeePlaceIds);
  const heuristic = planningHeuristic(trip.preferences);
  const commitmentIds = new Set<string>(
    retrieval.places.filter((place) => place.majorDayCommitment).map((place) => place.id),
  );

  push(notices, "no_prices", "The catalog has no verified prices. This plan does not estimate cost.", null, null);
  push(
    notices,
    "no_opening_hours",
    "Opening hours and showtimes are unknown. This plan does not reserve a time.",
    null,
    null,
  );
  push(
    notices,
    "no_travel_times",
    "Travel times are unknown. This plan does not estimate the journey between stops.",
    null,
    null,
  );
  push(
    notices,
    "planning_heuristic",
    "Daily stop limits are a planning heuristic. They are not a promise that an itinerary is achievable.",
    null,
    null,
  );

  if (trip.preferences.constraints.mobility !== null) {
    push(
      notices,
      "mobility_unknown",
      "Mobility is saved as a hard constraint. The catalog has no step-free or walking-distance facts, so no place is marked accessible. The daily heuristic is tighter, and it is still not a promise.",
      null,
      null,
    );
  }

  if (
    trip.preferences.priorities.placeStyle === "lesser_known" &&
    trip.preferences.interests.includes("landmarks")
  ) {
    push(
      notices,
      "preference_conflict",
      "A lesser-known priority and a landmark interest are both set. Must-see places stay. Extra stops are not a promise that both tastes fit in one day.",
      null,
      null,
    );
  }

  if (extra.draftRejected) {
    push(
      notices,
      "planner_fallback",
      "The generated draft was not accepted. This plan places must-see stops only.",
      null,
      null,
    );
  }

  for (const placeId of extra.omittedPlaceIds) {
    const place = retrieval.placeById.get(placeId);
    if (!place) {
      continue;
    }
    push(
      notices,
      "excluded_omitted",
      `${place.name} was left out because it matches something to avoid.`,
      place.id,
      null,
    );
  }

  for (const interest of trip.preferences.interests) {
    const available = retrieval.places.filter(
      (place) =>
        placeMatchesInterest(place, interest) &&
        !isExcluded(trip.preferences, retrieval, place.id),
    );
    if (available.length === 0) {
      push(
        notices,
        "thin_coverage",
        `The approved catalog has no places left for ${interest.replaceAll("_", " ")} after exclusions.`,
        null,
        null,
      );
    }
  }

  const commitmentDays = trip.days.filter((day) =>
    day.items.some((item) => commitmentIds.has(item.placeId)),
  );
  if (commitmentDays.length > 1) {
    const area = commitmentArea(retrieval, commitmentIds);
    push(
      notices,
      "major_day_split",
      `${area} stays split across days because locked or traveler-added stops were kept where they are. Opening hours and travel time are unknown.`,
      null,
      null,
    );
  }

  for (const day of trip.days) {
    const commitmentItems = day.items.filter((item) => commitmentIds.has(item.placeId));
    const otherItems = day.items.filter((item) => !commitmentIds.has(item.placeId));
    if (commitmentItems.length > 0) {
      const area = commitmentArea(retrieval, commitmentIds);
      push(
        notices,
        "major_day_commitment",
        `${area} is a full-day commitment. Opening hours and travel time are unknown, and the stops kept with it are not a timed schedule.`,
        commitmentItems[0]?.placeId ?? null,
        day.dayIndex,
      );
      if (otherItems.length > 0) {
        push(
          notices,
          "major_day_mixed",
          `${area} shares this day with another stop that was kept on purpose. Travel time is unknown, and the mix is not a claim that the day works.`,
          null,
          day.dayIndex,
        );
      }
    }

    if (dayExceedsHeuristic(day, heuristic, retrieval)) {
      push(
        notices,
        "pace_overflow",
        "This day stays past the planning heuristic because a must-see or protected stop was kept. The heuristic is not a promise that the day is achievable.",
        null,
        day.dayIndex,
      );
    }

    const core = day.items.filter((item) => item.role === "core");
    for (let index = 0; index < core.length - 1; index += 1) {
      const left = core[index];
      const right = core[index + 1];
      if (!left || !right) {
        continue;
      }
      const leftPlace = retrieval.placeById.get(left.placeId);
      const rightPlace = retrieval.placeById.get(right.placeId);
      if (!leftPlace || !rightPlace || !coordinatesFar(leftPlace, rightPlace)) {
        continue;
      }
      push(
        notices,
        "long_gap",
        `${leftPlace.name} and ${rightPlace.name} are far apart on this day. Travel time is unknown.`,
        null,
        day.dayIndex,
      );
    }
  }

  for (const item of [...trip.days.flatMap((day) => day.items), ...trip.unscheduled]) {
    const place = retrieval.placeById.get(item.placeId);
    if (!place) {
      continue;
    }
    if (place.approximateDurationMinutes === null) {
      push(
        notices,
        "missing_duration",
        `${place.name} has no duration in the catalog. It stays eligible, and the time it needs is unknown.`,
        place.id,
        null,
      );
    }
    if (place.coordinates === null) {
      push(
        notices,
        "missing_coordinates",
        `${place.name} has no coordinates in the catalog. Route distance and travel time are unknown.`,
        place.id,
        null,
      );
    }
    if (conflictsWithAvoid(trip.preferences, retrieval, place) && (mustSee.has(place.id) || isProtected(item))) {
      push(
        notices,
        "exclusion_conflict",
        `${place.name} matches something to avoid, and it stays because it is a must-see or a protected stop.`,
        place.id,
        null,
      );
    }
  }

  for (const item of trip.unscheduled) {
    const place = retrieval.placeById.get(item.placeId);
    if (!place) {
      continue;
    }
    if (mustSee.has(place.id)) {
      push(
        notices,
        "must_see_unscheduled",
        `${place.name} is unscheduled because it did not fit a day without dropping a protected stop or crowding a full-day commitment. It was not removed.`,
        place.id,
        null,
      );
    } else if (place.majorDayCommitment) {
      push(
        notices,
        "major_day_unscheduled",
        `${place.name} needs a day of its own. No day was free of protected stops, so it is unscheduled rather than squeezed beside them. Opening hours and travel time are unknown.`,
        place.id,
        null,
      );
    }
  }

  return notices.sort(compareNotices);
}

function dayExceedsHeuristic(day: TripDay, heuristic: PlanningHeuristic, retrieval: RetrievalSet): boolean {
  const coreCount = day.items.filter((item) => item.role === "core").length;
  return coreCount > heuristic.coreStops || knownCoreMinutes(day, retrieval) > heuristic.knownMinutes;
}

function coordinatesFar(left: RetrievalPlace, right: RetrievalPlace): boolean {
  if (left.coordinates === null || right.coordinates === null) {
    return false;
  }
  return distanceKm(left.coordinates, right.coordinates) > LONG_GAP_KM;
}

function distanceKm(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const earthRadiusKm = 6371;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function commitmentArea(retrieval: RetrievalSet, commitmentIds: ReadonlySet<string>): string {
  for (const placeId of commitmentIds) {
    const area = retrieval.placeById.get(placeId)?.areaLabel;
    if (area) {
      return area;
    }
  }
  return "This area";
}

function conflictsWithAvoid(
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
  place: RetrievalPlace,
): boolean {
  return isExcluded(preferences, retrieval, place.id);
}

function isExcluded(
  preferences: TravelerPreferences,
  retrieval: RetrievalSet,
  placeId: string,
): boolean {
  if (preferences.exclusions.placeIds.includes(placeId)) {
    return true;
  }
  const place = retrieval.placeById.get(placeId);
  if (!place) {
    return false;
  }
  return preferences.exclusions.avoid.some((interest) => placeMatchesInterest(place, interest));
}

function push(
  notices: PlannerNotice[],
  code: PlannerNotice["code"],
  message: string,
  placeId: string | null,
  dayIndex: number | null,
) {
  if (notices.some((notice) => notice.code === code && notice.placeId === placeId && notice.dayIndex === dayIndex && notice.message === message)) {
    return;
  }
  notices.push({ code, message, placeId, dayIndex });
}

function compareNotices(left: PlannerNotice, right: PlannerNotice): number {
  return `${left.code}|${left.dayIndex ?? 0}|${left.placeId ?? ""}|${left.message}`.localeCompare(
    `${right.code}|${right.dayIndex ?? 0}|${right.placeId ?? ""}|${right.message}`,
  );
}

function containsPlace(days: readonly TripDay[], unscheduled: readonly TripItem[], placeId: string): boolean {
  return (
    days.some((day) => day.items.some((item) => item.placeId === placeId)) ||
    unscheduled.some((item) => item.placeId === placeId)
  );
}

function collectItems(trip: TripDocument | null): TripItem[] {
  if (!trip) {
    return [];
  }
  return [...trip.days.flatMap((day) => day.items), ...trip.unscheduled];
}

export function isProtected(item: TripItem): boolean {
  return item.lock === "locked" || item.source === "traveler";
}

function createItem(
  ids: IdFactory,
  placeId: string,
  role: TripItem["role"],
  lock: TripItem["lock"],
  source: TripItem["source"],
): TripItem {
  return { id: ids.itemId(), placeId, role, lock, source };
}

function cloneItem(item: TripItem): TripItem {
  return { ...item };
}

function cloneDays(days: readonly TripDay[]): TripDay[] {
  return days.map((day) => ({
    dayIndex: day.dayIndex,
    date: day.date,
    items: day.items.map(cloneItem),
  }));
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
