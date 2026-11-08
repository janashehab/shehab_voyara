export const INTERPRETER_LIMIT_MESSAGE = "Too many interpretation requests. Try again later.";

export type InterpreterGate = "allowed" | "limited" | "unavailable";

export type InterpreterBeforeCall = () => Promise<InterpreterGate>;

export class InterpreterAccessError extends Error {
  readonly code: "interpreter_limited" | "interpreter_unavailable";

  constructor(code: "interpreter_limited" | "interpreter_unavailable", message: string) {
    super(message);
    this.name = "InterpreterAccessError";
    this.code = code;
  }
}
