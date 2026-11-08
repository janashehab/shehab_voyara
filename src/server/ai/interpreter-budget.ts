import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type { InterpreterGate } from "./interpreter-access";

/**
 * Reserves one AI interpretation request in PostgreSQL.
 * The global day bucket and the caller window are updated in one transaction.
 * A lost race or a full bucket reserves nothing. A database error reserves nothing.
 * Counts are requests, not currency.
 */

export type InterpreterBudgetInput = {
  callerId: string;
  now: Date;
  callerLimit: number;
  callerWindowMs: number;
  dailyLimit: number;
};

type BudgetClient = Pick<PrismaClient, "$transaction">;

export async function reserveInterpreterRequest(
  db: BudgetClient,
  input: InterpreterBudgetInput,
): Promise<InterpreterGate> {
  if (
    !Number.isSafeInteger(input.callerLimit) ||
    !Number.isSafeInteger(input.dailyLimit) ||
    !Number.isSafeInteger(input.callerWindowMs)
  ) {
    return "unavailable";
  }
  if (input.callerLimit < 1 || input.dailyLimit < 1 || input.callerWindowMs < 1_000) {
    return "unavailable";
  }

  const day = input.now.toISOString().slice(0, 10);
  const dayKey = `global:${day}`;
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const windowStartMs = Math.floor(input.now.getTime() / input.callerWindowMs) * input.callerWindowMs;
  const callerKey = `caller:${input.callerId}:${new Date(windowStartMs).toISOString()}`;

  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${dayKey}, 0))`);
      const daily = await tx.$queryRaw<Array<{ request_count: number }>>(Prisma.sql`
        INSERT INTO interpreter_usage_bucket AS bucket (bucket_key, window_start, request_count)
        VALUES (${dayKey}, ${dayStart}, 1)
        ON CONFLICT (bucket_key) DO UPDATE
          SET request_count = bucket.request_count + 1
          WHERE bucket.request_count < ${input.dailyLimit}
        RETURNING request_count
      `);
      if (daily.length === 0) {
        return "limited";
      }

      const caller = await tx.$queryRaw<Array<{ request_count: number }>>(Prisma.sql`
        INSERT INTO interpreter_usage_bucket AS bucket (bucket_key, window_start, request_count)
        VALUES (${callerKey}, ${new Date(windowStartMs)}, 1)
        ON CONFLICT (bucket_key) DO UPDATE
          SET request_count = bucket.request_count + 1
          WHERE bucket.request_count < ${input.callerLimit}
        RETURNING request_count
      `);
      if (caller.length === 0) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE interpreter_usage_bucket
          SET request_count = request_count - 1
          WHERE bucket_key = ${dayKey} AND request_count > 0
        `);
        return "limited";
      }
      return "allowed";
    });
  } catch {
    return "unavailable";
  }
}
