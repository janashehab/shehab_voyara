import assert from "node:assert/strict";
import test from "node:test";

import { importThailandCatalog } from "@/lib/catalog/imports/thailand/index";
import { checkThailandImport, isLiveQuote } from "@/lib/catalog/travel/index";
import type { ApprovalState, TravelCatalog } from "@/lib/catalog/travel/schema";
import { FUTURE_REFRESH_SCOPE, FUTURE_TRUSTED_APPROVAL_READ } from "@/server/sync/index";

import {
  APPROVAL_ACTOR_RULE,
  FUTURE_APPROVAL_STORAGE,
  HIERARCHY_APPROVAL_RULE,
  PHASE_1_PRICING_MODEL,
  ROUTE_TEMPLATE_RULE,
  attestIdentity,
  emptyApprovalLedger,
  findingClass,
  listApprovedRecords,
  overrideQualityReview,
  resolveFinding,
  transitionApproval,
} from "./index";
import type { ApprovalLedger, ApprovalSubjectType, TrustedAdminActor } from "./index";

const at = "2026-10-31T12:00:00.000Z";
const admin = {
  role: "admin",
  actorId: "admin_editor",
  serverAuthenticated: true,
} satisfies TrustedAdminActor;

const imported = importThailandCatalog();

test("approval storage and the two sync integrations stay specified", () => {
  assert.match(FUTURE_APPROVAL_STORAGE, /approval audit table/);
  assert.match(FUTURE_APPROVAL_STORAGE, /identity attestations/);
  assert.match(FUTURE_APPROVAL_STORAGE, /Do not store approval inside supplier payloads/);
  assert.match(APPROVAL_ACTOR_RULE, /server/);
  assert.match(FUTURE_REFRESH_SCOPE, /individual offer/);
  assert.match(FUTURE_TRUSTED_APPROVAL_READ, /trusted server-side catalog storage/);
  assert.match(APPROVAL_ACTOR_RULE, /No approval endpoint is exposed until authentication and authorization exist/);
  assert.match(ROUTE_TEMPLATE_RULE, /not a dated flight offer/);
  assert.match(ROUTE_TEMPLATE_RULE, /Krabi Airport/);
  assert.match(HIERARCHY_APPROVAL_RULE, /does not approve its parent or its children/);
  assert.match(PHASE_1_PRICING_MODEL, /internal reference data/);
  assert.match(PHASE_1_PRICING_MODEL, /indicative estimate/);
  assert.match(PHASE_1_PRICING_MODEL, /final quotations and bookings manually/);
  assert.match(PHASE_1_PRICING_MODEL, /PriceObservation stays separate from a verified supplier offer/);
  assert.match(PHASE_1_PRICING_MODEL, /does not scrape/);
  assert.equal(checkThailandImport(imported).length, 0);
  assert.equal(listApprovedRecords(imported).properties.length, 0);
  assert.equal(listApprovedRecords(imported).flightTemplates.length, 0);
});

test("invalid transitions record an audit and leave the catalog in place", () => {
  const property = requireProperty((item) => item.stayBaseId !== null && item.approval === "draft");
  const ledger = emptyApprovalLedger();
  const skipped = transitionApproval(imported, ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "approved",
    reason: "Skip review.",
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.errorCode, "invalid_transition");
  assert.equal(skipped.catalog, imported);
  const audit = skipped.ledger.audits[0];
  assert.ok(audit);
  assert.equal(audit.kind, "approval_rejected");
  assert.equal(audit.actorId, admin.actorId);
  assert.equal(audit.at, at);
  assert.equal(audit.subjectType, "stay_property");
  assert.equal(audit.subjectId, property.id);
  assert.equal(audit.from, "draft");
  assert.equal(audit.to, "approved");
  assert.equal(audit.reason, "Skip review.");
  assert.equal(propertyOf(skipped.catalog, property.id).approval, "draft");

  const reviewed = mustTransition(imported, ledger, property.id, "stay_property", "in_review", "Send to review.");
  const attested = mustAttest(reviewed.catalog, reviewed.ledger, property.id, "stay_property", "Source ids match the listing.");
  const hierarchy = approveHierarchy(attested.catalog, attested.ledger, property);
  const approved = mustTransition(
    hierarchy.catalog,
    hierarchy.ledger,
    property.id,
    "stay_property",
    "approved",
    "Identity and stay base are enough.",
  );
  const backToDraft = transitionApproval(approved.catalog, approved.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "draft",
    reason: "Approved records return through review.",
  });
  assert.equal(backToDraft.errorCode, "invalid_transition");
  assert.equal(propertyOf(backToDraft.catalog, property.id).approval, "approved");

  const archived = mustTransition(
    approved.catalog,
    approved.ledger,
    property.id,
    "stay_property",
    "archived",
    "Retire this listing.",
  );
  const restoreApproved = transitionApproval(archived.catalog, archived.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "approved",
    reason: "Archived records are not approved directly.",
  });
  assert.equal(restoreApproved.errorCode, "invalid_transition");
  assert.equal(propertyOf(restoreApproved.catalog, property.id).approval, "archived");

  const same = transitionApproval(imported, ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "draft",
    reason: "No change.",
  });
  assert.equal(same.errorCode, "invalid_transition");
  assert.equal(same.catalog, imported);

  const missingClock = transitionApproval(imported, ledger, admin, "yesterday", {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "in_review",
    reason: "Bad clock.",
  });
  assert.equal(missingClock.errorCode, "invalid_command");
  assert.equal(missingClock.ledger, ledger);
  assert.equal(missingClock.catalog, imported);
});

