import assert from "node:assert/strict";
import test from "node:test";

import { checkCatalogIntegrity, getPrototypeCatalog } from "../../index";
import { checkThailandImport, checkTravelCatalog, isLiveQuote } from "../../travel/index";
import { expectedSourceIds, importThailandCatalog } from "./index";

const catalog = importThailandCatalog();

function propertyFor(sourceId: string) {
  const property = catalog.properties.find((item) => item.sourceIds.includes(sourceId));
  assert.ok(property, `missing property for ${sourceId}`);
  return property;
}

function ratesFor(sourceId: string) {
  return catalog.rates.filter((rate) => rate.sourceId === sourceId);
}

function amountFor(rateId: string) {
  const amount = catalog.amounts.find(
    (item) => item.subject.type === "stay_rate" && item.subject.id === rateId,
  );
  assert.ok(amount, `missing amount for ${rateId}`);
  return amount;
}

test("thailand import keeps the paris catalog approved and separate", () => {
  const paris = getPrototypeCatalog();

  assert.deepEqual(checkCatalogIntegrity(paris), []);
  assert.equal(paris.destinations[0]?.id, "dst_paris");
  assert.equal(paris.destinations[0]?.status, "approved");
  assert.equal(paris.dynamicFacts.length, 0);
  assert.equal(catalog.stayBases.some((base) => base.slug === "paris"), false);
});

test("explicit source ids are kept and counted separately from the stated total", () => {
  const sourceIds = catalog.provenance.map((item) => item.sourceId);

  assert.equal(catalog.totals.statedDocumentTotal, 137);
  assert.equal(catalog.totals.sourceRecords, 139);
  assert.equal(catalog.totals.flightTemplates, 16);
  assert.equal(catalog.totals.accommodationSourceRecords, 123);
  assert.equal(catalog.totals.properties, 120);
  assert.equal(catalog.totals.rateVariants, 124);
  assert.equal(new Set(sourceIds).size, 139);
  assert.equal(sourceIds.length, expectedSourceIds().length);
  for (const sourceId of expectedSourceIds()) {
    assert.equal(sourceIds.includes(sourceId), true);
  }
  assert.equal(
    catalog.findings.some(
      (finding) => finding.field === "document_total" && finding.kind === "ambiguous",
    ),
    true,
  );
  assert.equal(catalog.provenance.every((item) => item.sourcePath === "docs/inventory/thailand.md"), true);
  assert.equal(catalog.provenance.find((item) => item.sourceId === "TH-F001")?.excerpt.includes("TH-F001"), true);
});

test("internal ids are unique and shared properties do not invent source ids", () => {
  assert.equal(new Set(catalog.properties.map((property) => property.id)).size, 120);
  assert.equal(new Set(catalog.properties.flatMap((property) => property.sourceIds)).size, 123);
  assert.equal(new Set(catalog.rates.map((rate) => rate.id)).size, 124);
  assert.equal(new Set(catalog.rates.map((rate) => `${rate.sourceId}:${rate.rateKey}`)).size, 124);
  assert.equal(new Set(catalog.flightTemplates.map((flight) => flight.id)).size, 16);
  assert.equal(catalog.provenance.some((item) => item.sourceId === "PH-H014"), false);
  assert.equal(catalog.provenance.some((item) => item.sourceId === "CM-H074"), false);
  assert.equal(catalog.provenance.some((item) => item.sourceId === "CM-H068B"), false);

  const mazi = propertyFor("PH-H014A");
  assert.equal(mazi.id, propertyFor("PH-H014B").id);
  assert.deepEqual(mazi.sourceIds, ["PH-H014A", "PH-H014B"]);
  assert.equal(catalog.rates.filter((rate) => rate.propertyId === mazi.id).length, 2);

  const onThapae = propertyFor("CM-H062");
  assert.equal(onThapae.name, "ON Thapae Gate Chiang Mai");
  assert.deepEqual(onThapae.sourceIds, ["CM-H062", "CM-H063", "CM-H063B"]);
  assert.equal(catalog.rates.filter((rate) => rate.propertyId === onThapae.id).length, 3);
  assert.deepEqual(
    catalog.rates
      .filter((rate) => rate.propertyId === onThapae.id)
      .map((rate) => amountFor(rate.id).amountMinor),
    [8800, 12700, 13900],
  );

  const dusitRates = ratesFor("CM-H068");
  assert.equal(propertyFor("CM-H068").sourceIds.length, 1);
  assert.equal(catalog.provenance.filter((item) => item.sourceId === "CM-H068").length, 1);
  assert.deepEqual(
    dusitRates.map((rate) => [rate.rateKey, rate.breakfast, amountFor(rate.id).amountMinor]),
    [
      ["without_breakfast", "not_included", 11100],
      ["with_breakfast", "included", 12600],
    ],
  );

  const astra = catalog.properties.filter((property) => property.name.includes("Astra Sky River"));
  assert.equal(astra.length, 2);
});

