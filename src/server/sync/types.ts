/**
 * Provider credentials stay in server environment variables. A future adapter
 * reads them inside the server process. Payloads, audits, suggestions, offers,
 * and client state never carry key, token, secret, or password values.
 */
export const SERVER_CREDENTIAL_RULE =
  "Provider credentials stay in server environment variables. Payloads, audits, suggestions, offers, and client state never carry key, token, secret, or password values.";

/**
 * The in-memory policy is the contract for a later database and scheduler.
 * Editorial columns stay on the catalog tables. Supplier links, dated offers,
 * supplier facts, dynamic updates, pending suggestions, and audit events get
 * their own tables. A scheduler may refresh only an approved entity that
 * already has an admin-created supplier link. It reads credentials on the
 * server, and it does not approve suggestions or imported drafts.
 */
export const FUTURE_PERSISTENCE_AND_SCHEDULE =
  "Persist supplier links, dated offers, supplier facts, dynamic updates, pending suggestions, and audit events in separate tables from editorial catalog columns. A later scheduler refreshes only approved entities that already have an admin-created supplier link, reads provider credentials from server environment variables, and does not approve suggestions or imported drafts.";

/**
 * Not implemented. applyFailedRefresh still marks every offer and fact on the
 * supplier link. A later change must record the supplier request or offer id
 * and update only that row.
 */
export const FUTURE_REFRESH_SCOPE =
  "A failed supplier refresh must update only the supplier request or the individual offer that failed. It must not mark every offer on the supplier link as refresh_failed.";

/**
 * Not implemented. The policy still reads SyncTarget.approval from the caller.
 * A later change must load that state from trusted server-side catalog storage.
 */
export const FUTURE_TRUSTED_APPROVAL_READ =
  "Supplier sync must read approval from trusted server-side catalog storage. It must not accept the approval value supplied by the caller.";

export const supplierAdapterNames = [
  "flight_shopping",
  "hotel_shopping",
  "flight_status",
  "mapping",
  "activities",
] as const;

export const supplierDomainValues = [
  "flights",
  "accommodation",
  "weather",
  "activities",
  "other",
] as const;

export const syncSubjectTypes = [
  "stay_property",
  "flight_template",
  "stay_base",
  "place",
  "activity",
] as const;

export const catalogApprovalValues = ["draft", "in_review", "approved", "archived"] as const;

export const freshnessValues = [
  "unverified",
  "fresh",
  "stale",
  "expired",
  "refresh_failed",
] as const;

export type SupplierAdapterName = (typeof supplierAdapterNames)[number];
export type SupplierDomain = (typeof supplierDomainValues)[number];
export type SyncSubjectType = (typeof syncSubjectTypes)[number];
export type CatalogApproval = (typeof catalogApprovalValues)[number];
export type Freshness = (typeof freshnessValues)[number];

export const adapterDomain: Record<SupplierAdapterName, SupplierDomain> = {
  flight_shopping: "flights",
  hotel_shopping: "accommodation",
  flight_status: "other",
  mapping: "other",
  activities: "activities",
};

export const permittedFields: Record<SupplierAdapterName, readonly string[]> = {
  flight_shopping: [
    "amountMinor",
    "currency",
    "segments",
    "fareBasis",
    "seats",
    "expiresAt",
    "supplierOfferId",
  ],
  hotel_shopping: [
    "amountMinor",
    "currency",
    "availability",
    "rateName",
    "cancellationSummary",
    "roomCount",
    "occupancy",
    "stayStart",
    "stayEnd",
    "expiresAt",
    "supplierOfferId",
  ],
  flight_status: ["status", "delayMinutes", "observedAt"],
  mapping: ["latitude", "longitude", "observedAt"],
  activities: [
    "amountMinor",
    "currency",
    "schedule",
    "availability",
    "expiresAt",
    "supplierOfferId",
  ],
};

export const editorialFieldNames = [
  "name",
  "summary",
  "editorialSummary",
  "vibeTags",
  "approval",
  "qualityReview",
  "recommendation",
  "slug",
] as const;

/** Claims the supplier must not get to make. The policy computes these. */
export const ignoredClaimNames = ["bookable", "verified"] as const;

