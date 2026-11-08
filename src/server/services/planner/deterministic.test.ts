import assert from "node:assert/strict";
import test from "node:test";

import type { CatalogSnapshot, DynamicFact } from "@/lib/catalog";
import { getPrototypeCatalog } from "@/lib/catalog";
import type { TripDocument } from "@/features/trips/schemas";
import { planningHeuristic } from "./policy";
import { acceptableCopy } from "./text";
import { generateDeterministicItinerary } from "./deterministic";

const catalog = getPrototypeCatalog();

const base = {
  destinationId: "dst_paris",
  startDate: null,
  endDate: null,
  dayCount: 2,
  companions: "solo",
  pace: "steady",
  budget: "open",
  interests: ["landmarks"],
  priorities: { vibe: null, placeStyle: null },
  exclusions: { avoid: [], placeIds: [] },
  constraints: { mustSeePlaceIds: [], mobility: null },
  notes: null,
};

test("landmarks and food produce different approved place ids", () => {
  const landmarks = plan({ ...base, interests: ["landmarks"] });
  const food = plan({ ...base, interests: ["food"] });

  assert.deepEqual(placeIds(landmarks), [
    "plc_paris_arc_de_triomphe",
    "plc_paris_notre_dame",
    "plc_paris_sainte_chapelle",
    "plc_paris_eiffel_tower",
    "plc_paris_sacre_coeur",
  ]);
  assert.deepEqual(dayPlaceIds(landmarks), [
    ["plc_paris_arc_de_triomphe", "plc_paris_notre_dame", "plc_paris_sainte_chapelle"],
    ["plc_paris_eiffel_tower", "plc_paris_sacre_coeur"],
  ]);
  assert.deepEqual(placeIds(food), ["plc_paris_bouillon_pigalle", "plc_paris_pink_mamma"]);
  assert.deepEqual(dayPlaceIds(food), [
    ["plc_paris_bouillon_pigalle"],
    ["plc_paris_pink_mamma"],
  ]);
  assert.equal(placeIds(landmarks).some((id) => placeIds(food).includes(id)), false);
  assert.equal(placeIds(landmarks).includes("plc_paris_disneyland"), false);
  assert.equal(placeIds(food).includes("plc_paris_eiffel_tower"), false);
  assert.equal(noticeCodes(landmarks).includes("planner_fallback"), false);
  assertWithinPace(landmarks);
  assertWithinPace(food);
  assertNoPriceClaims(landmarks);
  assertNoPriceClaims(food);
});

test("a must-see place is kept and a place id is not repeated", () => {
  const planned = plan({
    ...base,
    interests: ["landmarks"],
    constraints: { mustSeePlaceIds: ["plc_paris_pink_mamma"], mobility: null },
  });
  const ids = placeIds(planned);
  assert.equal(ids.includes("plc_paris_pink_mamma"), true);
  assert.equal(ids.includes("plc_paris_eiffel_tower"), true);
  assert.equal(ids.filter((id) => id === "plc_paris_eiffel_tower").length, 1);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(noticeCodes(planned).includes("must_see_unscheduled"), false);
});

test("exclusions remove a category and a specific place", () => {
  const avoidLandmarks = plan({
    ...base,
    interests: ["food"],
    exclusions: { avoid: ["landmarks"], placeIds: [] },
  });
  assert.deepEqual(placeIds(avoidLandmarks), [
    "plc_paris_bouillon_pigalle",
    "plc_paris_pink_mamma",
  ]);

  const avoidOneTable = plan({
    ...base,
    interests: ["food"],
    exclusions: { avoid: [], placeIds: ["plc_paris_pink_mamma"] },
  });
  assert.deepEqual(placeIds(avoidOneTable), ["plc_paris_bouillon_pigalle"]);
  assert.equal(placeIds(avoidOneTable).includes("plc_paris_pink_mamma"), false);
});

