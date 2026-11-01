import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import type { PrismaClient } from "@/generated/prisma/client";
import { runtimeConnectionUrl } from "@/server/catalog/database-url";
import type { ImportReport } from "@/server/catalog/import-catalog";
import { importPersistentCatalog } from "@/server/catalog/import-catalog";
import { createPrismaClient } from "@/server/catalog/prisma-client";

async function main(): Promise<void> {
  if (existsSync(".env")) {
    loadEnvFile(".env");
  }

  const prisma = createPrismaClient(runtimeConnectionUrl(process.env.DATABASE_URL));
  try {
    const report = await importPersistentCatalog(prisma);
    const summary = await importSummary(prisma, report);
    printSummary(summary);
    if (summary.liveOrVerifiedAmounts > 0) {
      throw new Error("Historical amounts include a live or verified price.");
    }
    if (report.status === "applied" && summary.approvalAudits === 0 && summary.thailandNotDraft > 0) {
      throw new Error("The import left Thailand records outside draft before any admin audit.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(safeMessage(error));
  process.exitCode = 1;
});

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Catalog seed failed.";
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://***");
}

async function importSummary(prisma: PrismaClient, report: ImportReport) {
  const thailand = await prisma.country.findUnique({ where: { id: "cty_thailand" }, select: { id: true } });
  const thailandId = thailand?.id;
  const [approvalAudits, historicalAmounts, liveOrVerifiedAmounts, paris, thailandNotDraft] = await Promise.all([
    prisma.approvalAudit.count(),
    prisma.historicalAmount.count(),
    prisma.historicalAmount.count({
      where: {
        OR: [{ liveQuote: true }, { lastVerifiedAt: { not: null } }, { expiresAt: { not: null } }],
      },
    }),
    prisma.stayBase.findUnique({ where: { id: "dst_paris" }, select: { approval: true } }),
    countThailandOutsideDraft(prisma, thailandId),
  ]);

  return {
    ...report,
    approvalAudits,
    historicalAmounts,
    liveOrVerifiedAmounts,
    parisStayBaseApproval: paris?.approval ?? null,
    thailandNotDraft,
  };
}

async function countThailandOutsideDraft(prisma: PrismaClient, thailandId: string | undefined): Promise<number> {
  if (thailandId === undefined) {
    return 0;
  }
  const [countries, regions, stayBases, areas, properties, rates, flights, recommendations] = await Promise.all([
    prisma.country.count({ where: { id: thailandId, approval: { not: "draft" } } }),
    prisma.region.count({ where: { countryId: thailandId, approval: { not: "draft" } } }),
    prisma.stayBase.count({ where: { countryId: thailandId, approval: { not: "draft" } } }),
    prisma.area.count({ where: { stayBase: { countryId: thailandId }, approval: { not: "draft" } } }),
    prisma.stayProperty.count({ where: { countryId: thailandId, approval: { not: "draft" } } }),
    prisma.stayRate.count({ where: { property: { countryId: thailandId }, approval: { not: "draft" } } }),
    prisma.flightTemplate.count({ where: { approval: { not: "draft" } } }),
    prisma.editorialRecommendation.count({ where: { approval: { not: "draft" } } }),
  ]);
  return countries + regions + stayBases + areas + properties + rates + flights + recommendations;
}

function printSummary(summary: {
  status: "applied" | "skipped";
  runId: string;
  holds: number;
  properties: number;
  rates: number;
  flights: number;
  approvalAudits: number;
  historicalAmounts: number;
  liveOrVerifiedAmounts: number;
  parisStayBaseApproval: string | null;
  thailandNotDraft: number;
}): void {
  console.log(`Catalog import ${summary.status}`);
  console.log(`Run: ${summary.runId}`);
  console.log(`Holds: ${summary.holds}`);
  console.log(`Properties: ${summary.properties}`);
  console.log(`Rates: ${summary.rates}`);
  console.log(`Flights: ${summary.flights}`);
  console.log(`Thailand rows outside draft: ${summary.thailandNotDraft}`);
  console.log(`Historical amounts: ${summary.historicalAmounts}`);
  console.log(`Live or verified historical amounts: ${summary.liveOrVerifiedAmounts}`);
  console.log(`Paris stay base approval: ${summary.parisStayBaseApproval ?? "missing"}`);
  console.log(`Approval audits: ${summary.approvalAudits}`);
}
