import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getPrototypeCatalog } from "@/lib/catalog";
import { fingerprintFor } from "@/server/services/catalog-approval/identity";
import { findingClass } from "@/server/services/catalog-approval/findings";
import { emptyApprovalLedger } from "@/server/services/catalog-approval/types";
import {
  generateItineraryFromRepository,
  memoryPlannerRepository,
} from "@/server/services/planner/catalog-repository";
import { retrieveDestination } from "@/server/services/planner/retrieve";

import {
  assertDatabaseUrl,
  LOCAL_MIGRATION_PLACEHOLDER,
  migrationConnectionUrl,
  runtimeConnectionUrl,
  seedConnectionUrl,
} from "./database-url";
import { decideField, mergeFields } from "./field-ownership";
import { listPublicTravel } from "./public-retrieval";
import {
  THAILAND_JSON_PATH,
  THAILAND_MARKDOWN_PATH,
  sha256,
} from "./constants";
import { buildThailandPersistencePlan } from "./thailand-plan";
import { trustedSyncTarget } from "./trusted-approval";

const markdown = readFileSync(THAILAND_MARKDOWN_PATH, "utf8");
const jsonText = readFileSync(THAILAND_JSON_PATH, "utf8");
const markdownChecksum = sha256(markdown);
const plan = buildThailandPersistencePlan({
  markdown,
  jsonText,
  markdownChecksum,
  jsonChecksum: sha256(jsonText),
  markdownAliasChecksum: markdownChecksum,
});

test("Thailand persistence plan keeps one property per hotel and draft approval", () => {
  assert.equal(plan.catalog.properties.length, 120);
  assert.equal(plan.catalog.rates.length, 124);
  assert.equal(plan.catalog.flightTemplates.length, 16);
  assert.equal(plan.catalog.properties.every((row) => row.approval === "draft"), true);
  assert.equal(plan.catalog.flightTemplates.every((row) => row.approval === "draft"), true);
  assert.equal(plan.catalog.countries.every((row) => row.approval === "draft"), true);
  assert.equal(plan.catalog.amounts.every((row) => row.liveQuote === false && row.freshness === "unverified"), true);
  assert.equal(plan.catalog.rates.every((row) => row.occupancyKnown === false), true);

  const dusit = plan.catalog.properties.filter((row) => row.name === "Dusit Princess Chiang Mai");
  assert.equal(dusit.length, 1);
  assert.deepEqual(dusit[0]?.sourceIds, ["CM-H068", "CM-H068B"]);
  const breakfastRate = plan.catalog.rates.find((row) => row.sourceId === "CM-H068B");
  assert.equal(breakfastRate?.rateKey, "with_breakfast");
  assert.equal(plan.catalog.properties.filter((row) => row.name.includes("Astra Sky River")).length, 2);

  const mazi = plan.catalog.rates.find((row) => row.sourceId === "PH-H014A");
  assert.equal(mazi?.breakfast, "unknown");
  const missingPrice = plan.catalog.amounts.find((row) => row.sourceId === "CM-H049");
  assert.equal(missingPrice?.amountMinor, null);

  const domestic = plan.catalog.flightTemplates.find((row) => row.sourceId === "TH-F013");
  assert.equal(plan.legCodes[domestic?.id ?? ""]?.some((leg) => leg.originCode === null), true);
  const jsonArtifact = plan.artifacts.find((artifact) => artifact.sourceSystem === "thailand_json");
  assert.equal(jsonArtifact?.metadata.occupancyVerified, false);
  assert.equal(jsonArtifact?.metadata.occupancyAdults, 2);
  assert.equal(plan.artifacts.some((artifact) => artifact.role === "markdown_alias"), true);
  assert.equal(new Set(plan.sourceRecords.map((row) => `${row.sourceSystem}:${row.sourceId}`)).size, plan.sourceRecords.length);
});

