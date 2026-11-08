import { approvedCatalog, type CatalogSnapshot, type Place } from "@/lib/catalog";
import { interestValues, paceValues, type TripDocument } from "@/features/trips/schemas";
import type {
  ConciergeIssue,
  ConciergeNotice,
  ConciergeResult,
  ConciergeStop,
  ConciergeView,
} from "@/features/trips/concierge-types";
import {
  editorialVisitEstimate,
  eligibleSampleNote,
  interestExplanation,
} from "@/features/trips/itinerary-explanation";
import { placePhotos } from "@/lib/media/travel-photos";
import { z } from "zod";

import { lockStop, unlockStop } from "./edit";
import { generateDeterministicItinerary } from "./deterministic";
import { issue, zodIssues, type PlannerIssue } from "./issues";
import {
  coverageNotices,
  refineDeterministicItinerary,
  replaceDeterministicMuseumStop,
  replaceableMuseumStops,
} from "./refine-deterministic";
import { isMajorDayArea, retrieveDestination, type RetrievalSet } from "./retrieve";
import { parseTripDocument } from "./validate";

/**
 * Server-side concierge. Callers pass a catalog they loaded themselves.
 * The browser action does not accept a catalog argument.
 *
 * The in-memory attempt counter is per process. It resets on restart and is
 * not shared across instances, so it is not a production rate limit.
 */

export const CONCIERGE_MAX_BYTES = 24_000;
export const CONCIERGE_MAX_ATTEMPTS = 12;
export const CONCIERGE_WINDOW_MS = 60_000;

const buckets = new Map<string, { windowStart: number; count: number }>();

const onboardingSchema = z
  .object({
    destinationId: z.literal("dst_paris"),
    dayCount: z.number().int().min(1).max(7),
    interests: z.array(z.enum(interestValues)).min(1).max(6),
    pace: z.enum(paceValues),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.interests).size !== value.interests.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interests"],
        message: "Choose each interest once.",
        params: { plannerCode: "duplicate_value" },
      });
    }
  });

const refinementSchema = z
  .object({
    trip: z.unknown(),
    instruction: z.string().trim().min(1).max(500),
  })
  .strict();

const lockSchema = z
  .object({
    trip: z.unknown(),
    itemId: z.string().regex(/^itm_[a-z0-9_]+$/),
    locked: z.boolean(),
  })
  .strict();

const museumStopSchema = z
  .object({
    trip: z.unknown(),
    itemId: z.string().regex(/^itm_[a-z0-9_]+$/),
  })
  .strict();

export function resetConciergeAttempts(): void {
  buckets.clear();
}

export function planConcierge(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  now: number;
  callerKey: string;
  skipScreen?: boolean;
}): ConciergeResult {
  if (!input.skipScreen) {
    const guarded = screenConciergeRequest(input.request, input.now, input.callerKey);
    if (!guarded.ok) {
      return guarded;
    }
  }
  if (
    isRecord(input.request) &&
    "destinationId" in input.request &&
    input.request.destinationId !== "dst_paris"
  ) {
    return failure(
      issue(
        "unapproved_destination",
        "destinationId",
        "Paris is the only approved destination for planning today.",
      ),
      null,
    );
  }

  const parsed = onboardingSchema.safeParse(input.request);
  if (!parsed.success) {
    return failureList(zodIssues(parsed.error), null, null);
  }

  const planned = generateDeterministicItinerary({
    preferences: {
      destinationId: parsed.data.destinationId,
      startDate: null,
      endDate: null,
      dayCount: parsed.data.dayCount,
      companions: "solo",
      pace: parsed.data.pace,
      budget: "open",
      interests: parsed.data.interests,
      priorities: { vibe: null, placeStyle: null },
      exclusions: { avoid: [], placeIds: [] },
      constraints: { mustSeePlaceIds: [], mobility: null },
      notes: null,
    },
    catalog: input.catalog,
  });
  if (!planned.ok || !planned.trip) {
    return failureList(planned.ok ? [] : planned.issues, null, null);
  }
  return success(planned.trip, input.catalog);
}

export function refineConcierge(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  now: number;
  callerKey: string;
  skipScreen?: boolean;
}): ConciergeResult {
  if (!input.skipScreen) {
    const guarded = screenConciergeRequest(input.request, input.now, input.callerKey);
    if (!guarded.ok) {
      return guarded;
    }
  }
  const parsed = refinementSchema.safeParse(input.request);
  if (!parsed.success) {
    return failureList(zodIssues(parsed.error), null, null);
  }

  const refined = refineDeterministicItinerary({
    trip: parsed.data.trip,
    instruction: parsed.data.instruction,
    catalog: input.catalog,
  });
  if (!refined.ok) {
    return failureList(refined.issues, refined.trip, input.catalog);
  }
  return success(refined.trip, input.catalog);
}

