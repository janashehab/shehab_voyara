import { z } from "zod";

import type { ApprovalState, TravelCatalog } from "@/lib/catalog/travel/schema";
import { approvalStateValues } from "@/lib/catalog/travel/schema";

import { approvalBlocker } from "./eligibility";
import { findingClass, unresolvedIdentityOrGeography } from "./findings";
import { fingerprintFor, sameFingerprint } from "./identity";
import {
  approvalSubjectTypes,
  approvalTransitionGraph,
  type ApprovalAuditEvent,
  type ApprovalErrorCode,
  type ApprovalLedger,
  type ApprovalResult,
  type ApprovalSubjectType,
  type TrustedAdminActor,
} from "./types";

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTOR_ID = /^[A-Za-z0-9_-]{1,80}$/;

const credentialKeys = new Set([
  "apikey",
  "api_key",
  "token",
  "accesstoken",
  "secret",
  "password",
  "authorization",
  "credential",
]);

const subjectCommand = {
  subjectType: z.enum(approvalSubjectTypes),
  subjectId: z.string().regex(/^(?:sty|flt|cty|rgn|dst)_[a-z0-9_]+$/),
  reason: z.string().trim().min(1).max(500),
};

const identitySubject = {
  subjectType: z.enum(["stay_property", "flight_template"] as const),
  subjectId: z.string().regex(/^(?:sty|flt)_[a-z0-9_]+$/),
  reason: z.string().trim().min(1).max(500),
};

const transitionCommandSchema = z
  .object({
    ...subjectCommand,
    to: z.enum(approvalStateValues),
  })
  .strict()
  .refine((command) => subjectPrefixMatches(command.subjectType, command.subjectId));

const attestCommandSchema = z
  .object(identitySubject)
  .strict()
  .refine((command) => subjectPrefixMatches(command.subjectType, command.subjectId));

const resolveCommandSchema = z
  .object({
    findingIndex: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const overrideCommandSchema = z
  .object({
    subjectType: z.literal("stay_property"),
    subjectId: z.string().regex(/^sty_[a-z0-9_]+$/),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

type TransitionCommand = z.infer<typeof transitionCommandSchema>;

type Caller = {
  role: "admin" | "public" | "supplier";
  actorId: string;
};

export type PublicStayProperty = {
  record: TravelCatalog["properties"][number];
  presentation: "approved_property";
};

export type PublicFlightTemplate = {
  record: TravelCatalog["flightTemplates"][number];
  presentation: "route_template";
  confirmedFlight: false;
  liveFare: false;
};

export function listApprovedRecords(catalog: TravelCatalog): {
  properties: PublicStayProperty[];
  flightTemplates: PublicFlightTemplate[];
} {
  return {
    properties: catalog.properties
      .filter((property) => property.approval === "approved" && hierarchyIsPublic(catalog, property))
      .map((record) => ({ record, presentation: "approved_property" })),
    flightTemplates: catalog.flightTemplates
      .filter((flight) => flight.approval === "approved")
      .map((record) => ({
        record,
        presentation: "route_template",
        confirmedFlight: false,
        liveFare: false,
      })),
  };
}

export function attestIdentity(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  actor: unknown,
  at: unknown,
  command: unknown,
): ApprovalResult {
  const opened = openOperation(catalog, ledger, actor, at, command);
  if (!opened.ok) {
    return opened.result;
  }

  const parsed = attestCommandSchema.safeParse(command);
  if (!parsed.success) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "invalid_command",
      "unknown",
      "unknown",
      null,
      null,
    );
  }

  const current = findSubject(catalog, parsed.data.subjectType, parsed.data.subjectId);
  if (!current) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "unknown_subject",
      parsed.data.subjectType,
      parsed.data.subjectId,
      null,
      null,
      parsed.data.reason,
    );
  }

  const fingerprint = fingerprintFor(catalog, parsed.data.subjectType, parsed.data.subjectId);
  if (!fingerprint) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "unverified_identity",
      parsed.data.subjectType,
      parsed.data.subjectId,
      current.approval,
      current.approval,
      parsed.data.reason,
    );
  }

  const already = opened.ledger.attestations.some(
    (item) =>
      item.status === "active" &&
      item.subjectType === parsed.data.subjectType &&
      item.subjectId === parsed.data.subjectId &&
      sameFingerprint(item.fingerprint, fingerprint),
  );
  if (already) {
    return { ok: true, catalog, ledger: opened.ledger, errorCode: null };
  }

  const attestation = {
    subjectType: parsed.data.subjectType,
    subjectId: parsed.data.subjectId,
    actorId: opened.actor.actorId,
    at: opened.at,
    reason: parsed.data.reason,
    status: "active" as const,
    fingerprint,
    invalidatedAt: null,
  };
  const nextLedger = appendAudit(
    { ...opened.ledger, attestations: [...opened.ledger.attestations, attestation] },
    {
      kind: "identity_attested",
      at: opened.at,
      actorId: opened.actor.actorId,
      actorRole: "admin",
      subjectType: parsed.data.subjectType,
      subjectId: parsed.data.subjectId,
      from: current.approval,
      to: current.approval,
      reason: parsed.data.reason,
      errorCode: null,
    },
  );
  return { ok: true, catalog, ledger: nextLedger, errorCode: null };
}

