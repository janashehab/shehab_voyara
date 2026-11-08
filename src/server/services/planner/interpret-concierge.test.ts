import assert from "node:assert/strict";
import test from "node:test";

import { developmentPreviewExamples } from "@/features/trips/concierge-display";
import type { TripDocument } from "@/features/trips/schemas";
import { getPrototypeCatalog } from "@/lib/catalog";
import type { InterpreterModel } from "@/server/ai/types";

import {
  CONCIERGE_MAX_ATTEMPTS,
  planConcierge,
  refineConcierge,
  resetConciergeAttempts,
  screenConciergeRequest,
} from "./concierge";
import {
  confirmDevelopmentPlan,
  confirmDevelopmentRefinement,
  previewDevelopmentPlan,
  previewDevelopmentRefinement,
} from "./interpret-concierge";

const catalog = getPrototypeCatalog();

test("listed development phrases stay on the fake interpreter and the summary names what changes", async () => {
  for (const phrase of developmentPreviewExamples) {
    const preview = await previewDevelopmentPlan({ request: { text: phrase }, catalog });
    assert.equal(preview.stage === "rejected", false, phrase);
  }

  const ready = await previewDevelopmentPlan({
    request: { text: "two food days at a steady pace" },
    catalog,
  });
  assert.equal(ready.ok, true);
  if (!ready.ok) {
    return;
  }
  assert.equal(ready.summary.headline, "2 days in Paris, food, steady pace.");
  assert.equal(ready.summary.unaffected.includes("do not change which places are chosen"), true);
  assert.equal(ready.summary.headline.includes("solo"), false);
  assert.equal(JSON.stringify(ready).includes("plc_"), false);

  const created = await confirmDevelopmentPlan({
    request: { text: "two food days at a steady pace" },
    catalog,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const names = created.view.days.flatMap((day) => day.stops.map((stop) => stop.name));
  assert.equal(names.includes("Bouillon Pigalle"), true);
  assert.equal(names.includes("Eiffel Tower"), false);
  assert.equal(JSON.stringify(created).includes("amountMinor"), false);

  const louvrePreview = await previewDevelopmentPlan({
    request: { text: "one museum day at a full pace, must see the louvre" },
    catalog,
  });
  assert.equal(louvrePreview.ok, true);
  if (!louvrePreview.ok) {
    return;
  }
  assert.equal(louvrePreview.summary.headline.includes("Louvre"), true);
  assert.equal(JSON.stringify(louvrePreview).includes("plc_"), false);
  const louvre = await confirmDevelopmentPlan({
    request: { text: "one museum day at a full pace, must see the louvre" },
    catalog,
  });
  assert.equal(louvre.ok, true);
  if (!louvre.ok) {
    return;
  }
  assert.equal(louvre.trip.preferences.constraints.mustSeePlaceIds.includes("plc_paris_louvre"), true);
});

test("a missing pace is kept as a clarification and is not invented", async () => {
  const preview = await previewDevelopmentPlan({ request: { text: "two food days" }, catalog });
  assert.equal(preview.ok, false);
  if (preview.ok || preview.stage !== "clarify") {
    return;
  }
  assert.equal(preview.code, "missing_fields");
  assert.deepEqual(preview.missing, ["pace"]);
  assert.equal(preview.extracted?.dayCount, 2);
  assert.deepEqual(preview.extracted?.interests, ["food"]);
  assert.equal(preview.extracted?.pace, null);
  assert.equal(preview.extracted?.companions, null);

  const early = await confirmDevelopmentPlan({ request: { text: "two food days" }, catalog });
  assert.equal(early.ok, false);
  if (early.ok) {
    return;
  }
  assert.equal(early.trip, null);

  const answered = await previewDevelopmentPlan({
    request: { extracted: preview.extracted, answer: { pace: "steady" } },
    catalog,
  });
  assert.equal(answered.ok, true);
  if (!answered.ok) {
    return;
  }
  assert.equal(answered.summary.headline, "2 days in Paris, food, steady pace.");

  const created = await confirmDevelopmentPlan({
    request: { extracted: preview.extracted, answer: { pace: "steady" } },
    catalog,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  assert.equal(created.view.days.some((day) => day.stops.some((stop) => stop.name === "Bouillon Pigalle")), true);
  assert.equal(created.trip.preferences.pace, "steady");
  assert.deepEqual(created.trip.preferences.interests, ["food"]);
});

test("unsupported text, another city, a contradiction, and several intents leave the trip unchanged", async () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);

  const boat = await previewDevelopmentRefinement({ request: { text: "book a boat", trip }, catalog });
  assert.equal(boat.ok, false);
  if (boat.ok || boat.stage !== "rejected") {
    return;
  }
  assert.equal(boat.error.message, "That request is not one of the development preview phrases. Nothing was changed.");
  const boatConfirm = await confirmDevelopmentRefinement({ request: { text: "book a boat", trip }, catalog });
  assert.equal(boatConfirm.ok, false);
  if (boatConfirm.ok || !boatConfirm.trip) {
    return;
  }
  assert.equal(boatConfirm.trip.preferences.pace, "steady");
  assert.equal(JSON.stringify(trip), before);

  const secret = await previewDevelopmentPlan({
    request: { text: "postgres://voyara:secret-password@localhost/db" },
    catalog,
  });
  assert.equal(JSON.stringify(secret).includes("postgres://"), false);
  assert.equal(JSON.stringify(secret).includes("secret-password"), false);

  const city = await previewDevelopmentPlan({
    request: { text: "two food days in bangkok at a steady pace" },
    catalog,
  });
  assert.equal(city.ok, false);
  if (city.ok || city.stage !== "rejected") {
    return;
  }
  assert.equal(city.error.code, "unapproved_destination");
  assert.equal(JSON.stringify(city).includes("dst_bangkok"), false);
  const cityTrip = await confirmDevelopmentPlan({
    request: { text: "two food days in bangkok at a steady pace" },
    catalog,
  });
  assert.equal(cityTrip.ok, false);

  const contradiction = await previewDevelopmentPlan({
    request: { text: "two steady days of food but avoid food" },
    catalog,
  });
  assert.equal(contradiction.ok, false);
  if (contradiction.ok || contradiction.stage !== "clarify") {
    return;
  }
  assert.equal(contradiction.code, "preference_contradiction");
  assert.deepEqual(contradiction.extracted?.interests, ["food"]);
  assert.deepEqual(contradiction.extracted?.exclusions, ["food"]);
  const contradicted = await confirmDevelopmentPlan({
    request: { text: "two steady days of food but avoid food" },
    catalog,
  });
  assert.equal(contradicted.ok, false);
  if (contradicted.ok) {
    return;
  }
  assert.equal(contradicted.trip, null);

  const many = await confirmDevelopmentRefinement({
    request: { text: "less walking and more cafes", trip },
    catalog,
  });
  assert.equal(many.ok, false);
  if (many.ok || !many.trip) {
    return;
  }
  assert.equal(many.error.code, "multi_intent");
  assert.equal(many.trip.preferences.pace, "steady");
  assert.equal(JSON.stringify(trip), before);
});

test("a refinement and a named museum use the deterministic planners without a client place id", async () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);
  const relaxed = await previewDevelopmentRefinement({ request: { text: "less walking", trip }, catalog });
  assert.equal(relaxed.ok, true);
  if (!relaxed.ok) {
    return;
  }
  assert.equal(relaxed.summary.headline, "Less walking.");
  assert.equal(relaxed.summary.details[0], "The pace used to fit stops changes.");
  const applied = await confirmDevelopmentRefinement({ request: { text: "less walking", trip }, catalog });
  assert.equal(applied.ok, true);
  if (!applied.ok) {
    return;
  }
  assert.equal(applied.trip.preferences.pace, "unhurried");
  assert.equal(JSON.stringify(trip), before);

  const choices = await confirmDevelopmentRefinement({ request: { text: "replace a museum", trip }, catalog });
  assert.equal(choices.ok, false);
  if (choices.ok || !choices.view) {
    return;
  }
  assert.equal(choices.error.code, "ambiguous_museum");
  assert.equal(choices.view.museumChoices.length > 1, true);
  assert.equal(JSON.stringify(trip), before);

  const named = await confirmDevelopmentRefinement({ request: { text: "replace notre-dame", trip }, catalog });
  assert.equal(named.ok, true);
  if (!named.ok) {
    return;
  }
  const names = named.view.days.flatMap((day) => day.stops.map((stop) => stop.name));
  assert.equal(names.includes("Notre-Dame"), false);
  assert.equal(names.includes("Louvre"), true);
  assert.equal(JSON.stringify(trip), before);

  const supplied = await confirmDevelopmentRefinement({
    request: { text: "replace notre-dame", trip, placeId: "plc_paris_louvre" },
    catalog,
  });
  assert.equal(supplied.ok, false);
  if (supplied.ok) {
    return;
  }
  assert.equal(supplied.trip, null);
  assert.equal(JSON.stringify(supplied).includes("plc_paris_louvre"), false);
  assert.equal(JSON.stringify(trip), before);
});

