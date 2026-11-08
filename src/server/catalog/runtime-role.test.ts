import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { createPrismaClient } from "@/server/catalog/prisma-client";
import { reserveInterpreterRequest } from "@/server/ai/interpreter-budget";

const migrationPath = "prisma/migrations/20261101234500_voyara_runtime_role/migration.sql";

test("the runtime role migration is least privilege and can reserve requests", { timeout: 180_000 }, async () => {
  const migration = readFileSync(migrationPath, "utf8");
  const statements = migration.replaceAll(/--.*$/gm, "");
  assert.equal(/\bPASSWORD\b/i.test(migration), false);
  assert.equal(/\bLOGIN\b/.test(statements.replaceAll("NOLOGIN", "")), false);
  assert.equal(/\bBYPASSRLS\b/i.test(statements), false);
  assert.equal(/\bSUPERUSER\b/i.test(statements), false);
  assert.equal(/\bDROP\s+TABLE\b/i.test(statements), false);
  assert.equal(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(statements), false);
  assert.equal(/\bGRANT\s+voyara_runtime\s+TO\b/i.test(statements), false);
  assert.match(migration, /CREATE ROLE voyara_runtime NOLOGIN NOINHERIT/);
  assert.match(migration, /GRANT USAGE ON SCHEMA public TO voyara_runtime/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE "interpreter_usage_bucket" TO voyara_runtime/);
  assert.equal(/GRANT\s+[^;]*\bDELETE\b/i.test(statements), false);
  assert.equal(/GRANT\s+[^;]*\bTRUNCATE\b/i.test(statements), false);
  for (const table of [
    "country",
    "region",
    "stay_base",
    "place",
    "curated_tip",
    "sample_itinerary",
    "sample_itinerary_item",
  ]) {
    assert.match(migration, new RegExp(`"${table}"`));
    assert.match(migration, new RegExp(`CREATE POLICY "voyara_runtime_select" ON "${table}"`));
  }
  assert.match(migration, /FOR INSERT TO voyara_runtime WITH CHECK \(true\)/);
  assert.match(migration, /FOR UPDATE TO voyara_runtime USING \(true\) WITH CHECK \(true\)/);
  assert.equal(/CREATE POLICY[^;]*TO (anon|authenticated|service_role|PUBLIC)/i.test(statements), false);
  assert.match(migration, /do not filter approval/i);

  const database = new PGlite();
  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await database.waitReady;
  await database.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `);
  const migrationNames = readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort();
  assert.deepEqual(migrationNames, [
    "20261101130000_catalog_persistence",
    "20261101230000_interpreter_usage_bucket",
    "20261101234500_voyara_runtime_role",
  ]);
  await database.exec(readFileSync("prisma/migrations/20261101130000_catalog_persistence/migration.sql", "utf8"));
  await database.exec(`
    GRANT TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
  `);
  await database.exec(readFileSync("prisma/migrations/20261101230000_interpreter_usage_bucket/migration.sql", "utf8"));
  await database.exec(migration);
  await database.exec(`
    INSERT INTO country (id, approval, name, country_code)
    VALUES ('cty_draft', 'draft', 'Draft Land', 'DL'), ('cty_live', 'approved', 'Approved Land', 'AL');
    INSERT INTO region (id, country_id, approval, name)
    VALUES ('reg_live', 'cty_live', 'approved', 'Approved Region');
    INSERT INTO stay_base (id, country_id, region_id, approval, name, slug, summary)
    VALUES ('stb_live', 'cty_live', 'reg_live', 'approved', 'Approved Base', 'approved-base', 'Summary');
    INSERT INTO place (id, stay_base_id, approval, name, kind, editorial_summary)
    VALUES ('plc_live', 'stb_live', 'approved', 'Approved Place', 'poi', 'Summary');
    INSERT INTO curated_tip (id, approval, body, subject_type, subject_id)
    VALUES ('tip_live', 'approved', 'Tip', 'place', 'plc_live');
    INSERT INTO sample_itinerary (id, approval, title, stay_base_ids)
    VALUES ('it_live', 'approved', 'Sample', ARRAY['stb_live']::text[]);
    INSERT INTO sample_itinerary_item (id, itinerary_id, sort_order, place_id, role)
    VALUES ('item_live', 'it_live', 1, 'plc_live', 'core');
  `);
  await server.start();
  const address = server.getServerConn();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const prisma = createPrismaClient(`postgresql://postgres:postgres@${address}/postgres`, 1);

  try {
    const privileges = await database.query<{ table_name: string; can_select: boolean; can_insert: boolean; can_delete: boolean }>(`
      SELECT table_name,
        has_table_privilege('voyara_runtime', format('public.%I', table_name), 'SELECT') AS can_select,
        has_table_privilege('voyara_runtime', format('public.%I', table_name), 'INSERT') AS can_insert,
        has_table_privilege('voyara_runtime', format('public.%I', table_name), 'DELETE') AS can_delete
      FROM unnest(ARRAY[
        'country', 'region', 'stay_base', 'place', 'curated_tip', 'sample_itinerary',
        'sample_itinerary_item', 'interpreter_usage_bucket', 'historical_amount', 'stay_property'
      ]::text[]) AS tables(table_name)
    `);
    const byTable = new Map(privileges.rows.map((row) => [row.table_name, row]));
    for (const table of ["country", "region", "stay_base", "place", "curated_tip", "sample_itinerary", "sample_itinerary_item"]) {
      assert.equal(byTable.get(table)?.can_select, true, table);
      assert.equal(byTable.get(table)?.can_insert, false, table);
      assert.equal(byTable.get(table)?.can_delete, false, table);
    }
    assert.equal(byTable.get("interpreter_usage_bucket")?.can_select, true);
    assert.equal(byTable.get("interpreter_usage_bucket")?.can_insert, true);
    assert.equal(byTable.get("interpreter_usage_bucket")?.can_delete, false);
    assert.equal(byTable.get("historical_amount")?.can_select, false);
    assert.equal(byTable.get("stay_property")?.can_select, false);

    const truncate = await database.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('anon', 'public.country', 'TRUNCATE') AS allowed",
    );
    assert.equal(truncate.rows[0]?.allowed, true);
    const anonLedger = await database.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('anon', 'public.interpreter_usage_bucket', 'SELECT') AS allowed",
    );
    assert.equal(anonLedger.rows[0]?.allowed, false);

    for (const role of ["anon", "authenticated", "service_role"]) {
      await database.exec(`SET ROLE ${role}`);
      await assert.rejects(database.query("SELECT id FROM country"));
      await assert.rejects(database.query("SELECT bucket_key FROM interpreter_usage_bucket"));
      await database.exec("RESET ROLE");
    }

    const session = await prisma.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user");
    assert.equal(session[0]?.current_user, "postgres");
    await prisma.$executeRawUnsafe("SET ROLE voyara_runtime");
    const acting = await prisma.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user");
    assert.equal(acting[0]?.current_user, "voyara_runtime");

    const countries = await prisma.$queryRawUnsafe<Array<{ id: string; approval: string }>>(
      "SELECT id, approval FROM country ORDER BY id",
    );
    assert.deepEqual(
      countries.map((row) => row.id),
      ["cty_draft", "cty_live"],
    );
    assert.equal(countries.find((row) => row.id === "cty_draft")?.approval, "draft");
    for (const table of ["region", "stay_base", "place", "curated_tip", "sample_itinerary", "sample_itinerary_item"]) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${table}`);
      assert.equal(rows.length, 1, table);
    }
    await assert.rejects(
      prisma.$executeRawUnsafe("INSERT INTO country (id, approval, name, country_code) VALUES ('cty_new', 'draft', 'Nope', 'NO')"),
    );
    await assert.rejects(prisma.$executeRawUnsafe("UPDATE country SET name = 'Changed' WHERE id = 'cty_live'"));
    await assert.rejects(prisma.$queryRawUnsafe("SELECT id FROM historical_amount"));
    await assert.rejects(prisma.$queryRawUnsafe("SELECT id FROM stay_property"));

    const reserved = await reserveInterpreterRequest(prisma, {
      callerId: "e43-role-verify",
      now: new Date("2099-04-01T12:00:00.000Z"),
      callerLimit: 8,
      callerWindowMs: 60_000,
      dailyLimit: 200,
    });
    assert.equal(reserved, "allowed");
    const limited = [
      await reserveInterpreterRequest(prisma, {
        callerId: "e43-role-cap",
        now: new Date("2099-04-02T15:30:00.000Z"),
        callerLimit: 20,
        callerWindowMs: 60_000,
        dailyLimit: 2,
      }),
      await reserveInterpreterRequest(prisma, {
        callerId: "e43-role-cap",
        now: new Date("2099-04-02T15:30:00.000Z"),
        callerLimit: 20,
        callerWindowMs: 60_000,
        dailyLimit: 2,
      }),
      await reserveInterpreterRequest(prisma, {
        callerId: "e43-role-cap",
        now: new Date("2099-04-02T15:30:00.000Z"),
        callerLimit: 20,
        callerWindowMs: 60_000,
        dailyLimit: 2,
      }),
    ];
    assert.deepEqual(limited, ["allowed", "allowed", "limited"]);
    await assert.rejects(
      prisma.$executeRawUnsafe("DELETE FROM interpreter_usage_bucket WHERE bucket_key = 'global:2099-04-01'"),
    );
    await assert.rejects(prisma.$executeRawUnsafe("TRUNCATE interpreter_usage_bucket"));
  } finally {
    await prisma.$executeRawUnsafe("RESET ROLE").catch(() => undefined);
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});