export function transitionApproval(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  actor: unknown,
  at: unknown,
  command: unknown,
): ApprovalResult {
  const opened = openOperation(catalog, ledger, actor, at, command);
  if (!opened.ok) {
    return opened.result;
  }

  const parsed = transitionCommandSchema.safeParse(command);
  if (!parsed.success) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "invalid_command",
      "unknown",
      "unknown",
      null,
      null,
    );
  }

  return applyTransition(catalog, opened.ledger, opened, parsed.data);
}

export function resolveFinding(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  actor: unknown,
  at: unknown,
  command: unknown,
): ApprovalResult {
  const opened = openOperation(catalog, ledger, actor, at, command);
  if (!opened.ok) {
    return opened.result;
  }
  const parsed = resolveCommandSchema.safeParse(command);
  if (!parsed.success) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "invalid_command",
      "unknown",
      "unknown",
      null,
      null,
    );
  }

  const finding = catalog.findings[parsed.data.findingIndex];
  if (!finding) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "unknown_subject",
      "unknown",
      "unknown",
      null,
      null,
      parsed.data.reason,
    );
  }

  const classification = findingClass(finding);
  const property = catalog.properties.find(
    (item) => finding.sourceId !== null && item.sourceIds.includes(finding.sourceId),
  );
  if (classification === "blocking_geography" && (property === undefined || property.stayBaseId === null)) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "insufficient_geography",
      property ? "stay_property" : "unknown",
      property?.id ?? "unknown",
      property?.approval ?? null,
      null,
      parsed.data.reason,
    );
  }

  if (opened.ledger.resolutions.some((item) => item.findingIndex === parsed.data.findingIndex)) {
    return { ok: true, catalog, ledger: opened.ledger, errorCode: null };
  }

  const flight = catalog.flightTemplates.find((item) => item.sourceId === finding.sourceId);
  const subjectType: ApprovalAuditEvent["subjectType"] = property
    ? "stay_property"
    : flight
      ? "flight_template"
      : "unknown";
  const subjectId = property?.id ?? flight?.id ?? "unknown";
  const resolution = {
    findingIndex: parsed.data.findingIndex,
    field: finding.field,
    sourceId: finding.sourceId,
    actorId: opened.actor.actorId,
    at: opened.at,
    reason: parsed.data.reason,
  };
  const nextLedger = appendAudit(
    { ...opened.ledger, resolutions: [...opened.ledger.resolutions, resolution] },
    {
      kind: "finding_resolved",
      at: opened.at,
      actorId: opened.actor.actorId,
      actorRole: "admin",
      subjectType,
      subjectId,
      from: property?.approval ?? flight?.approval ?? null,
      to: property?.approval ?? flight?.approval ?? null,
      reason: parsed.data.reason,
      errorCode: null,
    },
  );
  return { ok: true, catalog, ledger: nextLedger, errorCode: null };
}

