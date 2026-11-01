import { z } from "zod";

import { classifyFreshness } from "./freshness";
import {
  adapterDomain,
  editorialFieldNames,
  ignoredClaimNames,
  isOfferAdapter,
  permittedFields,
  suggestionTypeFor,
  supplierAdapterNames,
  type AuditEvent,
  type AuditKind,
  type CatalogSuggestion,
  type DatedOffer,
  type DynamicUpdate,
  type SupplierAdapterName,
  type SupplierFact,
  type SupplierLink,
  type SupplierPayload,
  type SyncState,
  type SyncTarget,
} from "./types";

const CREDENTIAL_KEY =
  /^(api[_-]?key|token|access[_-]?token|secret|password|authorization|credential)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const FLIGHT_STATUS = new Set(["scheduled", "delayed", "landed", "cancelled", "unknown"]);

const supplierPayloadSchema = z
  .object({
    adapter: z.enum(supplierAdapterNames),
    providerKey: z.string().min(1),
    externalEntityId: z.string().min(1),
    supplierOfferId: z.string().min(1).optional(),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ApplyContext = {
  targets: readonly SyncTarget[];
  now: string;
  staleAfterMs: number;
};

export type ApplyResult = {
  state: SyncState;
  outcome: "updated" | "rejected" | "failed" | "unmatched";
  errorCode: string | null;
};

export type LinkDraft = {
  adapter: SupplierAdapterName;
  providerKey: string;
  externalId: string;
  subjectType: SyncTarget["type"];
  subjectId: string;
};

export type LinkResult =
  | { ok: true; state: SyncState; link: SupplierLink }
  | { ok: false; state: SyncState; errorCode: "approval_boundary" | "ambiguous_supplier_identity" | "target_mismatch" };

type FieldSplit = {
  permitted: Record<string, unknown>;
  forbidden: string[];
};

type OfferBody = {
  payload: Record<string, unknown>;
  supplierOfferId: string;
  amountMinor: number | null;
  currency: string | null;
  occupancy: number | null;
  stayStart: string | null;
  stayEnd: string | null;
  expiresAt: string;
};

type FactBody = {
  payload: Record<string, unknown>;
  observedAt: string | null;
};

export function createSupplierLink(
  state: SyncState,
  targets: readonly SyncTarget[],
  draft: LinkDraft,
): LinkResult {
  const target = targets.find((item) => item.id === draft.subjectId && item.type === draft.subjectType);
  if (!target) {
    return { ok: false, state, errorCode: "target_mismatch" };
  }
  if (target.approval !== "approved") {
    return { ok: false, state, errorCode: "approval_boundary" };
  }

  const sameIdentity = state.links.find(
    (link) => link.providerKey === draft.providerKey && link.externalId === draft.externalId,
  );
  if (sameIdentity) {
    if (
      sameIdentity.subjectId === draft.subjectId &&
      sameIdentity.subjectType === draft.subjectType &&
      sameIdentity.adapter === draft.adapter
    ) {
      return { ok: true, state, link: sameIdentity };
    }
    return { ok: false, state, errorCode: "ambiguous_supplier_identity" };
  }

  const link: SupplierLink = {
    id: `sup_${syncSlug(draft.providerKey)}_${syncSlug(draft.externalId)}`,
    adapter: draft.adapter,
    providerKey: draft.providerKey,
    externalId: draft.externalId,
    domain: adapterDomain[draft.adapter],
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    mappedBy: "admin",
  };
  return { ok: true, state: { ...state, links: [...state.links, link] }, link };
}

export function applySupplierPayload(
  state: SyncState,
  context: ApplyContext,
  input: unknown,
): ApplyResult {
  if (containsCredential(input)) {
    return reject(state, context, {
      providerKey: "unknown",
      externalId: null,
      subjectId: null,
      errorCode: "credential_in_payload",
      message: "Payload included credential material and was rejected.",
    });
  }

  const parsed = supplierPayloadSchema.safeParse(input);
  if (!parsed.success) {
    return reject(state, context, {
      providerKey: "unknown",
      externalId: null,
      subjectId: null,
      errorCode: "invalid_payload",
      message: "Supplier payload did not match the adapter contract.",
    });
  }

  const payload = parsed.data;
  const link = state.links.find(
    (item) =>
      item.providerKey === payload.providerKey &&
      item.externalId === payload.externalEntityId &&
      item.adapter === payload.adapter,
  );
  if (!link) {
    return recordUnmatched(state, context, payload);
  }

  const target = context.targets.find(
    (item) => item.id === link.subjectId && item.type === link.subjectType,
  );
  // Caller-supplied approval stands in until FUTURE_TRUSTED_APPROVAL_READ.
  if (!target || target.approval !== "approved") {
    return reject(state, context, {
      providerKey: payload.providerKey,
      externalId: payload.externalEntityId,
      subjectId: link.subjectId,
      errorCode: "approval_boundary",
      message: "A supplier can update an approved linked entity only.",
    });
  }

  const split = splitFields(payload.adapter, payload.fields);
  if (split.forbidden.length > 0) {
    return reject(state, context, {
      providerKey: payload.providerKey,
      externalId: payload.externalEntityId,
      subjectId: link.subjectId,
      errorCode: "invalid_field",
      message: "Payload included a field outside the permitted set.",
    });
  }

  if (isOfferAdapter(payload.adapter)) {
    const offer = interpretOffer(payload, split.permitted);
    if (!offer.ok) {
      return reject(state, context, {
        providerKey: payload.providerKey,
        externalId: payload.externalEntityId,
        subjectId: link.subjectId,
        errorCode: offer.errorCode,
        message: "Supplier offer failed validation.",
      });
    }
    return upsertOffer(state, context, link, offer.body);
  }

  const fact = interpretFact(payload.adapter, split.permitted);
  if (!fact.ok) {
    return reject(state, context, {
      providerKey: payload.providerKey,
      externalId: payload.externalEntityId,
      subjectId: link.subjectId,
      errorCode: fact.errorCode,
      message: "Supplier fact failed validation.",
    });
  }
  return upsertFact(state, context, link, fact.body);
}

/** Failure scope is the whole supplier link until FUTURE_REFRESH_SCOPE is implemented. */
export function applyFailedRefresh(
  state: SyncState,
  context: ApplyContext,
  input: { linkId: string; errorCode: string },
): ApplyResult {
  const link = state.links.find((item) => item.id === input.linkId);
  if (!link) {
    return reject(state, context, {
      providerKey: "unknown",
      externalId: null,
      subjectId: null,
      errorCode: "unknown_link",
      message: "Refresh targeted a supplier link that does not exist.",
    });
  }

  const target = context.targets.find(
    (item) => item.id === link.subjectId && item.type === link.subjectType,
  );
  // Caller-supplied approval stands in until FUTURE_TRUSTED_APPROVAL_READ.
  if (!target || target.approval !== "approved") {
    return reject(state, context, {
      providerKey: link.providerKey,
      externalId: link.externalId,
      subjectId: link.subjectId,
      errorCode: "approval_boundary",
      message: "A supplier can update an approved linked entity only.",
    });
  }

  const offers = state.offers.map((offer) =>
    offer.linkId === link.id
      ? { ...offer, lastCheckedAt: context.now, freshness: "refresh_failed" as const }
      : offer,
  );
  const facts = state.facts.map((fact) =>
    fact.linkId === link.id
      ? { ...fact, lastCheckedAt: context.now, freshness: "refresh_failed" as const }
      : fact,
  );
  const existing = [
    ...state.offers.filter((offer) => offer.linkId === link.id),
    ...state.facts.filter((fact) => fact.linkId === link.id),
  ];
  const recordId = existing[0]?.id ?? link.id;
  const previousPayload = existing[0]?.payload ?? null;

  return {
    state: appendAttempt(state, context, {
      offers,
      facts,
      recordId,
      providerKey: link.providerKey,
      externalId: link.externalId,
      subjectId: link.subjectId,
      outcome: "failed",
      errorCode: input.errorCode,
      changedFields: [],
      previousPayload,
      nextPayload: null,
      auditKind: "refresh_failed",
      message: "Refresh failed. The previous verification and offer expiry were kept.",
    }),
    outcome: "failed",
    errorCode: input.errorCode,
  };
}

export function recomputeFreshness(state: SyncState, now: string, staleAfterMs: number): SyncState {
  return {
    ...state,
    offers: state.offers.map((offer) => {
      if (offer.freshness === "refresh_failed") {
        return offer;
      }
      const freshness = classifyFreshness({
        now,
        lastVerifiedAt: offer.lastVerifiedAt,
        expiresAt: offer.expiresAt,
        latestAttemptFailed: false,
        staleAfterMs,
      });
      return freshness === offer.freshness ? offer : { ...offer, freshness };
    }),
    facts: state.facts.map((fact) => {
      if (fact.freshness === "refresh_failed") {
        return fact;
      }
      const freshness = classifyFreshness({
        now,
        lastVerifiedAt: fact.lastVerifiedAt,
        expiresAt: null,
        latestAttemptFailed: false,
        staleAfterMs,
      });
      return freshness === fact.freshness ? fact : { ...fact, freshness };
    }),
  };
}

function recordUnmatched(state: SyncState, context: ApplyContext, payload: SupplierPayload): ApplyResult {
  const proposedType = suggestionTypeFor(payload.adapter);
  const dedupeKey = `${payload.providerKey}\n${payload.externalEntityId}\n${proposedType}`;
  const existing = state.suggestions.find((item) => item.dedupeKey === dedupeKey);
  const suggestion: CatalogSuggestion = existing ?? {
    id: `sug_${syncSlug(payload.providerKey)}_${syncSlug(payload.externalEntityId)}`,
    dedupeKey,
    status: "pending",
    proposedType,
    adapter: payload.adapter,
    providerKey: payload.providerKey,
    externalId: payload.externalEntityId,
  };
  const suggestions = existing ? state.suggestions : [...state.suggestions, suggestion];
  const audit = auditEvent(state, context.now, {
    kind: "unmatched_entity",
    providerKey: payload.providerKey,
    externalId: payload.externalEntityId,
    subjectId: null,
    errorCode: "unmatched_entity",
    message: "Supplier entity has no admin link and was stored as a pending suggestion.",
  });
  return {
    state: { ...state, suggestions, audits: [...state.audits, audit] },
    outcome: "unmatched",
    errorCode: "unmatched_entity",
  };
}

function upsertOffer(
  state: SyncState,
  context: ApplyContext,
  link: SupplierLink,
  body: OfferBody,
): ApplyResult {
  const dedupeKey = `${link.providerKey}\n${link.subjectId}\n${body.supplierOfferId}`;
  const existing = state.offers.find((offer) => offer.dedupeKey === dedupeKey);
  const freshness = classifyFreshness({
    now: context.now,
    lastVerifiedAt: context.now,
    expiresAt: body.expiresAt,
    latestAttemptFailed: false,
    staleAfterMs: context.staleAfterMs,
  });
  const offer: DatedOffer = {
    id: existing?.id ?? `off_${syncSlug(link.providerKey)}_${syncSlug(link.subjectId)}_${syncSlug(body.supplierOfferId)}`,
    dedupeKey,
    linkId: link.id,
    adapter: link.adapter,
    subjectType: link.subjectType,
    subjectId: link.subjectId,
    supplierOfferId: body.supplierOfferId,
    amountMinor: body.amountMinor,
    currency: body.currency,
    occupancy: body.occupancy,
    stayStart: body.stayStart,
    stayEnd: body.stayEnd,
    expiresAt: body.expiresAt,
    lastCheckedAt: context.now,
    lastVerifiedAt: context.now,
    freshness,
    payload: body.payload,
    source: {
      providerKey: link.providerKey,
      externalId: body.supplierOfferId,
      retrievedBy: "sync",
    },
  };
  const offers = existing
    ? state.offers.map((item) => (item.dedupeKey === dedupeKey ? offer : item))
    : [...state.offers, offer];
  return {
    state: appendAttempt(
      { ...state, offers },
      context,
      {
        offers,
        facts: state.facts,
        recordId: offer.id,
        providerKey: link.providerKey,
        externalId: body.supplierOfferId,
        subjectId: link.subjectId,
        outcome: "succeeded",
        errorCode: null,
        changedFields: changedKeys(existing?.payload ?? null, body.payload),
        previousPayload: existing?.payload ?? null,
        nextPayload: body.payload,
        auditKind: "update_succeeded",
        message: "Supplier offer updated permitted fields on an approved entity.",
      },
    ),
    outcome: "updated",
    errorCode: null,
  };
}

function upsertFact(
  state: SyncState,
  context: ApplyContext,
  link: SupplierLink,
  body: FactBody,
): ApplyResult {
  const dedupeKey = `${link.providerKey}\n${link.subjectId}\n${link.adapter}`;
  const existing = state.facts.find((fact) => fact.dedupeKey === dedupeKey);
  const freshness = classifyFreshness({
    now: context.now,
    lastVerifiedAt: context.now,
    expiresAt: null,
    latestAttemptFailed: false,
    staleAfterMs: context.staleAfterMs,
  });
  const fact: SupplierFact = {
    id: existing?.id ?? `fact_${syncSlug(link.providerKey)}_${syncSlug(link.subjectId)}_${link.adapter}`,
    dedupeKey,
    linkId: link.id,
    adapter: link.adapter,
    subjectType: link.subjectType,
    subjectId: link.subjectId,
    observedAt: body.observedAt,
    lastCheckedAt: context.now,
    lastVerifiedAt: context.now,
    freshness,
    payload: body.payload,
    source: {
      providerKey: link.providerKey,
      externalId: link.externalId,
      retrievedBy: "sync",
    },
  };
  const facts = existing
    ? state.facts.map((item) => (item.dedupeKey === dedupeKey ? fact : item))
    : [...state.facts, fact];
  return {
    state: appendAttempt(
      { ...state, facts },
      context,
      {
        offers: state.offers,
        facts,
        recordId: fact.id,
        providerKey: link.providerKey,
        externalId: link.externalId,
        subjectId: link.subjectId,
        outcome: "succeeded",
        errorCode: null,
        changedFields: changedKeys(existing?.payload ?? null, body.payload),
        previousPayload: existing?.payload ?? null,
        nextPayload: body.payload,
        auditKind: "update_succeeded",
        message: "Supplier fact updated permitted fields on an approved entity.",
      },
    ),
    outcome: "updated",
    errorCode: null,
  };
}

function appendAttempt(
  state: SyncState,
  context: ApplyContext,
  input: {
    offers: readonly DatedOffer[];
    facts: readonly SupplierFact[];
    recordId: string;
    providerKey: string;
    externalId: string | null;
    subjectId: string | null;
    outcome: "succeeded" | "failed";
    errorCode: string | null;
    changedFields: readonly string[];
    previousPayload: Record<string, unknown> | null;
    nextPayload: Record<string, unknown> | null;
    auditKind: AuditKind;
    message: string;
  },
): SyncState {
  const update: DynamicUpdate = {
    id: `upd_${state.updates.length + 1}`,
    recordId: input.recordId,
    attemptedAt: context.now,
    providerKey: input.providerKey,
    externalId: input.externalId,
    outcome: input.outcome,
    errorCode: input.errorCode,
    changedFields: input.changedFields,
    previousPayload: input.previousPayload,
    nextPayload: input.nextPayload,
  };
  const audit = auditEvent(state, context.now, {
    kind: input.auditKind,
    providerKey: input.providerKey,
    externalId: input.externalId,
    subjectId: input.subjectId,
    errorCode: input.errorCode,
    message: input.message,
  });
  return {
    ...state,
    offers: input.offers,
    facts: input.facts,
    updates: [...state.updates, update],
    audits: [...state.audits, audit],
  };
}

function reject(
  state: SyncState,
  context: ApplyContext,
  input: {
    providerKey: string;
    externalId: string | null;
    subjectId: string | null;
    errorCode: string;
    message: string;
  },
): ApplyResult {
  const audit = auditEvent(state, context.now, {
    kind: "update_rejected",
    providerKey: input.providerKey,
    externalId: input.externalId,
    subjectId: input.subjectId,
    errorCode: input.errorCode,
    message: input.message,
  });
  return {
    state: { ...state, audits: [...state.audits, audit] },
    outcome: "rejected",
    errorCode: input.errorCode,
  };
}

function auditEvent(
  state: SyncState,
  at: string,
  input: Omit<AuditEvent, "id" | "at">,
): AuditEvent {
  return {
    id: `aud_${state.audits.length + 1}`,
    at,
    ...input,
  };
}

function splitFields(adapter: SupplierAdapterName, fields: Record<string, unknown>): FieldSplit {
  const allowed = new Set<string>(permittedFields[adapter]);
  const ignored = new Set<string>([...editorialFieldNames, ...ignoredClaimNames]);
  const permitted: Record<string, unknown> = {};
  const forbidden: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (ignored.has(key)) {
      continue;
    }
    if (!allowed.has(key)) {
      forbidden.push(key);
      continue;
    }
    permitted[key] = value;
  }
  return { permitted, forbidden };
}

function interpretOffer(
  payload: SupplierPayload,
  fields: Record<string, unknown>,
): { ok: true; body: OfferBody } | { ok: false; errorCode: string } {
  const supplierOfferId = payload.supplierOfferId ?? readString(fields.supplierOfferId);
  if (supplierOfferId === null) {
    return { ok: false, errorCode: "missing_offer_id" };
  }

  const amountMinor = readInteger(fields.amountMinor, 0);
  if (amountMinor === "invalid") {
    return { ok: false, errorCode: "invalid_amount" };
  }
  const currency = readCurrency(fields.currency);
  if (currency === "invalid") {
    return { ok: false, errorCode: "invalid_currency" };
  }
  if ((amountMinor === null) !== (currency === null)) {
    return { ok: false, errorCode: "invalid_currency" };
  }

  const occupancy = readInteger(fields.occupancy, 1);
  if (occupancy === "invalid") {
    return { ok: false, errorCode: "invalid_occupancy" };
  }
  const stayStart = readDate(fields.stayStart);
  const stayEnd = readDate(fields.stayEnd);
  if (stayStart === "invalid" || stayEnd === "invalid") {
    return { ok: false, errorCode: "invalid_dates" };
  }
  if ((stayStart === null) !== (stayEnd === null)) {
    return { ok: false, errorCode: "invalid_dates" };
  }
  if (stayStart !== null && stayEnd !== null && stayEnd < stayStart) {
    return { ok: false, errorCode: "invalid_dates" };
  }

  const expiresAt = readDateTime(fields.expiresAt);
  if (expiresAt === "invalid" || expiresAt === null) {
    return { ok: false, errorCode: "invalid_expiry" };
  }

  const availability = readAvailability(fields.availability);
  if (availability === "invalid") {
    return { ok: false, errorCode: "invalid_availability" };
  }
  const seats = readInteger(fields.seats, 0);
  if (seats === "invalid") {
    return { ok: false, errorCode: "invalid_seats" };
  }
  const roomCount = readInteger(fields.roomCount, 0);
  if (roomCount === "invalid") {
    return { ok: false, errorCode: "invalid_room_count" };
  }
  const segments = readSegments(fields.segments);
  if (segments === "invalid") {
    return { ok: false, errorCode: "invalid_segments" };
  }
  const fareBasis = readOptionalString(fields.fareBasis);
  const rateName = readOptionalString(fields.rateName);
  const cancellationSummary = readOptionalString(fields.cancellationSummary);
  const schedule = readOptionalString(fields.schedule);
  if (
    fareBasis === "invalid" ||
    rateName === "invalid" ||
    cancellationSummary === "invalid" ||
    schedule === "invalid"
  ) {
    return { ok: false, errorCode: "invalid_field" };
  }

  const stored: Record<string, unknown> = { supplierOfferId, expiresAt };
  if (amountMinor !== null) {
    stored.amountMinor = amountMinor;
  }
  if (currency !== null) {
    stored.currency = currency;
  }
  if (occupancy !== null) {
    stored.occupancy = occupancy;
  }
  if (stayStart !== null) {
    stored.stayStart = stayStart;
  }
  if (stayEnd !== null) {
    stored.stayEnd = stayEnd;
  }
  if (availability !== null) {
    stored.availability = availability;
  }
  if (seats !== null) {
    stored.seats = seats;
  }
  if (roomCount !== null) {
    stored.roomCount = roomCount;
  }
  if (segments !== null) {
    stored.segments = segments;
  }
  if (fareBasis !== null) {
    stored.fareBasis = fareBasis;
  }
  if (rateName !== null) {
    stored.rateName = rateName;
  }
  if (cancellationSummary !== null) {
    stored.cancellationSummary = cancellationSummary;
  }
  if (schedule !== null) {
    stored.schedule = schedule;
  }

  return {
    ok: true,
    body: {
      payload: stored,
      supplierOfferId,
      amountMinor,
      currency,
      occupancy,
      stayStart,
      stayEnd,
      expiresAt,
    },
  };
}

function interpretFact(
  adapter: SupplierAdapterName,
  fields: Record<string, unknown>,
): { ok: true; body: FactBody } | { ok: false; errorCode: string } {
  const observedAt = readDateTime(fields.observedAt);
  if (observedAt === "invalid") {
    return { ok: false, errorCode: "invalid_dates" };
  }

  if (adapter === "flight_status") {
    const status = fields.status;
    if (typeof status !== "string" || !FLIGHT_STATUS.has(status)) {
      return { ok: false, errorCode: "invalid_field" };
    }
    const delayMinutes = readInteger(fields.delayMinutes, 0);
    if (delayMinutes === "invalid") {
      return { ok: false, errorCode: "invalid_field" };
    }
    const payload: Record<string, unknown> = { status };
    if (delayMinutes !== null) {
      payload.delayMinutes = delayMinutes;
    }
    if (observedAt !== null) {
      payload.observedAt = observedAt;
    }
    return { ok: true, body: { payload, observedAt } };
  }

  const latitude = readCoordinate(fields.latitude, -90, 90);
  const longitude = readCoordinate(fields.longitude, -180, 180);
  if (latitude === "invalid" || longitude === "invalid") {
    return { ok: false, errorCode: "invalid_coordinates" };
  }
  if (latitude === null || longitude === null) {
    return { ok: false, errorCode: "invalid_coordinates" };
  }
  const payload: Record<string, unknown> = { latitude, longitude };
  if (observedAt !== null) {
    payload.observedAt = observedAt;
  }
  return { ok: true, body: { payload, observedAt } };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalString(value: unknown): string | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  return readString(value) ?? "invalid";
}

function readInteger(value: unknown, minimum: number): number | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    return "invalid";
  }
  return value;
}

function readCurrency(value: unknown): string | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !CURRENCY.test(value)) {
    return "invalid";
  }
  return value;
}

function readDate(value: unknown): string | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return "invalid";
  }
  return value;
}

function readDateTime(value: unknown): string | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    return "invalid";
  }
  return value;
}

function readAvailability(value: unknown): boolean | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "available") {
    return true;
  }
  if (value === "unavailable") {
    return false;
  }
  return "invalid";
}

function readSegments(value: unknown): { origin: string; destination: string }[] | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return "invalid";
  }
  const segments: { origin: string; destination: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return "invalid";
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "origin" && key !== "destination")) {
      return "invalid";
    }
    const origin = readString(record.origin);
    const destination = readString(record.destination);
    if (origin === null || destination === null) {
      return "invalid";
    }
    segments.push({ origin, destination });
  }
  return segments;
}

function readCoordinate(value: unknown, minimum: number, maximum: number): number | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < minimum || value > maximum) {
    return "invalid";
  }
  return value;
}

function changedKeys(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  return [...keys].filter(
    (key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next[key]),
  );
}

function containsCredential(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      return true;
    }
    if (containsCredential(child)) {
      return true;
    }
  }
  return false;
}

function syncSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug.slice(0, 80) : "value";
}
