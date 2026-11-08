import assert from "node:assert/strict";
import test from "node:test";

import type { CatalogSnapshot, DynamicFact } from "@/lib/catalog";
import { getPrototypeCatalog } from "@/lib/catalog";
import type { TripDocument, TripItem } from "@/features/trips/schemas";

import { generateDeterministicItinerary } from "./deterministic";
import { createIdFactory } from "./ids";
import { planFromDraft } from "./policy";
import { refineDeterministicItinerary, replaceDeterministicMuseumStop } from "./refine-deterministic";
import { acceptableCopy } from "./text";
import { parseTravelerPreferences } from "./validate";

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
  exclusions: { avoid: [] as string[], placeIds: [] as string[] },
  constraints: { mustSeePlaceIds: [] as string[], mobility: null },
  notes: null,
};

test("less walking and more relaxed move stops that no longer fit", () => {
  const before = withMustSee(landmarks({ pace: "full", dayCount: 1 }), "plc_paris_eiffel_tower");
  const relaxed = refine(before, "less walking");
  const alias = refine(before, "More relaxed.");

  assert.equal(relaxed.preferences.pace, "steady");
  assert.equal(relaxed.preferences.constraints.mobility, null);
  assert.deepEqual(placeIds(relaxed), [
    "plc_paris_arc_de_triomphe",
    "plc_paris_eiffel_tower",
    "plc_paris_notre_dame",
  ]);
  assert.deepEqual(
    relaxed.unscheduled.map((item) => item.placeId),
    ["plc_paris_sacre_coeur"],
  );
  assert.deepEqual(placeIds(alias), placeIds(relaxed));
  assert.equal(hasPlace(relaxed, "plc_paris_eiffel_tower"), true);
  assertNoClaims(relaxed);
});

test("a locked stop stays when the pace gets tighter", () => {
  const before = lockPlace(landmarks({ pace: "full", dayCount: 1 }), "plc_paris_sacre_coeur");
  const relaxed = refine(before, "less walking");
  const kept = findItem(relaxed, "plc_paris_sacre_coeur");
  assert.equal(kept?.lock, "locked");
  assert.equal(placeIds(relaxed).includes("plc_paris_sacre_coeur"), true);
  assert.equal(relaxed.unscheduled.some((item) => item.placeId === "plc_paris_notre_dame"), true);
  assert.equal(hasPlace(relaxed, "plc_paris_eiffel_tower"), true);
});

test("limited walking is applied only after the pace is already unhurried", () => {
  const before = planned({
    ...base,
    dayCount: 2,
    pace: "unhurried",
    draft: {
      summary: "",
      days: [
        {
          dayIndex: 2,
          items: [
            { placeId: "plc_paris_eiffel_tower", role: "core" },
            { placeId: "plc_paris_notre_dame", role: "core" },
          ],
        },
      ],
      unscheduledPlaceIds: [],
    },
  });
  const relaxed = refine(before, "more relaxed");
  assert.equal(relaxed.preferences.pace, "unhurried");
  assert.equal(relaxed.preferences.constraints.mobility, "limited_walking");
  assert.equal(placeIds(relaxed).includes("plc_paris_eiffel_tower"), false);
  assert.equal(relaxed.unscheduled.some((item) => item.placeId === "plc_paris_eiffel_tower"), true);
  assert.equal(relaxed.days.some((day) => day.items.length === 0), true);
  assert.equal(noticeCodes(relaxed).includes("catalog_gap"), true);
  assert.equal(noticeCodes(relaxed).includes("mobility_unknown"), true);
  assertNoClaims(relaxed);

  const snapshot = JSON.stringify(relaxed);
  const again = refineDeterministicItinerary({
    trip: relaxed,
    instruction: "less walking",
    catalog,
  });
  assert.equal(again.ok, false);
  if (again.ok || !again.trip) {
    return;
  }
  assert.equal(again.issues.some((issue) => issue.code === "refinement_limit"), true);
  assert.deepEqual(placeIds(again.trip), placeIds(relaxed));
  assert.equal(JSON.stringify(relaxed), snapshot);
});