export function overrideQualityReview(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  actor: unknown,
  at: unknown,
  command: unknown,
): ApprovalResult {
  const opened = openOperation(catalog, ledger, actor, at, command);
  if (!opened.ok) {
    return opened.result;
  }
  const parsed = overrideCommandSchema.safeParse(command);
  if (!parsed.success) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "invalid_command",
      "unknown",
      "unknown",
      null,
      null,
    );
  }

  const property = catalog.properties.find((item) => item.id === parsed.data.subjectId);
  if (!property) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "unknown_subject",
      "stay_property",
      parsed.data.subjectId,
      null,
      null,
      parsed.data.reason,
    );
  }
  if (unresolvedIdentityOrGeography(catalog, opened.ledger, property)) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "override_not_allowed",
      "stay_property",
      property.id,
      property.approval,
      null,
      "A quality override cannot replace unresolved identity or missing geography.",
    );
  }
  if (!property.qualityReview) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "override_not_allowed",
      "stay_property",
      property.id,
      property.approval,
      null,
      "This property has no serious quality block to override.",
    );
  }
  if (opened.ledger.qualityOverrides.some((item) => item.subjectId === property.id)) {
    return { ok: true, catalog, ledger: opened.ledger, errorCode: null };
  }

  const override = {
    subjectType: "stay_property" as const,
    subjectId: property.id,
    actorId: opened.actor.actorId,
    at: opened.at,
    reason: parsed.data.reason,
  };
  const nextLedger = appendAudit(
    { ...opened.ledger, qualityOverrides: [...opened.ledger.qualityOverrides, override] },
    {
      kind: "quality_overridden",
      at: opened.at,
      actorId: opened.actor.actorId,
      actorRole: "admin",
      subjectType: "stay_property",
      subjectId: property.id,
      from: property.approval,
      to: property.approval,
      reason: parsed.data.reason,
      errorCode: null,
    },
  );
  return { ok: true, catalog, ledger: nextLedger, errorCode: null };
}

function applyTransition(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  opened: Opened,
  command: TransitionCommand,
): ApprovalResult {
  const current = findSubject(catalog, command.subjectType, command.subjectId);
  if (!current) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "unknown_subject",
      command.subjectType,
      command.subjectId,
      null,
      command.to,
      command.reason,
    );
  }

  const allowed: readonly ApprovalState[] = approvalTransitionGraph[current.approval];
  if (!allowed.includes(command.to)) {
    return reject(
      opened.catalog,
      opened.ledger,
      opened.at,
      { role: "admin", actorId: opened.actor.actorId },
      "invalid_transition",
      command.subjectType,
      command.subjectId,
      current.approval,
      command.to,
      command.reason,
    );
  }

  if (command.to === "approved") {
    const blocker = approvalBlocker(catalog, ledger, command.subjectType, command.subjectId);
    if (blocker) {
      return reject(
        opened.catalog,
        opened.ledger,
        opened.at,
        { role: "admin", actorId: opened.actor.actorId },
        blocker,
        command.subjectType,
        command.subjectId,
        current.approval,
        command.to,
        command.reason,
      );
    }
  }

  const nextCatalog = assignApproval(catalog, command.subjectType, command.subjectId, command.to);

  const nextLedger = appendAudit(ledger, {
    kind: "approval_transition",
    at: opened.at,
    actorId: opened.actor.actorId,
    actorRole: "admin",
    subjectType: command.subjectType,
    subjectId: command.subjectId,
    from: current.approval,
    to: command.to,
    reason: command.reason,
    errorCode: null,
  });
  return { ok: true, catalog: nextCatalog, ledger: nextLedger, errorCode: null };
}

type Opened = {
  catalog: TravelCatalog;
  ledger: ApprovalLedger;
  at: string;
  actor: TrustedAdminActor;
};

