const prohibitedPatterns: readonly { label: string; pattern: RegExp }[] = [
  { label: "clock time", pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/ },
  { label: "currency symbol", pattern: /[€$£]/ },
  { label: "money amount", pattern: /\b\d+(?:\.\d+)?\s*(?:euros?|dollars?|usd|eur)\b/i },
  { label: "duration claim", pattern: /\b\d+\s*(?:min|mins|minutes|hr|hrs|hours)\b/i },
  { label: "PIN", pattern: /\bPIN\b/ },
  { label: "confirmation number", pattern: /confirmation number/i },
  { label: "booking reference", pattern: /booking reference/i },
  { label: "last train", pattern: /last train/i },
];

export const SAFE_SUMMARY =
  "A plan made only from approved catalog places. Prices, opening hours, and travel times are unknown.";

export function prohibitedLabels(value: string): string[] {
  return prohibitedPatterns
    .filter((rule) => rule.pattern.test(value))
    .map((rule) => rule.label);
}

export function acceptableCopy(value: string): boolean {
  return prohibitedLabels(value).length === 0;
}