test("more cafés adds approved dining places and does not duplicate them", () => {
  const before = lockPlace(landmarks({ pace: "steady", dayCount: 2 }), "plc_paris_eiffel_tower");
  const fed = refine(before, "more cafés");
  assert.deepEqual(fed.preferences.interests, ["landmarks", "food"]);
  assert.deepEqual(dayPlaceIds(fed), [
    ["plc_paris_arc_de_triomphe", "plc_paris_notre_dame", "plc_paris_sainte_chapelle", "plc_paris_pink_mamma"],
    ["plc_paris_eiffel_tower", "plc_paris_sacre_coeur", "plc_paris_bouillon_pigalle"],
  ]);
  assert.equal(findItem(fed, "plc_paris_eiffel_tower")?.lock, "locked");
  assert.equal(new Set(allPlaceIds(fed)).size, allPlaceIds(fed).length);
  assert.equal(hasPlace(fed, "plc_paris_disneyland"), false);
  assertNoClaims(fed);

  const again = refineDeterministicItinerary({
    trip: fed,
    instruction: "more food spots",
    catalog,
  });
  assert.equal(again.ok, false);
  if (again.ok || !again.trip) {
    return;
  }
  assert.equal(again.issues.some((issue) => issue.code === "insufficient_matches"), true);
  assert.deepEqual(dayPlaceIds(again.trip), dayPlaceIds(fed));
  assert.equal(allPlaceIds(again.trip).filter((id) => id === "plc_paris_pink_mamma").length, 1);
});

test("more food reports a catalog gap when no dining place can be added", () => {
  const blocked = landmarks({
    pace: "steady",
    dayCount: 2,
    exclusions: { avoid: [], placeIds: ["plc_paris_pink_mamma", "plc_paris_bouillon_pigalle"] },
  });
  const fed = refine(blocked, "more cafes");
  assert.deepEqual(fed.preferences.interests, ["landmarks", "food"]);
  assert.equal(hasPlace(fed, "plc_paris_pink_mamma"), false);
  assert.equal(hasPlace(fed, "plc_paris_bouillon_pigalle"), false);
  assert.equal(noticeCodes(fed).includes("thin_coverage"), true);
  assertNoClaims(fed);

  const contradicted = landmarks({
    pace: "steady",
    dayCount: 2,
    exclusions: { avoid: ["food"], placeIds: [] },
  });
  const refused = refineDeterministicItinerary({
    trip: contradicted,
    instruction: "more food spots",
    catalog,
  });
  assert.equal(refused.ok, false);
  if (refused.ok || !refused.trip) {
    return;
  }
  assert.equal(refused.issues.some((issue) => issue.code === "preference_contradiction"), true);
  assert.deepEqual(dayPlaceIds(refused.trip), dayPlaceIds(contradicted));
  assert.equal(refused.trip.preferences.interests.includes("food"), false);
});

test("replace a museum swaps one unlocked museum and refuses ambiguous requests", () => {
  const single = landmarks({ pace: "full", dayCount: 1 });
  const replaced = refine(single, "replace a museum");
  assert.deepEqual(placeIds(replaced), [
    "plc_paris_arc_de_triomphe",
    "plc_paris_eiffel_tower",
    "plc_paris_sainte_chapelle",
    "plc_paris_sacre_coeur",
  ]);
  assert.equal(hasPlace(replaced, "plc_paris_notre_dame"), false);
  assert.equal(hasPlace(replaced, "plc_paris_louvre"), false);
  assert.deepEqual(replaced.preferences.interests, ["landmarks"]);

  const ambiguousSource = landmarks({ pace: "steady", dayCount: 2 });
  const before = JSON.stringify(ambiguousSource);
  const ambiguous = refineDeterministicItinerary({
    trip: ambiguousSource,
    instruction: "replace a museum",
    catalog,
  });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok || !ambiguous.trip) {
    return;
  }
  assert.equal(ambiguous.issues.some((issue) => issue.code === "ambiguous_museum"), true);
  assert.deepEqual(dayPlaceIds(ambiguous.trip), dayPlaceIds(ambiguousSource));
  assert.equal(JSON.stringify(ambiguousSource), before);
  assert.equal(hasPlace(ambiguous.trip, "plc_paris_notre_dame"), true);
  assert.equal(hasPlace(ambiguous.trip, "plc_paris_sainte_chapelle"), true);
});

