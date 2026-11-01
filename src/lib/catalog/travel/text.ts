const CURRENCY_AMOUNT = /\$\s?\d+(?:\s*\/\s*\$?\s?\d+)?/g;

export function toEditorialText(value: string): string {
  return value
    .replace(CURRENCY_AMOUNT, "the stated reference amount")
    .replace(/[€$£]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
