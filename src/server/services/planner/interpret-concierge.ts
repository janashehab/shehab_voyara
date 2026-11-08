import type { CatalogSnapshot } from "@/lib/catalog";
import { approvedCatalog } from "@/lib/catalog";
import type {
  ConciergeIssue,
  ConciergeResult,
  InterpretationSummary,
  InterpretedPlanDraft,
  InterpreterPreviewResult,
} from "@/features/trips/concierge-types";
import {
  interestValues,
  paceValues,
  type Interest,
  type TravelerPreferences,
  type TripDocument,
} from "@/features/trips/schemas";
import { developmentInterpreter } from "@/server/ai/development-interpreter";
import type { InterpreterModel } from "@/server/ai/types";
import { z } from "zod";

import { generateDeterministicItinerary } from "./deterministic";
import { presentConciergeTrip } from "./concierge";
import {
  interpretModelText,
  interpretWithModel,
  type ExtractedPlanFields,
  type InterpretationResult,
} from "./interpret";
import type { PlannerIssue } from "./issues";
import type { PlanDraftResult } from "./policy";
import { refineDeterministicItinerary, replaceDeterministicMuseumStop } from "./refine-deterministic";
import { parseTripDocument } from "./validate";

/**
 * Connects the development interpreter to the deterministic planner.
 * The catalog argument is a server snapshot. This module does not read the
 * database or accept a catalog, place id, or connection string from the
 * request. In-memory request screening stays in the server action. That
 * counter is per process, resets on restart, and is not a shared production
 * rate limit.
 */

const READ_FAILURE = "The concierge could not read that request.";
const UNAFFECTED = "Companions, dates, budget, and notes do not change which places are chosen.";

const blockedKeys = new Set([
  "catalog",
  "placeId",
  "placeIds",
  "itemId",
  "museumItemId",
  "replacementPlaceId",
  "databaseUrl",
  "databaseURL",
  "connectionString",
  "DATABASE_URL",
]);

const interestLabels: Record<Interest, string> = {
  landmarks: "landmarks",
  walks: "walks",
  museums: "museums",
  food: "food",
  shopping: "shopping",
  theme_parks: "theme parks",
  photo_stops: "photo stops",
};

const paceLabels: Record<TravelerPreferences["pace"], string> = {
  unhurried: "unhurried",
  steady: "steady",
  full: "full",
};

const draftSchema = z
  .object({
    destinationId: z.literal("dst_paris").nullable(),
    dayCount: z.number().int().nullable(),
    interests: z.array(z.enum(interestValues)).max(6),
    pace: z.enum(paceValues).nullable(),
    companions: z.enum(["solo", "couple", "family", "friends"]).nullable(),
    exclusions: z.array(z.enum(interestValues)).max(7),
    mustSeeNames: z.array(z.string().trim().min(1).max(80)).max(12),
    mobility: z.literal("limited_walking").nullable(),
  })
  .strict();

const answerSchema = z
  .object({
    destinationId: z.literal("dst_paris").optional(),
    dayCount: z.number().int().min(1).max(7).optional(),
    interests: z.array(z.enum(interestValues)).min(1).max(6).optional(),
    pace: z.enum(paceValues).optional(),
  })
  .strict()
  .refine((value) => value.destinationId !== undefined || value.dayCount !== undefined || value.interests !== undefined || value.pace !== undefined);

const textSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
  })
  .strict();

const refinementSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    trip: z.unknown(),
  })
  .strict();

type PlanAnswer = z.infer<typeof answerSchema>;

export async function previewDevelopmentPlan(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  model?: InterpreterModel;
}): Promise<InterpreterPreviewResult> {
  const read = readPlanRequest(input.request);
  if (!read.ok) {
    return read.preview;
  }
  const interpretation = await interpretPlanRequest(read.value, input.catalog, input.model);
  return previewFromInterpretation(interpretation, input.catalog, null);
}

export async function confirmDevelopmentPlan(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  model?: InterpreterModel;
}): Promise<ConciergeResult> {
  const read = readPlanRequest(input.request);
  if (!read.ok) {
    return rejectedResult(read.preview);
  }
  const interpretation = await interpretPlanRequest(read.value, input.catalog, input.model);
  if (!interpretation.ok || interpretation.kind !== "plan") {
    return rejectedResult(previewFromInterpretation(interpretation, input.catalog, null));
  }
  return fromDraft(
    generateDeterministicItinerary({ preferences: interpretation.preferences, catalog: input.catalog }),
    input.catalog,
  );
}

