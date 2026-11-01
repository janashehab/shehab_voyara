import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { approvedCatalog, getPrototypeCatalog } from "@/lib/catalog";
import { findingClass } from "@/server/services/catalog-approval/findings";
import type { TrustedAdminActor } from "@/server/services/catalog-approval/types";
import { retrieveDestination } from "@/server/services/planner/retrieve";

import { persistApprovalTransition, persistIdentityAttestation, storedApproval, updateStayPropertyIdentity } from "./approval-store";
import { importPersistentCatalog } from "./import-catalog";
import { loadApprovedEditorialCatalog, loadPlannerSnapshot } from "./planner-snapshot";
import { createPrismaClient } from "./prisma-client";
import { listPublicTravel } from "./public-retrieval";
import { readTravelState } from "./read-model";
import { trustedSyncTarget } from "./trusted-approval";

const actor: TrustedAdminActor = {
  role: "admin",
  actorId: "admin_test",
  serverAuthenticated: true,
};

test("catalog import is idempotent on an isolated database", { timeout: 180_000 }, async () => {
  const database = new PGlite();
  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await database.waitReady;
  await database.exec(readFileSync("prisma/migrations/20261101130000_catalog_persistence/migration.sql", "utf8"));
  await server.start();
  const address = server.getServerConn();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(address, /supabase/i);
  const prisma = createPrismaClient(`postgresql://postgres:postgres@${address}/postgres`, 1);

  try {
    const first = await importPersistentCatalog(prisma);
    const second = await importPersistentCatalog(prisma);
    assert.equal(first.status, "applied");
    assert.equal(second.status, "skipped");
    assert.equal(await prisma.stayProperty.count(), 120);
    assert.equal(await prisma.stayRate.count(), 124);
    assert.equal(await prisma.flightTemplate.count(), 16);
    assert.equal(await prisma.place.count(), getPrototypeCatalog().places.length);
    assert.equal((await prisma.country.findUnique({ where: { id: "cty_thailand" } }))?.approval, "draft");
    assert.equal((await prisma.country.findUnique({ where: { id: "cty_france" } }))?.approval, "approved");
    assert.equal((await prisma.stayRate.findFirst({ where: { sourceId: "PH-H014A" } }))?.breakfast, "unknown");
    assert.equal((await prisma.stayRate.findFirst({ where: { sourceId: "PH-H014A" } }))?.occupancyKnown, false);
    assert.equal((await prisma.historicalAmount.findFirst({ where: { sourceId: "CM-H049" } }))?.amountMinor, null);
    assert.equal(await prisma.historicalAmount.count({ where: { liveQuote: true } }), 0);

    const dusit = await prisma.stayProperty.findFirst({ where: { name: "Dusit Princess Chiang Mai" } });
    assert.deepEqual(dusit?.sourceIds, ["CM-H068", "CM-H068B"]);
    assert.equal(await prisma.stayProperty.count({ where: { name: "Dusit Princess Chiang Mai" } }), 1);

    const domestic = await prisma.flightTemplate.findUnique({ where: { sourceId: "TH-F013" } });
    const domesticLegs = await prisma.flightLeg.findMany({ where: { templateId: domestic?.id ?? "" } });
    assert.equal(domesticLegs.some((leg) => leg.originCode === null), true);

    const basis = await prisma.sourceArtifact.findUnique({
      where: { sourcePath: "docs/inventory/voyara_thailand_master_database.json" },
    });
    assert.equal((basis?.metadata as { occupancyVerified?: boolean }).occupancyVerified, false);

    const snapshot = await loadPlannerSnapshot(prisma);
    const fixture = getPrototypeCatalog();
    assert.deepEqual(snapshot.places.map((place) => place.id).sort(), fixture.places.map((place) => place.id).sort());
    assert.equal(snapshot.dynamicFacts.length, 0);
    assert.equal(retrieveDestination(snapshot, "dst_paris")?.places.length, fixture.places.length);
    assert.equal(retrieveDestination(snapshot, "dst_bangkok"), null);

    const editorial = await loadApprovedEditorialCatalog(prisma);
    const approvedFixture = approvedCatalog(fixture);
    assert.deepEqual(
      editorial.destinations.map((destination) => destination.id),
      ["dst_paris"],
    );
    for (const id of ["dst_bangkok", "dst_chiang_mai", "dst_phuket", "dst_koh_lanta", "dst_ao_nang"]) {
      assert.equal(
        editorial.destinations.some((destination) => destination.id === id),
        false,
        `${id} is a draft stay base`,
      );
    }
    assert.ok(await prisma.stayBase.count({ where: { approval: "draft" } }) > 0);
    assert.ok(await prisma.historicalAmount.count() > 0);
    assert.equal(await prisma.historicalAmount.count({ where: { liveQuote: true } }), 0);
    assert.equal(await prisma.historicalAmount.count({ where: { lastVerifiedAt: { not: null } } }), 0);
    assert.deepEqual(editorial.dynamicFacts, []);
    const propertyIds = new Set((await prisma.stayProperty.findMany({ select: { id: true } })).map((row) => row.id));
    assert.equal(
      editorial.places.some((place) => propertyIds.has(place.id)),
      false,
    );
    assert.deepEqual(editorial, approvedFixture);

    const state = await readTravelState(prisma);
    const property = state.catalog.properties.find((item) => {
      if (item.stayBaseId === null || item.qualityReview) {
        return false;
      }
      return !state.catalog.findings.some((finding) => {
        if (finding.sourceId === null || !item.sourceIds.includes(finding.sourceId)) {
          return false;
        }
        return findingClass(finding) !== "missing_detail";
      });
    });
    assert.ok(property?.stayBaseId);
    const region = state.catalog.regions.find((item) => item.id === property.regionId);
    assert.ok(region);
    await move(prisma, "country", property.countryId);
    await move(prisma, "region", property.regionId);
    await move(prisma, "stay_base", property.stayBaseId);
    const attested = await persistIdentityAttestation(
      prisma,
      actor,
      { subjectType: "stay_property", subjectId: property.id, reason: "Reviewed the property identity." },
      stamp(),
    );
    assert.equal(attested.ok, true, attested.errorCode ?? "attestation failed");
    await move(prisma, "stay_property", property.id);
    const published = await readTravelState(prisma);
    assert.equal(
      listPublicTravel(published.catalog, published.ledger).properties.some((item) => item.record.id === property.id),
      true,
    );
    assert.equal(listPublicTravel(published.catalog, published.ledger).flightTemplates.every((item) => item.liveFare === false), true);

    const renamed = `${property.name} reviewed`;
    const identity = await updateStayPropertyIdentity(prisma, {
      propertyId: property.id,
      actorId: actor.actorId,
      at: stamp(),
      reason: "The reviewed name differs from the import.",
      name: renamed,
    });
    assert.equal(identity.invalidated, 1);
    const hidden = await readTravelState(prisma);
    assert.equal(listPublicTravel(hidden.catalog, hidden.ledger).properties.some((item) => item.record.id === property.id), false);
    assert.equal((await prisma.stayProperty.findUnique({ where: { id: property.id } }))?.approval, "approved");
    assert.equal((await prisma.stayProperty.findUnique({ where: { id: property.id } }))?.name, renamed);

    const repeated = await importPersistentCatalog(prisma, { normalizerVersion: "e1.1-repeat" });
    assert.equal(repeated.status, "applied");
    const kept = await prisma.stayProperty.findUnique({ where: { id: property.id } });
    assert.equal(kept?.name, renamed);
    assert.equal(kept?.approval, "approved");
    assert.equal(await prisma.stayProperty.count(), 120);
    assert.ok(await prisma.importHold.findFirst({ where: { subjectId: property.id, field: "name" } }));
    assert.equal(await prisma.approvalAudit.count({ where: { kind: "identity_invalidated" } }), 1);

    const trusted = trustedSyncTarget(
      { id: property.id, type: "stay_property" as const, approval: "draft" as const, name: property.name, summary: "" },
      await storedApproval(prisma, "stay_property", property.id),
    );
    assert.equal(trusted.approval, "approved");
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});

async function move(
  prisma: Parameters<typeof persistApprovalTransition>[0],
  subjectType: "country" | "region" | "stay_base" | "stay_property",
  subjectId: string,
): Promise<void> {
  const review = await persistApprovalTransition(
    prisma,
    actor,
    { subjectType, subjectId, to: "in_review", reason: "Send the row for review." },
    stamp(),
  );
  assert.equal(review.ok, true, review.errorCode ?? `${subjectId} did not enter review`);
  const approved = await persistApprovalTransition(
    prisma,
    actor,
    { subjectType, subjectId, to: "approved", reason: "Approve the reviewed row." },
    stamp(),
  );
  assert.equal(approved.ok, true, approved.errorCode ?? `${subjectId} was not approved`);
}

function stamp(): string {
  return new Date().toISOString();
}
