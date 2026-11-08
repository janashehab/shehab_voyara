import type { MobilityNeed, TravelerPreferences } from "@/features/trips/schemas";

const paceLabels: Record<TravelerPreferences["pace"], string> = {
  unhurried: "Unhurried",
  steady: "Steady",
  full: "Full",
};

export const interestLabels = {
  landmarks: "Landmarks",
  walks: "Walks",
  museums: "Museums",
  food: "Food",
  shopping: "Shopping",
  theme_parks: "Theme parks",
  photo_stops: "Photo stops",
} as const;

const interestOrder = Object.keys(interestLabels) as (keyof typeof interestLabels)[];

export type TripBrief = {
  dayCount: number;
  interests: readonly string[];
  pace: TravelerPreferences["pace"];
};

/** Fields the traveler has changed and not yet applied to the draft. */
export type PendingBrief = {
  dayCount?: number;
  interests?: readonly string[];
  pace?: TravelerPreferences["pace"];
};

export type BriefAction =
  | { type: "day"; dayCount: number }
  | { type: "interests"; interests: readonly string[] }
  | { type: "pace"; pace: TravelerPreferences["pace"] }
  | { type: "cancel" }
  | { type: "escape" }
  | { type: "confirm" };

export type BriefState = {
  pending: PendingBrief | null;
  replace: boolean;
};

export const pendingAnswersCopy = {
  differs: "These answers differ from the draft.",
  stays: "The draft, including locked stops and follow-up changes, stays as it is until you update it.",
  matches: "These answers match the current draft.",
  needInterest: "Choose at least one interest before updating the draft.",
} as const;

export const replacementDialog = {
  title: "Replace this draft?",
  body: "A new draft replaces this one. Locked stops and follow-up changes, such as less walking or more cafés, are discarded.",
  keep: "Keep this draft",
  confirm: "Replace the draft",
} as const;

export const replacementKeptDraft = "The current draft is unchanged.";

export const lockStopNote =
  "Lock a stop to keep it when you ask for less walking, more cafés, or a museum change. Updating the draft from new answers replaces the whole plan, including locked stops.";

export const lockedStopStatus = "Stays through a change.";

export function lockStopName(name: string, locked: boolean): string {
  return locked ? `Unlock ${name}` : `Lock ${name}`;
}

export const startOverDialog = {
  title: "Start over?",
  withDraft: "This clears the draft and your answers. Locked stops are cleared with it. The copy in this browser is removed too.",
  withoutDraft: "This clears your answers in this browser.",
  keep: "Keep planning",
  confirm: "Start over",
} as const;

export function startOverMessage(hasDraft: boolean): string {
  return hasDraft ? startOverDialog.withDraft : startOverDialog.withoutDraft;
}

export const planStorageCopy = {
  saved:
    "This plan is saved in this browser only. It is not an account, and it is not on another device. Start over removes it from this browser.",
  restored: "Your saved Paris plan was restored in this browser.",
  restoredAnswers: "Your saved answers were restored in this browser.",
  rejected: "The saved plan could not be read. Nothing was restored.",
  unapproved: "A saved stop is no longer in the approved catalog. The saved plan was cleared.",
  catalog: "The approved catalog could not be read. The saved plan is still in this browser.",
  notStored: "This browser could not store the plan. It stays on this page until you leave.",
  undoFailed: "The earlier plan could not be restored. This plan is unchanged.",
  undoTrimmed: "The latest change could not be stored for undo. This plan is still saved in this browser.",
  undoDiscarded: "The saved undo no longer matches the approved catalog. The current plan was restored.",
} as const;

export const undoExplanation =
  "Only the latest of these changes can be undone: less walking, more cafés, or a museum change. Undo brings back the whole earlier plan, including the locks from that moment.";

export function undoButtonLabel(label: "less walking" | "more cafés" | "museum"): string {
  if (label === "less walking") {
    return "Undo less walking";
  }
  if (label === "more cafés") {
    return "Undo more cafés";
  }
  return "Undo the museum change";
}

export type ConciergeAnswers = {
  step: "place" | "days" | "interests" | "pace" | "plan";
  dayCount: number | null;
  interests: string[];
  initialPace: TravelerPreferences["pace"] | null;
  selectedDay: number;
  note: string;
};

/** Blank onboarding and follow-up state. Start over returns this shape. */
export function initialConciergeAnswers(): ConciergeAnswers {
  return {
    step: "place",
    dayCount: null,
    interests: [],
    initialPace: null,
    selectedDay: 1,
    note: "",
  };
}

/**
 * The current-trip line uses the pace stored on the trip. The first
 * questionnaire answer stays available for the note after a follow-up.
 */
export function describeTripPace(
  current: TravelerPreferences["pace"],
  initial: TravelerPreferences["pace"] | null,
): { currentLabel: string; initialNote: string | null } {
  const currentLabel = paceLabels[current];
  if (!initial || initial === current) {
    return { currentLabel, initialNote: null };
  }
  return { currentLabel, initialNote: `Your first answer was ${paceLabels[initial]}.` };
}

/** Exact phrases the development preview lists. The server fake matches these. */
export const developmentPreviewExamples = [
  "two food days at a steady pace",
  "two food days",
  "two landmark days at a steady pace",
  "less walking",
  "replace a museum",
] as const;

export const developmentPreviewNotice =
  "Development preview. This fake interpreter matches a few exact phrases. It is not a live model. The request limit is in-memory on this server and is not a shared production limit.";

