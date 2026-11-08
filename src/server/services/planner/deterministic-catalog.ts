import type { PrismaClient } from "@/generated/prisma/client";
import { loadApprovedEditorialCatalog } from "@/server/catalog/planner-snapshot";

import { generateDeterministicItinerary } from "./deterministic";
import type { IdFactory } from "./ids";
import type { PlanDraftResult } from "./policy";
import { refineDeterministicItinerary } from "./refine-deterministic";

/**
 * Reads approved editorial rows, including an approved stay base, country,
 * and region. Draft destinations and historical amounts stay out of the snapshot.
 */
export async function generateDeterministicItineraryFromApprovedCatalog(
  prisma: PrismaClient,
  input: { preferences: unknown; ids?: IdFactory },
): Promise<PlanDraftResult> {
  const catalog = await loadApprovedEditorialCatalog(prisma);
  return generateDeterministicItinerary({
    preferences: input.preferences,
    catalog,
    ids: input.ids,
  });
}

export async function refineDeterministicItineraryFromApprovedCatalog(
  prisma: PrismaClient,
  input: { trip: unknown; instruction: unknown; ids?: IdFactory },
): Promise<PlanDraftResult> {
  const catalog = await loadApprovedEditorialCatalog(prisma);
  return refineDeterministicItinerary({
    trip: input.trip,
    instruction: input.instruction,
    catalog,
    ids: input.ids,
  });
}
