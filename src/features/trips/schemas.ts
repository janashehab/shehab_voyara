import { z } from "zod";

/**
 * Traveler preferences stay provider-neutral. The future form can show the
 * first group on its own and disclose the rest on request.
 *
 * Interests are soft and positive. They rank approved places.
 * Priorities are optional single choices: a trip vibe, and iconic versus
 * lesser-known. They rank as well. They do not exclude a place.
 * Exclusions are categories and specific place ids the traveler wants left
 * out of new suggestions.
 * Hard constraints are the dates or length, the pace heuristic, must-see
 * place ids, and mobility. Mobility tightens that heuristic. It does not
 * mark a place accessible, because the catalog has no accessibility facts.
 *
 * The schema rejects a combination that states both sides of the same choice:
 * an interest also listed to avoid, a must-see place also excluded by id,
 * an iconic priority that also avoids landmarks, or a vibe that also avoids
 * the category that vibe is for. A lesser-known priority alongside a landmark
 * interest is allowed and reported later as tension, because must-see places
 * still have to remain.
 */
export const interestValues = [
  "landmarks",
  "walks",
  "museums",
  "food",
  "shopping",
  "theme_parks",
  "photo_stops",
] as const;

export const vibeValues = ["riverside", "artistic", "neighborhood", "playful"] as const;

export const placeStyleValues = ["iconic", "lesser_known", "mixed"] as const;

export const mobilityValues = ["limited_walking", "step_free_preferred"] as const;

export const companionValues = ["solo", "couple", "family", "friends"] as const;

export const paceValues = ["unhurried", "steady", "full"] as const;

export const budgetValues = ["modest", "moderate", "open"] as const;

export const noticeCodes = [
  "no_prices",
  "no_opening_hours",
  "no_travel_times",
  "planning_heuristic",
  "missing_duration",
  "missing_coordinates",
  "long_gap",
  "major_day_commitment",
  "major_day_mixed",
  "major_day_split",
  "major_day_unscheduled",
  "catalog_gap",
  "thin_coverage",
  "preference_conflict",
  "pace_overflow",
  "mobility_unknown",
  "must_see_unscheduled",
  "exclusion_conflict",
  "excluded_omitted",
  "planner_fallback",
] as const;

const interestSchema = z.enum(interestValues);
const placeIdSchema = z.string().regex(/^plc_[a-z0-9_]+$/);
const destinationIdSchema = z.string().regex(/^dst_[a-z0-9_]+$/);
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const vibeAvoidConflict = {
  playful: "theme_parks",
  artistic: "museums",
} as const;

export type Interest = z.infer<typeof interestSchema>;
export type TripVibe = (typeof vibeValues)[number];
export type PlaceStyle = (typeof placeStyleValues)[number];
export type MobilityNeed = (typeof mobilityValues)[number];

export function utcDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

export function inclusiveDayCount(start: string, end: string): number | null {
  const startDay = utcDay(start);
  const endDay = utcDay(end);
  if (!startDay || !endDay) {
    return null;
  }

  const span = Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000);
  return span + 1;
}

export function shiftIsoDate(start: string, days: number): string | null {
  const date = utcDay(start);
  if (!date) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function uniqueIssue(
  value: readonly string[],
  context: z.RefinementCtx,
  path: string,
  message: string,
) {
  if (new Set(value).size === value.length) {
    return;
  }

  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
    params: { plannerCode: "duplicate_value" },
  });
}