test("public retrieval requires approval, attestation, hierarchy, and no blocking finding", () => {
  assert.equal(listPublicTravel(plan.catalog, emptyApprovalLedger()).properties.length, 0);
  const catalog = structuredClone(plan.catalog);
  const property = catalog.properties.find((item) => {
    if (item.stayBaseId === null || item.qualityReview) {
      return false;
    }
    return !catalog.findings.some((finding) => {
      if (finding.sourceId === null || !item.sourceIds.includes(finding.sourceId)) {
        return false;
      }
      const classification = findingClass(finding);
      return classification !== "missing_detail";
    });
  });
  assert.ok(property);
  const country = catalog.countries.find((item) => item.id === property.countryId);
  const region = catalog.regions.find((item) => item.id === property.regionId);
  const stayBase = catalog.stayBases.find((item) => item.id === property.stayBaseId);
  assert.ok(country && region && stayBase);
  country.approval = "approved";
  region.approval = "approved";
  stayBase.approval = "approved";
  property.approval = "approved";
  const fingerprint = fingerprintFor(catalog, "stay_property", property.id);
  assert.ok(fingerprint);
  const ledger = emptyApprovalLedger();
  ledger.attestations.push({
    subjectType: "stay_property",
    subjectId: property.id,
    actorId: "admin_test",
    at: "2026-11-01T10:00:00.000Z",
    reason: "Reviewed identity",
    status: "active",
    fingerprint,
    invalidatedAt: null,
  });
  const visible = listPublicTravel(catalog, ledger);
  assert.equal(visible.properties.some((item) => item.record.id === property.id), true);
  assert.equal("amountMinor" in visible.properties[0]!, false);

  property.name = `${property.name} renamed`;
  assert.equal(listPublicTravel(catalog, ledger).properties.some((item) => item.record.id === property.id), false);
});

test("import field ownership holds an attested identity and keeps approval", () => {
  assert.equal(
    decideField({
      changed: true,
      identityCritical: true,
      adminLocked: false,
      hasActiveAttestation: true,
      approval: "approved",
    }),
    "hold",
  );
  const merged = mergeFields({
    existing: { name: "Admin name", approval: "approved", adminLockedFields: ["name"] },
    incoming: { name: "Source name", approval: "draft", adminLockedFields: [] },
    sourceOwned: ["name"],
    identityFields: ["name"],
    adminLockedFields: ["name"],
    hasActiveAttestation: true,
  });
  assert.equal(merged.values.name, "Admin name");
  assert.equal(merged.values.approval, "approved");
  assert.equal(merged.holds.length, 1);
});

test("repository approval replaces the caller value", () => {
  const caller = { id: "sty_example", approval: "approved" as const };
  assert.equal(trustedSyncTarget(caller, "draft").approval, "draft");
  assert.equal(trustedSyncTarget(caller, null).approval, "draft");
  assert.equal(trustedSyncTarget({ ...caller, approval: "draft" }, "approved").approval, "approved");
});

test("the planner repository returns the current Paris snapshot", async () => {
  const snapshot = await memoryPlannerRepository().loadPlannerSnapshot();
  const fixture = getPrototypeCatalog();
  assert.deepEqual(
    snapshot.places.map((place) => place.id).sort(),
    fixture.places.map((place) => place.id).sort(),
  );
  assert.equal(snapshot.dynamicFacts.length, 0);
  assert.equal(retrieveDestination(snapshot, "dst_paris")?.places.length, fixture.places.length);
  assert.equal(typeof generateItineraryFromRepository, "function");
});

test("database URL stays server-only", () => {
  assert.throws(() => assertDatabaseUrl(undefined), /DATABASE_URL is required/);
  assert.throws(() => assertDatabaseUrl("NEXT_PUBLIC_DATABASE_URL=postgres"), /NEXT_PUBLIC/);
  assert.equal(assertDatabaseUrl("postgresql://db.example/voyara"), "postgresql://db.example/voyara");
});

test("migration and runtime URLs stay on IPv4 Supabase poolers", () => {
  const session = "postgresql://postgres.example:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require";
  const transaction = "postgresql://postgres.example:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
  assert.equal(migrationConnectionUrl(undefined), "postgresql://127.0.0.1:5432/voyara");
  assert.equal(migrationConnectionUrl(session), session);
  assert.throws(() => migrationConnectionUrl(transaction), /port 5432/);
  assert.throws(
    () => migrationConnectionUrl("postgresql://postgres:secret@db.example.supabase.co:5432/postgres"),
    /IPv4/,
  );
  assert.equal(runtimeConnectionUrl(transaction), transaction);
  assert.throws(
    () => runtimeConnectionUrl("postgresql://postgres:secret@db.example.supabase.co:5432/postgres"),
    /IPv4/,
  );
  assert.throws(
    () => runtimeConnectionUrl("postgresql://postgres.example:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"),
    /pgbouncer=true/,
  );
});

