import { interestValues, paceValues, type TravelerPreferences } from "@/features/trips/schemas";
import { z } from "zod";

import type { PendingBrief } from "./concierge-display";

export const PLAN_STORAGE_KEY = "voyara.plan.v1";
export const PLAN_STORAGE_VERSION = 1;
export const PLAN_STORAGE_MAX_BYTES = 48_000;

export type PlanStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type SavedQuestionnaire = {
  step: "place" | "days" | "interests" | "pace" | "plan";
  dayCount: number | null;
  interests: string[];
  pace: TravelerPreferences["pace"] | null;
};

/** Untrusted browser envelope. The trip is not shown until the server revalidates it. */
export const undoLabels = ["less walking", "more cafés", "museum"] as const;
export type UndoLabel = (typeof undoLabels)[number];

/** One earlier confirmed trip. This is not the planner's undoAi snapshot. */
export type SavedUndo = {
  label: UndoLabel;
  trip: Record<string, unknown>;
};

export type SavedPlan = {
  version: 1;
  trip: Record<string, unknown> | null;
  questionnaire: SavedQuestionnaire;
  selectedDay: number;
  initialPace: TravelerPreferences["pace"] | null;
  pending: PendingBrief | null;
  undo: SavedUndo | null;
};

export type StorageMode = "hold" | "ready" | "blocked";

export type ReadPlanResult =
  | { status: "empty" }
  | { status: "unavailable" }
  | { status: "rejected"; reason: "malformed" | "version" | "oversized" | "invalid" }
  | { status: "ok"; envelope: SavedPlan };

const questionnaireSchema = z
  .object({
    step: z.enum(["place", "days", "interests", "pace", "plan"]),
    dayCount: z.number().int().min(1).max(14).nullable(),
    interests: z.array(z.enum(interestValues)).max(6),
    pace: z.enum(paceValues).nullable(),
  })
  .strict();

const pendingSchema = z
  .object({
    dayCount: z.number().int().min(1).max(14).optional(),
    interests: z.array(z.enum(interestValues)).max(6).optional(),
    pace: z.enum(paceValues).optional(),
  })
  .strict();

const undoSchema = z
  .object({
    label: z.enum(undoLabels),
    trip: z.record(z.string(), z.unknown()),
  })
  .strict();

const envelopeSchema = z
  .object({
    version: z.literal(PLAN_STORAGE_VERSION),
    trip: z.record(z.string(), z.unknown()).nullable(),
    questionnaire: questionnaireSchema,
    selectedDay: z.number().int().min(1).max(14),
    initialPace: z.enum(paceValues).nullable(),
    pending: pendingSchema.nullable(),
    undo: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.trip && Object.hasOwn(value.trip, "catalog")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trip"],
        message: "The saved plan cannot include a catalog.",
      });
    }
  });

export function undoLabelForInstruction(instruction: string): UndoLabel | null {
  const value = instruction.trim().toLowerCase();
  if (value === "less walking") {
    return "less walking";
  }
  if (value === "more cafés" || value === "more cafes") {
    return "more cafés";
  }
  if (value === "replace a museum") {
    return "museum";
  }
  return null;
}

/** A failed or unsupported change keeps the previous snapshot. Success replaces it. */
export function undoForRefinement(
  existing: SavedUndo | null,
  previousTrip: Record<string, unknown> | null,
  label: UndoLabel | null,
  succeeded: boolean,
): SavedUndo | null {
  if (!succeeded || !label || !previousTrip) {
    return existing;
  }
  return { label, trip: previousTrip };
}

/**
 * The undo trip is checked on its own. An invalid snapshot is dropped.
 * A catalog outage keeps the stored snapshot for a later retry.
 */
export function restoredUndo(
  stored: SavedUndo | null,
  result: { ok: true; trip: Record<string, unknown> } | { ok: false; code: string },
): { undo: SavedUndo | null; discarded: boolean } {
  if (!stored) {
    return { undo: null, discarded: false };
  }
  if (result.ok) {
    return { undo: { label: stored.label, trip: result.trip }, discarded: false };
  }
  if (result.code === "catalog_unavailable") {
    return { undo: stored, discarded: false };
  }
  return { undo: null, discarded: true };
}