test("public callers and supplier payloads cannot change approval", () => {
  const property = requireProperty((item) => item.approval === "draft");
  const ledger = emptyApprovalLedger();
  const command = {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "in_review",
    reason: "Public edit.",
  };
  const publicAttempt = transitionApproval(imported, ledger, { role: "public" }, at, command);
  assert.equal(publicAttempt.ok, false);
  assert.equal(publicAttempt.errorCode, "unauthorized");
  assert.equal(publicAttempt.catalog, imported);
  assert.equal(publicAttempt.ledger.audits[0]?.actorRole, "public");
  assert.equal(publicAttempt.ledger.audits[0]?.actorId, "public");
  assert.equal(publicAttempt.ledger.audits[0]?.at, at);
  assert.equal(publicAttempt.ledger.audits[0]?.reason, "Approval changes require a trusted server admin actor.");

  const unsigned = transitionApproval(
    imported,
    ledger,
    { role: "admin", actorId: "admin_editor", serverAuthenticated: false },
    at,
    command,
  );
  assert.equal(unsigned.errorCode, "unauthorized");
  assert.equal(unsigned.catalog, imported);
  assert.equal(unsigned.ledger.audits[0]?.actorId, "admin_editor");
  assert.equal(propertyOf(unsigned.catalog, property.id).approval, property.approval);

  const supplier = transitionApproval(imported, ledger, admin, at, {
    adapter: "hotel_shopping",
    providerKey: "hotel_shopping_test",
    externalEntityId: "ext-hotel-1",
    fields: { approval: "approved", apiKey: "sk_live_secret" },
  });
  assert.equal(supplier.errorCode, "supplier_payload");
  assert.equal(supplier.catalog, imported);
  assert.equal(supplier.ledger.audits[0]?.actorRole, "supplier");
  assert.equal(supplier.ledger.audits[0]?.subjectId, "unknown");
  assert.equal(JSON.stringify(supplier.ledger).includes("sk_live_secret"), false);
  assert.equal(propertyOf(imported, property.id).approval, property.approval);
});

