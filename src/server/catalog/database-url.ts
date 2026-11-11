/**
 * Local placeholder used only so `prisma generate` can load prisma.config.ts
 * before a migration URL exists. It is not a Supabase connection.
 */
export const LOCAL_MIGRATION_PLACEHOLDER = "postgresql://127.0.0.1:5432/voyara";

/**
 * Rejects a missing URL and any value that was clearly built for the browser.
 * The real URL is read only by the server-only database module.
 */
export function assertDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is required for the server database module.");
  }
  if (value.includes("NEXT_PUBLIC")) {
    throw new Error("DATABASE_URL must stay server-only and must not use a NEXT_PUBLIC variable.");
  }
  return value;
}

/**
 * Runtime pooler URL. The Supabase direct host is often IPv6-only, so the
 * seed and the website use the IPv4 transaction pooler instead.
 */
export function runtimeConnectionUrl(value: string | undefined): string {
  const connectionString = assertDatabaseUrl(value);
  const url = postgresUrl(connectionString, "DATABASE_URL");
  if (isSupabaseDirectHost(url.hostname)) {
    throw new Error(
      "DATABASE_URL uses the Supabase direct database host, which often has no IPv4 address. Use the transaction pooler on port 6543.",
    );
  }
  const port = url.port === "" ? "5432" : url.port;
  if (port === "6543" && url.searchParams.get("pgbouncer") !== "true") {
    // Temporary production diagnostic. Facts only: no URL, host, user, or password.
    console.error(
      JSON.stringify({
        source: "database-url",
        databaseUrlExists: value !== undefined && value.trim() !== "",
        portIs6543: port === "6543",
        pgbouncerKeyExists: url.searchParams.has("pgbouncer"),
        pgbouncerValueIsTrue: url.searchParams.get("pgbouncer") === "true",
        vercelEnv: process.env.VERCEL_ENV ?? "unset",
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? "unset",
      }),
    );
    throw new Error("DATABASE_URL on port 6543 must include pgbouncer=true.");
  }
  return connectionString;
}

/**
 * Migration URL. An empty value keeps generate working offline. A set value
 * must be the IPv4 session pooler, not the transaction pooler and not the
 * direct Supabase host.
 */
export function migrationConnectionUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    return LOCAL_MIGRATION_PLACEHOLDER;
  }
  if (value.includes("NEXT_PUBLIC")) {
    throw new Error("DIRECT_URL must stay server-only and must not use a NEXT_PUBLIC variable.");
  }
  const url = postgresUrl(value, "DIRECT_URL");
  if (isSupabaseDirectHost(url.hostname)) {
    throw new Error(
      "DIRECT_URL uses the Supabase direct database host, which often has no IPv4 address. Use the session pooler host on port 5432.",
    );
  }
  const port = url.port === "" ? "5432" : url.port;
  if (port === "6543" || url.searchParams.get("pgbouncer") === "true") {
    throw new Error(
      "DIRECT_URL must use the Supabase session pooler on port 5432. Port 6543 is the transaction pooler and cannot apply Prisma migrations.",
    );
  }
  return value;
}

/**
 * Owner session-pooler URL for catalog seeding. An empty value is rejected.
 * This does not use DATABASE_URL or the offline generate placeholder.
 */
export function seedConnectionUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("DIRECT_URL is required to seed the catalog.");
  }
  const connectionString = migrationConnectionUrl(value);
  if (connectionString === LOCAL_MIGRATION_PLACEHOLDER) {
    throw new Error("DIRECT_URL is required to seed the catalog.");
  }
  const url = postgresUrl(connectionString, "DIRECT_URL");
  if (isRuntimeSeedRole(url.username)) {
    throw new Error("DIRECT_URL must use the migration owner. Refusing to seed as voyara_runtime.");
  }
  return connectionString;
}

function isRuntimeSeedRole(username: string): boolean {
  const name = username.toLowerCase();
  return name === "voyara_runtime" || name.startsWith("voyara_runtime.");
}

function postgresUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL connection URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use the postgresql protocol.`);
  }
  return url;
}

function isSupabaseDirectHost(hostname: string): boolean {
  return hostname.startsWith("db.") && hostname.endsWith(".supabase.co");
}
