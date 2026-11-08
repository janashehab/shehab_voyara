import assert from "node:assert/strict";
import test from "node:test";

import { parisCatalog } from "@/lib/catalog";
import {
  CONCIERGE_MAX_BYTES,
  conciergeFailure,
  planConcierge,
  revalidateSavedTrip,
  screenConciergeRequest,
} from "@/server/services/planner/concierge";

import {
  PLAN_STORAGE_KEY,
  PLAN_STORAGE_MAX_BYTES,
  clearPlan,
  isBlankPlan,
  readPlan,
  restoredSelectedDay,
  restoredUndo,
  savedPlanDisposition,
  shouldApplyRestore,
  storageWriteAllowed,
  undoForRefinement,
  undoLabelForInstruction,
  writePlan,
  type PlanStorage,
  type SavedPlan,
  type SavedUndo,
} from "./plan-storage";

class MemoryStorage implements PlanStorage {
  values = new Map<string, string>();
  failWrites = false;
  failReads = false;

  getItem(key: string): string | null {
    if (this.failReads) {
      throw new Error("storage blocked");
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("QuotaExceededError");
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function saved(
  trip: Record<string, unknown> | null,
  pending: SavedPlan["pending"] = null,
  undo: SavedUndo | null = null,
): SavedPlan {
  return {
    version: 1,
    trip,
    questionnaire: { step: trip ? "plan" : "days", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    selectedDay: 2,
    initialPace: "steady",
    pending,
    undo,
  };
}

test("a saved envelope keeps the trip, pending answers, selected day, and first pace", () => {
  const storage = new MemoryStorage();
  const envelope = saved({ id: "trp_plan_1", notices: [{ message: "ignore this notice" }] }, { dayCount: 3 });
  assert.equal(writePlan(storage, envelope), "saved");
  const read = readPlan(storage);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") {
    return;
  }
  assert.equal(read.envelope.selectedDay, 2);
  assert.equal(read.envelope.initialPace, "steady");
  assert.deepEqual(read.envelope.pending, { dayCount: 3 });
  assert.deepEqual(read.envelope.trip?.notices, []);
  assert.equal(JSON.stringify(read.envelope).includes("ignore this notice"), false);
});

test("malformed, outdated, oversized, and catalog-bearing envelopes are rejected", () => {
  const storage = new MemoryStorage();
  storage.setItem(PLAN_STORAGE_KEY, "{");
  assert.deepEqual(readPlan(storage), { status: "rejected", reason: "malformed" });

  storage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ version: 2 }));
  assert.deepEqual(readPlan(storage), { status: "rejected", reason: "version" });

  storage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ ...saved(null), view: { days: [] } }));
  assert.deepEqual(readPlan(storage), { status: "rejected", reason: "invalid" });

  storage.setItem(PLAN_STORAGE_KEY, JSON.stringify(saved({ catalog: { places: [] } })));
  assert.deepEqual(readPlan(storage), { status: "rejected", reason: "invalid" });

  storage.setItem(PLAN_STORAGE_KEY, "x".repeat(PLAN_STORAGE_MAX_BYTES + 1));
  assert.deepEqual(readPlan(storage), { status: "rejected", reason: "oversized" });
});

test("an empty initial render does not overwrite a saved trip", () => {
  const storage = new MemoryStorage();
  writePlan(storage, saved({ id: "trp_plan_1" }));
  const before = storage.getItem(PLAN_STORAGE_KEY);
  assert.equal(storageWriteAllowed("hold"), false);
  if (storageWriteAllowed("hold")) {
    writePlan(storage, saved(null));
  }
  assert.equal(storage.getItem(PLAN_STORAGE_KEY), before);
});

test("full or blocked storage leaves the previous value and stays in memory", () => {
  const storage = new MemoryStorage();
  writePlan(storage, saved({ id: "trp_plan_1" }));
  storage.failWrites = true;
  assert.equal(writePlan(storage, saved({ id: "trp_plan_2" })), "unavailable");
  const read = readPlan(storage);
  assert.equal(read.status, "ok");
  if (read.status === "ok") {
    assert.equal(read.envelope.trip?.id, "trp_plan_1");
  }
  storage.failReads = true;
  assert.equal(readPlan(storage).status, "unavailable");
  assert.equal(clearPlan(storage), "cleared");
});