export function replaceConciergeMuseum(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  now: number;
  callerKey: string;
  skipScreen?: boolean;
}): ConciergeResult {
  if (!input.skipScreen) {
    const guarded = screenConciergeRequest(input.request, input.now, input.callerKey);
    if (!guarded.ok) {
      return guarded;
    }
  }
  const parsed = museumStopSchema.safeParse(input.request);
  if (!parsed.success) {
    return failureList(zodIssues(parsed.error), null, null);
  }
  const replaced = replaceDeterministicMuseumStop({
    trip: parsed.data.trip,
    itemId: parsed.data.itemId,
    catalog: input.catalog,
  });
  if (!replaced.ok) {
    return failureList(replaced.issues, replaced.trip, input.catalog);
  }
  return success(replaced.trip, input.catalog);
}

export function lockConciergeStop(input: {
  request: unknown;
  catalog: CatalogSnapshot;
  now: number;
  callerKey: string;
  skipScreen?: boolean;
}): ConciergeResult {
  if (!input.skipScreen) {
    const guarded = screenConciergeRequest(input.request, input.now, input.callerKey);
    if (!guarded.ok) {
      return guarded;
    }
  }
  const parsed = lockSchema.safeParse(input.request);
  if (!parsed.success) {
    return failureList(zodIssues(parsed.error), null, null);
  }
  const trip = parseTripDocument(parsed.data.trip, input.catalog);
  if (!trip.ok) {
    return failureList(trip.issues, null, null);
  }
  const edited = parsed.data.locked
    ? lockStop(trip.trip, input.catalog, parsed.data.itemId)
    : unlockStop(trip.trip, input.catalog, parsed.data.itemId);
  if (!edited.ok) {
    return failureList(edited.issues, trip.trip, input.catalog);
  }
  return success(edited.trip, input.catalog);
}

export function presentConciergeTrip(trip: TripDocument, catalog: CatalogSnapshot): ConciergeView {
  const retrieval = retrieveDestination(catalog, trip.destinationId);
  const approved = approvedCatalog(catalog);
  const places = new Map<string, Place>(approved.places.map((place) => [place.id, place]));
  const sampleNotes = new Map<string, (string | null)[]>();
  for (const item of approved.sampleItineraryItems) {
    const notes = sampleNotes.get(item.placeId) ?? [];
    notes.push(item.editorialNote);
    sampleNotes.set(item.placeId, notes);
  }
  const notices = mergeNotices(trip, retrieval);
  const explain = (item: { id: string; placeId: string; lock: "locked" | "unlocked" }) =>
    toStop(item, places, sampleNotes, trip.preferences.interests);
  return {
    summary: trip.summary,
    pace: trip.preferences.pace,
    mobility: trip.preferences.constraints.mobility,
    museumChoices: retrieval
      ? replaceableMuseumStops(trip, retrieval).map((stop) => ({
          itemId: stop.itemId,
          name: places.get(stop.placeId)?.name ?? "Approved place",
          dayIndex: stop.dayIndex,
        }))
      : [],
    days: trip.days.map((day) => ({
      dayIndex: day.dayIndex,
      stops: day.items.map((item) => explain(item)),
      notice:
        notices.find((notice) => notice.code === "catalog_gap" && notice.dayIndex === day.dayIndex)?.message ??
        null,
    })),
    unscheduled: trip.unscheduled.map((item) => explain(item)),
    notices,
  };
}

const revalidateRequestSchema = z.object({ trip: z.unknown() }).strict();

/**
 * A browser-saved trip is untrusted. Notices and place copy are rebuilt from
 * the approved catalog. This does not plan, refine, or lock.
 */
export function revalidateSavedTrip(request: unknown, catalog: CatalogSnapshot): ConciergeResult {
  const parsed = revalidateRequestSchema.safeParse(request);
  if (!parsed.success) {
    return failureList(zodIssues(parsed.error), null, null);
  }
  const trip = parseTripDocument(withoutSavedNotices(parsed.data.trip), catalog);
  if (!trip.ok) {
    return failureList(trip.issues, null, null);
  }
  return success(trip.trip, catalog);
}

export function conciergeFailure(error: unknown): ConciergeResult {
  const message = error instanceof Error ? error.message : "";
  const leaked = /postgres:\/\/|password|supabase|DATABASE_URL|@/i.test(message);
  console.error(leaked ? "Concierge catalog read failed." : `Concierge catalog read failed. ${message.slice(0, 120)}`);
  return failure(issue("catalog_unavailable", "catalog", "The approved catalog could not be read."), null);
}

