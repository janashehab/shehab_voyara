import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ApprovalState } from "@/lib/catalog/travel/schema";
import {
  attestIdentity,
  overrideQualityReview,
  resolveFinding,
  transitionApproval,
} from "@/server/services/catalog-approval/policy";
import type {
  ApprovalResult,
  ApprovalSubjectType,
  TrustedAdminActor,
} from "@/server/services/catalog-approval/types";

import { sha256 } from "./constants";
import { readTravelState, type TravelState } from "./read-model";

type CatalogDb = PrismaClient;

export async function persistApprovalTransition(
  prisma: CatalogDb,
  actor: TrustedAdminActor,
  command: unknown,
  at: string,
): Promise<ApprovalResult> {
  return commit(prisma, (state) => transitionApproval(state.catalog, state.ledger, actor, at, command));
}

export async function persistIdentityAttestation(
  prisma: CatalogDb,
  actor: TrustedAdminActor,
  command: unknown,
  at: string,
): Promise<ApprovalResult> {
  return commit(prisma, (state) => attestIdentity(state.catalog, state.ledger, actor, at, command));
}

export async function persistFindingResolution(
  prisma: CatalogDb,
  actor: TrustedAdminActor,
  command: unknown,
  at: string,
): Promise<ApprovalResult> {
  return commit(prisma, (state) => resolveFinding(state.catalog, state.ledger, actor, at, command));
}

export async function persistQualityOverride(
  prisma: CatalogDb,
  actor: TrustedAdminActor,
  command: unknown,
  at: string,
): Promise<ApprovalResult> {
  return commit(prisma, (state) => overrideQualityReview(state.catalog, state.ledger, actor, at, command));
}

export async function updateStayPropertyIdentity(
  prisma: CatalogDb,
  input: {
    propertyId: string;
    actorId: string;
    at: string;
    reason: string;
    name?: string;
    countryId?: string;
    regionId?: string;
    stayBaseId?: string | null;
    areaId?: string | null;
  },
): Promise<{ changed: boolean; invalidated: number }> {
  return prisma.$transaction(async (tx) => {
    const property = await tx.stayProperty.findUnique({ where: { id: input.propertyId } });
    if (!property) {
      throw new Error(`Unknown stay property ${input.propertyId}.`);
    }
    const data: {
      name?: string;
      countryId?: string;
      regionId?: string;
      stayBaseId?: string | null;
      areaId?: string | null;
    } = {};
    const locked = new Set(property.adminLockedFields);
    if (input.name !== undefined && input.name !== property.name) {
      data.name = input.name;
      locked.add("name");
    }
    if (input.countryId !== undefined && input.countryId !== property.countryId) {
      data.countryId = input.countryId;
      locked.add("countryId");
    }
    if (input.regionId !== undefined && input.regionId !== property.regionId) {
      data.regionId = input.regionId;
      locked.add("regionId");
    }
    if (input.stayBaseId !== undefined && input.stayBaseId !== property.stayBaseId) {
      data.stayBaseId = input.stayBaseId;
      locked.add("stayBaseId");
    }
    if (input.areaId !== undefined && input.areaId !== property.areaId) {
      data.areaId = input.areaId;
      locked.add("areaId");
    }
    if (Object.keys(data).length === 0) {
      return { changed: false, invalidated: 0 };
    }

    const occurredAt = new Date(input.at);
    const active = await tx.identityAttestation.findMany({
      where: { subjectType: "stay_property", subjectId: input.propertyId, status: "active" },
    });
    await tx.stayProperty.update({
      where: { id: input.propertyId },
      data: { ...data, adminLockedFields: [...locked] },
    });
    if (active.length > 0) {
      await tx.identityAttestation.updateMany({
        where: { id: { in: active.map((row) => row.id) } },
        data: { status: "invalidated", invalidatedAt: occurredAt },
      });
      const auditCount = await tx.approvalAudit.count();
      await tx.approvalAudit.create({
        data: {
          id: `apr_${auditCount + 1}`,
          kind: "identity_invalidated",
          occurredAt,
          actorId: input.actorId,
          actorRole: "admin",
          subjectType: "stay_property",
          subjectId: input.propertyId,
          fromState: property.approval,
          toState: property.approval,
          reason: input.reason,
        },
      });
    }
    return { changed: true, invalidated: active.length };
  });
}