test("pace and day count limit how many stops are scheduled", () => {
  const unhurried = plan({ ...base, dayCount: 1, pace: "unhurried", interests: ["landmarks"] });
  const full = plan({ ...base, dayCount: 1, pace: "full", interests: ["landmarks"] });
  const oneDay = plan({ ...base, dayCount: 1, pace: "steady", interests: ["landmarks"] });
  const threeDays = plan({ ...base, dayCount: 3, pace: "steady", interests: ["landmarks"] });
  const limited = plan({
    ...base,
    dayCount: 1,
    pace: "unhurried",
    interests: ["landmarks"],
    constraints: { mustSeePlaceIds: [], mobility: "limited_walking" },
  });

  assert.deepEqual(placeIds(unhurried), ["plc_paris_arc_de_triomphe", "plc_paris_eiffel_tower"]);
  assert.deepEqual(placeIds(full), [
    "plc_paris_arc_de_triomphe",
    "plc_paris_eiffel_tower",
    "plc_paris_notre_dame",
    "plc_paris_sacre_coeur",
  ]);
  assert.ok(placeIds(full).length > placeIds(unhurried).length);
  for (const id of placeIds(unhurried)) {
    assert.equal(placeIds(full).includes(id), true);
  }

  assert.equal(oneDay.days.length, 1);
  assert.equal(threeDays.days.length, 3);
  assert.deepEqual(placeIds(oneDay), [
    "plc_paris_arc_de_triomphe",
    "plc_paris_eiffel_tower",
    "plc_paris_notre_dame",
  ]);
  assert.equal(placeIds(threeDays).length, 5);
  assert.ok(threeDays.days.filter((day) => day.items.length > 0).length > 1);
  assert.deepEqual(placeIds(limited), ["plc_paris_arc_de_triomphe"]);
  assertWithinPace(unhurried);
  assertWithinPace(full);
  assertWithinPace(oneDay);
  assertWithinPace(threeDays);
  assertWithinPace(limited);
});

test("a major-day place stays on its own day and off a landmarks plan", () => {
  const mixed = plan({
    ...base,
    dayCount: 2,
    pace: "steady",
    interests: ["landmarks", "theme_parks"],
  });
  const city = mixed.days[0]?.items.map((item) => item.placeId) ?? [];
  const commitment = mixed.days[1]?.items.map((item) => item.placeId) ?? [];
  assert.equal(city.includes("plc_paris_disneyland"), false);
  assert.equal(commitment.includes("plc_paris_disneyland"), true);
  assert.equal(commitment.includes("plc_paris_eiffel_tower"), false);
  assert.equal(noticeCodes(mixed).includes("major_day_commitment"), true);
  assert.equal(noticeCodes(mixed).includes("major_day_mixed"), false);
});

test("draft places and unknown destinations are rejected", () => {
  const drafted = generateDeterministicItinerary({
    preferences: { ...base, interests: ["landmarks"] },
    catalog: withDraftPlace("plc_paris_eiffel_tower"),
  });
  assert.equal(drafted.ok, true);
  if (!drafted.ok || !drafted.trip) {
    return;
  }
  assert.equal(placeIds(drafted.trip).includes("plc_paris_eiffel_tower"), false);
  assert.equal(placeIds(drafted.trip).includes("plc_paris_arc_de_triomphe"), true);

  const bangkok = generateDeterministicItinerary({
    preferences: { ...base, destinationId: "dst_bangkok" },
    catalog: withDraftDestination(),
  });
  assert.equal(bangkok.ok, false);
  if (bangkok.ok) {
    return;
  }
  assert.equal(bangkok.trip, null);
  assert.equal(bangkok.issues.some((issue) => issue.code === "unapproved_destination"), true);

  const unknown = generateDeterministicItinerary({
    preferences: { ...base, destinationId: "dst_nowhere" },
    catalog,
  });
  assert.equal(unknown.ok, false);
  if (unknown.ok) {
    return;
  }
  assert.equal(unknown.issues.some((issue) => issue.code === "unapproved_destination"), true);
});

