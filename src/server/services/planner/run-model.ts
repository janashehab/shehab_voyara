import type { PlannerDraft, TravelerPreferences } from "@/features/trips/schemas";
import type { PlannerModel } from "@/server/ai/types";
import { issue, type PlannerIssue } from "./issues";
import { assessPlannerDraft } from "./policy";
import { buildPlannerPrompt } from "./prompt";
import type { RetrievalSet } from "./retrieve";
import { parsePlannerDraft } from "./validate";

export async function requestAcceptedDraft(input: {
  model: PlannerModel;
  retrieval: RetrievalSet;
  preferences: TravelerPreferences;
  instruction: string | null;
  lockedPlaceIds: readonly string[];
  travelerPlaceIds: readonly string[];
}): Promise<{ ok: true; draft: PlannerDraft } | { ok: false; issues: PlannerIssue[] }> {
  const request = buildPlannerPrompt(input);
  let lastIssues: PlannerIssue[] = [
    issue("planner_draft_invalid", "draft", "The planner did not return a usable draft."),
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user =
      attempt === 0
        ? request.user
        : `${request.user}\nDraft issues:\n${lastIssues.map((entry) => entry.message).join("\n")}`;
    let text: string | null = null;
    try {
      const completion = await input.model.complete({ ...request, user });
      text = completion.text;
    } catch {
      lastIssues = [
        issue("planner_unavailable", "draft", "The planner did not return a usable draft."),
      ];
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      lastIssues = [issue("draft_json", "draft", "The planner draft was not valid JSON.")];
      continue;
    }

    const parsed = parsePlannerDraft(json);
    if (!parsed.ok) {
      lastIssues = parsed.issues;
      continue;
    }

    const assessed = assessPlannerDraft(parsed.draft, input.preferences, input.retrieval);
    if (!assessed.ok) {
      lastIssues = assessed.issues;
      continue;
    }

    return { ok: true, draft: parsed.draft };
  }

  return { ok: false, issues: lastIssues };
}