function openOperation(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  actor: unknown,
  at: unknown,
  command: unknown,
): { ok: true } & Opened | { ok: false; result: ApprovalResult } {
  if (!isTimestamp(at)) {
    return {
      ok: false,
      result: { ok: false, catalog, ledger, errorCode: "invalid_command" },
    };
  }

  const caller = describeCaller(actor);
  if (
    containsCredential(actor) ||
    containsCredential(command) ||
    isSupplierPayload(command) ||
    caller.role === "supplier"
  ) {
    return {
      ok: false,
      result: reject(
        catalog,
        ledger,
        at,
        { role: "supplier", actorId: "supplier" },
        "supplier_payload",
        "unknown",
        "unknown",
        null,
        null,
      ),
    };
  }

  const parsedActor = parseTrustedActor(actor);
  if (!parsedActor) {
    return {
      ok: false,
      result: reject(catalog, ledger, at, caller, "unauthorized", "unknown", "unknown", null, null),
    };
  }

  return {
    ok: true,
    catalog,
    ledger: invalidateStaleAttestations(catalog, ledger, at, parsedActor.actorId),
    at,
    actor: parsedActor,
  };
}

function reject(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  at: string,
  caller: Caller,
  errorCode: ApprovalErrorCode,
  subjectType: ApprovalAuditEvent["subjectType"],
  subjectId: string,
  from: ApprovalState | null,
  to: ApprovalState | null,
  reason?: string,
): ApprovalResult {
  const auditReason = reason ?? fixedReason(errorCode);
  const nextLedger = appendAudit(ledger, {
    kind: "approval_rejected",
    at,
    actorId: caller.actorId,
    actorRole: caller.role,
    subjectType,
    subjectId,
    from,
    to,
    reason: auditReason,
    errorCode,
  });
  return { ok: false, catalog, ledger: nextLedger, errorCode };
}

function fixedReason(errorCode: ApprovalErrorCode): string {
  if (errorCode === "unauthorized") {
    return "Approval changes require a trusted server admin actor.";
  }
  if (errorCode === "supplier_payload") {
    return "Supplier payloads cannot change catalog approval.";
  }
  return "Approval command was not accepted.";
}

function findSubject(
  catalog: TravelCatalog,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): { approval: ApprovalState } | null {
  const records = recordsFor(catalog, subjectType);
  const record = records.find((item) => item.id === subjectId);
  return record ? { approval: record.approval } : null;
}

function recordsFor(
  catalog: TravelCatalog,
  subjectType: ApprovalSubjectType,
): readonly { id: string; approval: ApprovalState }[] {
  if (subjectType === "stay_property") {
    return catalog.properties;
  }
  if (subjectType === "flight_template") {
    return catalog.flightTemplates;
  }
  if (subjectType === "country") {
    return catalog.countries;
  }
  if (subjectType === "region") {
    return catalog.regions;
  }
  return catalog.stayBases;
}

function assignApproval(
  catalog: TravelCatalog,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  to: ApprovalState,
): TravelCatalog {
  if (subjectType === "stay_property") {
    return {
      ...catalog,
      properties: catalog.properties.map((property) =>
        property.id === subjectId ? { ...property, approval: to } : property,
      ),
    };
  }
  if (subjectType === "flight_template") {
    return {
      ...catalog,
      flightTemplates: catalog.flightTemplates.map((flight) =>
        flight.id === subjectId ? { ...flight, approval: to } : flight,
      ),
    };
  }
  if (subjectType === "country") {
    return {
      ...catalog,
      countries: catalog.countries.map((country) =>
        country.id === subjectId ? { ...country, approval: to } : country,
      ),
    };
  }
  if (subjectType === "region") {
    return {
      ...catalog,
      regions: catalog.regions.map((region) =>
        region.id === subjectId ? { ...region, approval: to } : region,
      ),
    };
  }
  return {
    ...catalog,
    stayBases: catalog.stayBases.map((stayBase) =>
      stayBase.id === subjectId ? { ...stayBase, approval: to } : stayBase,
    ),
  };
}

