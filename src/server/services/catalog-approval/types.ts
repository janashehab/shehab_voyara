import type { ApprovalState } from "@/lib/catalog/travel/schema";

/**
 * Approval changes run on the server. A later auth step is the only code that
 * should set serverAuthenticated. This module has no route and no server action.
 * Public callers and supplier payloads cannot change approval.
 */
export const APPROVAL_ACTOR_RULE =
  "Approval changes run only on the server for a trusted admin actor. No approval endpoint is exposed until authentication and authorization exist. Public callers and supplier payloads cannot change approval.";

/**
 * A route template names cities or airports. It is not a dated offer, a
 * confirmed seat, or a live fare. Carrier gaps stay unresolved metadata.
 */
export const ROUTE_TEMPLATE_RULE =
  "A flight route template is not a dated flight offer, a confirmed flight, or a live fare. Missing or multiple carriers stay unresolved metadata. A route needs an origin and a destination. An airport or city, including Krabi Airport, is not an accommodation stay base.";

/**
 * Country, region, and stay base each move through the approval graph on
 * their own. Nothing in the chain is approved because a child was approved.
 */
export const HIERARCHY_APPROVAL_RULE =
  "Approve each country, region, and stay base explicitly. Approving a record does not approve its parent or its children. Public retrieval returns an approved property only while its country, region, and stay base are also approved. An area is not a destination record in this step.";

/**
 * Phase 1 prices. Historical import rows stay internal. Web-observed
 * estimates and verified supplier offers are different records. No scraper
 * is part of this step.
 */
export const PHASE_1_PRICING_MODEL =
  "Historical imported prices are internal reference data. A recent permitted web-observed price may be shown as an indicative estimate only when it is fresh enough and matches the customer's requested conditions. The Voyara team handles final quotations and bookings manually. A future PriceObservation stays separate from a verified supplier offer. This step does not scrape the web.";

/**
 * Not implemented. The ledger is in memory. A later database stores approval
 * on the catalog row and appends audits, attestations, resolutions, and
 * quality overrides separately.
 */
export const FUTURE_APPROVAL_STORAGE =
  "Store approval on the catalog row. Append each transition to an approval audit table with actor id, timestamp, subject type, subject id, previous state, next state, and reason. Store identity attestations with a fingerprint of the identity-critical fields, and store finding resolutions and quality overrides in their own tables. Do not delete import findings. Do not store approval inside supplier payloads or dated offers.";

export const approvalSubjectTypes = [
  "stay_property",
  "flight_template",
  "country",
  "region",
  "stay_base",
] as const;

export const approvalTransitionGraph = {
  draft: ["in_review", "archived"],
  in_review: ["draft", "approved", "archived"],
  approved: ["in_review", "archived"],
  archived: ["draft"],
} as const satisfies Record<ApprovalState, readonly ApprovalState[]>;

export const approvalErrorCodes = [
  "unauthorized",
  "supplier_payload",
  "invalid_command",
  "invalid_transition",
  "unknown_subject",
  "unverified_identity",
  "insufficient_geography",
  "hierarchy_not_approved",
  "blocking_finding",
  "quality_blocked",
  "override_not_allowed",
] as const;

export type ApprovalSubjectType = (typeof approvalSubjectTypes)[number];
export type ApprovalErrorCode = (typeof approvalErrorCodes)[number];

/**
 * A future auth module constructs this from the server session.
 * serverAuthenticated is not proof of a session in this step.
 */
export type TrustedAdminActor = {
  role: "admin";
  actorId: string;
  serverAuthenticated: true;
};

export type IdentityFingerprint = {
  kind: "stay_property" | "flight_template";
  name: string;
  sourceIds: readonly string[];
  countryId: string | null;
  regionId: string | null;
  stayBaseId: string | null;
  areaId: string | null;
  route: readonly { sequence: number; origin: string; destination: string }[];
};

export type IdentityAttestation = {
  subjectType: "stay_property" | "flight_template";
  subjectId: string;
  actorId: string;
  at: string;
  reason: string;
  status: "active" | "invalidated";
  fingerprint: IdentityFingerprint;
  invalidatedAt: string | null;
};

export type FindingResolution = {
  findingIndex: number;
  field: string;
  sourceId: string | null;
  actorId: string;
  at: string;
  reason: string;
};

export type QualityOverride = {
  subjectType: "stay_property";
  subjectId: string;
  actorId: string;
  at: string;
  reason: string;
};

export type ApprovalAuditEvent = {
  id: string;
  kind:
    | "approval_transition"
    | "approval_rejected"
    | "identity_attested"
    | "identity_invalidated"
    | "finding_resolved"
    | "quality_overridden";
  at: string;
  actorId: string;
  actorRole: "admin" | "public" | "supplier";
  subjectType: ApprovalSubjectType | "unknown";
  subjectId: string;
  from: ApprovalState | null;
  to: ApprovalState | null;
  reason: string;
  errorCode: ApprovalErrorCode | null;
};

export type ApprovalLedger = {
  attestations: IdentityAttestation[];
  resolutions: FindingResolution[];
  qualityOverrides: QualityOverride[];
  audits: ApprovalAuditEvent[];
};

export type ApprovalResult = {
  ok: boolean;
  catalog: import("@/lib/catalog/travel/schema").TravelCatalog;
  ledger: ApprovalLedger;
  errorCode: ApprovalErrorCode | null;
};

export function emptyApprovalLedger(): ApprovalLedger {
  return { attestations: [], resolutions: [], qualityOverrides: [], audits: [] };
}
