import assert from "node:assert/strict";
import test from "node:test";

import { getPrototypeCatalog } from "@/lib/catalog";
import type { TripDocument } from "@/features/trips/schemas";
import { fakeInterpreter } from "@/server/ai/fake-interpreter";
import type { InterpreterModel } from "@/server/ai/types";

import { generateDeterministicItinerary } from "./deterministic";
import {
  buildInterpreterRequest,
  interpretModelText,
  interpretWithModel,
  refinementPhrases,
} from "./interpret";
import { refineDeterministicItinerary, replaceDeterministicMuseumStop } from "./refine-deterministic";

const catalog = getPrototypeCatalog();

const foodPlan = JSON.stringify({
  kind: "plan",
  destinationId: "dst_paris",
  dayCount: 2,
  interests: ["food"],
  pace: "steady",
});

test("a fake interpreter returns scripted text and the prompt carries no place ids", async () => {
  const request = buildInterpreterRequest("two food days", ["Notre-Dame"]);
  const model = fakeInterpreter([foodPlan, "{\"kind\":\"unsupported\",\"message\":\"Booking a boat is not available.\"}"]);
  const first = await model.complete(request);
  const second = await model.complete(request);
  assert.equal(first.text, foodPlan);
  assert.equal(second.text.includes("boat"), true);
  const rendered = JSON.stringify(request);
  assert.equal(rendered.includes("plc_"), false);
  assert.equal(rendered.includes("amountMinor"), false);
  assert.equal(rendered.includes("two food days"), true);
  assert.equal(request.schemaName, "voyara.interpreter.turn");
});

test("a valid plan becomes traveler preferences and does not build a trip", () => {
  const result = interpretModelText({ text: foodPlan, catalog, trip: null });
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "plan") {
    return;
  }
  assert.equal(result.preferences.destinationId, "dst_paris");
  assert.equal(result.preferences.dayCount, 2);
  assert.deepEqual(result.preferences.interests, ["food"]);
  assert.equal(result.preferences.pace, "steady");
  assert.equal(result.preferences.companions, "solo");
  assert.equal(result.preferences.budget, "open");
  assert.deepEqual(result.preferences.constraints.mustSeePlaceIds, []);
  assert.equal(result.serverDefaults.includes("companions"), true);
  assert.equal("days" in result, false);
  assert.equal(JSON.stringify(result).includes("amountMinor"), false);
});

test("a must-see name resolves to one approved place", () => {
  const result = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["landmarks"],
      pace: "unhurried",
      companions: "family",
      mustSeeNames: ["Notre Dame"],
    }),
    catalog,
    trip: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "plan") {
    return;
  }
  assert.deepEqual(result.preferences.constraints.mustSeePlaceIds, ["plc_paris_notre_dame"]);
  assert.equal(result.preferences.companions, "family");
  assert.equal(result.serverDefaults.includes("companions"), false);
});

test("missing fields are clarified without inventing a pace or a trip", () => {
  const result = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["food"],
    }),
    catalog,
    trip: null,
  });
  assert.equal(result.ok, false);
  if (result.ok || result.kind !== "clarify") {
    return;
  }
  assert.equal(result.code, "missing_fields");
  assert.deepEqual(result.missing, ["pace"]);
  assert.equal(result.extracted?.dayCount, 2);
  assert.deepEqual(result.extracted?.interests, ["food"]);
  assert.equal(result.extracted?.pace, null);
  assert.equal(result.extracted?.companions, null);
  assert.equal("preferences" in result, false);
});

