import assert from "node:assert/strict";
import test from "node:test";

import { getPrototypeCatalog } from "@/lib/catalog";
import { buildInterpreterRequest, interpretWithModel } from "@/server/services/planner/interpret";

import {
  createChatInterpreter,
  prepareInterpreter,
  type InterpreterFetch,
} from "./chat-interpreter";
import { INTERPRETER_LIMIT_MESSAGE, InterpreterAccessError } from "./interpreter-access";
import {
  DEFAULT_INTERPRETER_MODEL,
  INTERPRETER_MAX_INPUT_CHARS,
  INTERPRETER_PROVIDER_FAILURE,
  INTERPRETER_SYSTEM_INSTRUCTION,
  INTERPRETER_UNAVAILABLE_MESSAGE,
  readInterpreterConfig,
  readInterpreterLimits,
} from "./interpreter-config";

const catalog = getPrototypeCatalog();
const secretKey = "sk-test-key";
const travelerNote = "please keep this note private";
const databaseUrl = "postgres://voyara:secret-password@db.internal/voyara";
const recordedPlan = JSON.stringify({
  kind: "plan",
  destinationId: "dst_paris",
  dayCount: 2,
  interests: ["food"],
  pace: "steady",
});

test("the provider stays off unless it is explicitly enabled and configured", async () => {
  const fetchImpl = failIfCalled();
  const disabled = prepareInterpreter({ AI_API_KEY: secretKey, AI_MODEL: "gpt-4.1-mini" }, fetchImpl);
  assert.equal(disabled.ok, true);
  if (!disabled.ok) {
    return;
  }
  assert.equal(disabled.mode, "development");
  const scripted = await disabled.model.complete(buildInterpreterRequest("two food days", []));
  assert.equal(scripted.text.includes("\"pace\":\"steady\""), false);
  assert.equal(JSON.stringify(readInterpreterConfig({ AI_API_KEY: secretKey })).includes(secretKey), false);

  const flagged = prepareInterpreter({ VOYARA_INTERPRETER_PROVIDER: "true", AI_API_KEY: secretKey }, fetchImpl);
  assert.equal(flagged.ok, true);
  if (!flagged.ok) {
    return;
  }
  assert.equal(flagged.mode, "development");

  const missingKey = prepareInterpreter({ VOYARA_INTERPRETER_PROVIDER: "enabled" }, fetchImpl);
  assert.deepEqual(missingKey, {
    ok: false,
    code: "interpreter_unavailable",
    message: INTERPRETER_UNAVAILABLE_MESSAGE,
  });
  assert.equal(JSON.stringify(missingKey).includes("AI_API_KEY"), false);

  const insecure = prepareInterpreter(
    { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey, AI_INTERPRETER_URL: "http://example.test/v1" },
    fetchImpl,
  );
  assert.equal(insecure.ok, false);

  const rejectedUrls = [
    "https://example.com/v1/chat/completions",
    "https://api.openai.com.evil.com/v1/chat/completions",
    "https://user:pass@api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/v1/chat/completions?stream=true",
    "https://api.openai.com:8443/v1/chat/completions",
    "http://api.openai.com/v1/chat/completions",
  ];
  for (const url of rejectedUrls) {
    const rejected = prepareInterpreter(
      { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey, AI_INTERPRETER_URL: url },
      fetchImpl,
    );
    assert.equal(rejected.ok, false, url);
    assert.equal(JSON.stringify(rejected).includes(secretKey), false);
    assert.equal(JSON.stringify(rejected).includes(url), false);
  }

  let developmentHooks = 0;
  const development = prepareInterpreter({ AI_API_KEY: secretKey }, fetchImpl, async () => {
    developmentHooks += 1;
    return "allowed";
  });
  assert.equal(development.ok, true);
  if (development.ok) {
    await development.model.complete(buildInterpreterRequest("two food days", []));
  }
  assert.equal(developmentHooks, 0);
});

