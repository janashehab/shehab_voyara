import assert from "node:assert/strict";
import test from "node:test";

import { importThailandCatalog } from "../../lib/catalog/imports/thailand/index";
import { isBookableFact, isBookableOffer } from "./freshness";
import {
  applyFailedRefresh,
  applySupplierPayload,
  createSupplierLink,
  recomputeFreshness,
  type ApplyContext,
} from "./policy";
import { createAdapterRegistry, executeRefresh, registerAdapter } from "./registry";
import {
  FUTURE_PERSISTENCE_AND_SCHEDULE,
  SERVER_CREDENTIAL_RULE,
  emptySyncState,
  permittedFields,
  type SupplierAdapter,
  type SupplierPayload,
  type SyncTarget,
} from "./types";

const now = "2026-10-31T12:00:00.000Z";
const expiry = "2026-11-07T12:00:00.000Z";
const staleAfterMs = 60 * 60 * 1000;

const hotel: SyncTarget = {
  id: "sty_example",
  type: "stay_property",
  approval: "approved",
  name: "iCheck Inn Residence",
  summary: "Editorial summary",
};

const route: SyncTarget = {
  id: "flt_example",
  type: "flight_template",
  approval: "approved",
  name: "Cairo to Bangkok",
  summary: "Route template",
};

function context(targets: readonly SyncTarget[], at = now): ApplyContext {
  return { targets, now: at, staleAfterMs };
}

function hotelPayload(fields: Record<string, unknown> = {}): SupplierPayload {
  return {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalEntityId: "ext-hotel-1",
    supplierOfferId: "offer-1",
    fields: {
      amountMinor: 4300,
      currency: "USD",
      availability: true,
      occupancy: 2,
      stayStart: "2026-12-01",
      stayEnd: "2026-12-04",
      expiresAt: expiry,
      supplierOfferId: "offer-1",
      rateName: "Standard",
      ...fields,
    },
  };
}

function linkedHotel(approval: SyncTarget["approval"] = "approved") {
  const target = { ...hotel, approval };
  const linked = createSupplierLink(emptySyncState(), [target], {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalId: "ext-hotel-1",
    subjectType: "stay_property",
    subjectId: hotel.id,
  });
  assert.equal(linked.ok, true);
  if (!linked.ok) {
    throw new Error("link");
  }
  return { target, state: linked.state, link: linked.link };
}

test("future persistence stays server-side and the registry starts empty", async () => {
  assert.match(FUTURE_PERSISTENCE_AND_SCHEDULE, /separate tables/);
  assert.match(FUTURE_PERSISTENCE_AND_SCHEDULE, /scheduler/);
  assert.match(FUTURE_PERSISTENCE_AND_SCHEDULE, /server environment/);
  assert.match(FUTURE_PERSISTENCE_AND_SCHEDULE, /does not approve/);
  assert.match(SERVER_CREDENTIAL_RULE, /server environment/);

  const registry = createAdapterRegistry();
  assert.equal(registry.adapters.length, 0);
  const { state, link } = linkedHotel();
  const missing = await executeRefresh({
    registry,
    state,
    context: context([hotel]),
    linkId: link.id,
  });
  assert.equal(missing.outcome, "failed");
  assert.equal(missing.errorCode, "adapter_missing");
  assert.equal(missing.state.offers.length, 0);
  assert.equal(missing.state.audits[0]?.kind, "refresh_failed");
});

test("a supplier link matches one approved entity and is created by an admin", () => {
  const draft = createSupplierLink(emptySyncState(), [{ ...hotel, approval: "draft" }], {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalId: "ext-hotel-1",
    subjectType: "stay_property",
    subjectId: hotel.id,
  });
  assert.equal(draft.ok, false);
  if (!draft.ok) {
    assert.equal(draft.errorCode, "approval_boundary");
  }
  assert.equal(draft.state.links.length, 0);

  const { state, link } = linkedHotel();
  assert.equal(link.mappedBy, "admin");
  const again = createSupplierLink(state, [hotel], {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalId: "ext-hotel-1",
    subjectType: "stay_property",
    subjectId: hotel.id,
  });
  assert.equal(again.ok, true);
  assert.equal(again.state.links.length, 1);

  const otherHotel = { ...hotel, id: "sty_other", name: "Other Hotel" };
  const clash = createSupplierLink(state, [hotel, otherHotel], {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalId: "ext-hotel-1",
    subjectType: "stay_property",
    subjectId: otherHotel.id,
  });
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.equal(clash.errorCode, "ambiguous_supplier_identity");
  }
  assert.equal(clash.state.links.length, 1);

  const unmatched = applySupplierPayload(
    state,
    context([hotel]),
    hotelPayload({ supplierOfferId: "offer-1" }),
  );
  const wrongEntity = applySupplierPayload(state, context([hotel]), {
    ...hotelPayload(),
    externalEntityId: "ext-hotel-2",
  });
  assert.equal(unmatched.outcome, "updated");
  assert.equal(wrongEntity.outcome, "unmatched");
  assert.equal(wrongEntity.state.offers.length, 0);
  assert.equal(wrongEntity.state.suggestions[0]?.status, "pending");
  assert.equal(wrongEntity.state.suggestions[0]?.externalId, "ext-hotel-2");
});