test("a historical price on the snapshot is not copied into the plan", () => {
  const priced = getPrototypeCatalog();
  const fact: DynamicFact = {
    id: "dyn_hidden_historical_price",
    subject: { type: "place", id: "plc_paris_eiffel_tower" },
    kind: "price",
    freshness: "unverified",
    source: {
      providerKey: "historical_note",
      externalId: "sty_hidden_rate",
      retrievedBy: "manual",
    },
    lastCheckedAt: null,
    lastVerifiedAt: null,
    expiresAt: null,
    historicalNote: "Historical reference only.",
    amountMinor: 880000,
    currency: "THB",
  };
  const planned = plan({ ...base, interests: ["landmarks"] }, { ...priced, dynamicFacts: [fact] });
  const rendered = JSON.stringify(planned);
  assert.equal(rendered.includes("880000"), false);
  assert.equal(rendered.includes("THB"), false);
  assert.equal(rendered.includes("sty_hidden_rate"), false);
  assert.equal(rendered.includes("historical_note"), false);
  assertNoPriceClaims(planned);
});

function plan(preferences: unknown, snapshot: CatalogSnapshot = catalog): TripDocument {
  const result = generateDeterministicItinerary({ preferences, catalog: snapshot });
  assert.equal(result.ok, true);
  if (!result.ok || !result.trip) {
    throw new Error("expected a plan");
  }
  return result.trip;
}

function placeIds(trip: TripDocument): string[] {
  return trip.days.flatMap((day) => day.items.map((item) => item.placeId));
}

function dayPlaceIds(trip: TripDocument): string[][] {
  return trip.days.map((day) => day.items.map((item) => item.placeId));
}

function noticeCodes(trip: TripDocument): string[] {
  return trip.notices.map((notice) => notice.code);
}

function assertWithinPace(trip: TripDocument) {
  const heuristic = planningHeuristic(trip.preferences);
  assert.equal(trip.days.length, trip.preferences.dayCount);
  const ids = placeIds(trip);
  assert.equal(new Set(ids).size, ids.length);
  for (const day of trip.days) {
    const core = day.items.filter((item) => item.role === "core");
    assert.ok(core.length <= heuristic.coreStops);
    let minutes = 0;
    for (const item of core) {
      const place = catalog.places.find((candidate) => candidate.id === item.placeId);
      if (typeof place?.approximateDurationMinutes === "number") {
        minutes += place.approximateDurationMinutes;
      }
    }
    assert.ok(minutes <= heuristic.knownMinutes);
  }
}

function assertNoPriceClaims(trip: TripDocument) {
  assert.equal(acceptableCopy(trip.summary), true);
  assert.equal(noticeCodes(trip).includes("no_prices"), true);
  assert.equal(noticeCodes(trip).includes("no_opening_hours"), true);
  assert.equal(noticeCodes(trip).includes("no_travel_times"), true);
  for (const notice of trip.notices) {
    assert.equal(acceptableCopy(notice.message), true);
  }
  const rendered = JSON.stringify(trip);
  assert.equal(rendered.includes("€"), false);
  assert.equal(rendered.includes("amountMinor"), false);
}

function withDraftPlace(placeId: string): CatalogSnapshot {
  return {
    ...catalog,
    places: catalog.places.map((place) =>
      place.id === placeId ? { ...place, status: "draft" } : place,
    ),
  };
}

function withDraftDestination(): CatalogSnapshot {
  const paris = catalog.destinations[0];
  if (!paris) {
    throw new Error("Paris is missing from the fixture.");
  }
  return {
    ...catalog,
    destinations: [
      ...catalog.destinations,
      {
        ...paris,
        id: "dst_bangkok",
        slug: "bangkok",
        name: "Bangkok",
        countryCode: "TH",
        status: "draft",
      },
    ],
  };
}