test("a locked museum, a missing museum, and a missing replacement stay unchanged", () => {
  const locked = lockPlace(landmarks({ pace: "full", dayCount: 1 }), "plc_paris_notre_dame");
  const keptLocked = refineDeterministicItinerary({
    trip: locked,
    instruction: "replace a museum",
    catalog,
  });
  assert.equal(keptLocked.ok, false);
  if (keptLocked.ok || !keptLocked.trip) {
    return;
  }
  assert.equal(keptLocked.issues.some((issue) => issue.code === "locked_stop"), true);
  assert.equal(findItem(keptLocked.trip, "plc_paris_notre_dame")?.lock, "locked");

  const foodOnly = landmarks({ pace: "steady", dayCount: 2, interests: ["food"] });
  const missing = refineDeterministicItinerary({
    trip: foodOnly,
    instruction: "replace a museum",
    catalog,
  });
  assert.equal(missing.ok, false);
  if (missing.ok || !missing.trip) {
    return;
  }
  assert.equal(missing.issues.some((issue) => issue.code === "museum_not_found"), true);
  assert.deepEqual(dayPlaceIds(missing.trip), dayPlaceIds(foodOnly));

  const crowded = planned({
    ...base,
    dayCount: 1,
    pace: "full",
    draft: {
      summary: "",
      days: [
        {
          dayIndex: 1,
          items: [
            { placeId: "plc_paris_louvre", role: "core" },
            { placeId: "plc_paris_notre_dame", role: "core" },
            { placeId: "plc_paris_sainte_chapelle", role: "core" },
          ],
        },
      ],
      unscheduledPlaceIds: [],
    },
  });
  const held = lockPlace(lockPlace(crowded, "plc_paris_louvre"), "plc_paris_sainte_chapelle");
  const noSwap = refineDeterministicItinerary({
    trip: held,
    instruction: "replace a museum",
    catalog,
  });
  assert.equal(noSwap.ok, false);
  if (noSwap.ok || !noSwap.trip) {
    return;
  }
  assert.equal(noSwap.issues.some((issue) => issue.code === "no_replacement"), true);
  assert.deepEqual(placeIds(noSwap.trip), placeIds(held));
});

