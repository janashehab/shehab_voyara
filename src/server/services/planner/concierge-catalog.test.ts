import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { importPersistentCatalog } from "@/server/catalog/import-catalog";
import { loadApprovedEditorialCatalog } from "@/server/catalog/planner-snapshot";
import { createPrismaClient } from "@/server/catalog/prisma-client";

import { planConcierge, resetConciergeAttempts } from "./concierge";

test("the concierge plans from approved editorial rows", { timeout: 180_000 }, async () => {
  resetConciergeAttempts();
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
    const catalog = await loadApprovedEditorialCatalog(prisma);
    const planned = planConcierge({
      request: { destinationId: "dst_paris", dayCount: 2, interests: ["food"], pace: "steady" },
      catalog,
      now: 1,
      callerKey: "approved-food",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const names = planned.view.days.flatMap((day) => day.stops.map((stop) => stop.name));
    assert.deepEqual(names, ["Bouillon Pigalle"]);
    const rendered = JSON.stringify(planned);
    assert.equal(rendered.includes("plc_paris_pink_mamma"), false);
    assert.equal(rendered.includes(String(priced.amountMinor)), false);
    assert.equal(rendered.includes(priced.currency), false);
    if (priced.externalId) {
      assert.equal(rendered.includes(priced.externalId), false);
    }
    assert.equal(rendered.includes("dst_bangkok"), false);
    assert.equal(rendered.includes("postgres"), false);
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});
