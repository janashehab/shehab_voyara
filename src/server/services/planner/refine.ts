import type { CatalogSnapshot } from "@/lib/catalog";
import { refinementInstructionSchema } from "@/features/trips/schemas";
import type { PlannerModel } from "@/server/ai/types";
import { createIdFactory, type IdFactory } from "./ids";
import { zodIssues } from "./issues";
import { isProtected, planFromDraft, type PlanDraftResult } from "./policy";
import { requestAcceptedDraft } from "./run-model";
import { parseTripDocument } from "./validate";

/**
 * Refinement asks the model for a new draft, then puts locked stops and
 * traveler-added stops back where they were. If the draft is unusable, the
 * previous trip is returned unchanged with the failure. A validation failure
 * on the submitted document does not produce a replacement plan.
 */
export async function refineItinerary(input: {
  trip: unknown;
  instruction: unknown;
  catalog: CatalogSnapshot;
  model: PlannerModel;
  ids?: IdFactory;
}): Promise<PlanDraftResult> {
  const parsed = parseTripDocument(input.trip, input.catalog);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, trip: null };
  }

  const instruction = refinementInstructionSchema.safeParse(input.instruction);
  if (!instruction.success) {
    return { ok: false, issues: zodIssues(instruction.error), trip: parsed.trip };
  }

  const items = [
    ...parsed.trip.days.flatMap((day) => day.items),
    ...parsed.trip.unscheduled,
  ];
  const lockedPlaceIds = items.filter((item) => item.lock === "locked").map((item) => item.placeId);
  const travelerPlaceIds = items
    .filter((item) => item.source === "traveler")
    .map((item) => item.placeId);

  const accepted = await requestAcceptedDraft({
    model: input.model,
    retrieval: parsed.retrieval,
    preferences: parsed.trip.preferences,
    instruction: instruction.data,
    lockedPlaceIds,
    travelerPlaceIds,
  });

  if (!accepted.ok) {
    return { ok: false, issues: accepted.issues, trip: parsed.trip };
  }

  const planned = planFromDraft({
    preferences: parsed.trip.preferences,
    draft: accepted.draft,
    previous: parsed.trip,
    catalog: input.catalog,
    ids: input.ids ?? createIdFactory(),
    draftRejected: false,
  });

  if (!planned.ok) {
    return { ok: false, issues: planned.issues, trip: parsed.trip };
  }

  const kept = items.filter(isProtected);
  const restoredMissing = kept.filter(
    (item) =>
      !planned.trip.days.some((day) => day.items.some((candidate) => candidate.id === item.id)) &&
      !planned.trip.unscheduled.some((candidate) => candidate.id === item.id),
  );
  if (restoredMissing.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: "protected_stop_missing",
          path: restoredMissing[0]?.id ?? "items",
          message: "A locked or traveler-added stop could not be kept. The previous plan was left unchanged.",
        },
      ],
      trip: parsed.trip,
    };
  }

  return planned;
}