test("a short caller pepper makes the provider unavailable before reservation", async () => {
  let reservations = 0;
  let fetches = 0;
  const fetchImpl: InterpreterFetch = async () => {
    fetches += 1;
    return jsonResponse({ choices: [{ message: { content: recordedPlan } }] });
  };
  const beforeCall = async () => {
    reservations += 1;
    return "allowed" as const;
  };
  const enabled = { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey };
  const pepper31 = "a".repeat(31);
  const pepper32 = "b".repeat(32);
  const blocked = [
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1" },
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1", VOYARA_INTERPRETER_CALLER_PEPPER: "" },
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1", VOYARA_INTERPRETER_CALLER_PEPPER: "   " },
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "5", VOYARA_INTERPRETER_CALLER_PEPPER: pepper31 },
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1", VOYARA_INTERPRETER_CALLER_PEPPER: `  ${pepper31}  ` },
  ];

  for (const env of blocked) {
    assert.equal(readInterpreterConfig(env).mode, "unavailable");
    const prepared = prepareInterpreter(env, fetchImpl, beforeCall);
    assert.deepEqual(prepared, {
      ok: false,
      code: "interpreter_unavailable",
      message: INTERPRETER_UNAVAILABLE_MESSAGE,
    });
    assert.equal(JSON.stringify(prepared).includes(secretKey), false);
    assert.equal(JSON.stringify(prepared).includes(pepper31), false);
  }

  const exact = prepareInterpreter(
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1", VOYARA_INTERPRETER_CALLER_PEPPER: pepper32 },
    fetchImpl,
    beforeCall,
  );
  assert.equal(exact.ok, true);
  if (!exact.ok) {
    return;
  }
  assert.equal(exact.mode, "provider");

  const padded = prepareInterpreter(
    { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: "1", VOYARA_INTERPRETER_CALLER_PEPPER: `  ${pepper32}  ` },
    fetchImpl,
    beforeCall,
  );
  assert.equal(padded.ok, true);
  if (!padded.ok) {
    return;
  }
  assert.equal(padded.mode, "provider");
  const completion = await padded.model.complete(buildInterpreterRequest("two food days", []));
  assert.equal(completion.text, recordedPlan);
  assert.equal(reservations, 1);
  assert.equal(fetches, 1);

  for (const hops of [undefined, "", "0", "6"]) {
    const prepared = prepareInterpreter(
      { ...enabled, VOYARA_TRUSTED_PROXY_HOPS: hops },
      fetchImpl,
      beforeCall,
    );
    assert.equal(prepared.ok, true, hops ?? "unset");
    if (!prepared.ok) {
      return;
    }
    assert.equal(prepared.mode, "provider");
  }

  const development = prepareInterpreter(
    { AI_API_KEY: secretKey, VOYARA_TRUSTED_PROXY_HOPS: "1" },
    fetchImpl,
    beforeCall,
  );
  assert.equal(development.ok, true);
  if (development.ok) {
    assert.equal(development.mode, "development");
    await development.model.complete(buildInterpreterRequest("two food days", []));
  }
  const flagged = prepareInterpreter(
    { VOYARA_INTERPRETER_PROVIDER: "true", AI_API_KEY: secretKey, VOYARA_TRUSTED_PROXY_HOPS: "1" },
    fetchImpl,
    beforeCall,
  );
  assert.equal(flagged.ok, true);
  if (flagged.ok) {
    assert.equal(flagged.mode, "development");
  }
  assert.equal(reservations, 1);
  assert.equal(fetches, 1);
});