export const travelerPreferencesSchema = z
  .object({
    destinationId: destinationIdSchema,
    startDate: calendarDateSchema.nullable().default(null),
    endDate: calendarDateSchema.nullable().default(null),
    dayCount: z.number().int().min(1).max(14).nullable().default(null),
    companions: z.enum(companionValues),
    pace: z.enum(paceValues),
    budget: z.enum(budgetValues),
    interests: z.array(interestSchema).max(6).default([]),
    priorities: z
      .object({
        vibe: z.enum(vibeValues).nullable().default(null),
        placeStyle: z.enum(placeStyleValues).nullable().default(null),
      })
      .strict()
      .default({ vibe: null, placeStyle: null }),
    exclusions: z
      .object({
        avoid: z.array(interestSchema).max(7).default([]),
        placeIds: z.array(placeIdSchema).max(12).default([]),
      })
      .strict()
      .default({ avoid: [], placeIds: [] }),
    constraints: z
      .object({
        mustSeePlaceIds: z.array(placeIdSchema).max(12).default([]),
        mobility: z.enum(mobilityValues).nullable().default(null),
      })
      .strict()
      .default({ mustSeePlaceIds: [], mobility: null }),
    notes: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .default(null)
      .transform((value) => (value === "" ? null : value)),
  })
  .strict()
  .superRefine((value, context) => {
    uniqueIssue(value.interests, context, "interests", "Interests cannot repeat.");
    uniqueIssue(value.exclusions.avoid, context, "exclusions.avoid", "Avoided categories cannot repeat.");
    uniqueIssue(
      value.exclusions.placeIds,
      context,
      "exclusions.placeIds",
      "Avoided places cannot repeat.",
    );
    uniqueIssue(
      value.constraints.mustSeePlaceIds,
      context,
      "constraints.mustSeePlaceIds",
      "Must-see places cannot repeat.",
    );

    const hasDates = value.startDate !== null || value.endDate !== null;
    if (hasDates && (value.startDate === null || value.endDate === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "A dated trip needs both a start date and an end date.",
        params: { plannerCode: "invalid_date" },
      });
    }

    if (value.startDate !== null && utcDay(value.startDate) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "Start date must be a real calendar date.",
        params: { plannerCode: "invalid_date" },
      });
    }

    if (value.endDate !== null && utcDay(value.endDate) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be a real calendar date.",
        params: { plannerCode: "invalid_date" },
      });
    }

    if (value.startDate !== null && value.endDate !== null && utcDay(value.startDate) && utcDay(value.endDate)) {
      const span = inclusiveDayCount(value.startDate, value.endDate);
      if (span === null || span < 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "The end date has to fall on or after the start date.",
          params: { plannerCode: "invalid_date" },
        });
      } else if (span > 14) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "A plan can cover at most 14 days.",
          params: { plannerCode: "invalid_duration" },
        });
      } else if (value.dayCount !== null && value.dayCount !== span) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dayCount"],
          message: "Day count has to match the inclusive dates. Dates set the length.",
          params: { plannerCode: "duration_mismatch" },
        });
      }
    }

    if (!hasDates && value.dayCount === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dayCount"],
        message: "Choose dates or a trip length from 1 to 14 days.",
        params: { plannerCode: "duration_required" },
      });
    }

    if (value.interests.length === 0 && value.constraints.mustSeePlaceIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interests"],
        message: "Choose at least one interest or one must-see place.",
        params: { plannerCode: "preference_empty" },
      });
    }

    const overlap = value.interests.filter((interest) => value.exclusions.avoid.includes(interest));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusions", "avoid"],
        message: "An interest cannot also be on the avoid list. Keep it as an interest or as an exclusion.",
        params: { plannerCode: "preference_contradiction" },
      });
    }

    const placeOverlap = value.constraints.mustSeePlaceIds.filter((placeId) =>
      value.exclusions.placeIds.includes(placeId),
    );
    if (placeOverlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusions", "placeIds"],
        message: "A must-see place cannot also be excluded. Remove it from one of the two lists.",
        params: { plannerCode: "preference_contradiction" },
      });
    }

    if (value.priorities.placeStyle === "iconic" && value.exclusions.avoid.includes("landmarks")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["priorities", "placeStyle"],
        message: "An iconic priority conflicts with avoiding landmarks. Keep one of those choices.",
        params: { plannerCode: "preference_contradiction" },
      });
    }

    const vibe = value.priorities.vibe;
    if (vibe === "playful" || vibe === "artistic") {
      const avoided = vibeAvoidConflict[vibe];
      if (value.exclusions.avoid.includes(avoided)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["priorities", "vibe"],
          message: "This trip vibe conflicts with the avoid list. Keep the vibe or the exclusion.",
          params: { plannerCode: "preference_contradiction" },
        });
      }
    }
  })
  .transform((value) => {
    if (value.startDate !== null && value.endDate !== null) {
      const span = inclusiveDayCount(value.startDate, value.endDate);
      return { ...value, dayCount: span ?? value.dayCount ?? 1 };
    }

    return { ...value, dayCount: value.dayCount ?? 1 };
  });

export type TravelerPreferences = z.infer<typeof travelerPreferencesSchema>;

export const plannerDraftSchema = z
  .object({
    summary: z.string().max(600),
    days: z
      .array(
        z
          .object({
            dayIndex: z.number().int().min(1).max(14),
            items: z
              .array(
                z
                  .object({
                    placeId: placeIdSchema,
                    role: z.enum(["core", "optional"]),
                  })
                  .strict(),
              )
              .max(24),
          })
          .strict(),
      )
      .max(14),
    unscheduledPlaceIds: z.array(placeIdSchema).max(24),
  })
  .strict();

export type PlannerDraft = z.infer<typeof plannerDraftSchema>;

export const tripItemSchema = z
  .object({
    id: z.string().regex(/^itm_[a-z0-9_]+$/),
    placeId: placeIdSchema,
    role: z.enum(["core", "optional"]),
    lock: z.enum(["locked", "unlocked"]),
    source: z.enum(["planner", "traveler"]),
  })
  .strict();

export type TripItem = z.infer<typeof tripItemSchema>;

export const plannerNoticeSchema = z
  .object({
    code: z.enum(noticeCodes),
    message: z.string().min(1).max(400),
    placeId: placeIdSchema.nullable(),
    dayIndex: z.number().int().min(1).max(14).nullable(),
  })
  .strict();

export type PlannerNotice = z.infer<typeof plannerNoticeSchema>;
export type NoticeCode = PlannerNotice["code"];

export const tripDaySchema = z
  .object({
    dayIndex: z.number().int().min(1).max(14),
    date: calendarDateSchema.nullable(),
    items: z.array(tripItemSchema).max(24),
  })
  .strict();

export type TripDay = z.infer<typeof tripDaySchema>;

export const aiUndoSnapshotSchema = z
  .object({
    days: z.array(tripDaySchema).min(1).max(14),
    unscheduled: z.array(tripItemSchema).max(24),
    summary: z.string().max(600),
  })
  .strict();

export type AiUndoSnapshot = z.infer<typeof aiUndoSnapshotSchema>;

export const tripDocumentSchema = z
  .object({
    id: z.string().regex(/^trp_[a-z0-9_]+$/),
    destinationId: destinationIdSchema,
    preferences: travelerPreferencesSchema,
    days: z.array(tripDaySchema).min(1).max(14),
    unscheduled: z.array(tripItemSchema).max(24),
    notices: z.array(plannerNoticeSchema).max(80),
    summary: z.string().max(600),
    undoAi: aiUndoSnapshotSchema.nullable(),
  })
  .strict();

export type TripDocument = z.output<typeof tripDocumentSchema>;

export const refinementInstructionSchema = z.string().trim().min(1).max(500);