test("geography keeps countries, regions, stay bases, and areas distinct", () => {
  assert.equal(catalog.countries[0]?.name, "Thailand");
  assert.equal(catalog.countries[0]?.countryCode, "TH");
  assert.deepEqual(
    catalog.regions.map((region) => region.name),
    ["Bangkok", "Phuket", "Chiang Mai", "Krabi"],
  );

  const aoNang = catalog.stayBases.find((base) => base.id === "dst_ao_nang");
  const kohLanta = catalog.stayBases.find((base) => base.id === "dst_koh_lanta");
  const phuket = catalog.stayBases.find((base) => base.id === "dst_phuket");
  assert.equal(aoNang?.regionId, "rgn_krabi");
  assert.equal(kohLanta?.regionId, "rgn_krabi");
  assert.equal(aoNang?.id === kohLanta?.id, false);
  assert.deepEqual(aoNang?.aliases, ["Mainland Krabi"]);
  assert.deepEqual(
    catalog.areas.filter((area) => area.stayBaseId === phuket?.id).map((area) => area.name),
    ["Patong", "Karon", "Kamala", "Bang Tao"],
  );

  assert.equal(propertyFor("PH-H001").areaId, "area_phuket_patong");
  assert.equal(propertyFor("PH-H008").areaId, "area_phuket_patong");
  assert.equal(propertyFor("PH-H007").areaId, "area_phuket_karon");
  assert.equal(propertyFor("PH-H015").areaId, "area_phuket_kamala");
  assert.equal(propertyFor("PH-H016").areaId, "area_phuket_bang_tao");
  assert.equal(propertyFor("PH-H004").areaId, null);

  assert.equal(propertyFor("KR-H003").stayBaseId, "dst_koh_lanta");
  assert.equal(propertyFor("KR-H012").stayBaseId, "dst_ao_nang");
  assert.equal(propertyFor("KR-H012").areaId, "area_ao_nang_beach");
  assert.equal(propertyFor("KR-H001").stayBaseId, null);
  assert.equal(propertyFor("KR-H001").regionId, "rgn_krabi");

  const krabiFlight = catalog.flightTemplates.find((flight) => flight.sourceId === "TH-F015");
  assert.equal(krabiFlight?.legs[0]?.destination, "Krabi");
  assert.equal(krabiFlight?.legs[0]?.endpointStayBaseId, null);

  const areaIds = [
    "area_phuket_patong",
    "area_phuket_karon",
    "area_phuket_kamala",
    "area_phuket_bang_tao",
  ];
  const grouped = areaIds.map(
    (areaId) =>
      new Set(
        catalog.properties
          .filter((property) => property.areaId === areaId)
          .flatMap((property) => property.sourceIds),
      ),
  );
  for (let index = 0; index < grouped.length; index += 1) {
    for (let other = index + 1; other < grouped.length; other += 1) {
      for (const sourceId of grouped[index] ?? []) {
        assert.equal(grouped[other]?.has(sourceId), false);
      }
    }
  }
});

