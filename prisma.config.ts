import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { defineConfig } from "prisma/config";

import { migrationConnectionUrl } from "./src/server/catalog/database-url";

/**
 * Prisma 7 does not load `.env` before evaluating this file. Generate does
 * not connect. Migrate uses DIRECT_URL, and the application uses DATABASE_URL.
 */
if (existsSync(".env")) {
  loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npm run db:seed",
  },
  datasource: {
    url: migrationConnectionUrl(process.env.DIRECT_URL),
  },
});
