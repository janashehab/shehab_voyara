import type { CatalogSnapshot } from "@/lib/catalog";
import type { TripDay, TripDocument, TripItem } from "@/features/trips/schemas";
import { issue, type PlannerIssue } from "./issues";
import { recomputeNotices } from "./policy";
import { isPlaceId, retrieveDestination } from "./retrieve";
import { parseTripDocument } from "./validate";

export type EditResult =
  | { ok: true; trip: TripDocument }
  | { ok: false; issues: PlannerIssue[] };

type ItemLocation =
  | { where: "day"; dayIndex: number; index: number }
  | { where: "unscheduled"; index: number };

/**
 * Local edits do not call a model. Locked stops and traveler-added stops stay
 * unless the traveler confirms a removal. Undo restores the itinerary from
 * before the latest generated draft, which also discards local edits made
 * after that draft. A second undo is refused.
 */
export function addStop(
  trip: TripDocument,
  catalog: CatalogSnapshot,
  input: { placeId: string; dayIndex: number; itemId: string },
): EditResult {
  if (!/^itm_[a-z0-9_]+$/.test(input.itemId)) {
    return fail("invalid_item", "itemId", "A new stop needs an item id.");
  }
  if (findById(trip, input.itemId)) {
    return fail("duplicate_item", input.itemId, "That stop id is already on the plan.");
  }

  const retrieval = retrieveDestination(catalog, trip.preferences.destinationId);
  if (!retrieval || !isPlaceId(input.placeId) || !retrieval.placeById.has(input.placeId)) {
    return fail(
      "unapproved_place",
      "placeId",
      "A stop can only be added from the approved catalog for this destination.",
    );
  }

  const day = trip.days.find((candidate) => candidate.dayIndex === input.dayIndex);
  if (!day) {
    return fail("unknown_day", "dayIndex", "That day is not part of this trip.");
  }
  if (day.items.some((item) => item.placeId === input.placeId)) {
    return fail("duplicate_place", "placeId", "That place is already on this day.");
  }

  const item: TripItem = {
    id: input.itemId,
    placeId: input.placeId,
    role: "core",
    lock: "locked",
    source: "traveler",
  };
  const days = trip.days.map((candidate) =>
    candidate.dayIndex === day.dayIndex ? { ...candidate, items: [...candidate.items, item] } : candidate,
  );
  const unscheduled = trip.unscheduled.filter((existing) => existing.placeId !== item.placeId);
  return ok({ ...trip, days, unscheduled }, catalog);
}

export function removeStop(
  trip: TripDocument,
  catalog: CatalogSnapshot,
  input: { itemId: string; acknowledgeLocked?: boolean },
): EditResult {
  const located = findById(trip, input.itemId);
  if (!located) {
    return fail("unknown_item", "itemId", "That stop is not on the plan.");
  }
  if (located.item.lock === "locked" && input.acknowledgeLocked !== true) {
    return fail(
      "locked_stop",
      input.itemId,
      "This stop is locked. Removing it needs an explicit confirmation.",
    );
  }

  const mustSee = trip.preferences.constraints.mustSeePlaceIds.includes(located.item.placeId);
  const anotherCopy = hasOtherCopy(trip, located.item);
  if (mustSee && !anotherCopy && located.where === "unscheduled") {
    return fail(
      "must_see_kept",
      input.itemId,
      "This must-see stays on the unscheduled list. Remove it from must-see places before deleting it.",
    );
  }

  const cleared = withoutItem(trip, located.item.id);
  if (mustSee && !anotherCopy) {
    return ok(
      { ...cleared, unscheduled: [...cleared.unscheduled, located.item] },
      catalog,
    );
  }
  return ok(cleared, catalog);
}

export function moveStop(
  trip: TripDocument,
  catalog: CatalogSnapshot,
  input: { itemId: string; dayIndex: number },
): EditResult {
  const located = findById(trip, input.itemId);
  if (!located) {
    return fail("unknown_item", "itemId", "That stop is not on the plan.");
  }
  const day = trip.days.find((candidate) => candidate.dayIndex === input.dayIndex);
  if (!day) {
    return fail("unknown_day", "dayIndex", "That day is not part of this trip.");
  }
  if (located.where === "day" && located.dayIndex === day.dayIndex) {
    return ok(trip, catalog);
  }
  if (day.items.some((item) => item.placeId === located.item.placeId)) {
    return fail("duplicate_place", "dayIndex", "That place is already on the destination day.");
  }

  const cleared = withoutItem(trip, located.item.id);
  const days = cleared.days.map((candidate) =>
    candidate.dayIndex === day.dayIndex
      ? { ...candidate, items: [...candidate.items, located.item] }
      : candidate,
  );
  return ok({ ...cleared, days }, catalog);
}

