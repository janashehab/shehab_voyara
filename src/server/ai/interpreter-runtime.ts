import "server-only";

import { prepareInterpreter, type PreparedInterpreter } from "@/server/ai/chat-interpreter";
import { reserveInterpreterRequest } from "@/server/ai/interpreter-budget";
import type { InterpreterBeforeCall } from "@/server/ai/interpreter-access";
import { readInterpreterLimits } from "@/server/ai/interpreter-config";
import { getDatabase } from "@/server/db";

/**
 * Server-only selection. The scripted interpreter does not reserve a request
 * and does not call fetch. A configured provider reserves one shared request
 * before fetch. A missing ledger, a bad limit, or a database error denies
 * the call. The in-memory concierge counter is a separate development screen.
 */
export function resolveServerInterpreter(
  env: Record<string, string | undefined> = process.env,
  callerId = "direct",
): PreparedInterpreter {
  return prepareInterpreter(env, fetch, () => reserveProviderCall(env, callerId));
}

async function reserveProviderCall(
  env: Record<string, string | undefined>,
  callerId: string,
): Promise<Awaited<ReturnType<InterpreterBeforeCall>>> {
  const limits = readInterpreterLimits(env);
  if (!limits) {
    return "unavailable";
  }
  return reserveInterpreterRequest(getDatabase(), {
    callerId,
    now: new Date(),
    callerLimit: limits.callerLimit,
    callerWindowMs: limits.callerWindowMs,
    dailyLimit: limits.dailyLimit,
  });
}
