import type { InterpreterModel } from "@/server/ai/types";

/**
 * Returns scripted model text in order. It does not read the environment,
 * call a network, or choose places.
 */
export function fakeInterpreter(responses: readonly string[]): InterpreterModel {
  let index = 0;
  return {
    async complete() {
      const text = responses[index] ?? "";
      index += 1;
      return { text };
    },
  };
}
