import assert from "node:assert/strict";
import test from "node:test";

import {
  alternativeItemsForDay,
  coreItemsForDay,
  editorialAdditionItems,
  getPrototypeCatalog,
  type CatalogSnapshot,
  type DynamicFact,
} from "@/lib/catalog";

import { sampleDaysLabel } from "@/lib/format";

import { approvedSampleDayCount, getDestinationPage, getHomeFeature } from "./queries";

const itineraryId = "itn_paris_three_day" as const;

test("public views follow the approved Paris fixture", () => {
  const snapshot = getPrototypeCatalog();
  const feature = getHomeFeature(snapshot);
  const page = getDestinationPage(snapshot, "paris");

  assert.deepEqual(
    feature.destinations.map((item) => ({
      slug: item.destination.slug,
      title: item.itineraryTitle,
      cover: item.cover?.src ?? null,
    })),
    [
      {
        slug: "paris",
        title: "Paris sample, three days",
        cover: "/images/travel/paris-seine-eiffel.jpg",
      },
    ],
  );
  assert.ok(page);
  assert.equal(page.destination.name, "Paris");
  assert.equal(page.itinerary?.title, "Paris sample, three days");
  assert.deepEqual(
    page.days.map((day) => day.stops.map((stop) => stop.placeId)),
    [1, 2, 3].map((dayIndex) =>
      coreItemsForDay(snapshot, itineraryId, dayIndex).map((item) => item.placeId),
    ),
  );
  assert.deepEqual(
    page.days.map((day) => day.optional.map((stop) => stop.placeId)),
    [1, 2, 3].map((dayIndex) =>
      alternativeItemsForDay(snapshot, itineraryId, dayIndex).map((item) => item.placeId),
    ),
  );
  assert.deepEqual(
    page.additions.map((stop) => stop.placeId),
    editorialAdditionItems(snapshot, itineraryId).map((item) => item.placeId),
  );
  assert.deepEqual(
    page.tips.map((tip) => tip.id),
    snapshot.tips.map((tip) => tip.id),
  );
  assert.equal(approvedSampleDayCount(snapshot, "dst_paris"), 3);
  assert.equal(feature.destinations[0]?.sampleDayCount, 3);
  assert.equal(page.days.length, 3);
  assert.equal(sampleDaysLabel(3, "The"), "The 3 days");
  assert.equal(sampleDaysLabel(3, "Read"), "Read the 3 days");
  assert.equal(getDestinationPage(snapshot, "not-a-place"), null);
});

test("sample day labels follow scheduled days and omit an unscheduled route", () => {
  const oneDay = structuredClone(getPrototypeCatalog());

  for (const item of oneDay.sampleItineraryItems) {
    if (item.dayIndex !== null && item.dayIndex !== 1) {
      item.dayIndex = null;
    }
  }

  const oneDayCount = approvedSampleDayCount(oneDay, "dst_paris");

  assert.ok(oneDayCount);
  assert.equal(oneDayCount, 1);
  assert.equal(getHomeFeature(oneDay).destinations[0]?.sampleDayCount, 1);
  assert.equal(getDestinationPage(oneDay, "paris")?.days.length, 1);
  assert.equal(sampleDaysLabel(oneDayCount, "Read"), "Read the day");
  assert.equal(sampleDaysLabel(oneDayCount, "The"), "The day");
  assert.equal(sampleDaysLabel(oneDayCount, "Read").includes("three"), false);

  const unscheduled = structuredClone(getPrototypeCatalog());

  for (const item of unscheduled.sampleItineraryItems) {
    item.dayIndex = null;
  }

  assert.equal(approvedSampleDayCount(unscheduled, "dst_paris"), null);
  assert.equal(getHomeFeature(unscheduled).destinations[0]?.sampleDayCount, null);
  assert.equal(getDestinationPage(unscheduled, "paris")?.days.length, 0);
});

test("public views drop draft geography and historical prices", () => {
  const snapshot = contaminatedCatalog();
  const feature = getHomeFeature(snapshot);
  const paris = getDestinationPage(snapshot, "paris");
  const bangkok = getDestinationPage(snapshot, "bangkok");
  const rendered = JSON.stringify({ feature, paris, bangkok });

  assert.deepEqual(
    feature.destinations.map((item) => item.destination.slug),
    ["paris"],
  );
  assert.equal(bangkok, null);
  assert.ok(paris);
  assert.equal(
    paris.days.some((day) => day.stops.some((stop) => stop.placeId === "plc_paris_eiffel_tower")),
    false,
  );
  assert.equal(paris.tips.some((tip) => tip.subject.type === "place" && tip.subject.id === "plc_paris_eiffel_tower"), false);
  assert.equal(rendered.includes("Bangkok"), false);
  assert.equal(rendered.includes("THB"), false);
  assert.equal(rendered.includes("18000"), false);
  assert.equal(rendered.includes("sty_ph_mazi_design_hotel"), false);
  assert.equal(getDestinationPage(snapshot, "not-a-place"), null);
});

test("homepage destinations sort by slug and leave an unapproved destination out", () => {
  const snapshot = structuredClone(getPrototypeCatalog());
  snapshot.destinations = [
    ...snapshot.destinations,
    sampleDestination("dst_sample_zurich", "approved", "zurich", "Zurich"),
    sampleDestination("dst_sample_amalfi", "approved", "amalfi", "Amalfi"),
    sampleDestination("dst_bangkok", "draft", "bangkok", "Bangkok"),
  ];

  assert.deepEqual(
    getHomeFeature(snapshot).destinations.map((item) => item.destination.slug),
    ["amalfi", "paris", "zurich"],
  );
  assert.equal(getDestinationPage(snapshot, "bangkok"), null);
  assert.ok(getDestinationPage(snapshot, "paris"));
  assert.equal(getDestinationPage(snapshot, "amalfi")?.destination.name, "Amalfi");
});

function sampleDestination(
  id: "dst_sample_zurich" | "dst_sample_amalfi" | "dst_bangkok",
  status: "approved" | "draft",
  slug: string,
  name: string,
): CatalogSnapshot["destinations"][number] {
  return {
    id,
    status,
    slug,
    name,
    countryCode: "ZZ",
    editorialSummary: "Sample destination for the public list.",
    vibeTags: [],
  };
}

function contaminatedCatalog(): CatalogSnapshot {
  const snapshot = structuredClone(getPrototypeCatalog());
  const eiffel = snapshot.places.find((place) => place.id === "plc_paris_eiffel_tower");
  if (!eiffel) {
    throw new Error("The Paris fixture is missing the Eiffel Tower.");
  }
  eiffel.status = "draft";
  snapshot.destinations = [
    ...snapshot.destinations,
    {
      id: "dst_bangkok",
      status: "draft",
      slug: "bangkok",
      name: "Bangkok",
      countryCode: "TH",
      editorialSummary: "Draft stay base.",
      vibeTags: ["markets"],
    },
  ];
  snapshot.dynamicFacts = [historicalPrice];
  return snapshot;
}

const historicalPrice: DynamicFact = {
  id: "dyn_historical_price",
  subject: { type: "destination", id: "dst_paris" },
  kind: "price",
  freshness: "unverified",
  source: { providerKey: "historical", externalId: "sty_ph_mazi_design_hotel", retrievedBy: "manual" },
  lastCheckedAt: null,
  lastVerifiedAt: null,
  expiresAt: null,
  historicalNote: "Internal reference only.",
  amountMinor: 18000,
  currency: "THB",
};