test("editorial copy and approval stay outside the supplier payload", () => {
  const { state, target } = linkedHotel();
  const before = structuredClone(target);
  const result = applySupplierPayload(state, context([target]), hotelPayload({
    name: "Supplier Hotel",
    approval: "approved",
    summary: "Supplier copy",
    bookable: true,
    verified: true,
  }));
  const offer = result.state.offers[0];

  assert.equal(result.outcome, "updated");
  assert.deepEqual(target, before);
  assert.equal(offer?.payload.name, undefined);
  assert.equal(offer?.payload.approval, undefined);
  assert.equal(offer?.payload.bookable, undefined);
  assert.ok(offer);
  assert.equal(offer.payload.rateName, "Standard");
  assert.equal(offer.amountMinor, 4300);
  assert.equal(offer.currency, "USD");
  assert.equal(isBookableOffer(offer, now), true);
});

test("an unknown supplier entity stays a pending suggestion", () => {
  const first = applySupplierPayload(emptySyncState(), context([hotel]), hotelPayload());
  const second = applySupplierPayload(first.state, context([hotel]), hotelPayload());

  assert.equal(first.outcome, "unmatched");
  assert.equal(second.state.suggestions.length, 1);
  assert.equal(second.state.suggestions[0]?.status, "pending");
  assert.equal(second.state.offers.length, 0);
  assert.equal(second.state.facts.length, 0);
  assert.equal(second.state.links.length, 0);
  assert.equal(second.state.audits.every((audit) => audit.kind === "unmatched_entity"), true);
});

test("repeating a supplier payload updates one offer", () => {
  const { state } = linkedHotel();
  const first = applySupplierPayload(state, context([hotel]), hotelPayload());
  const second = applySupplierPayload(first.state, context([hotel]), hotelPayload({ amountMinor: 4500 }));
  const ids = second.state.offers.map((offer) => offer.id);

  assert.equal(second.state.offers.length, 1);
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], first.state.offers[0]?.id);
  assert.equal(second.state.offers[0]?.amountMinor, 4500);
  assert.equal(second.state.offers[0]?.supplierOfferId, "offer-1");
  assert.equal(second.state.updates.length, 2);
  assert.equal(second.state.updates[1]?.previousPayload?.amountMinor, 4300);
  assert.equal(second.state.updates[1]?.nextPayload?.amountMinor, 4500);
});

test("failed, stale, and expired offers are not bookable", () => {
  const { state, link } = linkedHotel();
  const saved = applySupplierPayload(state, context([hotel]), hotelPayload());
  const offer = saved.state.offers[0];
  assert.ok(offer);
  assert.equal(isBookableOffer(offer, now), true);

  const failedAt = "2026-10-31T13:00:00.000Z";
  const failed = applyFailedRefresh(saved.state, context([hotel], failedAt), {
    linkId: link.id,
    errorCode: "timeout",
  });
  const kept = failed.state.offers[0];
  assert.ok(kept);
  assert.equal(failed.outcome, "failed");
  assert.equal(kept.lastVerifiedAt, now);
  assert.equal(kept.expiresAt, expiry);
  assert.equal(kept.lastCheckedAt, failedAt);
  assert.equal(kept.freshness, "refresh_failed");
  assert.equal(kept.amountMinor, 4300);
  assert.deepEqual(kept.payload, offer.payload);
  assert.equal(failed.state.updates.at(-1)?.outcome, "failed");
  assert.equal(failed.state.updates.at(-1)?.nextPayload, null);
  assert.equal(isBookableOffer(kept, failedAt), false);

  const later = recomputeFreshness(failed.state, "2026-11-08T12:00:00.000Z", staleAfterMs);
  assert.equal(later.offers[0]?.freshness, "refresh_failed");
  assert.equal(later.offers[0]?.expiresAt, expiry);
  assert.equal(later.offers[0]?.lastVerifiedAt, now);

  const stale = recomputeFreshness(saved.state, "2026-10-31T15:00:00.000Z", staleAfterMs);
  const staleOffer = stale.offers[0];
  assert.ok(staleOffer);
  assert.equal(staleOffer.freshness, "stale");
  assert.equal(staleOffer.lastVerifiedAt, now);
  assert.equal(staleOffer.expiresAt, expiry);
  assert.equal(isBookableOffer(staleOffer, "2026-10-31T15:00:00.000Z"), false);

  const expired = recomputeFreshness(saved.state, "2026-11-08T12:00:00.000Z", staleAfterMs);
  const expiredOffer = expired.offers[0];
  assert.ok(expiredOffer);
  assert.equal(expiredOffer.freshness, "expired");
  assert.equal(expiredOffer.expiresAt, expiry);
  assert.equal(isBookableOffer(expiredOffer, "2026-11-08T12:00:00.000Z"), false);
});

