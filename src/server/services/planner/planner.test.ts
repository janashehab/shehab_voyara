import assert from "node:assert/strict";
import test from "node:test";
import { developmentRateLimitPolicyText } from "@/server/ai/types";
import type { PlannerModel } from "@/server/ai/types";
import type { CatalogSnapshot, Place, PlaceId } from "@/lib/catalog";
import { approvedCatalog, getPrototypeCatalog } from "@/lib/catalog";
import type { PlannerDraft, TripDocument, TripItem } from "@/features/trips/schemas";
import {
  addStop,
  buildPlannerPrompt,
  createIdFactory,
  generateItinerary,
  lockStop,
  moveStop,
  parseTravelerPreferences,
  parseTripDocument,
  planFromDraft,
  refineItinerary,
  removeStop,
  reorderStop,
  undoLastAiChange,
  unlockStop,
} from "./index";

const catalog = getPrototypeCatalog();

const baseInput = {
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
  constraints: { mustSeePlaceIds: ["plc_paris_eiffel_tower"], mobility: null },
  notes: null,
};

test("invalid dates, durations, and preference combinations are rejected", () => {
  assert.ok(issueCodes({ ...baseInput, startDate: "2026-02-31", endDate: "2026-03-02" }).includes("invalid_date"));
  assert.ok(issueCodes({ ...baseInput, startDate: "2026-04-10", endDate: "2026-04-09" }).includes("invalid_date"));
  assert.ok(issueCodes({ ...baseInput, startDate: "2026-01-01", endDate: null }).includes("invalid_date"));
  assert.ok(
    issueCodes({ ...baseInput, startDate: "2026-01-01", endDate: "2026-01-15", dayCount: null }).includes(
      "invalid_duration",
    ),
  );
  assert.ok(
    issueCodes({ ...baseInput, startDate: "2026-03-30", endDate: "2026-04-01", dayCount: 2 }).includes(
      "duration_mismatch",
    ),
  );
  assert.ok(issueCodes({ ...baseInput, dayCount: null }).includes("duration_required"));
  assert.ok(issueCodes({ ...baseInput, dayCount: 0 }).includes("too_small"));
  assert.ok(issueCodes({ ...baseInput, notes: "a".repeat(501) }).includes("too_big"));
  assert.ok(
    issueCodes({
      ...baseInput,
      interests: [],
      constraints: { mustSeePlaceIds: [], mobility: null },
    }).includes("preference_empty"),
  );
  assert.ok(
    issueCodes({
      ...baseInput,
      interests: ["food", "food"],
    }).includes("duplicate_value"),
  );
  assert.ok(
    issueCodes({
      ...baseInput,
      interests: ["theme_parks"],
      exclusions: { avoid: ["theme_parks"], placeIds: [] },
    }).includes("preference_contradiction"),
  );
  assert.ok(
    issueCodes({
      ...baseInput,
      priorities: { vibe: null, placeStyle: "iconic" },
      exclusions: { avoid: ["landmarks"], placeIds: [] },
    }).includes("preference_contradiction"),
  );
  assert.ok(
    issueCodes({
      ...baseInput,
      priorities: { vibe: "playful", placeStyle: null },
      exclusions: { avoid: ["theme_parks"], placeIds: [] },
    }).includes("preference_contradiction"),
  );
  assert.ok(
    issueCodes({
      ...baseInput,
      constraints: { mustSeePlaceIds: ["plc_paris_eiffel_tower"], mobility: null },
      exclusions: { avoid: [], placeIds: ["plc_paris_eiffel_tower"] },
    }).includes("preference_contradiction"),
  );
  assert.ok(issueCodes({ ...baseInput, constraints: { mustSeePlaceIds: ["plc_missing"], mobility: null } }).includes("unapproved_place"));
  assert.ok(issueCodes({ ...baseInput, destinationId: "dst_lyon" }).includes("unapproved_destination"));

  const dated = parseTravelerPreferences(
    { ...baseInput, startDate: "2026-03-30", endDate: "2026-04-01", dayCount: null, interests: ["food"] },
    catalog,
  );
  assert.equal(dated.ok, true);
  if (dated.ok) {
    assert.equal(dated.preferences.dayCount, 3);
  }

  const disclosed = parseTravelerPreferences(
    {
      destinationId: "dst_paris",
      companions: "couple",
      pace: "full",
      budget: "modest",
      interests: ["food"],
      dayCount: 2,
    },
    catalog,
  );
  assert.equal(disclosed.ok, true);
  if (disclosed.ok) {
    assert.equal(disclosed.preferences.priorities.vibe, null);
    assert.equal(disclosed.preferences.priorities.placeStyle, null);
    assert.deepEqual(disclosed.preferences.exclusions.avoid, []);
    assert.equal(disclosed.preferences.constraints.mobility, null);
    assert.equal(disclosed.preferences.notes, null);
  }
});

