import type { InterpreterCompletionRequest, InterpreterModel } from "@/server/ai/types";

import { developmentInterpreter } from "./development-interpreter";
import {
  INTERPRETER_LIMIT_MESSAGE,
  InterpreterAccessError,
  type InterpreterBeforeCall,
} from "./interpreter-access";
import {
  INTERPRETER_MAX_INPUT_CHARS,
  INTERPRETER_MAX_OUTPUT_CHARS,
  INTERPRETER_MAX_RESPONSE_CHARS,
  INTERPRETER_PROVIDER_FAILURE,
  INTERPRETER_SYSTEM_INSTRUCTION,
  INTERPRETER_UNAVAILABLE_MESSAGE,
  readInterpreterConfig,
  type InterpreterConfig,
  type InterpreterProviderSettings,
} from "./interpreter-config";

/**
 * One chat-completions adapter. It returns model text for the existing
 * interpreter parser. It does not build a TripDocument, choose a place id,
 * or send tool definitions.
 *
 * Pass the fetch implementation. The default development selection never
 * calls it.
 */

export type InterpreterFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export type PreparedInterpreter =
  | { ok: true; mode: "development" | "provider"; model: InterpreterModel }
  | { ok: false; code: "interpreter_unavailable"; message: string };

const denyProviderCall: InterpreterBeforeCall = async () => "unavailable";

export function prepareInterpreter(
  env: Record<string, string | undefined>,
  fetchImpl: InterpreterFetch,
  beforeCall: InterpreterBeforeCall = denyProviderCall,
): PreparedInterpreter {
  return interpreterFromConfig(readInterpreterConfig(env), fetchImpl, beforeCall);
}

export function interpreterFromConfig(
  config: InterpreterConfig,
  fetchImpl: InterpreterFetch,
  beforeCall: InterpreterBeforeCall = denyProviderCall,
): PreparedInterpreter {
  if (config.mode === "development") {
    return { ok: true, mode: "development", model: developmentInterpreter() };
  }
  if (config.mode === "unavailable") {
    return { ok: false, code: "interpreter_unavailable", message: INTERPRETER_UNAVAILABLE_MESSAGE };
  }
  return { ok: true, mode: "provider", model: createChatInterpreter(config.settings, fetchImpl, beforeCall) };
}

export function createChatInterpreter(
  settings: InterpreterProviderSettings,
  fetchImpl: InterpreterFetch,
  beforeCall: InterpreterBeforeCall = denyProviderCall,
): InterpreterModel {
  return {
    async complete(request) {
      assertBoundedRequest(request);
      await assertProviderCallAllowed(beforeCall);
      let response: Response;
      try {
        response = await fetchImpl(settings.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${settings.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: settings.model,
            temperature: 0,
            max_completion_tokens: settings.maxOutputTokens,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: `${request.system} ${INTERPRETER_SYSTEM_INSTRUCTION}` },
              { role: "user", content: request.user },
            ],
          }),
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch {
        throw providerFailure();
      }

      if (!response.ok) {
        await discard(response);
        throw providerFailure();
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > INTERPRETER_MAX_RESPONSE_CHARS) {
        await discard(response);
        throw providerFailure();
      }

      let raw = "";
      try {
        raw = await response.text();
      } catch {
        throw providerFailure();
      }
      if (raw.length > INTERPRETER_MAX_RESPONSE_CHARS) {
        throw providerFailure();
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw providerFailure();
      }
      return { text: readModelText(body) };
    },
  };
}

async function assertProviderCallAllowed(beforeCall: InterpreterBeforeCall): Promise<void> {
  let gate: Awaited<ReturnType<InterpreterBeforeCall>>;
  try {
    gate = await beforeCall();
  } catch {
    throw new InterpreterAccessError("interpreter_unavailable", INTERPRETER_UNAVAILABLE_MESSAGE);
  }
  if (gate === "allowed") {
    return;
  }
  if (gate === "limited") {
    throw new InterpreterAccessError("interpreter_limited", INTERPRETER_LIMIT_MESSAGE);
  }
  throw new InterpreterAccessError("interpreter_unavailable", INTERPRETER_UNAVAILABLE_MESSAGE);
}

function assertBoundedRequest(request: InterpreterCompletionRequest): void {
  if (request.schemaName !== "voyara.interpreter.turn") {
    throw providerFailure();
  }
  if (request.system.length > INTERPRETER_MAX_INPUT_CHARS || request.user.length > INTERPRETER_MAX_INPUT_CHARS) {
    throw providerFailure();
  }
}

function readModelText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length !== 1) {
    throw providerFailure();
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw providerFailure();
  }
  if ("tool_calls" in choice.message || "function_call" in choice.message) {
    throw providerFailure();
  }
  const content = choice.message.content;
  if (typeof content !== "string" || content.length === 0 || content.length > INTERPRETER_MAX_OUTPUT_CHARS) {
    throw providerFailure();
  }
  return content;
}

function providerFailure(): Error {
  return new Error(INTERPRETER_PROVIDER_FAILURE);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