test("a recorded provider response becomes traveler preferences through the existing parser", async () => {
  let calls = 0;
  const fetchImpl: InterpreterFetch = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body) as {
      model: string;
      temperature: number;
      max_completion_tokens: number;
      tools?: unknown;
      messages: { role: string; content: string }[];
    };
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(body.model, DEFAULT_INTERPRETER_MODEL);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_completion_tokens, 400);
    assert.equal(body.tools, undefined);
    assert.equal(init.headers.authorization, `Bearer ${secretKey}`);
    assert.equal(body.messages[0]?.content.includes(INTERPRETER_SYSTEM_INSTRUCTION), true);
    assert.equal(body.messages[0]?.content.includes(secretKey), false);
    assert.equal(body.messages[0]?.content.includes("untrusted"), true);
    assert.equal(body.messages[1]?.content.includes(travelerNote), true);
    assert.equal(init.body.includes("placeId"), false);
    return jsonResponse({ choices: [{ message: { content: recordedPlan } }] });
  };

  const prepared = prepareInterpreter(
    { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey },
    fetchImpl,
    async () => "allowed",
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    return;
  }
  assert.equal(prepared.mode, "provider");
  const result = await interpretWithModel({
    model: prepared.model,
    travelerText: travelerNote,
    catalog,
    trip: null,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== "plan") {
    return;
  }
  assert.equal(result.preferences.destinationId, "dst_paris");
  assert.equal(result.preferences.dayCount, 2);
  assert.deepEqual(result.preferences.interests, ["food"]);
  assert.equal(result.preferences.pace, "steady");
  assert.equal("days" in result, false);
});

test("invalid output, provider errors, timeouts, and secrets stay out of the result", async () => {
  const leakedBody = JSON.stringify({
    error: { message: `${databaseUrl} ${secretKey} ${travelerNote} ${INTERPRETER_SYSTEM_INSTRUCTION}` },
  });
  const failures: InterpreterFetch[] = [
    async () => jsonResponse({ choices: [{ message: { content: "not json" } }] }),
    async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ kind: "plan", placeId: "plc_paris_louvre" }) } }] }),
    async () => jsonResponse({ choices: [{ message: { content: recordedPlan, tool_calls: [] } }] }),
    async () => jsonResponse({ choices: [] }),
    async () => new Response(leakedBody, { status: 500, headers: { "content-type": "application/json" } }),
    async () => new Response(leakedBody, { status: 200, headers: { "content-length": "999999" } }),
  ];

  for (const fetchImpl of failures) {
    const model = enabledModel(fetchImpl);
    const result = await interpretWithModel({
      model,
      travelerText: travelerNote,
      catalog,
      trip: null,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.kind, "invalid");
    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes(secretKey), false);
    assert.equal(rendered.includes(databaseUrl), false);
    assert.equal(rendered.includes(travelerNote), false);
    assert.equal(rendered.includes("plc_paris_louvre"), false);
    assert.equal(rendered.includes(INTERPRETER_SYSTEM_INSTRUCTION), false);
  }

  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await assert.rejects(
      enabledModel(async () => new Response(leakedBody, { status: 503 })).complete(buildInterpreterRequest(travelerNote, [])),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        if (!(error instanceof Error)) {
          return false;
        }
        assert.equal(error.message, INTERPRETER_PROVIDER_FAILURE);
        const rendered = JSON.stringify(error.message);
        assert.equal(rendered.includes(secretKey), false);
        assert.equal(rendered.includes(databaseUrl), false);
        assert.equal(rendered.includes(travelerNote), false);
        return true;
      },
    );
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 0);

  let timedOut = false;
  const hanging: InterpreterFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        timedOut = true;
        const error = new Error(`${databaseUrl} ${secretKey}`);
        error.name = "AbortError";
        reject(error);
      });
    });
  const timeoutModel = createChatInterpreter(
    {
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: secretKey,
      model: DEFAULT_INTERPRETER_MODEL,
      timeoutMs: 20,
      maxOutputTokens: 400,
    },
    hanging,
    async () => "allowed",
  );
  await assert.rejects(timeoutModel.complete(buildInterpreterRequest(travelerNote, [])), (error: unknown) => {
    assert.equal(error instanceof Error && error.message === INTERPRETER_PROVIDER_FAILURE, true);
    return true;
  });
  assert.equal(timedOut, true);

  let oversizedCalls = 0;
  const oversized = createChatInterpreter(providerSettings(), async () => {
    oversizedCalls += 1;
    return jsonResponse({ choices: [{ message: { content: recordedPlan } }] });
  }, async () => "allowed");
  const huge = buildInterpreterRequest(travelerNote, []);
  await assert.rejects(
    oversized.complete({ ...huge, user: "x".repeat(INTERPRETER_MAX_INPUT_CHARS + 1) }),
    (error: unknown) => error instanceof Error && error.message === INTERPRETER_PROVIDER_FAILURE,
  );
  assert.equal(oversizedCalls, 0);
});