test("runtime pooler URL accepts only an exact pgbouncer=true parameter", () => {
  const host = "pooler.example.test";
  const secret = "not-a-real-password";
  const base = `postgresql://postgres.example:${secret}@${host}:6543/postgres`;
  const logs: string[] = [];
  const originalError = console.error;
  const previousEnv = process.env.VERCEL_ENV;
  const previousDeployment = process.env.VERCEL_DEPLOYMENT_ID;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_diagnostic_test";

  try {
    for (const url of [
      `${base}?pgbouncer=true`,
      `${base}?sslmode=require&pgbouncer=true`,
      `${base}?pgbouncer=true&sslmode=require`,
    ]) {
      assert.equal(runtimeConnectionUrl(url), url);
    }
    assert.equal(logs.length, 0);

    for (const url of [
      base,
      `${base}?sslmode=require`,
      `${base}?sslmode=require?pgbouncer=true`,
      `${base}?PgBouncer=true`,
    ]) {
      assertMalformedPgbouncer(url, false, secret, host, logs);
    }
    for (const url of [`${base}?pgbouncer=True`, `${base}?pgbouncer="true"`, `${base}?pgbouncer=1`]) {
      assertMalformedPgbouncer(url, true, secret, host, logs);
    }
  } finally {
    console.error = originalError;
    restoreProcessEnv("VERCEL_ENV", previousEnv);
    restoreProcessEnv("VERCEL_DEPLOYMENT_ID", previousDeployment);
  }
});

test("catalog seeding requires the owner session pooler", () => {
  const host = "aws-0-eu-central-1.pooler.supabase.com";
  const secret = "secret-token";
  const session = `postgresql://postgres.example:${secret}@${host}:5432/postgres?sslmode=require`;
  const transaction = `postgresql://postgres.example:${secret}@${host}:6543/postgres?pgbouncer=true`;
  assert.equal(seedConnectionUrl(session), session);
  assert.equal(runtimeConnectionUrl(transaction), transaction);

  for (const missing of [undefined, "", "   "]) {
    assert.throws(() => seedConnectionUrl(missing), (error: unknown) => secretSafe(error, /DIRECT_URL is required/, secret, host));
  }
  assert.throws(
    () => seedConnectionUrl(LOCAL_MIGRATION_PLACEHOLDER),
    (error: unknown) => secretSafe(error, /DIRECT_URL is required/, secret, host),
  );

  const runtimeUsers = ["voyara_runtime", "voyara_runtime.projectref", "Voyara_Runtime.projectref"];
  for (const username of runtimeUsers) {
    const url = `postgresql://${username}:${secret}@${host}:5432/postgres?sslmode=require`;
    assert.throws(() => seedConnectionUrl(url), (error: unknown) => secretSafe(error, /voyara_runtime/, secret, host, url));
  }

  assert.throws(
    () => seedConnectionUrl(transaction),
    (error: unknown) => secretSafe(error, /port 5432/, secret, host, transaction),
  );
  const direct = `postgresql://postgres.example:${secret}@db.example.supabase.co:5432/postgres`;
  assert.throws(() => seedConnectionUrl(direct), (error: unknown) => secretSafe(error, /IPv4/, secret, host, direct));

  const malformed = `not-a-url ${secret} ${host}`;
  assert.throws(
    () => seedConnectionUrl(malformed),
    (error: unknown) => secretSafe(error, /PostgreSQL connection URL/, secret, host, malformed),
  );
});

function assertMalformedPgbouncer(
  url: string,
  pgbouncerKeyExists: boolean,
  secret: string,
  host: string,
  logs: string[],
): void {
  assert.throws(
    () => runtimeConnectionUrl(url),
    (error: unknown) => secretSafe(error, /DATABASE_URL on port 6543 must include pgbouncer=true/, secret, host, url),
  );
  const line = logs.at(-1);
  assert.equal(typeof line, "string");
  assert.equal(line?.includes(secret), false);
  assert.equal(line?.includes(host), false);
  assert.equal(line?.includes(url), false);
  assert.equal(line?.includes("postgresql://"), false);
  const diagnostic: unknown = JSON.parse(line ?? "");
  assert.deepEqual(diagnostic, {
    source: "database-url",
    databaseUrlExists: true,
    portIs6543: true,
    pgbouncerKeyExists,
    pgbouncerValueIsTrue: false,
    vercelEnv: "production",
    deploymentId: "dpl_diagnostic_test",
  });
}

function restoreProcessEnv(name: "VERCEL_ENV" | "VERCEL_DEPLOYMENT_ID", previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function secretSafe(error: unknown, pattern: RegExp, secret: string, host: string, url?: string): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, pattern);
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes(host), false);
  if (url !== undefined) {
    assert.equal(error.message.includes(url), false);
  }
  return true;
}
