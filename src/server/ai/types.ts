/**
 * Provider-neutral completion seam. Stage 1 does not choose a model, ship a
 * provider adapter, or read an API key. A later adapter can implement this
 * with `fetch` and stay behind `src/server/ai`.
 *
 * In-memory rate limits are development-only. A counter in one process resets
 * on restart and is not shared across instances, so it cannot protect a public
 * endpoint. Public AI endpoints need production-grade shared limits: shared
 * storage, a hard daily budget, and a per-caller cap, before they accept
 * traveler traffic.
 */
export const developmentRateLimitPolicy = {
  inMemoryLimits: "development-only",
  publicEndpoints: "require-shared-production-limits",
} as const;

export const developmentRateLimitPolicyText =
  "In-memory rate limits are development-only. They reset when the process restarts and are not shared across instances. Public AI endpoints require production-grade shared limits before they accept traveler traffic.";

export type PlannerCompletionRequest = {
  schemaName: "voyara.planner.draft";
  system: string;
  user: string;
};

export type PlannerCompletion = {
  text: string;
};

export type PlannerModel = {
  complete(request: PlannerCompletionRequest): Promise<PlannerCompletion>;
};

/**
 * Interprets a traveler note into JSON text. It does not select places or
 * build a TripDocument. The chat adapter reads a server-only API key only
 * when the interpreter provider is explicitly enabled.
 */
export type InterpreterCompletionRequest = {
  schemaName: "voyara.interpreter.turn";
  system: string;
  user: string;
};

export type InterpreterCompletion = {
  text: string;
};

export type InterpreterModel = {
  complete(request: InterpreterCompletionRequest): Promise<InterpreterCompletion>;
};