test("a blank plan is removable and a missing day falls back to day 1", () => {
  const blank: SavedPlan = {
    version: 1,
    trip: null,
    questionnaire: { step: "place", dayCount: null, interests: [], pace: null },
    selectedDay: 1,
    initialPace: null,
    pending: null,
    undo: null,
  };
  assert.equal(isBlankPlan(blank), true);
  assert.equal(isBlankPlan(saved(null)), false);
  assert.equal(restoredSelectedDay(4, [{ dayIndex: 1 }, { dayIndex: 2 }]), 1);
  assert.equal(restoredSelectedDay(2, [{ dayIndex: 1 }, { dayIndex: 2 }]), 2);
  assert.equal(shouldApplyRestore(1, 1), true);
  assert.equal(shouldApplyRestore(1, 2), false);
});

test("the server accepts a saved trip only against the approved catalog", () => {
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog: parisCatalog,
    now: 1,
    callerKey: "restore-plan",
    skipScreen: true,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const restored = revalidateSavedTrip({ trip: { ...planned.trip, notices: [{ code: "no_prices", message: "Pay $10 now.", placeId: null, dayIndex: null }] } }, parisCatalog);
  assert.equal(restored.ok, true);
  if (!restored.ok) {
    return;
  }
  assert.equal(JSON.stringify(restored.view).includes("$10"), false);
  assert.equal(JSON.stringify(restored.view).includes("Pay "), false);
  assert.equal(restored.view.days.some((day) => day.stops.some((stop) => stop.name === "Arc de Triomphe")), true);

  const labeled = structuredClone(planned.trip);
  const firstItem = labeled.days[0]?.items[0];
  assert.ok(firstItem);
  Object.assign(firstItem, { name: "Saved label" });
  const labeledResult = revalidateSavedTrip({ trip: labeled }, parisCatalog);
  assert.equal(labeledResult.ok, false);
  if (!labeledResult.ok) {
    assert.equal(labeledResult.view, null);
    assert.equal(JSON.stringify(labeledResult).includes("Saved label"), false);
  }

  const priced = revalidateSavedTrip({ trip: { ...planned.trip, summary: "The price is €50." } }, parisCatalog);
  assert.equal(priced.ok, false);
  if (!priced.ok) {
    assert.equal(priced.view, null);
  }

  const placeId = planned.trip.days.flatMap((day) => day.items)[0]?.placeId;
  assert.ok(placeId);
  const removed = {
    ...parisCatalog,
    places: parisCatalog.places.filter((place) => place.id !== placeId),
  };
  const rejected = revalidateSavedTrip({ trip: planned.trip }, removed);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "unapproved_place");
    assert.equal(rejected.view, null);
    assert.equal(savedPlanDisposition(rejected.error.code), "clear");
  }
});

test("a catalog outage keeps the saved plan and does not invent places", () => {
  const failed = conciergeFailure(new Error("connect ECONNREFUSED 127.0.0.1"));
  assert.equal(failed.ok, false);
  if (failed.ok) {
    return;
  }
  assert.equal(failed.view, null);
  assert.equal(failed.trip, null);
  assert.equal(failed.error.code, "catalog_unavailable");
  assert.equal(savedPlanDisposition(failed.error.code), "keep");
  assert.equal(JSON.stringify(failed).includes("plc_"), false);

  const oversized = screenConciergeRequest({ trip: "x".repeat(CONCIERGE_MAX_BYTES) }, 1, "restore-size");
  assert.equal(oversized.ok, false);
  if (!oversized.ok) {
    assert.equal(oversized.error.code, "payload_too_large");
    assert.equal(savedPlanDisposition(oversized.error.code), "clear");
  }
  const supplied = screenConciergeRequest({ trip: { id: "trp_plan_1" }, catalog: parisCatalog }, 2, "restore-catalog");
  assert.equal(supplied.ok, false);
  if (!supplied.ok) {
    assert.equal(supplied.error.code, "untrusted_catalog");
  }
});

