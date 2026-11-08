import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { getPrototypeCatalog } from "@/lib/catalog";
import type { TripDocument } from "@/features/trips/schemas";

import { importPersistentCatalog } from "@/server/catalog/import-catalog";
import { loadApprovedEditorialCatalog } from "@/server/catalog/planner-snapshot";
import { createPrismaClient } from "@/server/catalog/prisma-client";

import { generateDeterministicItinerary } from "./deterministic";
import { generateDeterministicItineraryFromApprovedCatalog } from "./deterministic-catalog";

const preferences = {
  destinationId: "dst_paris",
  startDate: null,
  endDate: null,
  dayCount: 2,
  companions: "solo",
  pace: "steady",
  budget: "open",
  interests: ["landmarks"],
  priorities: { vibe: null, placeStyle: null },
  exclusions: { avoid: [], placeIds: [] },
  constraints: { mustSeePlaceIds: [], mobility: null },
  notes: null,
};

test("approved editorial rows plan Paris and leave drafts and prices out", { timeout: 180_000 }, async () => {
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
    const imported = await importPersistentCatalog(prisma);
    assert.equal(imported.status, "applied");
    assert.ok(await prisma.stayBase.count({ where: { approval: "draft" } }) > 0);
    assert.ok(await prisma.historicalAmount.count() > 0);
    const priced = await prisma.historicalAmount.findFirst({
      where: { amountMinor: { not: null } },
      select: { amountMinor: true, currency: true, externalId: true },
    });
    assert.ok(priced?.amountMinor);
    assert.ok(priced.currency);

    const fixturePlan = generateDeterministicItinerary({
      preferences,
      catalog: getPrototypeCatalog(),
    });
    const databasePlan = await generateDeterministicItineraryFromApprovedCatalog(prisma, {
      preferences,
    });
    assert.equal(fixturePlan.ok, true);
    assert.equal(databasePlan.ok, true);
    if (!fixturePlan.ok || !fixturePlan.trip || !databasePlan.ok || !databasePlan.trip) {
      return;
    }
    assert.deepEqual(placeIds(databasePlan.trip), placeIds(fixturePlan.trip));
    assert.equal(databasePlan.trip.destinationId, "dst_paris");

    const food = await generateDeterministicItineraryFromApprovedCatalog(prisma, {
      preferences: { ...preferences, interests: ["food"] },
    });
    assert.equal(food.ok, true);
    if (!food.ok || !food.trip) {
      return;
    }
    assert.deepEqual(placeIds(food.trip), ["plc_paris_bouillon_pigalle", "plc_paris_pink_mamma"]);
    assert.equal(placeIds(food.trip).some((id) => placeIds(databasePlan.trip).includes(id)), false);

    const editorial = await loadApprovedEditorialCatalog(prisma);
    assert.deepEqual(editorial.dynamicFacts, []);
    assert.deepEqual(
      editorial.destinations.map((destination) => destination.id),
      ["dst_paris"],
    );
    const rendered = JSON.stringify(databasePlan.trip);
    assert.equal(rendered.includes(String(priced.amountMinor)), false);
    assert.equal(rendered.includes(priced.currency), false);
    if (priced.externalId) {
      assert.equal(rendered.includes(priced.externalId), false);
    }
    assert.equal(rendered.includes("Bangkok"), false);
    assert.equal(rendered.includes("dst_bangkok"), false);
    assert.equal(rendered.includes("postgres"), false);

    await prisma.place.update({
      where: { id: "plc_paris_pink_mamma" },
      data: { approval: "draft" },
    });
    const afterDraft = await generateDeterministicItineraryFromApprovedCatalog(prisma, {
      preferences: { ...preferences, interests: ["food"] },
    });
    assert.equal(afterDraft.ok, true);
    if (!afterDraft.ok || !afterDraft.trip) {
      return;
    }
    assert.deepEqual(placeIds(afterDraft.trip), ["plc_paris_bouillon_pigalle"]);
    assert.equal(placeIds(afterDraft.trip).includes("plc_paris_pink_mamma"), false);

    const bangkok = await generateDeterministicItineraryFromApprovedCatalog(prisma, {
      preferences: { ...preferences, destinationId: "dst_bangkok" },
    });
    assert.equal(bangkok.ok, false);
    if (bangkok.ok) {
      return;
    }
    assert.equal(bangkok.trip, null);
    assert.equal(
      bangkok.issues.some((issue) => issue.code === "unapproved_destination"),
      true,
    );
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});

function placeIds(trip: TripDocument): string[] {
  return trip.days.flatMap((day) => day.items.map((item) => item.placeId));
}