test("approved retrieval keeps draft, in-review, and archived records out", () => {
  const property = requireProperty((item) => item.stayBaseId !== null && item.approval === "draft");
  const flight = requireFlight(
    (item) => item.approval === "draft" && !item.carrierUnresolved && item.carriers.length === 1,
  );
  const reviewed = mustTransition(imported, emptyApprovalLedger(), property.id, "stay_property", "in_review", "Review one property.");
  const waiting = listApprovedRecords(reviewed.catalog);
  assert.equal(waiting.properties.some((item) => item.record.id === property.id), false);
  assert.equal(waiting.flightTemplates.length, 0);

  const attested = mustAttest(reviewed.catalog, reviewed.ledger, property.id, "stay_property", "Listing identity checked.");
  const hierarchy = approveHierarchy(attested.catalog, attested.ledger, property);
  const approved = mustTransition(
    hierarchy.catalog,
    hierarchy.ledger,
    property.id,
    "stay_property",
    "approved",
    "Publish this property only.",
  );
  const flightReviewed = mustTransition(
    approved.catalog,
    approved.ledger,
    flight.id,
    "flight_template",
    "in_review",
    "Review one route.",
  );
  const flightAttested = mustAttest(
    flightReviewed.catalog,
    flightReviewed.ledger,
    flight.id,
    "flight_template",
    "Carrier is a single airline.",
  );
  const both = mustTransition(
    flightAttested.catalog,
    flightAttested.ledger,
    flight.id,
    "flight_template",
    "approved",
    "Publish this route only.",
  );

  const visible = listApprovedRecords(both.catalog);
  assert.deepEqual(visible.properties.map((item) => item.record.id), [property.id]);
  assert.deepEqual(visible.flightTemplates.map((item) => item.record.id), [flight.id]);
  assert.equal(visible.flightTemplates[0]?.presentation, "route_template");
  assert.equal(visible.flightTemplates[0]?.confirmedFlight, false);
  assert.equal(visible.flightTemplates[0]?.liveFare, false);
  assert.equal(both.catalog.stayBases.filter((item) => item.approval === "approved").length, 1);
  assert.equal(both.catalog.properties.filter((item) => item.approval === "approved").length, 1);
  assert.equal(both.catalog.flightTemplates.filter((item) => item.approval === "approved").length, 1);
  assert.equal(imported.properties.every((item) => item.approval !== "approved"), true);

  assert.ok(property.stayBaseId);
  const archived = mustTransition(
    both.catalog,
    both.ledger,
    property.stayBaseId,
    "stay_base",
    "archived",
    "The destination leaves public retrieval.",
  );
  const afterArchive = listApprovedRecords(archived.catalog);
  assert.equal(afterArchive.properties.some((item) => item.record.id === property.id), false);
  assert.equal(afterArchive.flightTemplates.map((item) => item.record.id).join(","), flight.id);
  assert.equal(propertyOf(archived.catalog, property.id).approval, "approved");
  assert.equal(archived.catalog.properties.filter((item) => item.approval === "approved").length, 1);
});

test("approving a property leaves historical rates and editorial notes unchanged", () => {
  const property = requireProperty((item) => {
    const rates = imported.rates.filter((rate) => rate.propertyId === item.id);
    const amounts = amountsForRates(imported, rates.map((rate) => rate.id));
    return (
      item.stayBaseId !== null &&
      !item.qualityReview &&
      amounts.length > 0 &&
      amounts.every((amount) => amount.amountMinor === null)
    );
  });
  const reviewed = reviewProperty(imported, emptyApprovalLedger(), property.id);
  const approved = mustTransition(
    reviewed.catalog,
    reviewed.ledger,
    property.id,
    "stay_property",
    "approved",
    "No live price is required.",
  );

  assert.equal(propertyOf(approved.catalog, property.id).approval, "approved");
  assert.equal(approved.catalog.rates, imported.rates);
  assert.equal(approved.catalog.amounts, imported.amounts);
  assert.equal(approved.catalog.recommendations, imported.recommendations);
  assert.equal(approved.catalog.referenceProfiles, imported.referenceProfiles);
  assert.equal(approved.catalog.findings, imported.findings);
  assert.equal(approved.catalog.stayBases.find((item) => item.id === property.stayBaseId)?.approval, "approved");
  assert.equal(approved.catalog.stayBases.filter((item) => item.approval === "approved").length, 1);
  assert.equal(imported.countries.every((item) => item.approval === "draft"), true);
  const rates = approved.catalog.rates.filter((rate) => rate.propertyId === property.id);
  assert.ok(rates.length > 0);
  for (const rate of rates) {
    assert.notEqual(rate.approval, "approved");
  }
  for (const amount of amountsForRates(approved.catalog, rates.map((rate) => rate.id))) {
    assert.equal(amount.presentation, "historical_reference");
    assert.equal(amount.liveQuote, false);
    assert.equal(amount.freshness, "unverified");
    assert.equal(amount.lastVerifiedAt, null);
    assert.equal(amount.approval === "approved", false);
    assert.equal(isLiveQuote(amount), false);
  }
  const profiles = approved.catalog.referenceProfiles.filter((profile) => profile.propertyId === property.id);
  assert.ok(profiles.length > 0);
  assert.equal(profiles.every((profile) => profile.verified === false), true);
});

test("hierarchy approval is explicit and public retrieval follows it", () => {
  const region = imported.regions[0];
  assert.ok(region);
  const reviewed = mustTransition(imported, emptyApprovalLedger(), region.id, "region", "in_review", "Review the region.");
  const blocked = transitionApproval(reviewed.catalog, reviewed.ledger, admin, at, {
    subjectType: "region",
    subjectId: region.id,
    to: "approved",
    reason: "The country is still draft.",
  });
  assert.equal(blocked.errorCode, "hierarchy_not_approved");
  assert.equal(blocked.catalog.countries.every((item) => item.approval === "draft"), true);
  assert.equal(blocked.catalog.regions.find((item) => item.id === region.id)?.approval, "in_review");
  assert.equal(blocked.catalog.properties.every((item) => item.approval !== "approved"), true);
});