export function reorderStop(
  trip: TripDocument,
  catalog: CatalogSnapshot,
  input: { itemId: string; toIndex: number },
): EditResult {
  const located = findById(trip, input.itemId);
  if (!located) {
    return fail("unknown_item", "itemId", "That stop is not on the plan.");
  }
  if (!Number.isInteger(input.toIndex) || input.toIndex < 0) {
    return fail("invalid_index", "toIndex", "The new position has to be a whole number.");
  }

  if (located.where === "unscheduled") {
    if (input.toIndex >= trip.unscheduled.length) {
      return fail("invalid_index", "toIndex", "The new position is outside the unscheduled list.");
    }
    const unscheduled = moveIndex(trip.unscheduled, located.index, input.toIndex);
    return ok({ ...trip, unscheduled }, catalog);
  }

  const day = trip.days.find((candidate) => candidate.dayIndex === located.dayIndex);
  if (!day || input.toIndex >= day.items.length) {
    return fail("invalid_index", "toIndex", "The new position is outside this day.");
  }
  const items = moveIndex(day.items, located.index, input.toIndex);
  const days = trip.days.map((candidate) =>
    candidate.dayIndex === day.dayIndex ? { ...candidate, items } : candidate,
  );
  return ok({ ...trip, days }, catalog);
}

export function lockStop(trip: TripDocument, catalog: CatalogSnapshot, itemId: string): EditResult {
  return setLock(trip, catalog, itemId, "locked");
}

export function unlockStop(trip: TripDocument, catalog: CatalogSnapshot, itemId: string): EditResult {
  return setLock(trip, catalog, itemId, "unlocked");
}

export function undoLastAiChange(trip: TripDocument, catalog: CatalogSnapshot): EditResult {
  if (trip.undoAi === null) {
    return fail("nothing_to_undo", "undoAi", "There is no generated change to undo.");
  }

  const restored: TripDocument = {
    ...trip,
    days: trip.undoAi.days.map(cloneDay),
    unscheduled: trip.undoAi.unscheduled.map((item) => ({ ...item })),
    summary: trip.undoAi.summary,
    notices: [],
    undoAi: null,
  };
  const parsed = parseTripDocument(restored, catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }
  return { ok: true, trip: parsed.trip };
}

function setLock(
  trip: TripDocument,
  catalog: CatalogSnapshot,
  itemId: string,
  lock: TripItem["lock"],
): EditResult {
  const located = findById(trip, itemId);
  if (!located) {
    return fail("unknown_item", "itemId", "That stop is not on the plan.");
  }
  const next = { ...located.item, lock };
  return ok(replaceItem(trip, next), catalog);
}

function ok(trip: TripDocument, catalog: CatalogSnapshot): EditResult {
  return { ok: true, trip: recomputeNotices(trip, catalog) };
}

function fail(code: string, path: string, message: string): EditResult {
  return { ok: false, issues: [issue(code, path, message)] };
}

function findById(trip: TripDocument, itemId: string): (ItemLocation & { item: TripItem }) | null {
  for (const day of trip.days) {
    const index = day.items.findIndex((item) => item.id === itemId);
    const item = day.items[index];
    if (item && index >= 0) {
      return { where: "day", dayIndex: day.dayIndex, index, item };
    }
  }
  const index = trip.unscheduled.findIndex((item) => item.id === itemId);
  const item = trip.unscheduled[index];
  if (item && index >= 0) {
    return { where: "unscheduled", index, item };
  }
  return null;
}

function hasOtherCopy(trip: TripDocument, item: TripItem): boolean {
  const scheduled = trip.days.some((day) =>
    day.items.some((candidate) => candidate.id !== item.id && candidate.placeId === item.placeId),
  );
  const waiting = trip.unscheduled.some(
    (candidate) => candidate.id !== item.id && candidate.placeId === item.placeId,
  );
  return scheduled || waiting;
}

function withoutItem(trip: TripDocument, itemId: string): TripDocument {
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      items: day.items.filter((item) => item.id !== itemId),
    })),
    unscheduled: trip.unscheduled.filter((item) => item.id !== itemId),
  };
}

function replaceItem(trip: TripDocument, next: TripItem): TripDocument {
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      items: day.items.map((item) => (item.id === next.id ? next : item)),
    })),
    unscheduled: trip.unscheduled.map((item) => (item.id === next.id ? next : item)),
  };
}

function moveIndex<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) {
    return next;
  }
  next.splice(to, 0, item);
  return next;
}

function cloneDay(day: TripDay): TripDay {
  return { dayIndex: day.dayIndex, date: day.date, items: day.items.map((item) => ({ ...item })) };
}