export async function storedApproval(
  prisma: CatalogDb,
  subjectType: ApprovalSubjectType | "place",
  subjectId: string,
): Promise<ApprovalState | null> {
  if (subjectType === "stay_property") {
    return (await prisma.stayProperty.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
  }
  if (subjectType === "flight_template") {
    return (await prisma.flightTemplate.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
  }
  if (subjectType === "country") {
    return (await prisma.country.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
  }
  if (subjectType === "region") {
    return (await prisma.region.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
  }
  if (subjectType === "stay_base") {
    return (await prisma.stayBase.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
  }
  return (await prisma.place.findUnique({ where: { id: subjectId }, select: { approval: true } }))?.approval ?? null;
}

async function commit(
  prisma: CatalogDb,
  mutate: (state: TravelState) => ApprovalResult,
): Promise<ApprovalResult> {
  return prisma.$transaction(async (tx) => {
    const before = await readTravelState(tx);
    const result = mutate(before);
    await persistDelta(tx, before, result);
    return { ...result, catalog: (await readTravelState(tx)).catalog, ledger: (await readTravelState(tx)).ledger };
  });
}

async function persistDelta(
  tx: Prisma.TransactionClient,
  before: TravelState,
  result: ApprovalResult,
): Promise<void> {
  await updateApproval(tx, "country", before.catalog.countries, result.catalog.countries);
  await updateApproval(tx, "region", before.catalog.regions, result.catalog.regions);
  await updateApproval(tx, "stayBase", before.catalog.stayBases, result.catalog.stayBases);
  await updateApproval(tx, "stayProperty", before.catalog.properties, result.catalog.properties);
  await updateApproval(tx, "flightTemplate", before.catalog.flightTemplates, result.catalog.flightTemplates);

  const knownAudits = new Set(before.ledger.audits.map((audit) => audit.id));
  for (const audit of result.ledger.audits) {
    if (knownAudits.has(audit.id)) {
      continue;
    }
    await tx.approvalAudit.create({
      data: {
        id: audit.id,
        kind: audit.kind,
        occurredAt: new Date(audit.at),
        actorId: audit.actorId,
        actorRole: audit.actorRole,
        subjectType: audit.subjectType,
        subjectId: audit.subjectId,
        fromState: audit.from,
        toState: audit.to,
        reason: audit.reason,
        errorCode: audit.errorCode,
      },
    });
  }

  for (const attestation of result.ledger.attestations) {
    const id = attestationId(attestation.subjectType, attestation.subjectId, attestation.at);
    await tx.identityAttestation.upsert({
      where: { id },
      create: {
        id,
        subjectType: attestation.subjectType,
        subjectId: attestation.subjectId,
        actorId: attestation.actorId,
        attestedAt: new Date(attestation.at),
        reason: attestation.reason,
        status: attestation.status,
        fingerprint: attestation.fingerprint,
        invalidatedAt: attestation.invalidatedAt ? new Date(attestation.invalidatedAt) : null,
      },
      update: {
        status: attestation.status,
        invalidatedAt: attestation.invalidatedAt ? new Date(attestation.invalidatedAt) : null,
      },
    });
  }

  const knownResolutions = new Set(before.ledger.resolutions.map((item) => `${item.findingIndex}:${item.at}`));
  for (const resolution of result.ledger.resolutions) {
    if (knownResolutions.has(`${resolution.findingIndex}:${resolution.at}`)) {
      continue;
    }
    const finding = result.catalog.findings[resolution.findingIndex];
    if (!finding) {
      continue;
    }
    const findingId = `find_${sha256(`${finding.kind}|${finding.sourceId ?? ""}|${finding.field}|${finding.message}`).slice(0, 24)}`;
    await tx.findingResolution.create({
      data: {
        id: `res_${findingId}_${resolution.at.replace(/[:.]/g, "_")}`,
        findingId,
        actorId: resolution.actorId,
        resolvedAt: new Date(resolution.at),
        reason: resolution.reason,
      },
    });
  }

  for (const override of result.ledger.qualityOverrides) {
    await tx.qualityOverride.upsert({
      where: { subjectType_subjectId: { subjectType: override.subjectType, subjectId: override.subjectId } },
      create: {
        id: `qov_${override.subjectId}`,
        subjectType: override.subjectType,
        subjectId: override.subjectId,
        actorId: override.actorId,
        overriddenAt: new Date(override.at),
        reason: override.reason,
      },
      update: { reason: override.reason },
    });
  }
}

async function updateApproval(
  tx: Prisma.TransactionClient,
  model: "country" | "region" | "stayBase" | "stayProperty" | "flightTemplate",
  before: readonly { id: string; approval: ApprovalState }[],
  after: readonly { id: string; approval: ApprovalState }[],
): Promise<void> {
  const previous = new Map(before.map((row) => [row.id, row.approval]));
  for (const row of after) {
    if (previous.get(row.id) === row.approval) {
      continue;
    }
    const data = { approval: row.approval };
    if (model === "country") {
      await tx.country.update({ where: { id: row.id }, data });
    } else if (model === "region") {
      await tx.region.update({ where: { id: row.id }, data });
    } else if (model === "stayBase") {
      await tx.stayBase.update({ where: { id: row.id }, data });
    } else if (model === "stayProperty") {
      await tx.stayProperty.update({ where: { id: row.id }, data });
    } else {
      await tx.flightTemplate.update({ where: { id: row.id }, data });
    }
  }
}

function attestationId(subjectType: string, subjectId: string, at: string): string {
  return `att_${subjectType}_${subjectId}_${at.replace(/[:.]/g, "_")}`;
}