function hierarchyIsPublic(
  catalog: TravelCatalog,
  property: TravelCatalog["properties"][number],
): boolean {
  const country = catalog.countries.find((item) => item.id === property.countryId);
  const region = catalog.regions.find((item) => item.id === property.regionId);
  const stayBase = catalog.stayBases.find((item) => item.id === property.stayBaseId);
  return (
    country?.approval === "approved" &&
    region?.approval === "approved" &&
    stayBase?.approval === "approved"
  );
}

function invalidateStaleAttestations(
  catalog: TravelCatalog,
  ledger: ApprovalLedger,
  at: string,
  actorId: string,
): ApprovalLedger {
  let next = ledger;
  for (const attestation of ledger.attestations) {
    if (attestation.status !== "active") {
      continue;
    }
    const current = fingerprintFor(catalog, attestation.subjectType, attestation.subjectId);
    if (current && sameFingerprint(current, attestation.fingerprint)) {
      continue;
    }
    next = appendAudit(
      {
        ...next,
        attestations: next.attestations.map((item) =>
          item.subjectType === attestation.subjectType &&
          item.subjectId === attestation.subjectId &&
          item.at === attestation.at &&
          item.status === "active"
            ? { ...item, status: "invalidated", invalidatedAt: at }
            : item,
        ),
      },
      {
        kind: "identity_invalidated",
        at,
        actorId,
        actorRole: "admin",
        subjectType: attestation.subjectType,
        subjectId: attestation.subjectId,
        from: findSubject(catalog, attestation.subjectType, attestation.subjectId)?.approval ?? null,
        to: findSubject(catalog, attestation.subjectType, attestation.subjectId)?.approval ?? null,
        reason: "Identity-critical fields no longer match the attestation.",
        errorCode: null,
      },
    );
  }
  return next;
}

function appendAudit(
  ledger: ApprovalLedger,
  event: Omit<ApprovalAuditEvent, "id">,
): ApprovalLedger {
  return {
    ...ledger,
    audits: [...ledger.audits, { ...event, id: `apr_${ledger.audits.length + 1}` }],
  };
}

const trustedActorSchema = z
  .object({
    role: z.literal("admin"),
    actorId: z.string().regex(ACTOR_ID),
    serverAuthenticated: z.literal(true),
  })
  .strict();

function parseTrustedActor(actor: unknown): TrustedAdminActor | null {
  const parsed = trustedActorSchema.safeParse(actor);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function describeCaller(actor: unknown): Caller {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
    return { role: "public", actorId: "public" };
  }
  if (isSupplierPayload(actor)) {
    return { role: "supplier", actorId: "supplier" };
  }
  const role = field(actor, "role");
  const actorId = field(actor, "actorId");
  if (role === "admin" && typeof actorId === "string" && ACTOR_ID.test(actorId)) {
    return { role: "admin", actorId };
  }
  return { role: "public", actorId: "public" };
}

function isSupplierPayload(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = new Set(Object.keys(value));
  if (keys.has("providerKey") || keys.has("externalEntityId") || keys.has("adapter") || keys.has("fields")) {
    return true;
  }
  return field(value, "role") === "supplier";
}

function field(value: object, key: string): unknown {
  const entry = Object.entries(value).find(([entryKey]) => entryKey === key);
  return entry ? entry[1] : undefined;
}

function containsCredential(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsCredential(item, seen));
  }
  return Object.entries(value).some(([key, nested]) => {
    return credentialKeys.has(key.toLowerCase()) || containsCredential(nested, seen);
  });
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function subjectPrefixMatches(subjectType: ApprovalSubjectType, subjectId: string): boolean {
  if (subjectType === "stay_property") {
    return subjectId.startsWith("sty_");
  }
  if (subjectType === "flight_template") {
    return subjectId.startsWith("flt_");
  }
  if (subjectType === "country") {
    return subjectId.startsWith("cty_");
  }
  if (subjectType === "region") {
    return subjectId.startsWith("rgn_");
  }
  return subjectId.startsWith("dst_");
}