export async function previewDevelopmentRefinement(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  model?: InterpreterModel;
}): Promise<InterpreterPreviewResult> {
  const read = readRefinementRequest(input.request, input.catalog);
  if (!read.ok) {
    return read.preview;
  }
  const interpretation = await interpretRefinement(read.text, read.trip, input.catalog, input.model);
  return previewFromInterpretation(interpretation, input.catalog, read.trip);
}

export async function confirmDevelopmentRefinement(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  model?: InterpreterModel;
}): Promise<ConciergeResult> {
  const read = readRefinementRequest(input.request, input.catalog);
  if (!read.ok) {
    return rejectedResult(read.preview);
  }
  const interpretation = await interpretRefinement(read.text, read.trip, input.catalog, input.model);
  if (!interpretation.ok || interpretation.kind !== "refine") {
    const preview = previewFromInterpretation(interpretation, input.catalog, read.trip);
    return holdTrip(preview, read.trip, input.catalog);
  }
  if (interpretation.museumItemId) {
    return fromDraft(
      replaceDeterministicMuseumStop({
        trip: read.trip,
        itemId: interpretation.museumItemId,
        catalog: input.catalog,
      }),
      input.catalog,
    );
  }
  return fromDraft(
    refineDeterministicItinerary({
      trip: read.trip,
      instruction: interpretation.phrase,
      catalog: input.catalog,
    }),
    input.catalog,
  );
}

async function interpretPlanRequest(
  value: { mode: "text"; text: string } | { mode: "answer"; extracted: ExtractedPlanFields; answer: PlanAnswer },
  catalog: CatalogSnapshot,
  model: InterpreterModel | undefined,
): Promise<InterpretationResult> {
  if (value.mode === "text") {
    return interpretText(value.text, catalog, null, model);
  }
  return interpretModelText({
    text: planTextFromParts(value.extracted, value.answer),
    catalog,
    trip: null,
  });
}

async function interpretRefinement(
  text: string,
  trip: TripDocument,
  catalog: CatalogSnapshot,
  model: InterpreterModel | undefined,
): Promise<InterpretationResult> {
  const interpretation = await interpretText(text, catalog, trip, model);
  if (interpretation.ok && interpretation.kind === "plan") {
    return {
      ok: false,
      kind: "unsupported",
      code: "unsupported_request",
      message: "That phrase starts a new plan. The current trip was not changed.",
    };
  }
  return interpretation;
}

function interpretText(
  text: string,
  catalog: CatalogSnapshot,
  trip: TripDocument | null,
  model: InterpreterModel | undefined,
): Promise<InterpretationResult> {
  return interpretWithModel({
    model: model ?? developmentInterpreter(),
    travelerText: text,
    catalog,
    trip,
  });
}

function previewFromInterpretation(
  interpretation: InterpretationResult,
  catalog: CatalogSnapshot,
  trip: TripDocument | null,
): InterpreterPreviewResult {
  if (interpretation.ok && interpretation.kind === "plan") {
    return { ok: true, stage: "ready", kind: "plan", summary: describePlan(interpretation.preferences, catalog) };
  }
  if (interpretation.ok && interpretation.kind === "refine") {
    return {
      ok: true,
      stage: "ready",
      kind: "refine",
      summary: describeRefinement(interpretation.intent, museumName(trip, catalog, interpretation.museumItemId)),
    };
  }
  if (!interpretation.ok && interpretation.kind === "clarify") {
    return {
      ok: false,
      stage: "clarify",
      code: interpretation.code,
      message: safeCopy(interpretation.message),
      missing: interpretation.missing,
      extracted: interpretation.extracted ? toDraft(interpretation.extracted) : null,
      intents: interpretation.intents,
    };
  }
  return {
    ok: false,
    stage: "rejected",
    error: {
      code: interpretation.kind === "invalid" ? interpretation.code : interpretation.code,
      message: safeCopy(interpretation.message),
    },
  };
}

