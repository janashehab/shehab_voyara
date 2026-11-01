import "server-only";

import { PrismaClient } from "@/generated/prisma/client";

import { createPrismaClient } from "@/server/catalog/prisma-client";
import { runtimeConnectionUrl } from "@/server/catalog/database-url";

const globalForPrisma = globalThis as { voyaraPrisma?: PrismaClient };

export function getDatabase(): PrismaClient {
  if (globalForPrisma.voyaraPrisma) {
    return globalForPrisma.voyaraPrisma;
  }

  const prisma = createPrismaClient(runtimeConnectionUrl(process.env.DATABASE_URL));
  globalForPrisma.voyaraPrisma = prisma;
  return prisma;
}