test("another city, a contradiction, and an unsupported request do not change a trip", () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);

  const city = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_bangkok",
      dayCount: 2,
      interests: ["food"],
      pace: "steady",
    }),
    catalog,
    trip,
  });
  assert.equal(city.ok, false);
  if (city.ok || city.kind !== "unsupported") {
    return;
  }
  assert.equal(city.code, "unapproved_destination");
  assert.equal(city.message, "Paris is the only approved destination for planning today.");
  assert.equal(JSON.stringify(city).includes("dst_bangkok"), false);

  const contradiction = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["food"],
      exclusions: ["food"],
      pace: "steady",
    }),
    catalog,
    trip,
  });
  assert.equal(contradiction.ok, false);
  if (contradiction.ok || contradiction.kind !== "clarify") {
    return;
  }
  assert.equal(contradiction.code, "preference_contradiction");
  assert.deepEqual(contradiction.extracted?.interests, ["food"]);
  assert.deepEqual(contradiction.extracted?.exclusions, ["food"]);

  const boat = interpretModelText({
    text: JSON.stringify({ kind: "unsupported", message: "Booking a boat is not available." }),
    catalog,
    trip,
  });
  assert.equal(boat.ok, false);
  if (boat.ok || boat.kind !== "unsupported") {
    return;
  }
  assert.equal(boat.message, "Booking a boat is not available.");
  assert.equal(JSON.stringify(trip), before);
});

test("multi-intent requests are clarified and neither intent is applied", () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);
  const result = interpretModelText({
    text: JSON.stringify({
      kind: "refine",
      intents: [{ intent: "less_walking" }, { intent: "more_food" }],
    }),
    catalog,
    trip,
  });
  assert.equal(result.ok, false);
  if (result.ok || result.kind !== "clarify") {
    return;
  }
  assert.equal(result.code, "multi_intent");
  assert.deepEqual(result.intents, ["less_walking", "more_food"]);
  assert.equal(JSON.stringify(trip), before);
});

test("invalid JSON, extra keys, prices, hours, and place ids are rejected", () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);
  const cases = [
    "not json",
    JSON.stringify({ kind: "plan", destinationId: "dst_paris", dayCount: 2, interests: ["food"], pace: "rushed" }),
    JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["food"],
      pace: "steady",
      placeId: "plc_paris_louvre",
    }),
    JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["food"],
      pace: "steady",
      days: [{ dayIndex: 1, items: [] }],
    }),
    JSON.stringify({ kind: "unsupported", message: "Tickets are €20." }),
    JSON.stringify({ kind: "unsupported", message: "The Louvre opens at 09:00." }),
    JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["landmarks"],
      pace: "steady",
      mustSeeNames: ["plc_paris_louvre"],
    }),
  ];

  for (const text of cases) {
    const result = interpretModelText({ text, catalog, trip });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, "invalid");
    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes("plc_paris_louvre"), false);
    assert.equal(rendered.includes("€"), false);
    assert.equal(rendered.includes("09:00"), false);
    assert.equal(rendered.includes("rushed"), false);
  }
  assert.equal(JSON.stringify(trip), before);
});

test("unknown, ambiguous, and draft names are not turned into place ids", () => {
  const unknown = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["landmarks"],
      pace: "steady",
      mustSeeNames: ["Museum of Made Up Things"],
    }),
    catalog,
    trip: null,
  });
  assert.equal(unknown.ok, false);
  if (unknown.ok || unknown.kind !== "clarify") {
    return;
  }
  assert.equal(unknown.code, "unknown_name");
  assert.deepEqual(unknown.extracted?.mustSeeNames, ["Museum of Made Up Things"]);
  assert.equal(unknown.extracted?.pace, "steady");

  const ambiguousCatalog = {
    ...catalog,
    places: catalog.places.map((place) =>
      place.id === "plc_paris_louvre" || place.id === "plc_paris_sainte_chapelle"
        ? { ...place, name: "Chapel" }
        : place,
    ),
  };
  const ambiguous = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["landmarks"],
      pace: "steady",
      mustSeeNames: ["Chapel"],
    }),
    catalog: ambiguousCatalog,
    trip: null,
  });
  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok || ambiguous.kind !== "clarify") {
    return;
  }
  assert.equal(ambiguous.code, "ambiguous_name");
  assert.equal(JSON.stringify(ambiguous).includes("plc_"), false);

  const drafted = {
    ...catalog,
    places: catalog.places.map((place) =>
      place.id === "plc_paris_louvre" ? { ...place, status: "draft" as const } : place,
    ),
  };
  const hidden = interpretModelText({
    text: JSON.stringify({
      kind: "plan",
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["museums"],
      pace: "steady",
      mustSeeNames: ["Louvre"],
    }),
    catalog: drafted,
    trip: null,
  });
  assert.equal(hidden.ok, false);
  if (hidden.ok || hidden.kind !== "clarify") {
    return;
  }
  assert.equal(hidden.code, "unknown_name");
  assert.equal(JSON.stringify(hidden).includes("plc_paris_louvre"), false);
});

