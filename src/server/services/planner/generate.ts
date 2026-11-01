import type { CatalogSnapshot } from "@/lib/catalog";
import { plannerDraftSchema, type PlannerDraft } from "@/features/trips/schemas";
import type { PlannerModel } from "@/server/ai/types";
import { createIdFactory, type IdFactory } from "./ids";
import { planFromDraft, type PlanDraftResult } from "./policy";
import { requestAcceptedDraft } from "./run-model";
import { parseTravelerPreferences } from "./validate";

export type PlanResult = PlanDraftResult;

const emptyDraft: PlannerDraft = plannerDraftSchema.parse({
  summary: "",
  days: [],
  unscheduledPlaceIds: [],
});

export async function generateItinerary(input: {
  preferences: unknown;
  catalog: CatalogSnapshot;
  model: PlannerModel;
  ids?: IdFactory;
}): Promise<PlanResult> {
  const parsed = parseTravelerPreferences(input.preferences, input.catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: null };
  }

  const ids = input.ids ?? createIdFactory();
  const accepted = await requestAcceptedDraft({
    model: input.model,
    retrieval: parsed.retrieval,
    preferences: parsed.preferences,
    instruction: null,
    lockedPlaceIds: [],
    travelerPlaceIds: [],
  });

  if (!accepted.ok) {
    return planFromDraft({
      preferences: parsed.preferences,
      draft: emptyDraft,
      previous: null,
      catalog: input.catalog,
      ids,
      draftRejected: true,
    });
  }

  return planFromDraft({
    preferences: parsed.preferences,
    draft: accepted.draft,
    previous: null,
    catalog: input.catalog,
    ids,
    draftRejected: false,
  });
}
