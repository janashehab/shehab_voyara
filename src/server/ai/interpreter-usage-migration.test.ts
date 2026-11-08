import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { createPrismaClient } from "@/server/catalog/prisma-client";

import { reserveInterpreterRequest } from "./interpreter-budget";

const migrationPath = "prisma/migrations/20261101230000_interpreter_usage_bucket/migration.sql";
const catalogMigrationPath = "prisma/migrations/20261101130000_catalog_persistence/migration.sql";

test("the interpreter usage migration is additive and locked down", { timeout: 180_000 }, async () => {
  const migration = readFileSync(migrationPath, "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const catalogMigration = readFileSync(catalogMigrationPath, "utf8");
  const lock = readFileSync("prisma/migrations/migration_lock.toml", "utf8");

  assert.match(lock, /provider = "postgresql"/);
  assert.equal(catalogMigration.includes("interpreter_usage_bucket"), false);
  assert.equal(/\bDROP\s+TABLE\b/i.test(migration), false);
  assert.equal(/\bDROP\s+COLUMN\b/i.test(migration), false);
  assert.equal(/\bCREATE\s+POLICY\b/i.test(migration), false);
  assert.equal(/\bDELETE\s+FROM\b/i.test(migration), false);
  assert.match(migration, /CREATE TABLE "interpreter_usage_bucket"/);
  assert.match(migration, /"bucket_key" TEXT NOT NULL/);
  assert.match(migration, /"window_start" TIMESTAMPTZ\(6\) NOT NULL/);
  assert.match(migration, /"request_count" INTEGER NOT NULL/);
  assert.match(migration, /PRIMARY KEY \("bucket_key"\)/);
  assert.match(migration, /CHECK \("request_count" >= 0\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM anon/);
  assert.match(migration, /REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM service_role/);
  assert.match(
    migration,
    /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'service_role'\) THEN[\s\S]*REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM service_role;/,
  );

  const model = schema.slice(schema.indexOf("model InterpreterUsageBucket"));
  assert.match(model, /bucketKey\s+String\s+@id @map\("bucket_key"\)/);
  assert.match(model, /windowStart\s+DateTime\s+@map\("window_start"\) @db\.Timestamptz\(6\)/);
  assert.match(model, /requestCount\s+Int\s+@map\("request_count"\)/);
  assert.match(model, /@@map\("interpreter_usage_bucket"\)/);
  assert.equal(model.includes("@@ignore"), false);

  const plain = new PGlite();
  await plain.waitReady;
  await plain.exec(migration);
  const plainSecurity = await plain.query<{ relrowsecurity: boolean }>(
    "SELECT relrowsecurity FROM pg_class WHERE relname = 'interpreter_usage_bucket'",
  );
  assert.equal(plainSecurity.rows[0]?.relrowsecurity, true);
  await plain.close();

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
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role, PUBLIC;
  `);
  await database.exec(migration);
  await server.start();
  const address = server.getServerConn();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(address, /supabase/i);
  const prisma = createPrismaClient(`postgresql://postgres:postgres@${address}/postgres`, 1);

  try {
    const description = await database.query<{ column_name: string; data_type: string; datetime_precision: number }>(`
      SELECT column_name, data_type, datetime_precision
      FROM information_schema.columns
      WHERE table_name = 'interpreter_usage_bucket'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(
      description.rows.map((row) => row.column_name),
      ["bucket_key", "window_start", "request_count"],
    );
    assert.equal(description.rows[1]?.data_type, "timestamp with time zone");
    assert.equal(Number(description.rows[1]?.datetime_precision), 6);

    const access = await database.query<{ relrowsecurity: boolean; relacl: string | null }>(
      "SELECT relrowsecurity, relacl::text AS relacl FROM pg_class WHERE relname = 'interpreter_usage_bucket'",
    );
    assert.equal(access.rows[0]?.relrowsecurity, true);
    const acl = access.rows[0]?.relacl ?? "";
    assert.equal(acl.includes("anon="), false);
    assert.equal(acl.includes("authenticated="), false);
    assert.equal(acl.includes("service_role="), false);

    const grants = await database.query<{ grantee: string }>(`
      SELECT grantee
      FROM information_schema.role_table_grants
      WHERE table_name = 'interpreter_usage_bucket'
        AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
    `);
    assert.equal(grants.rows.length, 0);

    await database.exec("SET ROLE anon");
    await assert.rejects(
      database.exec(
        "INSERT INTO interpreter_usage_bucket (bucket_key, window_start, request_count) VALUES ('anon', now(), 1)",
      ),
    );
    await database.exec("RESET ROLE");

    await database.exec("SET ROLE service_role");
    await assert.rejects(
      database.exec(
        "INSERT INTO interpreter_usage_bucket (bucket_key, window_start, request_count) VALUES ('service-direct', now(), 1)",
      ),
      (error: unknown) => error instanceof Error && /permission denied for table/i.test(error.message),
    );
    await database.exec("RESET ROLE");

    await database.exec(`
      CREATE ROLE ledger_group NOLOGIN;
      GRANT ALL ON TABLE interpreter_usage_bucket TO ledger_group;
      GRANT ledger_group TO service_role;
    `);
    const membership = await database.query<{ inherits: string }>(`
      SELECT parent.rolname AS inherits
      FROM pg_auth_members member
      JOIN pg_roles child ON child.oid = member.member
      JOIN pg_roles parent ON parent.oid = member.roleid
      WHERE child.rolname = 'service_role'
    `);
    assert.deepEqual(membership.rows.map((row) => row.inherits), ["ledger_group"]);
    await database.exec("SET ROLE service_role");
    await database.exec(
      "INSERT INTO interpreter_usage_bucket (bucket_key, window_start, request_count) VALUES ('service-inherited', now(), 1)",
    );
    await database.exec("RESET ROLE");
    const inherited = await database.query<{ bucket_key: string }>(
      "SELECT bucket_key FROM interpreter_usage_bucket WHERE bucket_key = 'service-inherited'",
    );
    assert.equal(inherited.rows.length, 1);

    await assert.rejects(
      database.exec(
        "INSERT INTO interpreter_usage_bucket (bucket_key, window_start, request_count) VALUES ('negative', now(), -1)",
      ),
    );

    const reserved = await reserveInterpreterRequest(prisma, {
      callerId: "direct",
      now: new Date("2031-06-01T12:00:00.000Z"),
      callerLimit: 8,
      callerWindowMs: 60_000,
      dailyLimit: 200,
    });
    assert.equal(reserved, "allowed");
    const updated = await prisma.$executeRaw`
      UPDATE interpreter_usage_bucket
      SET request_count = request_count
      WHERE bucket_key = 'global:2031-06-01'
    `;
    assert.equal(Number(updated), 1);
    const visible = await prisma.$queryRaw<Array<{ request_count: number }>>`
      SELECT request_count FROM interpreter_usage_bucket WHERE bucket_key = 'global:2031-06-01'
    `;
    assert.equal(Number(visible[0]?.request_count), 1);
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});
