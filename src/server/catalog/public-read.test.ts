import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@/generated/prisma/client";
import { getPrototypeCatalog } from "@/lib/catalog";

import { loadApprovedEditorialCatalog } from "./planner-snapshot";
import { readApprovedPublicCatalog } from "./public-read";

const secretUrl =
  "postgresql://voyara_user:super-secret-password@db.internal:6543/postgres?pgbouncer=true";

test("a failed public catalog read fails closed", async () => {
  const fixture = getPrototypeCatalog();
  await expectClosed(
    failingClient(
      Object.assign(new Error(`Can't reach ${secretUrl} while reading draft dst_bangkok`), {
        code: "P1001",
      }),
    ),
  );
  await expectClosed(failingClient(new Error(`connect ${secretUrl} password=super-secret-password`)));
  await assert.rejects(
    () =>
      readApprovedPublicCatalog(
        async () => {
          throw new Error("framework-interrupt");
        },
        (error) => {
          throw error;
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "framework-interrupt");
      return true;
    },
  );
  assert.equal(fixture.destinations[0]?.slug, "paris");
});

async function expectClosed(prisma: PrismaClient): Promise<void> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await assert.rejects(
      () =>
        readApprovedPublicCatalog(
          () => loadApprovedEditorialCatalog(prisma),
          (error) => {
            if (error instanceof Error && error.message === "framework-interrupt") {
              throw error;
            }
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "The approved catalog could not be read.");
        assert.equal("cause" in error ? error.cause : undefined, undefined);
        const visible = `${error.message}\n${error.stack ?? ""}`;
        assert.equal(visible.includes(secretUrl), false);
        assert.equal(visible.includes("super-secret-password"), false);
        assert.equal(visible.includes("postgresql://"), false);
        assert.equal(visible.includes("voyara_user"), false);
        assert.equal(visible.includes("dst_bangkok"), false);
        assert.equal(visible.includes("dst_paris"), false);
        return true;
      },
    );
  } finally {
    console.error = original;
  }
  const logged = logs.join("\n");
  assert.equal(logged.includes(secretUrl), false);
  assert.equal(logged.includes("super-secret-password"), false);
  assert.equal(logged.includes("postgresql://"), false);
  assert.equal(logged.includes("voyara_user"), false);
  assert.equal(logged.includes("dst_bangkok"), false);
}

function failingClient(error: unknown): PrismaClient {
  return {
    stayBase: {
      findMany: async () => {
        throw error;
      },
    },
  } as unknown as PrismaClient;
}