test("invalid currency, occupancy, and dates are rejected", () => {
  const { state } = linkedHotel();
  const currency = applySupplierPayload(state, context([hotel]), hotelPayload({ currency: "US" }));
  const occupancy = applySupplierPayload(state, context([hotel]), hotelPayload({ occupancy: 0 }));
  const dates = applySupplierPayload(
    state,
    context([hotel]),
    hotelPayload({ stayStart: "2026-12-04", stayEnd: "2026-12-01" }),
  );
  const secret = applySupplierPayload(state, context([hotel]), {
    ...hotelPayload(),
    fields: { ...hotelPayload().fields, apiKey: "sk_live_secret" },
  });

  assert.equal(currency.errorCode, "invalid_currency");
  assert.equal(occupancy.errorCode, "invalid_occupancy");
  assert.equal(dates.errorCode, "invalid_dates");
  assert.equal(secret.errorCode, "credential_in_payload");
  assert.equal(currency.state.offers.length, 0);
  assert.equal(JSON.stringify(secret.state).includes("sk_live_secret"), false);
});

test("a draft Thailand property is not updated or approved", () => {
  const catalog = importThailandCatalog();
  const before = structuredClone(catalog);
  const property = catalog.properties.find((item) => item.sourceIds.includes("BK-H001"));
  assert.ok(property);
  assert.equal(property.approval, "draft");

  const target: SyncTarget = {
    id: property.id,
    type: "stay_property",
    approval: property.approval,
    name: property.name,
    summary: "Editorial summary",
  };
  const refused = createSupplierLink(emptySyncState(), [target], {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalId: "ext-hotel-1",
    subjectType: "stay_property",
    subjectId: property.id,
  });
  assert.equal(refused.ok, false);

  const forged = {
    ...emptySyncState(),
    links: [
      {
        id: "sup_forged",
        adapter: "hotel_shopping" as const,
        providerKey: "hotel_shopping_test",
        externalId: "ext-hotel-1",
        domain: "accommodation" as const,
        subjectType: "stay_property" as const,
        subjectId: property.id,
        mappedBy: "admin" as const,
      },
    ],
  };
  const result = applySupplierPayload(forged, context([target]), hotelPayload());
  assert.equal(result.outcome, "rejected");
  assert.equal(result.errorCode, "approval_boundary");
  assert.equal(result.state.offers.length, 0);
  assert.deepEqual(catalog, before);
});

test("flight status and mapping stay facts, and a thrown adapter does not leak secrets", async () => {
  const statusLink = createSupplierLink(emptySyncState(), [route], {
    adapter: "flight_status",
    providerKey: "flight_status_test",
    externalId: "ext-flight-1",
    subjectType: "flight_template",
    subjectId: route.id,
  });
  assert.equal(statusLink.ok, true);
  if (!statusLink.ok) {
    return;
  }
  const status = applySupplierPayload(statusLink.state, context([route]), {
    adapter: "flight_status",
    providerKey: "flight_status_test",
    externalEntityId: "ext-flight-1",
    fields: {
      status: "delayed",
      delayMinutes: 20,
      observedAt: now,
    },
  });
  assert.equal(status.state.facts.length, 1);
  assert.equal(status.state.offers.length, 0);
  const fact = status.state.facts[0];
  assert.ok(fact);
  assert.equal(isBookableFact(fact), false);

  const place: SyncTarget = {
    id: "plc_example",
    type: "place",
    approval: "approved",
    name: "Example place",
    summary: "Editorial place",
  };
  const mapLink = createSupplierLink(emptySyncState(), [place], {
    adapter: "mapping",
    providerKey: "mapping_test",
    externalId: "ext-place-1",
    subjectType: "place",
    subjectId: place.id,
  });
  assert.equal(mapLink.ok, true);
  if (!mapLink.ok) {
    return;
  }
  const coordinates = applySupplierPayload(mapLink.state, context([place]), {
    adapter: "mapping",
    providerKey: "mapping_test",
    externalEntityId: "ext-place-1",
    fields: { latitude: 95, longitude: 10 },
  });
  assert.equal(coordinates.errorCode, "invalid_coordinates");
  assert.equal(coordinates.state.facts.length, 0);

  const throwing: SupplierAdapter = {
    key: "hotel_shopping_test",
    adapter: "hotel_shopping",
    domain: "accommodation",
    permittedFields: permittedFields.hotel_shopping,
    async fetchUpdate() {
      throw new Error("sk_live_secret");
    },
  };
  const { state, link } = linkedHotel();
  const crashed = await executeRefresh({
    registry: registerAdapter(createAdapterRegistry(), throwing),
    state,
    context: context([hotel]),
    linkId: link.id,
  });
  assert.equal(crashed.errorCode, "adapter_error");
  assert.equal(crashed.state.offers.length, 0);
  assert.equal(JSON.stringify(crashed.state).includes("sk_live_secret"), false);
});
