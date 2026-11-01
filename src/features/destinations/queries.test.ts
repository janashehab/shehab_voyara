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

import { approvedDestinationSlugs, getDestinationPage, getHomeFeature } from "./queries";

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
  assert.deepEqual(approvedDestinationSlugs(), ["paris"]);
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
  assert.deepEqual(approvedDestinationSlugs(), ["paris"]);
});

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
