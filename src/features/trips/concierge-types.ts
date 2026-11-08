import type { Interest, TravelerPreferences, TripDocument } from "@/features/trips/schemas";

/**
 * Plain view of a plan. A later interpreter can return the same shape.
 * The catalog, prices, and connection details are not part of it.
 */
export type ConciergeStop = {
  itemId: string;
  placeId: string;
  name: string;
  summary: string;
  areaLabel: string | null;
  reason: string | null;
  visitEstimate: string | null;
  routeNote: string | null;
  locked: boolean;
  photo: { src: string; alt: string; width: number; height: number } | null;
};

export type ConciergeNotice = {
  code: string;
  message: string;
  dayIndex: number | null;
};

export type ConciergeMuseumChoice = {
  itemId: string;
  name: string;
  dayIndex: number | null;
};

export type ConciergeView = {
  summary: string;
  pace: "unhurried" | "steady" | "full";
  mobility: "limited_walking" | "step_free_preferred" | null;
  museumChoices: ConciergeMuseumChoice[];
  days: {
    dayIndex: number;
    stops: ConciergeStop[];
    notice: string | null;
  }[];
  unscheduled: ConciergeStop[];
  notices: ConciergeNotice[];
};

export type ConciergeIssue = {
  code: string;
  message: string;
};

export type ConciergeResult =
  | { ok: true; trip: TripDocument; view: ConciergeView }
  | {
      ok: false;
      error: ConciergeIssue;
      issues: ConciergeIssue[];
      trip: TripDocument | null;
      view: ConciergeView | null;
    };

/** Fields the interpreter extracted. Place ids are not part of this draft. */
export type InterpretedPlanDraft = {
  destinationId: "dst_paris" | null;
  dayCount: number | null;
  interests: Interest[];
  pace: TravelerPreferences["pace"] | null;
  companions: TravelerPreferences["companions"] | null;
  exclusions: Interest[];
  mustSeeNames: string[];
  mobility: "limited_walking" | null;
};

export type InterpretationSummary = {
  headline: string;
  details: string[];
  unaffected: string;
};

export type InterpreterPreviewResult =
  | { ok: true; stage: "ready"; kind: "plan" | "refine"; summary: InterpretationSummary }
  | {
      ok: false;
      stage: "clarify";
      code: string;
      message: string;
      missing: string[];
      extracted: InterpretedPlanDraft | null;
      intents: string[];
    }
  | { ok: false; stage: "rejected"; error: ConciergeIssue };
