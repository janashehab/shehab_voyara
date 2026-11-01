import assert from "node:assert/strict";
import test from "node:test";

import { importThailandCatalog } from "../imports/thailand/index";
import {
  FAILED_REFRESH_RULE,
  checkThailandImport,
  checkTravelCatalog,
  futureSupplierAdapters,
  isLiveQuote,
} from "./index";

const catalog = importThailandCatalog();

test("failed refreshes keep verification time and offer expiry apart", () => {
  assert.match(FAILED_REFRESH_RULE, /lastVerifiedAt/);
  assert.match(FAILED_REFRESH_RULE, /previous successful verification/);
  assert.match(FAILED_REFRESH_RULE, /expiresAt/);
  assert.match(FAILED_REFRESH_RULE, /offer expiry/);
  assert.match(FAILED_REFRESH_RULE, /refresh_failed/);
  assert.deepEqual(futureSupplierAdapters, [
    "flight_shopping",
    "hotel_shopping",
    "flight_status",
    "mapping",
    "activities",
  ]);
});

test("travel guards reject quote-like history, verified editorial, and crossed areas", () => {
  const quoted = structuredClone(catalog);
  const amount = quoted.amounts[0];
  assert.ok(amount);
  amount.freshness = "fresh";
  amount.liveQuote = true;
  assert.equal(
    checkTravelCatalog(quoted).some(
      (issue) => issue.code === "historical_amount_presented_as_current",
    ),
    true,
  );
  assert.equal(isLiveQuote(amount), false);

  const verified = structuredClone(catalog);
  const recommendation = verified.recommendations[0];
  assert.ok(recommendation);
  recommendation.verified = true;
  assert.equal(
    checkTravelCatalog(verified).some((issue) => issue.code === "editorial_marked_verified"),
    true,
  );

  const crossed = structuredClone(catalog);
  const lanta = crossed.properties.find((property) => property.stayBaseId === "dst_koh_lanta");
  assert.ok(lanta);
  lanta.areaId = "area_phuket_patong";
  assert.equal(
    checkTravelCatalog(crossed).some((issue) => issue.code === "area_base_mismatch"),
    true,
  );

  const priced = structuredClone(catalog);
  const note = priced.recommendations[0];
  assert.ok(note);
  note.body = "Costs $10";
  assert.equal(
    checkTravelCatalog(priced).some((issue) => issue.code === "prohibited_content"),
    true,
  );
});

test("the import check rejects approval and supplier mappings the markdown did not grant", () => {
  const approved = structuredClone(catalog);
  const property = approved.properties[0];
  assert.ok(property);
  property.approval = "approved";
  assert.equal(
    checkThailandImport(approved).some((issue) => issue.code === "import_approved"),
    true,
  );

  const mapped = structuredClone(catalog);
  mapped.supplierLinks.push({
    id: "sup_example",
    providerKey: "hotel_shopping",
    externalId: "supplier-property",
    domain: "accommodation",
    subjectType: "stay_property",
    subjectId: property.id,
    mappedBy: "admin",
  });
  assert.equal(
    checkThailandImport(mapped).some((issue) => issue.code === "supplier_mapping_created"),
    true,
  );
  assert.equal(catalog.supplierLinks.length, 0);
});
