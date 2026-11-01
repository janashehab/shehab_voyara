import type { CatalogSnapshot } from "@/lib/catalog";
import { getPrototypeCatalog } from "@/lib/catalog";
import { generateItinerary } from "@/server/services/planner/generate";
import type { IdFactory } from "@/server/services/planner/ids";
import type { PlanDraftResult } from "@/server/services/planner/policy";
import type { PlannerModel } from "@/server/ai/types";

/**
 * The planner keeps its current rules. A repository only supplies the snapshot.
 * The in-memory planner repository remains on the Paris fixture. Public
 * editorial pages read approved rows from PostgreSQL.
 */
export interface PlannerCatalogRepository {
  loadPlannerSnapshot(): Promise<CatalogSnapshot>;
}

export function memoryPlannerRepository(): PlannerCatalogRepository {
  return {
    async loadPlannerSnapshot() {
      return getPrototypeCatalog();
    },
  };
}

export async function generateItineraryFromRepository(input: {
  repository: PlannerCatalogRepository;
  preferences: unknown;
  model: PlannerModel;
  ids?: IdFactory;
}): Promise<PlanDraftResult> {
  const catalog = await input.repository.loadPlannerSnapshot();
  return generateItinerary({
    preferences: input.preferences,
    catalog,
    model: input.model,
    ids: input.ids,
  });
}
