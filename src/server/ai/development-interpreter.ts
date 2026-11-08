import type { InterpreterModel } from "@/server/ai/types";

/**
 * Development-only phrase table. It does not read the environment, call a
 * network, or infer meaning from arbitrary sentences. Unknown text becomes
 * an unsupported interpreter result.
 */

const UNSUPPORTED = JSON.stringify({
  kind: "unsupported",
  message: "That request is not one of the development preview phrases. Nothing was changed.",
});

const phrases = new Map<string, string>([
  [
    "two food days at a steady pace",
    plan({ destinationId: "dst_paris", dayCount: 2, interests: ["food"], pace: "steady" }),
  ],
  [
    "two food days",
    plan({ destinationId: "dst_paris", dayCount: 2, interests: ["food"] }),
  ],
  [
    "two landmark days at a steady pace",
    plan({ destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "steady" }),
  ],
  [
    "two landmark days at an unhurried pace",
    plan({ destinationId: "dst_paris", dayCount: 2, interests: ["landmarks"], pace: "unhurried" }),
  ],
  [
    "one museum day at a full pace must see the louvre",
    plan({
      destinationId: "dst_paris",
      dayCount: 1,
      interests: ["museums"],
      pace: "full",
      mustSeeNames: ["Louvre"],
    }),
  ],
  [
    "two steady days of food but avoid food",
    plan({
      destinationId: "dst_paris",
      dayCount: 2,
      interests: ["food"],
      exclusions: ["food"],
      pace: "steady",
    }),
  ],
  [
    "two food days in bangkok at a steady pace",
    plan({ destinationId: "dst_bangkok", dayCount: 2, interests: ["food"], pace: "steady" }),
  ],
  ["less walking", refine([{ intent: "less_walking" }])],
  ["more cafes", refine([{ intent: "more_food" }])],
  ["replace a museum", refine([{ intent: "replace_museum", museumName: null }])],
  ["replace notre dame", refine([{ intent: "replace_museum", museumName: "Notre-Dame" }])],
  [
    "less walking and more cafes",
    refine([{ intent: "less_walking" }, { intent: "more_food" }]),
  ],
]);

export function developmentInterpreter(): InterpreterModel {
  return {
    async complete(request) {
      const travelerText = readTravelerText(request.user);
      if (travelerText === null) {
        return { text: UNSUPPORTED };
      }
      return { text: phrases.get(normalizePhrase(travelerText)) ?? UNSUPPORTED };
    },
  };
}

function readTravelerText(user: string): string | null {
  try {
    const payload = JSON.parse(user) as { travelerText?: unknown };
    return typeof payload.travelerText === "string" ? payload.travelerText : null;
  } catch {
    return null;
  }
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function plan(value: Record<string, unknown>): string {
  return JSON.stringify({ kind: "plan", ...value });
}

function refine(intents: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ kind: "refine", intents });
}