test("unsupported instructions and untrusted trips do not change the plan", () => {
  const before = landmarks({ pace: "steady", dayCount: 2 });
  const original = JSON.stringify(before);
  const unsupported = refineDeterministicItinerary({
    trip: before,
    instruction: "book a table",
    catalog,
  });
  assert.equal(unsupported.ok, false);
  if (unsupported.ok || !unsupported.trip) {
    return;
  }
  assert.equal(unsupported.issues.some((issue) => issue.code === "unsupported_refinement"), true);
  assert.deepEqual(dayPlaceIds(unsupported.trip), dayPlaceIds(before));
  assert.equal(JSON.stringify(before), original);

  const unknown = structuredClone(before);
  const tampered = {
    ...unknown,
    days: unknown.days.map((day, index) =>
      index === 0
        ? {
            ...day,
            items: day.items.map((item, itemIndex) =>
              itemIndex === 0 ? { ...item, placeId: "plc_paris_not_real" } : item,
            ),
          }
        : day,
    ),
  };
  const tamperedJson = JSON.stringify(tampered);
  const rejected = refineDeterministicItinerary({
    trip: tampered,
    instruction: "less walking",
    catalog,
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    return;
  }
  assert.equal(rejected.trip, null);
  assert.equal(rejected.issues.some((issue) => issue.code === "unapproved_place"), true);
  assert.equal(JSON.stringify(tampered), tamperedJson);

  const sneaky = { ...before, catalog: { places: [{ id: "plc_paris_fake_cafe", vibeTags: ["dining"] }] } };
  const hiddenCatalog = refineDeterministicItinerary({
    trip: sneaky,
    instruction: "more cafés",
    catalog,
  });
  assert.equal(hiddenCatalog.ok, false);
  if (hiddenCatalog.ok) {
    return;
  }
  assert.equal(hiddenCatalog.trip, null);

  const drafted = refineDeterministicItinerary({
    trip: before,
    instruction: "replace a museum",
    catalog: withDraftPlace("plc_paris_notre_dame"),
  });
  assert.equal(drafted.ok, false);
  if (drafted.ok) {
    return;
  }
  assert.equal(drafted.trip, null);
  assert.equal(drafted.issues.some((issue) => issue.code === "unapproved_place"), true);
  assert.equal(JSON.stringify(before), original);

  const bangkok = {
    ...before,
    destinationId: "dst_bangkok",
    preferences: { ...before.preferences, destinationId: "dst_bangkok" },
  };
  const foreign = refineDeterministicItinerary({
    trip: bangkok,
    instruction: "more cafés",
    catalog,
  });
  assert.equal(foreign.ok, false);
  if (foreign.ok) {
    return;
  }
  assert.equal(foreign.trip, null);
  assert.equal(foreign.issues.some((issue) => issue.code === "unapproved_destination"), true);
});

test("a chosen museum is replaced and locked or must-see stops stay", () => {
  const source = landmarks({ pace: "steady", dayCount: 2 });
  const snapshot = JSON.stringify(source);
  const notre = findItem(source, "plc_paris_notre_dame");
  const sainte = findItem(source, "plc_paris_sainte_chapelle");
  const eiffel = findItem(source, "plc_paris_eiffel_tower");
  assert.ok(notre && sainte && eiffel);

  const replaced = replaceDeterministicMuseumStop({ trip: source, itemId: sainte.id, catalog });
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(replaced.ok, true);
  if (!replaced.ok || !replaced.trip) {
    return;
  }
  assert.equal(findItem(replaced.trip, "plc_paris_sainte_chapelle"), undefined);
  assert.equal(findItem(replaced.trip, "plc_paris_notre_dame")?.id, notre.id);
  assert.equal(findItem(replaced.trip, "plc_paris_louvre")?.id, sainte.id);
  assert.equal(findItem(replaced.trip, "plc_paris_louvre")?.lock, "unlocked");

  const locked = lockPlace(source, "plc_paris_notre_dame");
  const lockedItem = findItem(locked, "plc_paris_notre_dame");
  assert.ok(lockedItem);
  const lockedJson = JSON.stringify(locked);
  const keptLocked = replaceDeterministicMuseumStop({ trip: locked, itemId: lockedItem.id, catalog });
  assert.equal(keptLocked.ok, false);
  assert.equal(JSON.stringify(locked), lockedJson);
  if (keptLocked.ok || !keptLocked.trip) {
    return;
  }
  assert.equal(keptLocked.issues.some((issue) => issue.code === "locked_stop"), true);
  assert.equal(findItem(keptLocked.trip, "plc_paris_notre_dame")?.lock, "locked");
  assert.equal(hasPlace(keptLocked.trip, "plc_paris_louvre"), false);

  const required = withMustSee(source, "plc_paris_notre_dame");
  const requiredItem = findItem(required, "plc_paris_notre_dame");
  assert.ok(requiredItem);
  const requiredJson = JSON.stringify(required);
  const keptRequired = replaceDeterministicMuseumStop({ trip: required, itemId: requiredItem.id, catalog });
  assert.equal(JSON.stringify(required), requiredJson);
  assert.equal(keptRequired.ok, false);
  if (keptRequired.ok || !keptRequired.trip) {
    return;
  }
  assert.equal(keptRequired.issues.some((issue) => issue.code === "must_see_kept"), true);
  assert.equal(hasPlace(keptRequired.trip, "plc_paris_notre_dame"), true);
  assert.equal(hasPlace(keptRequired.trip, "plc_paris_louvre"), false);

  const missing = replaceDeterministicMuseumStop({ trip: source, itemId: "itm_not_on_this_plan", catalog });
  assert.equal(missing.ok, false);
  if (missing.ok || !missing.trip) {
    return;
  }
  assert.equal(missing.issues.some((issue) => issue.code === "unknown_item"), true);
  assert.deepEqual(dayPlaceIds(missing.trip), dayPlaceIds(source));

  const landmark = replaceDeterministicMuseumStop({ trip: source, itemId: eiffel.id, catalog });
  assert.equal(landmark.ok, false);
  if (landmark.ok || !landmark.trip) {
    return;
  }
  assert.equal(landmark.issues.some((issue) => issue.code === "unknown_item"), true);
  assert.equal(hasPlace(landmark.trip, "plc_paris_eiffel_tower"), true);
  assert.equal(hasPlace(landmark.trip, "plc_paris_louvre"), false);

  const malformed = replaceDeterministicMuseumStop({ trip: source, itemId: "Notre-Dame", catalog });
  assert.equal(malformed.ok, false);
  assert.equal(JSON.stringify(source), snapshot);
});

test("a historical price on the server snapshot is not copied into a refinement", () => {
  const fact: DynamicFact = {
    id: "dyn_hidden_historical_price",
    subject: { type: "place", id: "plc_paris_eiffel_tower" },
    kind: "price",
    freshness: "unverified",
    source: { providerKey: "historical_note", externalId: "sty_hidden_rate", retrievedBy: "manual" },
    lastCheckedAt: null,
    lastVerifiedAt: null,
    expiresAt: null,
    historicalNote: "Historical reference only.",
    amountMinor: 880000,
    currency: "THB",
  };
  const before = landmarks({ pace: "steady", dayCount: 2 });
  const fed = refineDeterministicItinerary({
    trip: before,
    instruction: "more cafés",
    catalog: { ...catalog, dynamicFacts: [fact] },
  });
  assert.equal(fed.ok, true);
  if (!fed.ok || !fed.trip) {
    return;
  }
  const rendered = JSON.stringify(fed.trip);
  assert.equal(rendered.includes("880000"), false);
  assert.equal(rendered.includes("THB"), false);
  assert.equal(rendered.includes("sty_hidden_rate"), false);
});

function landmarks(overrides: Record<string, unknown>): TripDocument {
  const result = generateDeterministicItinerary({
    preferences: { ...base, ...overrides },
    catalog,
    ids: createIdFactory("before"),
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.trip) {
    throw new Error("expected a starting plan");
  }
  return result.trip;
}

function planned(input: {
  draft: {
    summary: string;
    days: { dayIndex: number; items: { placeId: string; role: "core" | "optional" }[] }[];
    unscheduledPlaceIds: string[];
  };
  dayCount: number;
  pace: "unhurried" | "steady" | "full";
}): TripDocument {
  const parsed = parseTravelerPreferences({ ...base, dayCount: input.dayCount, pace: input.pace }, catalog);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("expected preferences");
  }
  const result = planFromDraft({
    preferences: parsed.preferences,
    draft: input.draft,
    previous: null,
    catalog,
    ids: createIdFactory("before"),
    draftRejected: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.trip) {
    throw new Error("expected a drafted plan");
  }
  return result.trip;
}

function refine(trip: TripDocument, instruction: string): TripDocument {
  const result = refineDeterministicItinerary({ trip, instruction, catalog });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  if (!result.ok || !result.trip) {
    throw new Error("expected a refinement");
  }
  return result.trip;
}

function withMustSee(trip: TripDocument, placeId: string): TripDocument {
  return {
    ...trip,
    undoAi: null,
    preferences: {
      ...trip.preferences,
      constraints: { ...trip.preferences.constraints, mustSeePlaceIds: [placeId] },
    },
  };
}

function lockPlace(trip: TripDocument, placeId: string): TripDocument {
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      items: day.items.map((item) => (item.placeId === placeId ? { ...item, lock: "locked" } : item)),
    })),
    unscheduled: trip.unscheduled.map((item) =>
      item.placeId === placeId ? { ...item, lock: "locked" } : item,
    ),
  };
}