test("the adapter does not call the process fetch implementation", async () => {
  const original = globalThis.fetch;
  let liveCalls = 0;
  globalThis.fetch = (() => {
    liveCalls += 1;
    throw new Error("live_fetch_blocked");
  }) as typeof fetch;
  try {
    const model = enabledModel(async () => jsonResponse({ choices: [{ message: { content: recordedPlan } }] }));
    const completion = await model.complete(buildInterpreterRequest("two food days", []));
    assert.equal(completion.text, recordedPlan);
    const disabled = prepareInterpreter({}, failIfCalled());
    assert.equal(disabled.ok, true);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(liveCalls, 0);
});

test("a denied or failed request ledger does not call the provider", async () => {
  let calls = 0;
  const fetchImpl: InterpreterFetch = async () => {
    calls += 1;
    return jsonResponse({ choices: [{ message: { content: recordedPlan } }] });
  };
  const env = { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey };

  const limited = prepareInterpreter(env, fetchImpl, async () => "limited");
  assert.equal(limited.ok, true);
  if (!limited.ok) {
    return;
  }
  await assert.rejects(
    () => interpretWithModel({ model: limited.model, travelerText: travelerNote, catalog, trip: null }),
    (error: unknown) => {
      assert.equal(error instanceof InterpreterAccessError, true);
      if (!(error instanceof InterpreterAccessError)) {
        return false;
      }
      assert.equal(error.code, "interpreter_limited");
      assert.equal(error.message, INTERPRETER_LIMIT_MESSAGE);
      const rendered = JSON.stringify(error);
      assert.equal(rendered.includes(secretKey), false);
      assert.equal(rendered.includes(travelerNote), false);
      assert.equal(rendered.includes(databaseUrl), false);
      return true;
    },
  );

  const blocked = prepareInterpreter(env, fetchImpl);
  assert.equal(blocked.ok, true);
  if (!blocked.ok) {
    return;
  }
  await assert.rejects(blocked.model.complete(buildInterpreterRequest(travelerNote, [])), (error: unknown) => {
    assert.equal(error instanceof InterpreterAccessError && error.code === "interpreter_unavailable", true);
    return true;
  });

  const broken = prepareInterpreter(env, fetchImpl, async () => {
    throw new Error(`${databaseUrl} ${secretKey}`);
  });
  assert.equal(broken.ok, true);
  if (!broken.ok) {
    return;
  }
  await assert.rejects(broken.model.complete(buildInterpreterRequest(travelerNote, [])), (error: unknown) => {
    assert.equal(error instanceof InterpreterAccessError, true);
    const rendered = JSON.stringify(error);
    assert.equal(rendered.includes(secretKey), false);
    assert.equal(rendered.includes(databaseUrl), false);
    return true;
  });
  assert.equal(calls, 0);

  assert.deepEqual(readInterpreterLimits({}), {
    callerLimit: 8,
    callerWindowMs: 60_000,
    dailyLimit: 200,
  });
  assert.equal(readInterpreterLimits({ VOYARA_INTERPRETER_DAILY_LIMIT: "0" }), null);
  assert.equal(readInterpreterLimits({ VOYARA_INTERPRETER_CALLER_LIMIT: "unlimited" }), null);
  assert.equal(readInterpreterLimits({ VOYARA_INTERPRETER_DAILY_LIMIT: "100001" }), null);
});

function enabledModel(fetchImpl: InterpreterFetch) {
  const prepared = prepareInterpreter(
    { VOYARA_INTERPRETER_PROVIDER: "enabled", AI_API_KEY: secretKey },
    fetchImpl,
    async () => "allowed",
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    throw new Error("expected a provider");
  }
  return prepared.model;
}

function providerSettings() {
  return {
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: secretKey,
    model: DEFAULT_INTERPRETER_MODEL,
    timeoutMs: 8_000,
    maxOutputTokens: 400,
  };
}

function failIfCalled(): InterpreterFetch {
  return () => {
    throw new Error("fetch should not be called");
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