test("imported records stay unapproved and editorial notes stay unverified", () => {
  assert.deepEqual(checkTravelCatalog(catalog), []);
  assert.deepEqual(checkThailandImport(catalog), []);

  const approvals = [
    ...catalog.countries,
    ...catalog.regions,
    ...catalog.stayBases,
    ...catalog.areas,
    ...catalog.properties,
    ...catalog.rates,
    ...catalog.flightTemplates,
    ...catalog.amounts,
    ...catalog.recommendations,
  ].map((record) => record.approval);

  assert.equal(approvals.includes("approved"), false);
  assert.equal(approvals.includes("draft"), true);
  assert.equal(approvals.includes("in_review"), true);
  assert.equal(propertyFor("BK-H001").approval, "draft");
  assert.equal(propertyFor("BK-H002").approval, "in_review");
  assert.equal(propertyFor("PH-H004").approval, "in_review");
  assert.equal(propertyFor("PH-H004").qualityReview, true);

  for (const recommendation of catalog.recommendations) {
    assert.equal(recommendation.verified, false);
    assert.equal(recommendation.approval === "approved", false);
  }
  for (const profile of catalog.referenceProfiles) {
    assert.equal(profile.verified, false);
    assert.equal(profile.provenance, "manual_import");
    assert.equal(profile.guestScoreScale, null);
  }

  const recommended = catalog.recommendations.find(
    (item) => item.sourceIds.includes("BK-H004") && item.stance === "your_recommended",
  );
  assert.equal(recommended?.tier, "recommended");
  assert.equal(recommended?.verified, false);
  assert.equal(
    catalog.recommendations.some(
      (item) => item.propertyIds.includes(propertyFor("PH-H004").id) && item.qualityReview,
    ),
    true,
  );
});

test("prices stay historical references and are not live quotes", () => {
  assert.equal(catalog.amounts.length, 140);
  assert.equal(catalog.supplierLinks.length, 0);
  assert.equal(catalog.dynamicUpdates.length, 0);
  assert.equal(catalog.suggestions.length, 0);

  for (const amount of catalog.amounts) {
    assert.equal(amount.presentation, "historical_reference");
    assert.equal(amount.freshness, "unverified");
    assert.equal(amount.liveQuote, false);
    assert.equal(amount.lastCheckedAt, null);
    assert.equal(amount.lastVerifiedAt, null);
    assert.equal(amount.expiresAt, null);
    assert.equal(amount.source.retrievedBy, "manual");
    assert.equal(isLiveQuote(amount), false);
    assert.equal(amount.note.includes("$"), false);
  }

  const bangkokRate = ratesFor("BK-H001")[0];
  assert.ok(bangkokRate);
  assert.equal(amountFor(bangkokRate.id).amountMinor, 3700);
  assert.equal(amountFor(bangkokRate.id).currency, "USD");
  assert.equal(amountFor(bangkokRate.id).unit, "per_night");

  const flightAmount = catalog.amounts.find((amount) => amount.sourceId === "TH-F001");
  assert.equal(flightAmount?.amountMinor, 55000);
  assert.equal(flightAmount?.unit, "itinerary_total");

  const missingPrice = catalog.amounts.find((amount) => amount.sourceId === "CM-H049");
  assert.equal(missingPrice?.amountMinor, null);
  assert.equal(missingPrice?.currency, null);
  assert.equal(ratesFor("CM-H014").length, 1);
  const european = ratesFor("CM-H014")[0];
  assert.ok(european);
  assert.equal(amountFor(european.id).amountMinor, 3500);

  const maziRates = catalog.rates.filter((rate) => rate.propertyId === propertyFor("PH-H014A").id);
  assert.deepEqual(
    maziRates.map((rate) => [rate.sourceId, rate.breakfast, amountFor(rate.id).amountMinor]),
    [
      ["PH-H014A", "unknown", 9200],
      ["PH-H014B", "included", 11000],
    ],
  );

  for (const rate of catalog.rates) {
    assert.equal(rate.roomCategory, null);
    assert.equal(rate.occupancyKnown, false);
    assert.equal(rate.taxesKnown, false);
    assert.equal(rate.cancellationKnown, false);
    assert.equal(rate.stayDatesKnown, false);
  }

  const openJaw = catalog.flightTemplates.find((flight) => flight.sourceId === "TH-F004");
  assert.deepEqual(openJaw?.carriers, ["Etihad", "Emirates"]);
  assert.equal(openJaw?.carrierUnresolved, true);
  assert.equal(openJaw?.journey, "multi_city");
  assert.equal(catalog.flightTemplates.filter((flight) => flight.sourceId === "TH-F004").length, 1);

  const domestic = catalog.flightTemplates.find((flight) => flight.sourceId === "TH-F013");
  assert.deepEqual(domestic?.carriers, []);
  assert.equal(domestic?.journey, "one_way");
  assert.equal(domestic?.approval, "in_review");
});