/** Opens the existing guided control for the first detail the interpreter still needs. */
export function clarificationFocus(missing: readonly string[]): ConciergeAnswers["step"] | null {
  if (missing.includes("destinationId")) {
    return "place";
  }
  if (missing.includes("dayCount")) {
    return "days";
  }
  if (missing.includes("interests")) {
    return "interests";
  }
  if (missing.includes("pace")) {
    return "pace";
  }
  return null;
}

export function tripBrief(preferences: {
  dayCount: number | null;
  interests: readonly string[];
  pace: TravelerPreferences["pace"];
}): TripBrief | null {
  if (preferences.dayCount === null) {
    return null;
  }
  return {
    dayCount: preferences.dayCount,
    interests: preferences.interests,
    pace: preferences.pace,
  };
}

export function sameInterests(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const first = [...left].sort();
  const second = [...right].sort();
  return first.every((item, index) => item === second[index]);
}

/** Drops any edited field that matches the draft. A null result is a clean questionnaire. */
export function pendingBriefFromEdit(
  current: TripBrief,
  pending: PendingBrief | null,
  edit: PendingBrief,
): PendingBrief | null {
  const next: PendingBrief = {
    dayCount: edit.dayCount ?? pending?.dayCount,
    interests: edit.interests ?? pending?.interests,
    pace: edit.pace ?? pending?.pace,
  };
  if (next.dayCount === undefined || next.dayCount === current.dayCount) {
    delete next.dayCount;
  }
  if (next.pace === undefined || next.pace === current.pace) {
    delete next.pace;
  }
  if (next.interests === undefined || sameInterests(next.interests, current.interests)) {
    delete next.interests;
  }
  if (next.dayCount === undefined && next.pace === undefined && next.interests === undefined) {
    return null;
  }
  return next;
}

export function reconcilePending(current: TripBrief, pending: PendingBrief | null): PendingBrief | null {
  if (!pending) {
    return null;
  }
  return pendingBriefFromEdit(current, null, pending);
}

export function displayedBrief(current: TripBrief, pending: PendingBrief | null): TripBrief {
  return {
    dayCount: pending?.dayCount ?? current.dayCount,
    interests: [...(pending?.interests ?? current.interests)],
    pace: pending?.pace ?? current.pace,
  };
}

/**
 * Questionnaire edits stay pending. Cancel clears them. Escape keeps them.
 * Confirm is the only action that asks for a replacement, and only when an edit exists.
 */
export function reduceBrief(current: TripBrief, pending: PendingBrief | null, action: BriefAction): BriefState {
  if (action.type === "cancel") {
    return { pending: null, replace: false };
  }
  if (action.type === "escape") {
    return { pending, replace: false };
  }
  if (action.type === "confirm") {
    return { pending, replace: pending !== null };
  }
  const edit: PendingBrief =
    action.type === "day"
      ? { dayCount: action.dayCount }
      : action.type === "pace"
        ? { pace: action.pace }
        : { interests: action.interests };
  return { pending: pendingBriefFromEdit(current, pending, edit), replace: false };
}

export function draftSummary(brief: TripBrief, destinationName: string): string {
  const days = brief.dayCount === 1 ? "1-day" : `${brief.dayCount}-day`;
  const interests = interestOrder
    .filter((interest) => brief.interests.includes(interest))
    .map((interest) => interestLabels[interest]);
  const interestText = interests.length > 0 ? interests.join(", ") : "no selected interests";
  const pace = paceLabels[brief.pace].toLowerCase();
  const article = /^[aeiou]/i.test(pace) ? "an" : "a";
  return `A ${days} ${destinationName} draft for ${interestText}, at ${article} ${pace} pace.`;
}

export const sampleRouteLabel = "From our sample route";

export const beforeYouGoNoticeCodes = [
  "no_prices",
  "no_opening_hours",
  "no_travel_times",
  "planning_heuristic",
] as const;

export function beforeYouGoNotices<T extends { code: string; dayIndex: number | null }>(
  notices: readonly T[],
): T[] {
  const codes = new Set<string>(beforeYouGoNoticeCodes);
  return notices.filter((notice) => notice.dayIndex === null && codes.has(notice.code));
}

export function dayCommitmentNotices<T extends { code: string; dayIndex: number | null }>(
  notices: readonly T[],
  dayIndex: number,
): T[] {
  return notices.filter(
    (notice) =>
      notice.dayIndex === dayIndex &&
      (notice.code === "major_day_commitment" || notice.code === "major_day_mixed"),
  );
}

export function describeCurrentTrip(brief: TripBrief): string {
  const days = brief.dayCount === 1 ? "1 day" : `${brief.dayCount} days`;
  const interests = interestOrder
    .filter((interest) => brief.interests.includes(interest))
    .map((interest) => interestLabels[interest]);
  const interestText = interests.length > 0 ? interests.join(", ") : "No interests";
  return `${days}. ${interestText}. Pace: ${paceLabels[brief.pace]}.`;
}

export function replacementFailureMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.endsWith(replacementKeptDraft)) {
    return trimmed;
  }
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${sentence} ${replacementKeptDraft}`;
}

export function describeMobility(mobility: MobilityNeed | null): string | null {
  if (mobility === "limited_walking") {
    return "Walking preference: limited walking. Distance and access are not verified.";
  }
  if (mobility === "step_free_preferred") {
    return "Walking preference: step-free where possible. Access is not verified.";
  }
  return null;
}