test("tampered trips, catalogs, connection strings, and invalid model text do not change a plan", async () => {
  const trip = landmarks();
  const before = JSON.stringify(trip);
  const tampered = structuredClone(trip);
  const first = tampered.days[0]?.items[0];
  if (!first) {
    throw new Error("expected a stop");
  }
  first.placeId = "plc_paris_not_real";
  const rejected = await confirmDevelopmentRefinement({
    request: { text: "less walking", trip: tampered },
    catalog,
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    return;
  }
  assert.equal(rejected.trip, null);
  assert.equal(JSON.stringify(rejected).includes("plc_paris_not_real"), false);
  assert.equal(JSON.stringify(trip), before);

  const suppliedCatalog = await previewDevelopmentPlan({
    request: { text: "two food days at a steady pace", catalog: { places: [] } },
    catalog,
  });
  assert.equal(suppliedCatalog.ok, false);
  if (suppliedCatalog.ok || suppliedCatalog.stage !== "rejected") {
    return;
  }
  assert.equal(suppliedCatalog.error.code, "untrusted_catalog");

  const databaseUrl = "postgresql://voyara:secret-password@localhost/voyara";
  const leaked = await previewDevelopmentPlan({
    request: { text: "two food days", databaseUrl },
    catalog,
  });
  assert.equal(leaked.ok, false);
  assert.equal(JSON.stringify(leaked).includes(databaseUrl), false);
  assert.equal(JSON.stringify(leaked).includes("secret-password"), false);

  const invalid: InterpreterModel = { async complete() { return { text: "{not json" }; } };
  const broken = await confirmDevelopmentRefinement({
    request: { text: "less walking", trip },
    catalog,
    model: invalid,
  });
  assert.equal(broken.ok, false);
  if (broken.ok || !broken.trip) {
    return;
  }
  assert.equal(broken.trip.preferences.pace, "steady");
  assert.equal(JSON.stringify(trip), before);

  const failing: InterpreterModel = {
    async complete() {
      throw new Error("postgres://voyara:secret-password@localhost/voyara");
    },
  };
  const thrown = await previewDevelopmentPlan({
    request: { text: "two food days at a steady pace" },
    catalog,
    model: failing,
  });
  assert.equal(thrown.ok, false);
  assert.equal(JSON.stringify(thrown).includes("postgres://"), false);
  assert.equal(JSON.stringify(thrown).includes("secret-password"), false);
});

test("questionnaire buttons stay on their deterministic actions and screening still applies", async () => {
  const planned = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "buttons-plan",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const refined = refineConcierge({
    request: { trip: planned.trip, instruction: "less walking" },
    catalog,
    now: 2,
    callerKey: "buttons-refine",
  });
  assert.equal(refined.ok, true);
  if (!refined.ok) {
    return;
  }
  assert.equal(refined.trip.preferences.pace, "unhurried");

  const typed = refineConcierge({
    request: { trip: planned.trip, instruction: "book a boat" },
    catalog,
    now: 3,
    callerKey: "buttons-typed",
  });
  assert.equal(typed.ok, false);
  if (typed.ok) {
    return;
  }
  assert.equal(typed.error.code, "unsupported_refinement");

  const followUp = await previewDevelopmentPlan({ request: { text: "less walking" }, catalog });
  assert.equal(followUp.ok, false);
  if (followUp.ok || followUp.stage !== "clarify") {
    return;
  }
  assert.equal(followUp.code, "missing_plan");

  resetConciergeAttempts();
  for (let attempt = 0; attempt < CONCIERGE_MAX_ATTEMPTS; attempt += 1) {
    const allowed = screenConciergeRequest({ text: "two food days" }, 10, "interpreter-limit");
    assert.equal(allowed.ok, true);
  }
  const limited = screenConciergeRequest({ text: "two food days" }, 10, "interpreter-limit");
  assert.equal(limited.ok, false);
  if (limited.ok) {
    return;
  }
  assert.equal(limited.error.code, "rate_limited");
});

function landmarks(): TripDocument {
  const result = planConcierge({
    request: { destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" },
    catalog,
    now: 1,
    callerKey: "interpreter-landmarks",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected a plan");
  }
  return result.trip;
}