test("route templates keep unresolved carriers and are not live fares", () => {
  const multiple = requireFlight((item) => item.carrierUnresolved && item.carriers.length > 1);
  const missing = requireFlight((item) => item.carriers.length === 0);
  const krabi = requireFlight((item) =>
    item.legs.some((leg) => leg.origin === "Krabi" || leg.destination === "Krabi"),
  );
  for (const flight of [multiple, missing, krabi]) {
    const approved = approveFlight(imported, emptyApprovalLedger(), flight.id);
    assert.equal(flightOf(approved.catalog, flight.id).approval, "approved");
    assert.equal(flightOf(approved.catalog, flight.id).carrierUnresolved, flight.carrierUnresolved);
    assert.deepEqual(flightOf(approved.catalog, flight.id).carriers, flight.carriers);
    const amount = approved.catalog.amounts.find((item) => item.subject.type === "flight_template" && item.subject.id === flight.id);
    assert.ok(amount);
    assert.equal(amount.presentation, "historical_reference");
    assert.equal(amount.liveQuote, false);
    assert.equal(isLiveQuote(amount), false);
    const visible = listApprovedRecords(approved.catalog).flightTemplates.find((item) => item.record.id === flight.id);
    assert.ok(visible);
    assert.equal(visible.presentation, "route_template");
    assert.equal(visible.confirmedFlight, false);
    assert.equal(visible.liveFare, false);
  }
  const repeat = approveFlight(imported, emptyApprovalLedger(), krabi.id);
  const again = mustAttest(repeat.catalog, repeat.ledger, krabi.id, "flight_template", "Route cities are enough.");
  assert.equal(again.ledger.attestations.length, repeat.ledger.attestations.length);
});

test("quality findings block until resolved or overridden, and identity cannot be overridden", () => {
  const flagged = requireProperty((item) => item.qualityReview && item.stayBaseId !== null);
  const listing = requireProperty((item) =>
    item.stayBaseId !== null &&
    imported.findings.some(
      (finding) => finding.field === "listing" && finding.sourceId !== null && item.sourceIds.includes(finding.sourceId),
    ),
  );
  const unplaced = requireProperty((item) => item.stayBaseId === null);
  assert.equal(findingClass({ kind: "missing", sourceId: null, field: "breakfast", message: "Breakfast inclusion was not stated." }), "missing_detail");
  assert.equal(findingClass({ kind: "ambiguous", sourceId: "KR-H005", field: "listing", message: "Verify the listing." }), "blocking_identity");
  assert.equal(findingClass({ kind: "missing", sourceId: "KR-H001", field: "stay_base", message: "Stay base is missing." }), "blocking_geography");

  const flaggedReady = reviewProperty(imported, emptyApprovalLedger(), flagged.id);
  const flaggedBlocked = transitionApproval(flaggedReady.catalog, flaggedReady.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: flagged.id,
    to: "approved",
    reason: "Quality is still open.",
  });
  assert.equal(flaggedBlocked.errorCode, "quality_blocked");
  const overridden = overrideQualityReview(flaggedBlocked.catalog, flaggedBlocked.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: flagged.id,
    reason: "Reviewed the quality note and accepted the property.",
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.catalog, flaggedBlocked.catalog);
  assert.equal(propertyOf(overridden.catalog, flagged.id).qualityReview, true);
  assert.equal(overridden.ledger.audits.some((item) => item.kind === "quality_overridden"), true);
  assert.equal(overridden.catalog.findings, imported.findings);
  const flaggedApproved = mustTransition(
    overridden.catalog,
    overridden.ledger,
    flagged.id,
    "stay_property",
    "approved",
    "Quality override is documented.",
  );
  assert.equal(propertyOf(flaggedApproved.catalog, flagged.id).approval, "approved");
  assert.equal(propertyOf(flaggedApproved.catalog, flagged.id).qualityReview, true);

  const listingOverride = overrideQualityReview(imported, emptyApprovalLedger(), admin, at, {
    subjectType: "stay_property",
    subjectId: listing.id,
    reason: "Try to skip the listing check.",
  });
  assert.equal(listingOverride.errorCode, "override_not_allowed");
  assert.match(listingOverride.ledger.audits[0]?.reason ?? "", /unresolved identity/);
  const listingIndex = imported.findings.findIndex(
    (finding) => finding.field === "listing" && finding.sourceId !== null && listing.sourceIds.includes(finding.sourceId),
  );
  assert.ok(listingIndex >= 0);
  const listingResolved = resolveFinding(imported, emptyApprovalLedger(), admin, at, {
    findingIndex: listingIndex,
    reason: "The listing matches the source row.",
  });
  assert.equal(listingResolved.ok, true);
  assert.equal(listingResolved.catalog, imported);
  assert.deepEqual(listingResolved.catalog.findings, imported.findings);
  assert.equal(listingResolved.ledger.audits.some((item) => item.kind === "finding_resolved"), true);
  const listingReady = reviewProperty(listingResolved.catalog, listingResolved.ledger, listing.id);
  const listingOverridden = propertyOf(listingReady.catalog, listing.id).qualityReview
    ? overrideQualityReview(listingReady.catalog, listingReady.ledger, admin, at, {
        subjectType: "stay_property",
        subjectId: listing.id,
        reason: "Quality note reviewed after the listing was resolved.",
      })
    : listingReady;
  assert.equal(listingOverridden.ok, true);
  const listingApproved = mustTransition(
    listingOverridden.catalog,
    listingOverridden.ledger,
    listing.id,
    "stay_property",
    "approved",
    "The listing finding is resolved and the hierarchy is approved.",
  );
  assert.equal(propertyOf(listingApproved.catalog, listing.id).approval, "approved");

  const stayBaseIndex = imported.findings.findIndex(
    (finding) =>
      finding.field === "stay_base" &&
      finding.sourceId !== null &&
      unplaced.sourceIds.includes(finding.sourceId),
  );
  assert.ok(stayBaseIndex >= 0);
  const stayBaseResolved = resolveFinding(imported, emptyApprovalLedger(), admin, at, {
    findingIndex: stayBaseIndex,
    reason: "There is still no Ao Nang or Koh Lanta assignment.",
  });
  assert.equal(stayBaseResolved.errorCode, "insufficient_geography");
  assert.equal(stayBaseResolved.catalog.findings, imported.findings);
  assert.equal(stayBaseResolved.ledger.resolutions.length, 0);
});

