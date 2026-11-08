import assert from "node:assert/strict";
import test from "node:test";

import {
  indexingResponseHeaders,
  isPubliclyIndexable,
  NOINDEX_DIRECTIVE,
  readIndexingEnv,
  ROBOTS_HEADER,
  robotsMetadata,
} from "@/lib/indexing-policy";

test("an unset indexing flag stays non-indexable", () => {
  assert.equal(isPubliclyIndexable({}), false);
  assert.equal(isPubliclyIndexable({ VERCEL_ENV: "production" }), false);
  assert.deepEqual(robotsMetadata({}), { index: false, follow: false });
});

test("an empty or unrecognized indexing flag stays non-indexable", () => {
  for (const flag of ["", "   ", "yes", "true", "APPROVED", "approved "]) {
    assert.equal(isPubliclyIndexable({ VOYARA_INDEXING: flag, VERCEL_ENV: "production" }), false);
  }
});

test("an approved flag stays non-indexable on a preview deployment", () => {
  const env = { VOYARA_INDEXING: "approved", VERCEL_ENV: "preview", NODE_ENV: "production" };
  assert.equal(isPubliclyIndexable(env), false);
  assert.deepEqual(robotsMetadata(env), { index: false, follow: false });
  assert.equal(indexingResponseHeaders(env)[0]?.headers[0]?.value, NOINDEX_DIRECTIVE);
});

test("process env ignores NODE_ENV when the deployment is not identified", () => {
  const env = readIndexingEnv({ VOYARA_INDEXING: "approved", NODE_ENV: "production" });
  assert.deepEqual(env, { VOYARA_INDEXING: "approved", VERCEL_ENV: undefined });
  assert.equal(isPubliclyIndexable(env), false);
});

test("an approved flag stays non-indexable when the deployment is not identified", () => {
  const env = { VOYARA_INDEXING: "approved", NODE_ENV: "production" };
  assert.equal(isPubliclyIndexable(env), false);
  assert.equal(isPubliclyIndexable({ VOYARA_INDEXING: "approved", VERCEL_ENV: "development" }), false);
});

test("an approved flag permits indexing only on an identified production deployment", () => {
  const env = { VOYARA_INDEXING: "approved", VERCEL_ENV: "production", NODE_ENV: "production" };
  assert.equal(isPubliclyIndexable(env), true);
  assert.deepEqual(robotsMetadata(env), { index: true, follow: true });
  assert.deepEqual(indexingResponseHeaders(env), []);
});

test("non-indexable responses send one robots header on every path", () => {
  const headers = indexingResponseHeaders({});
  assert.deepEqual(
    headers.map((rule) => rule.source),
    ["/:path*"],
  );
  for (const rule of headers) {
    assert.deepEqual(rule.headers, [{ key: ROBOTS_HEADER, value: NOINDEX_DIRECTIVE }]);
  }
});
