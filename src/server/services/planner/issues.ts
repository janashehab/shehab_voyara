import { z } from "zod";

export type PlannerIssue = {
  code: string;
  path: string;
  message: string;
};

export function issue(code: string, path: string, message: string): PlannerIssue {
  return { code, path, message };
}

export function zodIssues(error: z.ZodError): PlannerIssue[] {
  return error.issues.map((entry) => {
    const params = entry.code === "custom" ? entry.params : undefined;
    const plannerCode =
      params !== undefined &&
      typeof params === "object" &&
      params !== null &&
      "plannerCode" in params &&
      typeof params.plannerCode === "string"
        ? params.plannerCode
        : entry.code;

    return {
      code: plannerCode,
      path: entry.path.join("."),
      message: entry.message,
    };
  });
}