function placeIds(trip: TripDocument): string[] {
  return trip.days.flatMap((day) => day.items.map((item) => item.placeId));
}

function dayPlaceIds(trip: TripDocument): string[][] {
  return trip.days.map((day) => day.items.map((item) => item.placeId));
}

function allPlaceIds(trip: TripDocument): string[] {
  return [...placeIds(trip), ...trip.unscheduled.map((item) => item.placeId)];
}

function hasPlace(trip: TripDocument, placeId: string): boolean {
  return allPlaceIds(trip).includes(placeId);
}

function findItem(trip: TripDocument, placeId: string): TripItem | undefined {
  return [...trip.days.flatMap((day) => day.items), ...trip.unscheduled].find((item) => item.placeId === placeId);
}

function noticeCodes(trip: TripDocument): string[] {
  return trip.notices.map((notice) => notice.code);
}

function assertNoClaims(trip: TripDocument) {
  assert.equal(acceptableCopy(trip.summary), true);
  for (const notice of trip.notices) {
    assert.equal(acceptableCopy(notice.message), true);
  }
  const rendered = JSON.stringify(trip);
  assert.equal(rendered.includes("€"), false);
  assert.equal(rendered.includes("amountMinor"), false);
  assert.equal(/\b\d+\s*(?:min|minutes|hours)\b/i.test(rendered), false);
}

function withDraftPlace(placeId: string): CatalogSnapshot {
  return {
    ...catalog,
    places: catalog.places.map((place) =>
      place.id === placeId ? { ...place, status: "draft" } : place,
    ),
  };
}
