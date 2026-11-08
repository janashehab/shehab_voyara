import assert from "node:assert/strict";
import test from "node:test";

import { describeTripPace, initialConciergeAnswers } from "@/features/trips/concierge-display";
import { getPrototypeCatalog } from "@/lib/catalog";
import type { TripDocument } from "@/features/trips/schemas";

import {
  CONCIERGE_MAX_ATTEMPTS,
  conciergeFailure,
  lockConciergeStop,
  planConcierge,
  presentConciergeTrip,
  refineConcierge,
  replaceConciergeMuseum,
  resetConciergeAttempts,
} from "./concierge";

const catalog = getPrototypeCatalog();

test("a Paris request returns named places and no prices", () => {
  resetConciergeAttempts();
  const result = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "plan-landmarks",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const names = result.view.days.flatMap((day) => day.stops.map((stop) => stop.name));
  assert.equal(names.includes("Eiffel Tower"), true);
  assert.equal(names.includes("Bouillon Pigalle"), false);
  const eiffel = result.view.days.flatMap((day) => day.stops).find((stop) => stop.name === "Eiffel Tower");
  assert.equal(eiffel?.photo?.src, "/images/travel/paris-seine-eiffel.jpg");
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes("amountMinor"), false);
  assert.equal(rendered.includes("THB"), false);
  assert.equal(rendered.includes("€"), false);
  assert.equal(rendered.includes("postgres"), false);
});