export function storageWriteAllowed(mode: StorageMode): boolean {
  return mode === "ready";
}

export function shouldApplyRestore(startedGeneration: number, currentGeneration: number): boolean {
  return startedGeneration === currentGeneration;
}

export function savedPlanDisposition(code: string): "keep" | "clear" {
  return code === "catalog_unavailable" ? "keep" : "clear";
}

export function restoredSelectedDay(selectedDay: number, days: readonly { dayIndex: number }[]): number {
  if (days.some((day) => day.dayIndex === selectedDay)) {
    return selectedDay;
  }
  return days[0]?.dayIndex ?? 1;
}

export function isBlankPlan(envelope: SavedPlan): boolean {
  return (
    envelope.trip === null &&
    envelope.pending === null &&
    envelope.questionnaire.step === "place" &&
    envelope.questionnaire.dayCount === null &&
    envelope.questionnaire.interests.length === 0 &&
    envelope.questionnaire.pace === null &&
    envelope.initialPace === null
  );
}

export function readPlan(storage: PlanStorage): ReadPlanResult {
  let raw: string | null;
  try {
    raw = storage.getItem(PLAN_STORAGE_KEY);
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null || raw === "") {
    return { status: "empty" };
  }
  if (byteLength(raw) > PLAN_STORAGE_MAX_BYTES) {
    return { status: "rejected", reason: "oversized" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "rejected", reason: "malformed" };
  }
  if (!isRecord(parsed) || parsed.version !== PLAN_STORAGE_VERSION) {
    return { status: "rejected", reason: "version" };
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return { status: "rejected", reason: "invalid" };
  }
  const pending = envelope.data.pending;
  return {
    status: "ok",
    envelope: {
      ...envelope.data,
      pending: pending && Object.keys(pending).length > 0 ? pending : null,
      undo: acceptedUndo(envelope.data.undo),
    },
  };
}

export function writePlan(
  storage: PlanStorage,
  envelope: SavedPlan,
): "saved" | "trimmed" | "unavailable" | "oversized" {
  const payload = JSON.stringify(storedEnvelope(envelope, true));
  if (byteLength(payload) <= PLAN_STORAGE_MAX_BYTES) {
    return commitPlan(storage, payload);
  }
  if (envelope.undo) {
    const withoutUndo = JSON.stringify(storedEnvelope(envelope, false));
    if (byteLength(withoutUndo) <= PLAN_STORAGE_MAX_BYTES) {
      const written = commitPlan(storage, withoutUndo);
      return written === "saved" ? "trimmed" : written;
    }
  }
  return "oversized";
}

export function clearPlan(storage: PlanStorage): "cleared" | "unavailable" {
  try {
    storage.removeItem(PLAN_STORAGE_KEY);
    return "cleared";
  } catch {
    return "unavailable";
  }
}

function commitPlan(storage: PlanStorage, payload: string): "saved" | "unavailable" {
  try {
    storage.setItem(PLAN_STORAGE_KEY, payload);
    return "saved";
  } catch {
    return "unavailable";
  }
}

function storedEnvelope(envelope: SavedPlan, includeUndo: boolean): unknown {
  const trip = envelope.trip ? { ...envelope.trip, notices: [] } : null;
  const base = {
    version: envelope.version,
    trip,
    questionnaire: envelope.questionnaire,
    selectedDay: envelope.selectedDay,
    initialPace: envelope.initialPace,
    pending: envelope.pending,
  };
  if (!includeUndo || !envelope.undo) {
    return base;
  }
  return {
    ...base,
    undo: {
      label: envelope.undo.label,
      trip: { ...envelope.undo.trip, notices: [] },
    },
  };
}

function acceptedUndo(value: unknown): SavedUndo | null {
  if (value == null) {
    return null;
  }
  const parsed = undoSchema.safeParse(value);
  if (!parsed.success || Object.hasOwn(parsed.data.trip, "catalog")) {
    return null;
  }
  return parsed.data;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