test("an identity attestation is invalidated when identity-critical fields change", () => {
  const property = requireProperty(
    (item) => item.stayBaseId !== null && !item.qualityReview && item.approval === "draft",
  );
  const ready = reviewProperty(imported, emptyApprovalLedger(), property.id);
  const renamed = structuredClone(ready.catalog);
  const renamedProperty = renamed.properties.find((item) => item.id === property.id);
  assert.ok(renamedProperty);
  renamedProperty.name = `${renamedProperty.name} renamed`;
  const blocked = transitionApproval(renamed, ready.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "approved",
    reason: "The name changed after attestation.",
  });
  assert.equal(blocked.errorCode, "unverified_identity");
  assert.equal(blocked.ledger.audits.some((item) => item.kind === "identity_invalidated"), true);
  assert.notEqual(propertyOf(blocked.catalog, property.id).approval, "approved");
  const reattested = mustAttest(
    blocked.catalog,
    blocked.ledger,
    property.id,
    "stay_property",
    "The renamed listing was checked again.",
  );
  const approved = mustTransition(
    reattested.catalog,
    reattested.ledger,
    property.id,
    "stay_property",
    "approved",
    "The new attestation matches the renamed property.",
  );
  assert.equal(propertyOf(approved.catalog, property.id).approval, "approved");

  const moved = structuredClone(ready.catalog);
  const movedProperty = moved.properties.find((item) => item.id === property.id);
  assert.ok(movedProperty);
  movedProperty.stayBaseId = movedProperty.stayBaseId === "dst_bangkok" ? "dst_phuket" : "dst_bangkok";
  const movedBlock = transitionApproval(moved, ready.ledger, admin, at, {
    subjectType: "stay_property",
    subjectId: property.id,
    to: "approved",
    reason: "The stay base changed after attestation.",
  });
  assert.equal(movedBlock.errorCode, "unverified_identity");
  assert.equal(movedBlock.ledger.attestations.some((item) => item.status === "invalidated"), true);
});

function requireProperty(predicate: (property: TravelCatalog["properties"][number]) => boolean) {
  const property = imported.properties.find(predicate);
  assert.ok(property);
  return property;
}