export function screenConciergeRequest(
  request: unknown,
  now: number,
  callerKey: string,
): ConciergeResult | { ok: true } {
  if (payloadTooLarge(request) || (isRecord(request) && "catalog" in request)) {
    return failure(
      issue(
        isRecord(request) && "catalog" in request ? "untrusted_catalog" : "payload_too_large",
        "request",
        isRecord(request) && "catalog" in request
          ? "The catalog cannot be supplied with this request."
          : "That planning request is too large.",
      ),
      null,
    );
  }
  const attempt = consumeConciergeAttempt(callerKey, now);
  if (!attempt.ok) {
    return attempt;
  }
  return { ok: true };
}

function consumeConciergeAttempt(callerKey: string, now: number): ConciergeResult | { ok: true } {
  const key = callerKey.trim().slice(0, 80) || "anonymous";
  if (buckets.size > 1_000) {
    buckets.clear();
  }
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= CONCIERGE_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (existing.count >= CONCIERGE_MAX_ATTEMPTS) {
    return failure(
      issue("rate_limited", "request", "Too many planning requests. Wait a moment and try again."),
      null,
    );
  }
  existing.count += 1;
  return { ok: true };
}

function payloadTooLarge(request: unknown): boolean {
  try {
    return JSON.stringify(request).length > CONCIERGE_MAX_BYTES;
  } catch {
    return true;
  }
}

function success(trip: TripDocument, catalog: CatalogSnapshot): ConciergeResult {
  return { ok: true, trip, view: presentConciergeTrip(trip, catalog) };
}

function mergeNotices(trip: TripDocument, retrieval: RetrievalSet | null): ConciergeNotice[] {
  const stored: ConciergeNotice[] = trip.notices.map((notice) => ({
    code: notice.code,
    message: notice.message,
    dayIndex: notice.dayIndex,
  }));
  if (!retrieval) {
    return stored;
  }
  for (const notice of coverageNotices(trip, retrieval)) {
    if (
      stored.some(
        (existing) =>
          existing.code === notice.code &&
          existing.dayIndex === notice.dayIndex &&
          existing.message === notice.message,
      )
    ) {
      continue;
    }
    stored.push({ code: notice.code, message: notice.message, dayIndex: notice.dayIndex });
  }
  return stored;
}

function toStop(
  item: { id: string; placeId: string; lock: "locked" | "unlocked" },
  places: ReadonlyMap<string, Place>,
  sampleNotes: ReadonlyMap<string, readonly (string | null)[]>,
  interests: TripDocument["preferences"]["interests"],
): ConciergeStop {
  const place = places.get(item.placeId);
  const photo = place ? (placePhotos[place.id] ?? null) : null;
  const summary = place?.editorialSummary ?? "";
  const majorDayCommitment = isMajorDayArea(place?.areaLabel ?? null);
  return {
    itemId: item.id,
    placeId: item.placeId,
    name: place?.name ?? "Approved place",
    summary,
    areaLabel: place?.areaLabel ?? null,
    reason: place
      ? interestExplanation({ vibeTags: place.vibeTags, majorDayCommitment }, interests)
      : null,
    visitEstimate: editorialVisitEstimate(place?.approximateDurationMinutes),
    routeNote: eligibleSampleNote(sampleNotes.get(item.placeId) ?? [], summary),
    locked: item.lock === "locked",
    photo: photo ? { src: photo.src, alt: photo.alt, width: photo.width, height: photo.height } : null,
  };
}

function failureList(
  issues: readonly PlannerIssue[],
  trip: TripDocument | null,
  catalog: CatalogSnapshot | null,
): ConciergeResult {
  const safe = issues.map(publicIssue);
  const first = safe[0] ?? { code: "invalid_request", message: "The planning request could not be read." };
  return {
    ok: false,
    error: first,
    issues: safe.length > 0 ? safe : [first],
    trip,
    view: trip && catalog ? presentConciergeTrip(trip, catalog) : null,
  };
}

function failure(entry: PlannerIssue, trip: null): ConciergeResult {
  const safe = publicIssue(entry);
  return { ok: false, error: safe, issues: [safe], trip, view: null };
}

function publicIssue(entry: PlannerIssue): ConciergeIssue {
  if (entry.code === "unrecognized_keys" || /postgres:\/\/|password|supabase|DATABASE_URL/i.test(entry.message)) {
    return { code: entry.code === "unrecognized_keys" ? "invalid_request" : "catalog_unavailable", message: "The planning request could not be read." };
  }
  return { code: entry.code, message: entry.message };
}

function withoutSavedNotices(trip: unknown): unknown {
  if (!isRecord(trip)) {
    return trip;
  }
  return { ...trip, notices: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