function describePlan(preferences: TravelerPreferences, catalog: CatalogSnapshot): InterpretationSummary {
  const dayCount = preferences.dayCount ?? 0;
  const days = dayCount === 1 ? "1 day" : `${dayCount} days`;
  const interests = preferences.interests.map((interest) => interestLabels[interest]).join(", ");
  const mustSee = preferences.constraints.mustSeePlaceIds.map((placeId) => placeName(catalog, placeId)).join(", ");
  const focus = [interests, mustSee ? `must-see ${mustSee}` : ""].filter((part) => part.length > 0).join(", ");
  const headline = focus
    ? `${days} in Paris, ${focus}, ${paceLabels[preferences.pace]} pace.`
    : `${days} in Paris, ${paceLabels[preferences.pace]} pace.`;
  const details: string[] = [];
  if (preferences.exclusions.avoid.length > 0) {
    details.push(`Avoid: ${preferences.exclusions.avoid.map((interest) => interestLabels[interest]).join(", ")}.`);
  }
  if (preferences.constraints.mobility === "limited_walking") {
    details.push("Limited walking changes how many stops fit. Distance and access are not verified.");
  }
  return { headline, details, unaffected: UNAFFECTED };
}

function describeRefinement(intent: "less_walking" | "more_food" | "replace_museum", name: string | null): InterpretationSummary {
  if (intent === "less_walking") {
    return {
      headline: "Less walking.",
      details: ["The pace used to fit stops changes."],
      unaffected: UNAFFECTED,
    };
  }
  if (intent === "more_food") {
    return {
      headline: "More cafés.",
      details: ["Food is added as an interest, and an approved dining place can be scheduled."],
      unaffected: UNAFFECTED,
    };
  }
  if (name) {
    return {
      headline: `Replace ${name}.`,
      details: ["The replacement place is chosen from the approved catalog."],
      unaffected: UNAFFECTED,
    };
  }
  return {
    headline: "Replace a museum.",
    details: ["If more than one unlocked museum can change, choose one of the existing options. Nothing is removed until you do."],
    unaffected: UNAFFECTED,
  };
}

function planTextFromParts(extracted: ExtractedPlanFields, answer: PlanAnswer): string {
  const destinationId = answer.destinationId ?? extracted.destinationId;
  const dayCount = answer.dayCount ?? extracted.dayCount;
  const pace = answer.pace ?? extracted.pace;
  const body: Record<string, unknown> = {
    kind: "plan",
    interests: answer.interests ?? extracted.interests,
    exclusions: extracted.exclusions,
    mustSeeNames: extracted.mustSeeNames,
    companions: extracted.companions,
    mobility: extracted.mobility,
  };
  if (destinationId) {
    body.destinationId = destinationId;
  }
  if (dayCount !== null) {
    body.dayCount = dayCount;
  }
  if (pace !== null) {
    body.pace = pace;
  }
  return JSON.stringify(body);
}

function readPlanRequest(
  request: unknown,
):
  | { ok: true; value: { mode: "text"; text: string } | { mode: "answer"; extracted: ExtractedPlanFields; answer: PlanAnswer } }
  | { ok: false; preview: InterpreterPreviewResult } {
  const blocked = blockedRequest(request);
  if (blocked) {
    return { ok: false, preview: blocked };
  }
  if (!isRecord(request)) {
    return { ok: false, preview: rejected(READ_FAILURE) };
  }
  if ("text" in request && ("extracted" in request || "answer" in request)) {
    return { ok: false, preview: rejected(READ_FAILURE) };
  }
  if ("text" in request) {
    const parsed = textSchema.safeParse(request);
    if (!parsed.success) {
      return { ok: false, preview: rejected(READ_FAILURE) };
    }
    return { ok: true, value: { mode: "text", text: parsed.data.text } };
  }
  const parsed = z.object({ extracted: draftSchema, answer: answerSchema }).strict().safeParse(request);
  if (!parsed.success) {
    return { ok: false, preview: rejected(READ_FAILURE) };
  }
  return {
    ok: true,
    value: { mode: "answer", extracted: parsed.data.extracted, answer: parsed.data.answer },
  };
}