test("a lesser-known priority can sit beside a landmark interest and still keeps the must-see", () => {
  const planned = apply(
    {
      ...baseInput,
      dayCount: 1,
      interests: ["landmarks"],
      priorities: { vibe: null, placeStyle: "lesser_known" },
    },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.equal(hasPlace(planned.trip, "plc_paris_eiffel_tower"), true);
  assert.equal(noticeCodes(planned.trip).includes("preference_conflict"), true);
});

test("excluded suggestions are left out, while an excluded must-see stays with a conflict", () => {
  const planned = apply(
    {
      ...baseInput,
      dayCount: 1,
      interests: ["walks"],
      exclusions: { avoid: ["landmarks"], placeIds: [] },
      constraints: { mustSeePlaceIds: ["plc_paris_eiffel_tower"], mobility: null },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_eiffel_tower", role: "core" },
          { placeId: "plc_paris_arc_de_triomphe", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.equal(hasPlace(planned.trip, "plc_paris_eiffel_tower"), true);
  assert.equal(hasPlace(planned.trip, "plc_paris_arc_de_triomphe"), false);
  assert.equal(noticeCodes(planned.trip).includes("exclusion_conflict"), true);
  assert.equal(noticeCodes(planned.trip).includes("excluded_omitted"), true);
});

test("avoiding every food place leaves a coverage notice and does not invent a restaurant", () => {
  const planned = apply(
    {
      ...baseInput,
      interests: ["food"],
      exclusions: {
        avoid: [],
        placeIds: ["plc_paris_pink_mamma", "plc_paris_bouillon_pigalle"],
      },
    },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.equal(noticeCodes(planned.trip).includes("thin_coverage"), true);
  assert.equal(hasPlace(planned.trip, "plc_paris_pink_mamma"), false);
  assertNoInventedFacts(planned.trip);
});

test("Disneyland takes a day of its own and does not invent hours or travel time", () => {
  const planned = apply(
    {
      ...baseInput,
      dayCount: 2,
      constraints: {
        mustSeePlaceIds: ["plc_paris_eiffel_tower", "plc_paris_disneyland"],
        mobility: null,
      },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_eiffel_tower", role: "core" },
          { placeId: "plc_paris_louvre", role: "core" },
          { placeId: "plc_paris_disneyland", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }

  const parkDay = planned.trip.days.find((day) =>
    day.items.some((item) => item.placeId === "plc_paris_disneyland"),
  );
  assert.ok(parkDay);
  assert.deepEqual(
    parkDay.items.map((item) => item.placeId),
    ["plc_paris_disneyland"],
  );
  assert.equal(hasPlace(planned.trip, "plc_paris_eiffel_tower"), true);
  assert.equal(hasPlace(planned.trip, "plc_paris_louvre"), true);
  assert.equal(noticeCodes(planned.trip).includes("major_day_commitment"), true);
  assert.equal(noticeCodes(planned.trip).includes("missing_duration"), true);
  assert.equal(noticeCodes(planned.trip).includes("no_opening_hours"), true);
  assert.equal(noticeCodes(planned.trip).includes("no_travel_times"), true);
  assertNoInventedFacts(planned.trip);
});

test("a one-day trip keeps Disneyland and moves the other must-see to unscheduled", () => {
  const planned = apply(
    {
      ...baseInput,
      dayCount: 1,
      constraints: {
        mustSeePlaceIds: ["plc_paris_disneyland", "plc_paris_eiffel_tower"],
        mobility: null,
      },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_disneyland", role: "core" },
          { placeId: "plc_paris_eiffel_tower", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.deepEqual(idsOnDay(planned.trip, 1), ["plc_paris_disneyland"]);
  assert.deepEqual(
    planned.trip.unscheduled.map((item) => item.placeId),
    ["plc_paris_eiffel_tower"],
  );
  const notice = planned.trip.notices.find((entry) => entry.code === "must_see_unscheduled");
  assert.ok(notice);
  assert.match(notice.message, /was not removed/);
  assertNoInventedFacts(planned.trip);
});

test("a locked city stop keeps the only day, and Disneyland stays unscheduled", () => {
  const seeded = apply(
    {
      ...baseInput,
      dayCount: 1,
      interests: ["landmarks"],
      constraints: { mustSeePlaceIds: ["plc_paris_louvre"], mobility: null },
    },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_louvre", role: "core" }] }]),
  );
  assert.equal(seeded.ok, true);
  if (!seeded.ok || !seeded.trip) {
    return;
  }
  const louvre = seeded.trip.days[0]?.items[0];
  assert.ok(louvre);
  const locked = lockStop(seeded.trip, catalog, louvre.id);
  assert.equal(locked.ok, true);
  if (!locked.ok) {
    return;
  }

  const crowded = planFromDraft({
    preferences: prefer({
      ...baseInput,
      dayCount: 1,
      constraints: { mustSeePlaceIds: ["plc_paris_disneyland"], mobility: null },
    }),
    draft: draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_disneyland", role: "core" }] }]),
    previous: locked.trip,
    catalog,
    ids: createIdFactory("park"),
    draftRejected: false,
  });
  assert.equal(crowded.ok, true);
  if (!crowded.ok || !crowded.trip) {
    return;
  }
  assert.equal(idsOnDay(crowded.trip, 1).includes("plc_paris_louvre"), true);
  assert.equal(crowded.trip.days[0]?.items[0]?.lock, "locked");
  assert.equal(hasPlace(crowded.trip, "plc_paris_disneyland"), true);
  assert.equal(
    crowded.trip.unscheduled.some((item) => item.placeId === "plc_paris_disneyland"),
    true,
  );
  assert.equal(noticeCodes(crowded.trip).includes("must_see_unscheduled"), true);
});

test("park rides with unknown duration and coordinates stay on the Disneyland day", () => {
  const planned = apply(
    {
      ...baseInput,
      interests: ["theme_parks"],
      constraints: { mustSeePlaceIds: ["plc_paris_disneyland"], mobility: null },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_disneyland", role: "core" },
          { placeId: "plc_paris_big_thunder_mountain", role: "core" },
        ],
      },
      { dayIndex: 2, items: [{ placeId: "plc_paris_louvre", role: "core" }] },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  const parkDay = planned.trip.days.find((day) =>
    day.items.some((item) => item.placeId === "plc_paris_disneyland"),
  );
  assert.deepEqual(parkDay?.items.map((item) => item.placeId), [
    "plc_paris_disneyland",
    "plc_paris_big_thunder_mountain",
  ]);
  assert.equal(
    planned.trip.notices.some(
      (notice) =>
        notice.code === "missing_coordinates" && notice.placeId === "plc_paris_big_thunder_mountain",
    ),
    true,
  );
  assert.equal(
    planned.trip.notices.some(
      (notice) => notice.code === "missing_duration" && notice.placeId === "plc_paris_disneyland",
    ),
    true,
  );
  assert.equal(
    planned.trip.notices.some(
      (notice) =>
        notice.code === "long_gap" && notice.message.includes("Big Thunder Mountain"),
    ),
    false,
  );
});

test("missing duration and coordinates keep a place eligible", () => {
  const planned = apply(
    { ...baseInput, dayCount: 1 },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_eiffel_tower", role: "core" },
          { placeId: "plc_paris_seine_walk", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.deepEqual(idsOnDay(planned.trip, 1), ["plc_paris_eiffel_tower", "plc_paris_seine_walk"]);
  assert.equal(
    planned.trip.notices.some(
      (notice) => notice.code === "missing_duration" && notice.placeId === "plc_paris_seine_walk",
    ),
    true,
  );
  assert.equal(
    planned.trip.notices.some(
      (notice) => notice.code === "missing_coordinates" && notice.placeId === "plc_paris_seine_walk",
    ),
    true,
  );
});

test("pace heuristics move extra unlocked stops aside and keep a must-see that exceeds the minute cap", () => {
  const steady = apply(
    {
      ...baseInput,
      dayCount: 1,
      interests: ["photo_stops"],
      constraints: { mustSeePlaceIds: [], mobility: null },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_i_love_you_wall", role: "core" },
          { placeId: "plc_paris_la_maison_rose", role: "core" },
          { placeId: "plc_paris_place_du_tertre", role: "core" },
          { placeId: "plc_paris_trocadero", role: "core" },
          { placeId: "plc_paris_arc_de_triomphe", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(steady.ok, true);
  if (!steady.ok || !steady.trip) {
    return;
  }
  assert.equal(steady.trip.days[0]?.items.filter((item) => item.role === "core").length, 4);
  assert.deepEqual(
    steady.trip.unscheduled.map((item) => item.placeId),
    ["plc_paris_arc_de_triomphe"],
  );
  assert.equal(noticeCodes(steady.trip).includes("planning_heuristic"), true);

  const tight = apply(
    {
      ...baseInput,
      dayCount: 1,
      pace: "unhurried",
      constraints: { mustSeePlaceIds: ["plc_paris_eiffel_tower"], mobility: "limited_walking" },
    },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]),
  );
  assert.equal(tight.ok, true);
  if (!tight.ok || !tight.trip) {
    return;
  }
  assert.deepEqual(idsOnDay(tight.trip, 1), ["plc_paris_eiffel_tower"]);
  assert.equal(noticeCodes(tight.trip).includes("pace_overflow"), true);
  assert.equal(noticeCodes(tight.trip).includes("mobility_unknown"), true);
  assert.match(
    tight.trip.notices.find((notice) => notice.code === "planning_heuristic")?.message ?? "",
    /not a promise/,
  );
});

test("unhurried minute heuristic sets aside later stops with known durations", () => {
  const planned = apply(
    {
      ...baseInput,
      dayCount: 1,
      pace: "unhurried",
      constraints: { mustSeePlaceIds: [], mobility: null },
    },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_eiffel_tower", role: "core" },
          { placeId: "plc_paris_sacre_coeur", role: "core" },
          { placeId: "plc_paris_notre_dame", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.deepEqual(idsOnDay(planned.trip, 1), ["plc_paris_eiffel_tower"]);
  assert.deepEqual(planned.trip.unscheduled.map((item) => item.placeId).sort(), [
    "plc_paris_notre_dame",
    "plc_paris_sacre_coeur",
  ]);
});

test("locked and traveler-added stops survive a draft that omits them", async () => {
  const seeded = apply(
    { ...baseInput, dayCount: 3 },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]),
  );
  assert.equal(seeded.ok, true);
  if (!seeded.ok || !seeded.trip) {
    return;
  }
  const withLouvre = addStop(seeded.trip, catalog, {
    placeId: "plc_paris_louvre",
    dayIndex: 1,
    itemId: "itm_louvre_lock",
  });
  assert.equal(withLouvre.ok, true);
  if (!withLouvre.ok) {
    return;
  }
  const withChapel = addStop(withLouvre.trip, catalog, {
    placeId: "plc_paris_sainte_chapelle",
    dayIndex: 2,
    itemId: "itm_chapel_add",
  });
  assert.equal(withChapel.ok, true);
  if (!withChapel.ok) {
    return;
  }
  const unlockedChapel = unlockStop(withChapel.trip, catalog, "itm_chapel_add");
  assert.equal(unlockedChapel.ok, true);
  if (!unlockedChapel.ok) {
    return;
  }

  const calls = { n: 0 };
  const refined = await refineItinerary({
    trip: unlockedChapel.trip,
    instruction: "Keep the locked stops and drop anything else you can.",
    catalog,
    ids: createIdFactory("refine"),
    model: {
      async complete() {
        calls.n += 1;
        return {
          text: JSON.stringify(
            draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_disneyland", role: "core" }] }]),
          ),
        };
      },
    },
  });
  assert.equal(calls.n, 1);
  assert.equal(refined.ok, true);
  if (!refined.ok || !refined.trip) {
    return;
  }
  const louvre = findItem(refined.trip, "itm_louvre_lock");
  const chapel = findItem(refined.trip, "itm_chapel_add");
  assert.equal(louvre?.lock, "locked");
  assert.equal(louvre?.source, "traveler");
  assert.equal(dayOf(refined.trip, "itm_louvre_lock"), 1);
  assert.equal(chapel?.source, "traveler");
  assert.equal(chapel?.lock, "unlocked");
  assert.equal(dayOf(refined.trip, "itm_chapel_add"), 2);
  assert.equal(hasPlace(refined.trip, "plc_paris_eiffel_tower"), true);
  assert.equal(dayOfPlace(refined.trip, "plc_paris_disneyland"), 3);
});

test("local edits add, remove, move, reorder, lock, and unlock without a model", () => {
  const seeded = apply(
    { ...baseInput, dayCount: 2 },
    draft([
      {
        dayIndex: 1,
        items: [
          { placeId: "plc_paris_eiffel_tower", role: "core" },
          { placeId: "plc_paris_trocadero", role: "core" },
          { placeId: "plc_paris_louvre", role: "core" },
        ],
      },
    ]),
  );
  assert.equal(seeded.ok, true);
  if (!seeded.ok || !seeded.trip) {
    return;
  }
  const snapshot = structuredClone(seeded.trip);
  const added = addStop(seeded.trip, catalog, {
    placeId: "plc_paris_sainte_chapelle",
    dayIndex: 2,
    itemId: "itm_added_chapel",
  });
  assert.equal(added.ok, true);
  if (!added.ok) {
    return;
  }
  assert.equal(findItem(added.trip, "itm_added_chapel")?.lock, "locked");
  assert.equal(findItem(added.trip, "itm_added_chapel")?.source, "traveler");
  assert.deepEqual(seeded.trip, snapshot);

  const blocked = removeStop(added.trip, catalog, { itemId: "itm_added_chapel" });
  assert.equal(blocked.ok, false);
  if (blocked.ok) {
    return;
  }
  assert.equal(blocked.issues[0]?.code, "locked_stop");

  const louvre = added.trip.days[0]?.items.find((item) => item.placeId === "plc_paris_louvre");
  assert.ok(louvre);
  const moved = moveStop(added.trip, catalog, { itemId: louvre.id, dayIndex: 2 });
  assert.equal(moved.ok, true);
  if (!moved.ok) {
    return;
  }
  assert.equal(dayOf(moved.trip, louvre.id), 2);

  const reordered = reorderStop(moved.trip, catalog, { itemId: louvre.id, toIndex: 0 });
  assert.equal(reordered.ok, true);
  if (!reordered.ok) {
    return;
  }
  assert.equal(reordered.trip.days[1]?.items[0]?.id, louvre.id);

  const locked = lockStop(reordered.trip, catalog, louvre.id);
  assert.equal(locked.ok, true);
  if (!locked.ok) {
    return;
  }
  const unlocked = unlockStop(locked.trip, catalog, louvre.id);
  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) {
    return;
  }
  assert.equal(findItem(unlocked.trip, louvre.id)?.lock, "unlocked");

  const eiffel = unlocked.trip.days[0]?.items.find((item) => item.placeId === "plc_paris_eiffel_tower");
  assert.ok(eiffel);
  const removedMustSee = removeStop(unlocked.trip, catalog, { itemId: eiffel.id });
  assert.equal(removedMustSee.ok, true);
  if (!removedMustSee.ok) {
    return;
  }
  assert.equal(
    removedMustSee.trip.unscheduled.some((item) => item.placeId === "plc_paris_eiffel_tower"),
    true,
  );
  const kept = removeStop(removedMustSee.trip, catalog, {
    itemId: removedMustSee.trip.unscheduled[0]?.id ?? "",
  });
  assert.equal(kept.ok, false);
  if (kept.ok) {
    return;
  }
  assert.equal(kept.issues[0]?.code, "must_see_kept");

  const trocadero = removedMustSee.trip.days.flatMap((day) => day.items).find(
    (item) => item.placeId === "plc_paris_trocadero",
  );
  assert.ok(trocadero);
  const removedOptional = removeStop(removedMustSee.trip, catalog, { itemId: trocadero.id });
  assert.equal(removedOptional.ok, true);
  if (!removedOptional.ok) {
    return;
  }
  assert.equal(hasPlace(removedOptional.trip, "plc_paris_trocadero"), false);
});

test("undo restores the itinerary from before the last generated change", async () => {
  const ids = createIdFactory("undo");
  const generated = await generateItinerary({
    preferences: baseInput,
    catalog,
    ids,
    model: jsonModel([
      draft([
        { dayIndex: 1, items: [{ placeId: "plc_paris_louvre", role: "core" }] },
        { dayIndex: 2, items: [{ placeId: "plc_paris_trocadero", role: "core" }] },
      ]),
    ]),
  });
  assert.equal(generated.ok, true);
  if (!generated.ok || !generated.trip) {
    return;
  }
  const beforeRefine = placeLayout(generated.trip);
  const refined = await refineItinerary({
    trip: generated.trip,
    instruction: "Shift the plan toward the river.",
    catalog,
    ids,
    model: jsonModel([
      draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_seine_cruise", role: "core" }] }]),
    ]),
  });
  assert.equal(refined.ok, true);
  if (!refined.ok || !refined.trip) {
    return;
  }
  const edited = addStop(refined.trip, catalog, {
    placeId: "plc_paris_sainte_chapelle",
    dayIndex: 2,
    itemId: "itm_undo_chapel",
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) {
    return;
  }
  const undone = undoLastAiChange(edited.trip, catalog);
  assert.equal(undone.ok, true);
  if (!undone.ok) {
    return;
  }
  assert.deepEqual(placeLayout(undone.trip), beforeRefine);
  assert.equal(hasPlace(undone.trip, "itm_undo_chapel"), false);
  const second = undoLastAiChange(undone.trip, catalog);
  assert.equal(second.ok, false);
  if (second.ok) {
    return;
  }
  assert.equal(second.issues[0]?.code, "nothing_to_undo");
});

test("drafts and saved trips can use approved place ids only", async () => {
  const calls = { n: 0 };
  const model: PlannerModel = {
    async complete() {
      calls.n += 1;
      return { text: "not-json" };
    },
  };
  const unknown = await generateItinerary({
    preferences: {
      ...baseInput,
      constraints: { mustSeePlaceIds: ["plc_paris_not_real"], mobility: null },
    },
    catalog,
    model,
  });
  assert.equal(unknown.ok, false);
  if (unknown.ok) {
    return;
  }
  assert.equal(unknown.issues.some((entry) => entry.code === "unapproved_place"), true);
  assert.equal(calls.n, 0);

  const draftCatalog = withDraftPlace();
  const draftPlace = parseTravelerPreferences(
    {
      ...baseInput,
      constraints: { mustSeePlaceIds: ["plc_paris_draft_gate"], mobility: null },
    },
    draftCatalog,
  );
  assert.equal(draftPlace.ok, false);

  const badDraft = planFromDraft({
    preferences: prefer(baseInput),
    draft: draft([
      { dayIndex: 1, items: [{ placeId: "plc_paris_not_real", role: "core" }] },
    ]),
    previous: null,
    catalog,
    ids: createIdFactory("bad"),
    draftRejected: false,
  });
  assert.equal(badDraft.ok, false);

  const seeded = apply(baseInput, draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]));
  assert.equal(seeded.ok, true);
  if (!seeded.ok || !seeded.trip) {
    return;
  }
  const tampered: TripDocument = {
    ...seeded.trip,
    days: seeded.trip.days.map((day, index) =>
      index === 0
        ? {
            ...day,
            items: day.items.map((item) =>
              item.placeId === "plc_paris_eiffel_tower"
                ? { ...item, placeId: "plc_paris_not_real" }
                : item,
            ),
          }
        : day,
    ),
  };
  const parsed = parseTripDocument(tampered, catalog);
  assert.equal(parsed.ok, false);
  const refined = await refineItinerary({
    trip: tampered,
    instruction: "Add a hidden courtyard.",
    catalog,
    model,
  });
  assert.equal(refined.ok, false);
  assert.equal(calls.n, 0);

  const approvedIds = new Set<string>(
    approvedCatalog(catalog).places.map((place) => place.id),
  );
  const fallback = await generateItinerary({
    preferences: {
      ...baseInput,
      interests: ["walks"],
      constraints: { mustSeePlaceIds: ["plc_paris_sainte_chapelle"], mobility: null },
    },
    catalog,
    model,
  });
  assert.equal(fallback.ok, true);
  if (!fallback.ok || !fallback.trip) {
    return;
  }
  assert.equal(calls.n, 2);
  assert.deepEqual(allPlaceIds(fallback.trip), ["plc_paris_sainte_chapelle"]);
  assert.equal(hasPlace(fallback.trip, "plc_paris_montmartre"), false);
  assert.equal(noticeCodes(fallback.trip).includes("planner_fallback"), true);
  for (const placeId of allPlaceIds(fallback.trip)) {
    assert.equal(approvedIds.has(placeId), true);
  }
});

test("plans do not carry invented prices, schedules, or travel times", () => {
  const planned = apply(
    baseInput,
    draft(
      [{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }],
      [],
      "Meet at 18:00 and pay €40.",
    ),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.trip) {
    return;
  }
  assert.equal(planned.trip.summary.includes("18:00"), false);
  assert.equal(planned.trip.summary.includes("€"), false);
  assertNoInventedFacts(planned.trip);

  const forged: TripDocument = {
    ...planned.trip,
    summary: "A reserved table at 19:45.",
  };
  const parsed = parseTripDocument(forged, catalog);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.issues.some((entry) => entry.code === "prohibited_content"), true);
});

test("the prompt stays on the approved catalog and names no provider", () => {
  const preferences = prefer(baseInput);
  const retrieval = parseTravelerPreferences(baseInput, catalog);
  assert.equal(retrieval.ok, true);
  if (!retrieval.ok) {
    return;
  }
  const prompt = buildPlannerPrompt({
    retrieval: retrieval.retrieval,
    preferences,
    instruction: "Keep the locked stops.",
    lockedPlaceIds: ["plc_paris_louvre"],
    travelerPlaceIds: ["plc_paris_sainte_chapelle"],
  });
  assert.match(prompt.system, /editorial example, not a required route/);
  assert.match(prompt.system, /Do not invent prices, opening hours, showtimes, or travel times/);
  assert.match(prompt.system, /full-day commitment/);
  assert.equal(prompt.user.includes("plc_paris_disneyland"), true);
  assert.equal(prompt.user.includes("latitude"), false);
  assert.equal(/anthropic|openai|gemini|gpt-/i.test(prompt.system + prompt.user), false);
  assert.match(developmentRateLimitPolicyText, /development-only/);
  assert.match(developmentRateLimitPolicyText, /shared/);
});

test("a far pair kept on one day reports an unknown travel time", () => {
  const seeded = apply(
    { ...baseInput, dayCount: 1 },
    draft([{ dayIndex: 1, items: [{ placeId: "plc_paris_eiffel_tower", role: "core" }] }]),
  );
  assert.equal(seeded.ok, true);
  if (!seeded.ok || !seeded.trip) {
    return;
  }
  const mixed = addStop(seeded.trip, catalog, {
    placeId: "plc_paris_disneyland",
    dayIndex: 1,
    itemId: "itm_added_park",
  });
  assert.equal(mixed.ok, true);
  if (!mixed.ok) {
    return;
  }
  assert.deepEqual(idsOnDay(mixed.trip, 1), ["plc_paris_eiffel_tower", "plc_paris_disneyland"]);
  const gap = mixed.trip.notices.find((notice) => notice.code === "long_gap");
  assert.ok(gap);
  assert.match(gap.message, /Travel time is unknown/);
  assert.doesNotMatch(gap.message, /\d+\s*(?:min|minutes|hours)/);
  assert.equal(noticeCodes(mixed.trip).includes("major_day_commitment"), true);
  assertNoInventedFacts(mixed.trip);
});

function issueCodes(input: unknown): string[] {
  const parsed = parseTravelerPreferences(input, catalog);
  if (parsed.ok) {
    return [];
  }
  return parsed.issues.map((entry) => entry.code);
}

function prefer(input: unknown) {
  const parsed = parseTravelerPreferences(input, catalog);
  if (!parsed.ok) {
    throw new Error(parsed.issues.map((entry) => entry.message).join("; "));
  }
  return parsed.preferences;
}

function draft(
  days: PlannerDraft["days"],
  unscheduledPlaceIds: string[] = [],
  summary = "A walk through approved places.",
): PlannerDraft {
  return { summary, days, unscheduledPlaceIds };
}

function apply(input: unknown, plannerDraft: PlannerDraft) {
  return planFromDraft({
    preferences: prefer(input),
    draft: plannerDraft,
    previous: null,
    catalog,
    ids: createIdFactory("apply"),
    draftRejected: false,
  });
}

function idsOnDay(trip: TripDocument, dayIndex: number): string[] {
  return trip.days.find((day) => day.dayIndex === dayIndex)?.items.map((item) => item.placeId) ?? [];
}

function allPlaceIds(trip: TripDocument): string[] {
  return [
    ...trip.days.flatMap((day) => day.items.map((item) => item.placeId)),
    ...trip.unscheduled.map((item) => item.placeId),
  ];
}

function hasPlace(trip: TripDocument, placeId: string): boolean {
  return allPlaceIds(trip).includes(placeId) || findItem(trip, placeId) !== null;
}

function findItem(trip: TripDocument, itemId: string): TripItem | null {
  for (const day of trip.days) {
    const item = day.items.find((candidate) => candidate.id === itemId);
    if (item) {
      return item;
    }
  }
  return trip.unscheduled.find((item) => item.id === itemId) ?? null;
}

function dayOf(trip: TripDocument, itemId: string): number | null {
  const day = trip.days.find((candidate) => candidate.items.some((item) => item.id === itemId));
  return day?.dayIndex ?? null;
}

function dayOfPlace(trip: TripDocument, placeId: PlaceId): number | null {
  const day = trip.days.find((candidate) => candidate.items.some((item) => item.placeId === placeId));
  return day?.dayIndex ?? null;
}

function placeLayout(trip: TripDocument): string[] {
  return [
    ...trip.days.map((day) => day.items.map((item) => item.placeId).join(",")),
    `unscheduled:${trip.unscheduled.map((item) => item.placeId).join(",")}`,
  ];
}

function noticeCodes(trip: TripDocument): string[] {
  return trip.notices.map((notice) => notice.code);
}

function assertNoInventedFacts(trip: TripDocument) {
  const json = JSON.stringify(trip);
  assert.equal(json.includes("amountMinor"), false);
  assert.equal(json.includes("openingHours"), false);
  assert.equal(json.includes("travelMinutes"), false);
  assert.equal(json.includes("€"), false);
  assert.equal(json.includes("$"), false);
  assert.equal(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(json), false);
  assert.equal(/\b\d+\s*(?:min|mins|minutes|hr|hrs|hours)\b/i.test(json), false);
}

function jsonModel(drafts: readonly PlannerDraft[]): PlannerModel {
  let index = 0;
  return {
    async complete() {
      const next = drafts[index] ?? drafts[0];
      index += 1;
      return { text: JSON.stringify(next ?? draft([])) };
    },
  };
}

function withDraftPlace(): CatalogSnapshot {
  const place = catalog.places[0];
  if (!place) {
    throw new Error("Paris fixture has no places.");
  }
  const draftPlace: Place = {
    ...place,
    id: "plc_paris_draft_gate",
    status: "draft",
    name: "Draft gate",
  };
  return { ...catalog, places: [...catalog.places, draftPlace] };
}
