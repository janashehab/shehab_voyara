import assert from "node:assert/strict";
import test from "node:test";
import {
  alternativeItemsForDay,
  approvedCatalog,
  checkCatalogIntegrity,
  coreItemsForDay,
  editorialAdditionItems,
  getPrototypeCatalog,
  isVerifiedDynamicFact,
  parisCatalog,
  verifiedAmountMinor,
} from "./index";
import type { CatalogSnapshot, DynamicFact, Place } from "./types";

const itineraryId = "itn_paris_three_day" as const;

test("paris fixture passes integrity and exposes an approved three-day catalog", () => {
  const catalog = getPrototypeCatalog();

  assert.deepEqual(checkCatalogIntegrity(catalog), []);
  assert.equal(catalog.destinations[0]?.id, "dst_paris");
  assert.equal(catalog.destinations[0]?.status, "approved");
  assert.deepEqual(catalog.sampleItineraries[0]?.destinationIds, ["dst_paris"]);
  assert.equal(catalog.dynamicFacts.length, 0);
  assert.equal(JSON.stringify(catalog).includes("confirmationNumber"), false);
  assert.equal(JSON.stringify(catalog).includes('"pin"'), false);
});

test("core days reference reusable places and keep alternatives out of the sequence", () => {
  const dayOne = coreItemsForDay(parisCatalog, itineraryId, 1).map((item) => item.placeId);
  const dayOneAlternatives = alternativeItemsForDay(parisCatalog, itineraryId, 1).map(
    (item) => item.placeId,
  );
  const dayThree = coreItemsForDay(parisCatalog, itineraryId, 3).map((item) => item.placeId);

  assert.deepEqual(dayOne, [
    "plc_paris_eiffel_tower",
    "plc_paris_trocadero",
    "plc_paris_seine_walk",
    "plc_paris_pigalle",
    "plc_paris_rue_lepic",
    "plc_paris_montmartre",
    "plc_paris_i_love_you_wall",
    "plc_paris_la_maison_rose",
    "plc_paris_place_du_tertre",
    "plc_paris_sacre_coeur",
    "plc_paris_vintage_shopping",
  ]);
  assert.deepEqual(dayOneAlternatives, [
    "plc_paris_pink_mamma",
    "plc_paris_bouillon_pigalle",
  ]);
  assert.equal(dayOne.includes("plc_paris_pink_mamma"), false);
  assert.equal(dayThree.filter((placeId) => placeId === "plc_paris_eiffel_tower").length, 1);
  assert.equal(
    parisCatalog.sampleItineraryItems.filter(
      (item) => item.placeId === "plc_paris_eiffel_tower",
    ).length,
    2,
  );
});

test("editorial additions are identifiable and are not placed on a day", () => {
  const additions = editorialAdditionItems(parisCatalog, itineraryId);

  assert.deepEqual(
    additions.map((item) => item.placeId),
    [
      "plc_paris_sainte_chapelle",
      "plc_paris_palais_royal",
      "plc_paris_galeries_lafayette_haussmann",
      "plc_paris_canal_saint_martin",
    ],
  );
  assert.equal(
    additions.every((item) => item.dayIndex === null && item.role === "editorial_addition"),
    true,
  );
});

test("approved-only view drops a draft place and integrity flags a draft core stop", () => {
  const louvre = parisCatalog.places.find((place) => place.id === "plc_paris_louvre");
  assert.ok(louvre);

  const draftLouvre: Place = { ...louvre, status: "draft" };
  const withDraft: CatalogSnapshot = {
    ...parisCatalog,
    places: parisCatalog.places.map((place) =>
      place.id === draftLouvre.id ? draftLouvre : place,
    ),
  };

  assert.equal(
    approvedCatalog(withDraft).places.some((place) => place.id === "plc_paris_louvre"),
    false,
  );
  assert.equal(
    approvedCatalog(withDraft).sampleItineraryItems.some(
      (item) => item.placeId === "plc_paris_louvre",
    ),
    false,
  );
  assert.equal(
    checkCatalogIntegrity(withDraft).some((issue) => issue.code === "unapproved_reference"),
    true,
  );
});

test("a missing place reference fails integrity", () => {
  const broken: CatalogSnapshot = {
    ...parisCatalog,
    sampleItineraryItems: parisCatalog.sampleItineraryItems.map((item, index) =>
      index === 0 ? { ...item, placeId: "plc_paris_missing" } : item,
    ),
  };

  assert.equal(
    checkCatalogIntegrity(broken).some((issue) => issue.code === "missing_place"),
    true,
  );
});

test("an editorial addition cannot be assigned to a day", () => {
  const scheduled: CatalogSnapshot = {
    ...parisCatalog,
    sampleItineraryItems: parisCatalog.sampleItineraryItems.map((item) =>
      item.role === "editorial_addition" && item.sortOrder === 1
        ? { ...item, dayIndex: 1 }
        : item,
    ),
  };

  assert.equal(
    checkCatalogIntegrity(scheduled).some(
      (issue) => issue.code === "editorial_addition_has_day",
    ),
    true,
  );
});

test("monetary fields stay unverified unless a fresh check recorded verification", () => {
  const unverified: DynamicFact = {
    id: "dyn_example_unverified_price",
    subject: { type: "place", id: "plc_paris_louvre" },
    kind: "price",
    freshness: "unverified",
    source: {
      providerKey: "manual_note",
      externalId: null,
      retrievedBy: "manual",
    },
    lastCheckedAt: null,
    lastVerifiedAt: null,
    expiresAt: null,
    historicalNote: "Historical note with no usable amount.",
    amountMinor: null,
    currency: null,
  };
  const verified: DynamicFact = {
    ...unverified,
    id: "dyn_example_verified_price",
    freshness: "fresh",
    source: { ...unverified.source, retrievedBy: "revalidation" },
    lastCheckedAt: "2026-10-31T09:00:00.000Z",
    lastVerifiedAt: "2026-10-31T09:00:00.000Z",
    historicalNote: "Provider amount recorded after a successful revalidation.",
    amountMinor: 2200,
    currency: "EUR",
  };

  assert.equal(isVerifiedDynamicFact(unverified), false);
  assert.equal(verifiedAmountMinor(unverified), null);
  assert.equal(isVerifiedDynamicFact(verified), true);
  assert.equal(verifiedAmountMinor(verified), 2200);
  assert.equal(
    parisCatalog.dynamicFacts.some((fact) => fact.freshness === "fresh"),
    false,
  );
});