function requireFlight(predicate: (flight: TravelCatalog["flightTemplates"][number]) => boolean) {
  const flight = imported.flightTemplates.find(predicate);
  assert.ok(flight);
  return flight;
}

function propertyOf(catalog: TravelCatalog, id: string) {
  const property = catalog.properties.find((item) => item.id === id);
  assert.ok(property);
  return property;
}

function flightOf(catalog: TravelCatalog, id: string) {
  const flight = catalog.flightTemplates.find((item) => item.id === id);
  assert.ok(flight);
  return flight;
}

function amountsForRates(catalog: TravelCatalog, rateIds: readonly string[]) {
  return catalog.amounts.filter(
    (amount) => amount.subject.type === "stay_rate" && rateIds.includes(amount.subject.id),
  );
}

function mustTransition(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectId: string,
  subjectType: ApprovalSubjectType,
  to: ApprovalState,
  reason: string,
) {
  const result = transitionApproval(catalog, ledger, admin, at, { subjectType, subjectId, to, reason });
  assert.equal(result.ok, true, result.errorCode ?? "transition failed");
  return result;
}

function mustAttest(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectId: string,
  subjectType: "stay_property" | "flight_template",
  reason: string,
) {
  const result = attestIdentity(catalog, ledger, admin, at, { subjectType, subjectId, reason });
  assert.equal(result.ok, true, result.errorCode ?? "attestation failed");
  return result;
}

function moveToReview(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectId: string,
  subjectType: ApprovalSubjectType,
) {
  if (readApproval(catalog, subjectType, subjectId) === "in_review") {
    return { catalog, ledger };
  }
  return mustTransition(catalog, ledger, subjectId, subjectType, "in_review", "Move into review.");
}

function reviewProperty(catalog: TravelCatalog, ledger: ApprovalLedger, propertyId: string) {
  const property = propertyOf(catalog, propertyId);
  const hierarchy = approveHierarchy(catalog, ledger, property);
  const reviewed = moveToReview(hierarchy.catalog, hierarchy.ledger, propertyId, "stay_property");
  return mustAttest(reviewed.catalog, reviewed.ledger, propertyId, "stay_property", "Identity checked.");
}

function approveHierarchy(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  property: TravelCatalog["properties"][number],
) {
  assert.ok(property.stayBaseId);
  const country = approveRecord(catalog, ledger, "country", property.countryId);
  const region = approveRecord(country.catalog, country.ledger, "region", property.regionId);
  return approveRecord(region.catalog, region.ledger, "stay_base", property.stayBaseId);
}

function approveRecord(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  subjectType: ApprovalSubjectType,
  subjectId: string,
) {
  let state = { catalog, ledger };
  let approval = readApproval(state.catalog, subjectType, subjectId);
  if (approval === "draft") {
    state = mustTransition(
      state.catalog,
      state.ledger,
      subjectId,
      subjectType,
      "in_review",
      "Review this hierarchy record.",
    );
    approval = "in_review";
  }
  if (approval === "in_review") {
    state = mustTransition(
      state.catalog,
      state.ledger,
      subjectId,
      subjectType,
      "approved",
      "Publish this hierarchy record.",
    );
  }
  return state;
}

function approveFlight(catalog: TravelCatalog, ledger: ApprovalLedger, flightId: string) {
  const reviewed = moveToReview(catalog, ledger, flightId, "flight_template");
  const attested = mustAttest(reviewed.catalog, reviewed.ledger, flightId, "flight_template", "Route cities are enough.");
  return mustTransition(
    attested.catalog,
    attested.ledger,
    flightId,
    "flight_template",
    "approved",
    "Publish the route template.",
  );
}

function readApproval(catalog: TravelCatalog, subjectType: ApprovalSubjectType, subjectId: string): ApprovalState {
  if (subjectType === "stay_property") {
    return propertyOf(catalog, subjectId).approval;
  }
  if (subjectType === "flight_template") {
    return flightOf(catalog, subjectId).approval;
  }
  if (subjectType === "country") {
    const country = catalog.countries.find((item) => item.id === subjectId);
    assert.ok(country);
    return country.approval;
  }
  if (subjectType === "region") {
    const region = catalog.regions.find((item) => item.id === subjectId);
    assert.ok(region);
    return region.approval;
  }
  const stayBase = catalog.stayBases.find((item) => item.id === subjectId);
  assert.ok(stayBase);
  return stayBase.approval;
}