function readRefinementRequest(
  request: unknown,
  catalog: CatalogSnapshot,
): { ok: true; text: string; trip: TripDocument } | { ok: false; preview: InterpreterPreviewResult } {
  const blocked = blockedRequest(request);
  if (blocked) {
    return { ok: false, preview: blocked };
  }
  const parsed = refinementSchema.safeParse(request);
  if (!parsed.success) {
    return { ok: false, preview: rejected(READ_FAILURE) };
  }
  const trip = parseTripDocument(parsed.data.trip, catalog);
  if (!trip.ok) {
    const safe = publicIssue(trip.issues[0]);
    return { ok: false, preview: rejected(safe.message, safe.code) };
  }
  return { ok: true, text: parsed.data.text, trip: trip.trip };
}

function blockedRequest(request: unknown): InterpreterPreviewResult | null {
  if (!isRecord(request)) {
    return null;
  }
  if ("catalog" in request) {
    return rejected("The catalog cannot be supplied with this request.", "untrusted_catalog");
  }
  for (const key of blockedKeys) {
    if (key in request) {
      return rejected(READ_FAILURE, "invalid_request");
    }
  }
  return null;
}

function museumName(trip: TripDocument | null, catalog: CatalogSnapshot, itemId: string | null): string | null {
  if (!trip || !itemId) {
    return null;
  }
  const item = [...trip.days.flatMap((day) => day.items), ...trip.unscheduled].find((entry) => entry.id === itemId);
  if (!item) {
    return null;
  }
  return placeName(catalog, item.placeId);
}

function placeName(catalog: CatalogSnapshot, placeId: string): string {
  return approvedCatalog(catalog).places.find((place) => place.id === placeId)?.name ?? "Approved place";
}

function toDraft(extracted: ExtractedPlanFields): InterpretedPlanDraft {
  return {
    destinationId: extracted.destinationId,
    dayCount: extracted.dayCount,
    interests: extracted.interests,
    pace: extracted.pace,
    companions: extracted.companions,
    exclusions: extracted.exclusions,
    mustSeeNames: extracted.mustSeeNames,
    mobility: extracted.mobility,
  };
}

function fromDraft(result: PlanDraftResult, catalog: CatalogSnapshot): ConciergeResult {
  if (result.ok) {
    return { ok: true, trip: result.trip, view: presentConciergeTrip(result.trip, catalog) };
  }
  const safe = result.issues.map(publicIssue);
  const first = safe[0] ?? { code: "invalid_request", message: READ_FAILURE };
  return {
    ok: false,
    error: first,
    issues: safe.length > 0 ? safe : [first],
    trip: result.trip,
    view: result.trip ? presentConciergeTrip(result.trip, catalog) : null,
  };
}

function holdTrip(preview: InterpreterPreviewResult, trip: TripDocument, catalog: CatalogSnapshot): ConciergeResult {
  if (preview.ok) {
    return rejectedResult(rejected(READ_FAILURE));
  }
  const error = preview.stage === "clarify" ? { code: preview.code, message: preview.message } : preview.error;
  return {
    ok: false,
    error,
    issues: [error],
    trip,
    view: presentConciergeTrip(trip, catalog),
  };
}

function rejectedResult(preview: InterpreterPreviewResult): ConciergeResult {
  const error = !preview.ok && preview.stage === "clarify"
    ? { code: preview.code, message: preview.message }
    : !preview.ok
      ? preview.error
      : { code: "invalid_request", message: READ_FAILURE };
  return { ok: false, error, issues: [error], trip: null, view: null };
}

function rejected(message: string, code = "invalid_request"): InterpreterPreviewResult {
  return { ok: false, stage: "rejected", error: { code, message: safeCopy(message) } };
}

function publicIssue(entry: PlannerIssue | undefined): ConciergeIssue {
  if (!entry || entry.code === "unrecognized_keys" || /postgres:\/\/|password|supabase|DATABASE_URL/i.test(entry.message)) {
    return {
      code: !entry || entry.code === "unrecognized_keys" ? "invalid_request" : "catalog_unavailable",
      message: READ_FAILURE,
    };
  }
  return { code: entry.code, message: entry.message };
}

function safeCopy(message: string): string {
  if (/postgres:\/\/|password|supabase|DATABASE_URL|@/i.test(message)) {
    return READ_FAILURE;
  }
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
