import assert from "node:assert/strict";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { PrismaClient } from "@/generated/prisma/client";

import { createPrismaClient } from "@/server/catalog/prisma-client";
import { buildInterpreterRequest } from "@/server/services/planner/interpret";

import { prepareInterpreter, type InterpreterFetch } from "./chat-interpreter";
import { InterpreterAccessError } from "./interpreter-access";
import { reserveInterpreterRequest, type InterpreterBudgetInput } from "./interpreter-budget";
import { interpreterCallerId } from "./interpreter-caller";
import { INTERPRETER_USAGE_SCHEMA_SQL } from "./interpreter-usage-schema";

const secretKey = "sk-test-key";
const databaseUrl = "postgres://voyara:secret-password@db.internal/voyara";

test("interpreter request buckets stay within their limits under concurrency", { timeout: 180_000 }, async () => {
  const database = new PGlite();
  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await database.waitReady;
  await database.exec(INTERPRETER_USAGE_SCHEMA_SQL);
  await server.start();
  const address = server.getServerConn();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const prisma = createPrismaClient(`postgresql://postgres:postgres@${address}/postgres`, 4);

  try {
    const now = new Date("2031-06-01T12:00:00.000Z");
    const caller = interpreterCallerId({
      forwardedFor: "198.51.100.2, 203.0.113.8",
      trustedProxyHops: "1",
      pepper: "test-pepper",
    });
    const other = interpreterCallerId({
      forwardedFor: "198.51.100.2, 203.0.113.9",
      trustedProxyHops: "1",
      pepper: "test-pepper",
    });
    assert.notEqual(caller, other);

    const raced = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserveInterpreterRequest(prisma, budget({ callerId: caller, now, callerLimit: 20, dailyLimit: 5 })),
      ),
    );
    assert.equal(raced.filter((gate) => gate === "allowed").length, 5);
    assert.equal(raced.filter((gate) => gate === "limited").length, 3);
    await assertCounts(prisma, { "global:2031-06-01": 5 });

    const sameCaller = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserveInterpreterRequest(
          prisma,
          budget({
            callerId: caller,
            now: new Date("2031-06-02T12:00:00.000Z"),
            callerLimit: 2,
            dailyLimit: 50,
          }),
        ),
      ),
    );
    assert.equal(sameCaller.filter((gate) => gate === "allowed").length, 2);

    const sharedDay = new Date("2031-06-03T12:00:00.000Z");
    const shared = await Promise.all([
      ...Array.from({ length: 3 }, () =>
        reserveInterpreterRequest(prisma, budget({ callerId: caller, now: sharedDay, callerLimit: 2, dailyLimit: 3 })),
      ),
      ...Array.from({ length: 3 }, () =>
        reserveInterpreterRequest(prisma, budget({ callerId: other, now: sharedDay, callerLimit: 2, dailyLimit: 3 })),
      ),
    ]);
    assert.equal(shared.filter((gate) => gate === "allowed").length, 3);
    await assertCounts(prisma, { "global:2031-06-03": 3 });

    const windowStart = new Date("2031-06-04T00:00:00.000Z");
    const firstWindow = await reserveInterpreterRequest(
      prisma,
      budget({ callerId: caller, now: windowStart, callerLimit: 1, dailyLimit: 10 }),
    );
    const blockedWindow = await reserveInterpreterRequest(
      prisma,
      budget({ callerId: caller, now: windowStart, callerLimit: 1, dailyLimit: 10 }),
    );
    const nextWindow = await reserveInterpreterRequest(
      prisma,
      budget({ callerId: caller, now: new Date(windowStart.getTime() + 60_000), callerLimit: 1, dailyLimit: 10 }),
    );
    assert.deepEqual([firstWindow, blockedWindow, nextWindow], ["allowed", "limited", "allowed"]);

    const rows = await prisma.$queryRawUnsafe<Array<{ bucket_key: string; request_count: number }>>(
      "SELECT bucket_key, request_count FROM interpreter_usage_bucket",
    );
    const rendered = JSON.stringify(rows);
    assert.equal(rendered.includes("203.0.113.8"), false);
    assert.equal(rendered.includes("198.51.100.2"), false);
    assert.equal(rows.every((row) => Number(row.request_count) >= 0), true);

    let fetches = 0;
    const fetchImpl: InterpreterFetch = async () => {
      fetches += 1;
      throw new Error("paid_model_blocked");
    };
    const missing = await reserveInterpreterRequest(
      {
        $transaction: async () => {
          throw new Error(databaseUrl);
        },
      } as unknown as PrismaClient,
      budget({ callerId: caller, now, callerLimit: 8, dailyLimit: 200 }),
    );
    assert.equal(missing, "unavailable");
    const denied = prepareInterpreter(
      { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey },
      fetchImpl,
      async () => missing,
    );
    assert.equal(denied.ok, true);
    if (denied.ok) {
      await assert.rejects(denied.model.complete(buildInterpreterRequest("two food days", [])), (error: unknown) => {
        assert.equal(error instanceof InterpreterAccessError, true);
        assert.equal(JSON.stringify(error).includes(databaseUrl), false);
        assert.equal(JSON.stringify(error).includes(secretKey), false);
        return true;
      });
    }

    await database.exec("DROP TABLE interpreter_usage_bucket");
    const dropped = await reserveInterpreterRequest(
      prisma,
      budget({ callerId: caller, now: new Date("2031-06-05T00:00:00.000Z"), callerLimit: 8, dailyLimit: 200 }),
    );
    assert.equal(dropped, "unavailable");
    const disabled = prepareInterpreter({ AI_API_KEY: secretKey }, fetchImpl, async () => {
      throw new Error("ledger should not be consulted");
    });
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      const completion = await disabled.model.complete(buildInterpreterRequest("two food days", []));
      assert.equal(completion.text.includes("dst_paris"), true);
    }
    assert.equal(fetches, 0);
  } finally {
    await prisma.$disconnect();
    await server.stop();
    await database.close();
  }
});

function budget(input: Omit<InterpreterBudgetInput, "callerWindowMs">): InterpreterBudgetInput {
  return { callerWindowMs: 60_000, ...input };
}

async function assertCounts(prisma: PrismaClient, expected: Record<string, number>): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ bucket_key: string; request_count: number | string }>>(
    "SELECT bucket_key, request_count FROM interpreter_usage_bucket",
  );
  for (const [key, count] of Object.entries(expected)) {
    const row = rows.find((candidate) => candidate.bucket_key === key);
    assert.equal(Number(row?.request_count), count, key);
  }
}