test("a saved plan from before undo still reads, and a bad undo snapshot is dropped", () => {
  const storage = new MemoryStorage();
  const legacy = saved({ id: "trp_plan_1" });
  const withoutUndo = {
    version: legacy.version,
    trip: legacy.trip,
    questionnaire: legacy.questionnaire,
    selectedDay: legacy.selectedDay,
    initialPace: legacy.initialPace,
    pending: legacy.pending,
  };
  storage.setItem(PLAN_STORAGE_KEY, JSON.stringify(withoutUndo));
  const read = readPlan(storage);
  assert.equal(read.status, "ok");
  if (read.status === "ok") {
    assert.equal(read.envelope.undo, null);
    assert.equal(read.envelope.trip?.id, "trp_plan_1");
  }

  storage.setItem(
    PLAN_STORAGE_KEY,
    JSON.stringify({ ...withoutUndo, undo: { label: "yesterday", trip: { id: "trp_old" } } }),
  );
  const dropped = readPlan(storage);
  assert.equal(dropped.status, "ok");
  if (dropped.status === "ok") {
    assert.equal(dropped.envelope.undo, null);
    assert.equal(dropped.envelope.trip?.id, "trp_plan_1");
  }

  storage.setItem(
    PLAN_STORAGE_KEY,
    JSON.stringify({ ...withoutUndo, undo: { label: "less walking", trip: { catalog: { places: [] } } } }),
  );
  const catalogBearing = readPlan(storage);
  assert.equal(catalogBearing.status, "ok");
  if (catalogBearing.status === "ok") {
    assert.equal(catalogBearing.envelope.undo, null);
  }
});

test("one successful refinement replaces the only undo snapshot", () => {
  const before = { id: "trp_before" };
  const afterLessWalking = undoForRefinement(null, before, undoLabelForInstruction("less walking"), true);
  assert.deepEqual(afterLessWalking, { label: "less walking", trip: before });

  const afterCafes = undoForRefinement(
    afterLessWalking,
    { id: "trp_after_walking" },
    undoLabelForInstruction("more cafes"),
    true,
  );
  assert.equal(afterCafes?.label, "more cafés");
  assert.equal(afterCafes?.trip.id, "trp_after_walking");

  const failed = undoForRefinement(afterCafes, { id: "trp_failed" }, "museum", false);
  assert.equal(failed?.trip.id, "trp_after_walking");

  const locked = undoForRefinement(afterCafes, { id: "trp_locked" }, null, true);
  assert.equal(locked?.trip.id, "trp_after_walking");
  assert.equal(undoLabelForInstruction("replace a museum"), "museum");
  assert.equal(undoLabelForInstruction("add a beach"), null);
});

test("an invalid undo trip is discarded and a catalog outage keeps it", () => {
  const stored: SavedUndo = { label: "museum", trip: { id: "trp_undo" } };
  const validated = restoredUndo(stored, { ok: true, trip: { id: "trp_undo", notices: [] } });
  assert.equal(validated.discarded, false);
  assert.equal(validated.undo?.trip.id, "trp_undo");

  const invalid = restoredUndo(stored, { ok: false, code: "unapproved_place" });
  assert.equal(invalid.discarded, true);
  assert.equal(invalid.undo, null);

  const unavailable = restoredUndo(stored, { ok: false, code: "catalog_unavailable" });
  assert.equal(unavailable.discarded, false);
  assert.equal(unavailable.undo, stored);
});

test("an undo snapshot that does not fit is omitted and the current trip stays saved", () => {
  const storage = new MemoryStorage();
  const current = { id: "trp_current" };
  const oversizedUndo: SavedUndo = {
    label: "less walking",
    trip: { id: "trp_previous", pad: "x".repeat(PLAN_STORAGE_MAX_BYTES) },
  };
  assert.equal(writePlan(storage, saved(current, null, oversizedUndo)), "trimmed");
  const read = readPlan(storage);
  assert.equal(read.status, "ok");
  if (read.status === "ok") {
    assert.equal(read.envelope.trip?.id, "trp_current");
    assert.equal(read.envelope.undo, null);
  }

  const before = storage.getItem(PLAN_STORAGE_KEY);
  const oversizedTrip = saved({ id: "trp_big", pad: "y".repeat(PLAN_STORAGE_MAX_BYTES) }, null, oversizedUndo);
  assert.equal(writePlan(storage, oversizedTrip), "oversized");
  assert.equal(storage.getItem(PLAN_STORAGE_KEY), before);

  storage.failWrites = true;
  assert.equal(writePlan(storage, saved(current, null, { label: "museum", trip: { id: "trp_previous" } })), "unavailable");
  assert.equal(storage.getItem(PLAN_STORAGE_KEY), before);
});
