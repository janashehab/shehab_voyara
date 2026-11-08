"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import type { ConciergeResult, InterpreterPreviewResult } from "@/features/trips/concierge-types";
import { InterpreterAccessError } from "@/server/ai/interpreter-access";
import { interpreterCallerId } from "@/server/ai/interpreter-caller";
import { resolveServerInterpreter } from "@/server/ai/interpreter-runtime";
import type { InterpreterModel } from "@/server/ai/types";
import { getDatabase } from "@/server/db";
import { loadApprovedEditorialCatalog } from "@/server/catalog/planner-snapshot";
import {
  conciergeFailure,
  lockConciergeStop,
  planConcierge,
  refineConcierge,
  replaceConciergeMuseum,
  revalidateSavedTrip,
  screenConciergeRequest,
} from "@/server/services/planner/concierge";
import {
  confirmDevelopmentPlan,
  confirmDevelopmentRefinement,
  previewDevelopmentPlan,
  previewDevelopmentRefinement,
} from "@/server/services/planner/interpret-concierge";

/**
 * Questionnaire buttons, locks, and museum choices stay on the deterministic
 * actions below. Free text uses the scripted development interpreter unless
 * VOYARA_INTERPRETER_PROVIDER is enabled with a server-only API key. The
 * provider returns text to the existing parser and does not plan the days.
 *
 * Questionnaire screening still uses the in-memory concierge counter and the
 * first forwarded address. That counter is not the paid-call budget. A real
 * provider call reserves a shared PostgreSQL request before fetch, using a
 * caller identity that ignores X-Forwarded-For unless
 * VOYARA_TRUSTED_PROXY_HOPS is configured.
 */

async function callerKey(): Promise<string> {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || headerList.get("x-real-ip") || "local").slice(0, 80);
}

async function run(
  request: unknown,
  apply: (
    catalog: Awaited<ReturnType<typeof loadApprovedEditorialCatalog>>,
    now: number,
    key: string,
  ) => ConciergeResult | Promise<ConciergeResult>,
): Promise<ConciergeResult> {
  const now = Date.now();
  const key = await callerKey();
  const screened = screenConciergeRequest(request, now, key);
  if (!screened.ok) {
    return screened;
  }

  try {
    const catalog = await loadApprovedEditorialCatalog(getDatabase());
    return await apply(catalog, now, key);
  } catch (error) {
    unstable_rethrow(error);
    const limited = accessResult(error);
    if (limited) {
      return limited;
    }
    return conciergeFailure(error);
  }
}

export async function planParisItinerary(request: unknown): Promise<ConciergeResult> {
  return run(request, (catalog, now, callerKey) =>
    planConcierge({ request, catalog, now, callerKey, skipScreen: true }),
  );
}

export async function refineParisItinerary(request: unknown): Promise<ConciergeResult> {
  return run(request, (catalog, now, callerKey) =>
    refineConcierge({ request, catalog, now, callerKey, skipScreen: true }),
  );
}

export async function replaceParisMuseumStop(request: unknown): Promise<ConciergeResult> {
  return run(request, (catalog, now, callerKey) =>
    replaceConciergeMuseum({ request, catalog, now, callerKey, skipScreen: true }),
  );
}

export async function setParisStopLock(request: unknown): Promise<ConciergeResult> {
  return run(request, (catalog, now, callerKey) =>
    lockConciergeStop({ request, catalog, now, callerKey, skipScreen: true }),
  );
}

export async function revalidateParisItinerary(request: unknown): Promise<ConciergeResult> {
  return run(request, (catalog) => revalidateSavedTrip(request, catalog));
}

export async function previewParisInterpretation(request: unknown): Promise<InterpreterPreviewResult> {
  return runPreview(request, async (catalog) => {
    const selected = await selectedInterpreter();
    if (!selected.ok) {
      return unavailablePreview(selected);
    }
    return previewDevelopmentPlan({ request, catalog, model: selected.model });
  });
}

export async function confirmParisInterpretation(request: unknown): Promise<ConciergeResult> {
  return run(request, async (catalog) => {
    const selected = await selectedInterpreter();
    if (!selected.ok) {
      return unavailableResult(selected);
    }
    return confirmDevelopmentPlan({ request, catalog, model: selected.model });
  });
}

export async function previewParisRefinement(request: unknown): Promise<InterpreterPreviewResult> {
  return runPreview(request, async (catalog) => {
    const selected = await selectedInterpreter();
    if (!selected.ok) {
      return unavailablePreview(selected);
    }
    return previewDevelopmentRefinement({ request, catalog, model: selected.model });
  });
}

export async function confirmParisRefinement(request: unknown): Promise<ConciergeResult> {
  return run(request, async (catalog) => {
    const selected = await selectedInterpreter();
    if (!selected.ok) {
      return unavailableResult(selected);
    }
    return confirmDevelopmentRefinement({ request, catalog, model: selected.model });
  });
}

async function selectedInterpreter(): Promise<
  { ok: true; model: InterpreterModel } | { ok: false; code: string; message: string }
> {
  const headerList = await headers();
  const callerId = interpreterCallerId({
    forwardedFor: headerList.get("x-forwarded-for"),
    trustedProxyHops: process.env.VOYARA_TRUSTED_PROXY_HOPS,
    pepper: process.env.VOYARA_INTERPRETER_CALLER_PEPPER,
  });
  const prepared = resolveServerInterpreter(process.env, callerId);
  if (!prepared.ok) {
    return prepared;
  }
  return { ok: true, model: prepared.model };
}

function unavailablePreview(failure: { code: string; message: string }): InterpreterPreviewResult {
  return { ok: false, stage: "rejected", error: { code: failure.code, message: failure.message } };
}

function accessResult(error: unknown): ConciergeResult | null {
  if (!(error instanceof InterpreterAccessError)) {
    return null;
  }
  return unavailableResult(error);
}

function accessPreview(error: unknown): InterpreterPreviewResult | null {
  if (!(error instanceof InterpreterAccessError)) {
    return null;
  }
  return unavailablePreview(error);
}

function unavailableResult(failure: { code: string; message: string }): ConciergeResult {
  const error = { code: failure.code, message: failure.message };
  return { ok: false, error, issues: [error], trip: null, view: null };
}

async function runPreview(
  request: unknown,
  apply: (catalog: Awaited<ReturnType<typeof loadApprovedEditorialCatalog>>) => Promise<InterpreterPreviewResult>,
): Promise<InterpreterPreviewResult> {
  const now = Date.now();
  const key = await callerKey();
  const screened = screenConciergeRequest(request, now, key);
  if (!screened.ok) {
    return { ok: false, stage: "rejected", error: screened.error };
  }

  try {
    const catalog = await loadApprovedEditorialCatalog(getDatabase());
    return await apply(catalog);
  } catch (error) {
    unstable_rethrow(error);
    const limited = accessPreview(error);
    if (limited) {
      return limited;
    }
    const failed = conciergeFailure(error);
    if (!failed.ok) {
      return { ok: false, stage: "rejected", error: failed.error };
    }
    return {
      ok: false,
      stage: "rejected",
      error: { code: "catalog_unavailable", message: "The approved catalog could not be read." },
    };
  }
}