test("other destinations, extra catalog data, and oversized requests are refused", () => {
  resetConciergeAttempts();
  const bangkok = planConcierge({
    request: { destinationId: "dst_bangkok", dayCount: 2, interests: ["food"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "plan-bangkok",
  });
  assert.equal(bangkok.ok, false);
  if (bangkok.ok) {
    return;
  }
  assert.equal(bangkok.error.code, "unapproved_destination");
  assert.equal(bangkok.trip, null);
  assert.equal(JSON.stringify(bangkok).includes("postgres"), false);

  const supplied = planConcierge({
    request: {
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["landmarks"],
      pace: "steady",
      catalog: { places: [{ id: "plc_paris_fake_cafe" }] },
    },
    catalog,
    now: 1,
    callerKey: "plan-catalog",
  });
  assert.equal(supplied.ok, false);
  if (supplied.ok) {
    return;
  }
  assert.equal(supplied.error.code, "untrusted_catalog");

  const oversized = planConcierge({
    request: {
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["landmarks"],
      pace: "steady",
      padding: "x".repeat(25_000),
    },
    catalog,
    now: 1,
    callerKey: "plan-size",
  });
  assert.equal(oversized.ok, false);
  if (oversized.ok) {
    return;
  }
  assert.equal(oversized.error.code, "payload_too_large");
});

test("refinement, an unsupported request, and a tampered trip stay safe", () => {
  resetConciergeAttempts();
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "refine-base",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const before = placeIds(planned.trip);

  const fed = refineConcierge({
    request: { trip: planned.trip, instruction: "more cafés" },
    catalog,
    now: 2,
    callerKey: "refine-food",
  });
  assert.equal(fed.ok, true);
  if (!fed.ok) {
    return;
  }
  const names = fed.view.days.flatMap((day) => day.stops.map((stop) => stop.name));
  assert.equal(names.includes("Pink Mamma") || names.includes("Bouillon Pigalle"), true);

  const original = JSON.stringify(fed.trip);
  const unknown = refineConcierge({
    request: { trip: fed.trip, instruction: "book a boat" },
    catalog,
    now: 3,
    callerKey: "refine-unknown",
  });
  assert.equal(unknown.ok, false);
  if (unknown.ok || !unknown.trip) {
    return;
  }
  assert.equal(unknown.error.code, "unsupported_refinement");
  assert.deepEqual(placeIds(unknown.trip), placeIds(fed.trip));
  assert.equal(JSON.stringify(fed.trip), original);

  const tampered = structuredClone(fed.trip);
  const first = tampered.days[0]?.items[0];
  if (!first) {
    throw new Error("expected a stop");
  }
  first.placeId = "plc_paris_not_real";
  const rejected = refineConcierge({
    request: { trip: tampered, instruction: "less walking" },
    catalog,
    now: 4,
    callerKey: "refine-tamper",
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    return;
  }
  assert.equal(rejected.trip, null);
  assert.equal(JSON.stringify(rejected).includes("plc_paris_not_real"), false);
  assert.equal(before.includes("plc_paris_eiffel_tower"), true);
});

test("lock and unlock keep the same places and an empty day keeps its notice", () => {
  resetConciergeAttempts();
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 3, interests: ["food"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "lock-food",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const empty = planned.view.days.find((day) => day.stops.length === 0);
  assert.ok(empty?.notice);
  const stripped: TripDocument = { ...planned.trip, notices: [] };
  const again = presentConciergeTrip(stripped, catalog);
  assert.equal(again.days.some((day) => day.stops.length === 0 && day.notice !== null), true);

  const stop = planned.view.days.flatMap((day) => day.stops)[0];
  assert.ok(stop);
  const locked = lockConciergeStop({
    request: { trip: planned.trip, itemId: stop.itemId, locked: true },
    catalog,
    now: 2,
    callerKey: "lock-on",
  });
  assert.equal(locked.ok, true);
  if (!locked.ok) {
    return;
  }
  assert.equal(locked.view.days.flatMap((day) => day.stops).some((item) => item.itemId === stop.itemId && item.locked), true);
  assert.deepEqual(placeIds(locked.trip), placeIds(planned.trip));

  const unlocked = lockConciergeStop({
    request: { trip: locked.trip, itemId: stop.itemId, locked: false },
    catalog,
    now: 3,
    callerKey: "lock-off",
  });
  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) {
    return;
  }
  assert.equal(
    unlocked.view.days.flatMap((day) => day.stops).some((item) => item.itemId === stop.itemId && item.locked),
    false,
  );
});

test("the current pace follows the trip and the first answer can stay different", () => {
  resetConciergeAttempts();
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "pace-current",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  assert.equal(planned.view.pace, "steady");
  assert.equal(planned.view.mobility, null);
  assert.equal(describeTripPace(planned.view.pace, "steady").initialNote, null);

  const relaxed = refineConcierge({
    request: { trip: planned.trip, instruction: "less walking" },
    catalog,
    now: 2,
    callerKey: "pace-relaxed",
  });
  assert.equal(relaxed.ok, true);
  if (!relaxed.ok) {
    return;
  }
  assert.equal(relaxed.view.pace, "unhurried");
  assert.equal(describeTripPace(relaxed.view.pace, "steady").currentLabel, "Unhurried");
  assert.equal(describeTripPace(relaxed.view.pace, "steady").initialNote, "Your first answer was Steady.");
  assert.equal(planned.trip.preferences.pace, "steady");
});

test("a selected museum is replaced without accepting a client place", () => {
  resetConciergeAttempts();
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "museum-plan",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const before = JSON.stringify(planned.trip);
  const ambiguous = refineConcierge({
    request: { trip: planned.trip, instruction: "replace a museum" },
    catalog,
    now: 2,
    callerKey: "museum-ask",
  });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok || !ambiguous.view) {
    return;
  }
  assert.equal(ambiguous.error.code, "ambiguous_museum");
  assert.equal(JSON.stringify(planned.trip), before);
  const names = ambiguous.view.museumChoices.map((choice) => choice.name);
  assert.equal(names.includes("Notre-Dame"), true);
  assert.equal(names.includes("Sainte-Chapelle"), true);
  assert.equal(names.includes("Eiffel Tower"), false);
  const sainte = ambiguous.view.museumChoices.find((choice) => choice.name === "Sainte-Chapelle");
  const notre = ambiguous.view.museumChoices.find((choice) => choice.name === "Notre-Dame");
  assert.ok(sainte && notre);

  const swapped = replaceConciergeMuseum({
    request: { trip: planned.trip, itemId: sainte.itemId },
    catalog,
    now: 3,
    callerKey: "museum-swap",
  });
  assert.equal(swapped.ok, true);
  if (!swapped.ok) {
    return;
  }
  const swappedNames = allNames(swapped.view);
  assert.equal(swappedNames.includes("Sainte-Chapelle"), false);
  assert.equal(swappedNames.includes("Notre-Dame"), true);
  assert.equal(swappedNames.includes("Louvre"), true);
  assert.equal(JSON.stringify(planned.trip), before);

  const supplied = replaceConciergeMuseum({
    request: { trip: planned.trip, itemId: notre.itemId, placeId: "plc_paris_louvre" },
    catalog,
    now: 4,
    callerKey: "museum-supplied",
  });
  assert.equal(supplied.ok, false);
  if (supplied.ok) {
    return;
  }
  assert.equal(supplied.trip, null);
  assert.equal(JSON.stringify(supplied).includes("plc_paris_louvre"), false);
  assert.equal(JSON.stringify(planned.trip), before);

  const missing = replaceConciergeMuseum({
    request: { trip: planned.trip, itemId: "itm_not_on_this_plan" },
    catalog,
    now: 5,
    callerKey: "museum-missing",
  });
  assert.equal(missing.ok, false);
  if (missing.ok || !missing.trip) {
    return;
  }
  assert.equal(missing.error.code, "unknown_item");
  assert.deepEqual(placeIds(missing.trip), placeIds(planned.trip));

  const locked = lockConciergeStop({
    request: { trip: planned.trip, itemId: notre.itemId, locked: true },
    catalog,
    now: 6,
    callerKey: "museum-lock",
  });
  assert.equal(locked.ok, true);
  if (!locked.ok) {
    return;
  }
  assert.equal(
    locked.view.museumChoices.some((choice) => choice.itemId === notre.itemId),
    false,
  );
  const refused = replaceConciergeMuseum({
    request: { trip: locked.trip, itemId: notre.itemId },
    catalog,
    now: 7,
    callerKey: "museum-locked",
  });
  assert.equal(refused.ok, false);
  if (refused.ok || !refused.trip) {
    return;
  }
  assert.equal(refused.error.code, "locked_stop");
  assert.equal(
    [...refused.trip.days.flatMap((day) => day.items), ...refused.trip.unscheduled].some(
      (item) => item.id === notre.itemId && item.lock === "locked" && item.placeId === "plc_paris_notre_dame",
    ),
    true,
  );

  const required = structuredClone(planned.trip);
  required.preferences.constraints.mustSeePlaceIds = ["plc_paris_sainte_chapelle"];
  const requiredJson = JSON.stringify(required);
  const requiredView = presentConciergeTrip(required, catalog);
  assert.equal(
    requiredView.museumChoices.some((choice) => choice.itemId === sainte.itemId),
    false,
  );
  const kept = replaceConciergeMuseum({
    request: { trip: required, itemId: sainte.itemId },
    catalog,
    now: 8,
    callerKey: "museum-required",
  });
  assert.equal(JSON.stringify(required), requiredJson);
  assert.equal(kept.ok, false);
  if (kept.ok || !kept.trip) {
    return;
  }
  assert.equal(kept.error.code, "must_see_kept");
  assert.equal(
    placeIds(kept.trip).includes("plc_paris_sainte_chapelle") ||
      kept.trip.unscheduled.some((item) => item.placeId === "plc_paris_sainte_chapelle"),
    true,
  );
  assert.equal(hasPlaceId(kept.trip, "plc_paris_louvre"), false);
});

test("start over returns the blank questionnaire and follow-up state", () => {
  const started = initialConciergeAnswers();
  started.step = "plan";
  started.dayCount = 2;
  started.interests = ["landmarks", "food"];
  started.initialPace = "steady";
  started.selectedDay = 2;
  started.note = "book a boat";
  assert.deepEqual(initialConciergeAnswers(), {
    step: "place",
    dayCount: null,
    interests: [],
    initialPace: null,
    selectedDay: 1,
    note: "",
  });
  assert.equal(started.note, "book a boat");
});

test("repeated requests are limited and catalog failures hide connection details", () => {
  resetConciergeAttempts();
  const request = { destinationId: "dst_paris", dayCount: 1, interests: ["landmarks"], pace: "steady" };
  let limited = planConcierge({ request, catalog, now: 10, callerKey: "rate-window" });
  for (let count = 1; count < CONCIERGE_MAX_ATTEMPTS; count += 1) {
    limited = planConcierge({ request, catalog, now: 10, callerKey: "rate-window" });
    assert.equal(limited.ok, true);
  }
  const blocked = planConcierge({ request, catalog, now: 10, callerKey: "rate-window" });
  assert.equal(blocked.ok, false);
  if (blocked.ok) {
    return;
  }
  assert.equal(blocked.error.code, "rate_limited");
  assert.equal(JSON.stringify(blocked).includes("rate-window"), false);

  const logs: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    const secret = "postgres://voyara_user:super-secret-password@db.internal:6543/postgres";
    const failed = conciergeFailure(new Error(`Can't reach ${secret}`));
    assert.equal(failed.ok, false);
    if (failed.ok) {
      return;
    }
    assert.equal(failed.error.message, "The approved catalog could not be read.");
    const visible = `${JSON.stringify(failed)} ${logs.join(" ")}`;
    assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes("super-secret-password"), false);
    assert.equal(visible.includes("postgres://"), false);
  } finally {
    console.error = original;
  }
});

function placeIds(trip: TripDocument): string[] {
  return trip.days.flatMap((day) => day.items.map((item) => item.placeId));
}

function hasPlaceId(trip: TripDocument, placeId: string): boolean {
  return (
    placeIds(trip).includes(placeId) || trip.unscheduled.some((item) => item.placeId === placeId)
  );
}

function allNames(view: { days: { stops: { name: string }[] }[]; unscheduled: { name: string }[] }): string[] {
  return [...view.days.flatMap((day) => day.stops.map((stop) => stop.name)), ...view.unscheduled.map((stop) => stop.name)];
}