test("one refinement maps to an existing phrase, and a museum name selects one stop", () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);
  const relaxed = interpretModelText({
    text: JSON.stringify({ kind: "refine", intents: [{ intent: "less_walking", museumName: null }] }),
    catalog,
    trip,
  });
  assert.equal(relaxed.ok, true);
  if (!relaxed.ok || relaxed.kind !== "refine") {
    return;
  }
  assert.equal(relaxed.intent, "less_walking");
  assert.equal(relaxed.phrase, refinementPhrases.less_walking);
  assert.equal(relaxed.museumItemId, null);
  assert.equal(JSON.stringify(trip), before);

  const applied = refineDeterministicItinerary({ trip, instruction: relaxed.phrase, catalog });
  assert.equal(applied.ok, true);
  if (!applied.ok || !applied.trip) {
    return;
  }
  assert.equal(applied.trip.preferences.pace, "unhurried");
  assert.equal(JSON.stringify(trip), before);

  const notre = findItem(trip, "plc_paris_notre_dame");
  assert.ok(notre);
  const named = interpretModelText({
    text: JSON.stringify({
      kind: "refine",
      intents: [{ intent: "replace_museum", museumName: "Notre-Dame" }],
    }),
    catalog,
    trip,
  });
  assert.equal(named.ok, true);
  if (!named.ok || named.kind !== "refine") {
    return;
  }
  assert.equal(named.museumItemId, notre.id);
  const replaced = replaceDeterministicMuseumStop({ trip, itemId: named.museumItemId, catalog });
  assert.equal(replaced.ok, true);
  assert.equal(JSON.stringify(trip), before);

  const locked = lockPlace(trip, "plc_paris_notre_dame");
  const lockedBefore = JSON.stringify(locked);
  const refused = interpretModelText({
    text: JSON.stringify({
      kind: "refine",
      intents: [{ intent: "replace_museum", museumName: "Notre-Dame" }],
    }),
    catalog,
    trip: locked,
  });
  assert.equal(refused.ok, false);
  if (refused.ok || refused.kind !== "clarify") {
    return;
  }
  assert.equal(refused.code, "museum_not_eligible");
  assert.equal(JSON.stringify(locked), lockedBefore);
});

test("the fake model is read through the interpreter and a thrown model stays safe", async () => {
  const planned = await interpretWithModel({
    model: fakeInterpreter([foodPlan]),
    travelerText: "two food days",
    catalog,
    trip: null,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok || planned.kind !== "plan") {
    return;
  }
  assert.equal(planned.preferences.pace, "steady");

  const failing: InterpreterModel = {
    async complete() {
      throw new Error("postgres://voyara_user:super-secret-password@db.internal/postgres");
    },
  };
  const failed = await interpretWithModel({
    model: failing,
    travelerText: "two food days",
    catalog,
    trip: null,
  });
  assert.equal(failed.ok, false);
  if (failed.ok) {
    return;
  }
  assert.equal(failed.kind, "invalid");
  assert.equal(JSON.stringify(failed).includes("postgres://"), false);
  assert.equal(JSON.stringify(failed).includes("super-secret-password"), false);
});

function landmarks(): TripDocument {
  const result = generateDeterministicItinerary({
    preferences: {
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
    },
    catalog,
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.trip) {
    throw new Error("expected a plan");
  }
  return result.trip;
}

function findItem(trip: TripDocument, placeId: string) {
  return [...trip.days.flatMap((day) => day.items), ...trip.unscheduled].find((item) => item.placeId === placeId);
}

function lockPlace(trip: TripDocument, placeId: string): TripDocument {
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      items: day.items.map((item) => (item.placeId === placeId ? { ...item, lock: "locked" } : item)),
    })),
  };
}