export type SyncTarget = {
  id: string;
  type: SyncSubjectType;
  approval: CatalogApproval;
  name: string;
  summary: string;
};

export type SupplierLink = {
  id: string;
  adapter: SupplierAdapterName;
  providerKey: string;
  externalId: string;
  domain: SupplierDomain;
  subjectType: SyncSubjectType;
  subjectId: string;
  mappedBy: "admin";
};

export type SupplierSource = {
  providerKey: string;
  externalId: string;
  retrievedBy: "sync";
};

export type DatedOffer = {
  id: string;
  dedupeKey: string;
  linkId: string;
  adapter: SupplierAdapterName;
  subjectType: SyncSubjectType;
  subjectId: string;
  supplierOfferId: string;
  amountMinor: number | null;
  currency: string | null;
  occupancy: number | null;
  stayStart: string | null;
  stayEnd: string | null;
  expiresAt: string;
  lastCheckedAt: string;
  lastVerifiedAt: string;
  freshness: Freshness;
  payload: Record<string, unknown>;
  source: SupplierSource;
};

export type SupplierFact = {
  id: string;
  dedupeKey: string;
  linkId: string;
  adapter: SupplierAdapterName;
  subjectType: SyncSubjectType;
  subjectId: string;
  observedAt: string | null;
  lastCheckedAt: string;
  lastVerifiedAt: string;
  freshness: Freshness;
  payload: Record<string, unknown>;
  source: SupplierSource;
};

export type CatalogSuggestion = {
  id: string;
  dedupeKey: string;
  status: "pending";
  proposedType: SyncSubjectType;
  adapter: SupplierAdapterName;
  providerKey: string;
  externalId: string;
};

export type DynamicUpdate = {
  id: string;
  recordId: string;
  attemptedAt: string;
  providerKey: string;
  externalId: string | null;
  outcome: "succeeded" | "failed";
  errorCode: string | null;
  changedFields: readonly string[];
  previousPayload: Record<string, unknown> | null;
  nextPayload: Record<string, unknown> | null;
};

export type AuditKind =
  | "update_succeeded"
  | "update_rejected"
  | "refresh_failed"
  | "unmatched_entity";

export type AuditEvent = {
  id: string;
  kind: AuditKind;
  at: string;
  providerKey: string;
  externalId: string | null;
  subjectId: string | null;
  errorCode: string | null;
  message: string;
};

export type SyncState = {
  links: readonly SupplierLink[];
  offers: readonly DatedOffer[];
  facts: readonly SupplierFact[];
  suggestions: readonly CatalogSuggestion[];
  updates: readonly DynamicUpdate[];
  audits: readonly AuditEvent[];
};

export type ApprovedRecordRef = {
  subjectType: SyncSubjectType;
  subjectId: string;
  providerKey: string;
  externalId: string;
};

export type SupplierPayload = {
  adapter: SupplierAdapterName;
  providerKey: string;
  externalEntityId: string;
  supplierOfferId?: string;
  fields: Record<string, unknown>;
};

/**
 * A future HTTP adapter implements this on the server. `fetchUpdate` returns
 * data. It does not write the catalog. This module ships no HTTP adapter.
 */
export type SupplierAdapter = {
  key: string;
  adapter: SupplierAdapterName;
  domain: SupplierDomain;
  permittedFields: readonly string[];
  fetchUpdate(target: ApprovedRecordRef): Promise<SupplierPayload>;
};

export type AdapterRegistry = {
  adapters: readonly SupplierAdapter[];
};

export function emptySyncState(): SyncState {
  return {
    links: [],
    offers: [],
    facts: [],
    suggestions: [],
    updates: [],
    audits: [],
  };
}

export function suggestionTypeFor(adapter: SupplierAdapterName): SyncSubjectType {
  if (adapter === "hotel_shopping") {
    return "stay_property";
  }
  if (adapter === "flight_shopping" || adapter === "flight_status") {
    return "flight_template";
  }
  if (adapter === "activities") {
    return "activity";
  }
  return "place";
}

export function isOfferAdapter(adapter: SupplierAdapterName): boolean {
  return adapter === "flight_shopping" || adapter === "hotel_shopping" || adapter === "activities";
}
