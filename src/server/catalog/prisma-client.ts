import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export function createPrismaClient(connectionString: string, poolMax?: number): PrismaClient {
  const adapter = new PrismaPg(
    poolMax === undefined ? { connectionString } : { connectionString, max: poolMax },
  );
  return new PrismaClient({ adapter });
}
