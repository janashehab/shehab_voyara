import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import type { TripDocument } from "@/features/trips/schemas";

import { importPersistentCatalog } from "@/server/catalog/import-catalog";
import { createPrismaClient } from "@/server/catalog/prisma-client";

import {
  generateDeterministicItineraryFromApprovedCatalog,
  refineDeterministicItineraryFromApprovedCatalog,
} from "./deterministic-catalog";

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

test("deterministic refinement reads approved editorial rows", { timeout: 180_000 }, async () => {
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
    assert.equal((await importPersistentCatalog(prisma)).status, "applied");
    const priced = await prisma.historicalAmount.findFirst({
      where: { amountMinor: { not: null } },
      select: { amountMinor: true, currency: true, externalId: true },
    });
    assert.ok(priced?.amountMinor);
    assert.ok(priced.currency);

    await prisma.place.update({
      where: { id: "plc_paris_pink_mamma" },
      data: { approval: "draft" },
    });
    const planned = await generateDeterministicItineraryFromApprovedCatalog(prisma, { preferences });
    assert.equal(planned.ok, true);
    if (!planned.ok || !planned.trip) {
      return;
    }

    const fed = await refineDeterministicItineraryFromApprovedCatalog(prisma, {
      trip: planned.trip,
      instruction: "more cafés",
    });
    assert.equal(fed.ok, true);
    if (!fed.ok || !fed.trip) {
      return;
    }
    const ids = placeIds(fed.trip);
    assert.equal(ids.includes("plc_paris_bouillon_pigalle"), true);
    assert.equal(ids.includes("plc_paris_pink_mamma"), false);
    const rendered = JSON.stringify(fed.trip);
    assert.equal(rendered.includes(String(priced.amountMinor)), false);
    assert.equal(rendered.includes(priced.currency), false);
    if (priced.externalId) {
      assert.equal(rendered.includes(priced.externalId), false);
    }
    assert.equal(rendered.includes("dst_bangkok"), false);

    const bangkok = await refineDeterministicItineraryFromApprovedCatalog(prisma, {
      trip: {
        ...planned.trip,
        destinationId: "dst_bangkok",
        preferences: { ...planned.trip.preferences, destinationId: "dst_bangkok" },
      },
      instruction: "less walking",
    });
    assert.equal(bangkok.ok, false);
    if (bangkok.ok) {
      return;
    }
    assert.equal(bangkok.trip, null);
    assert.equal(bangkok.issues.some((issue) => issue.code === "unapproved_destination"), true);
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});

function placeIds(trip: TripDocument): string[] {
  return [...trip.days.flatMap((day) => day.items), ...trip.unscheduled].map((item) => item.placeId);
}
