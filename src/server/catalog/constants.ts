import { createHash } from "node:crypto";

export const CATALOG_NORMALIZER_VERSION = "e1.1";

export const THAILAND_MARKDOWN_PATH = "docs/inventory/thailand.md";
export const THAILAND_MARKDOWN_ALIAS_PATH = "docs/inventory/✈️ 1. FLIGHTS.md";
export const THAILAND_JSON_PATH = "docs/inventory/voyara_thailand_master_database.json";
export const PARIS_FIXTURE_PATH = "src/lib/catalog/fixtures/paris.ts";

export const PARIS_COUNTRY_ID = "cty_france";
export const PARIS_REGION_ID = "rgn_ile_de_france";
export const PARIS_STAY_BASE_ID = "dst_paris";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function findingKey(input: {
  kind: string;
  sourceId: string | null;
  field: string;
  message: string;
}): string {
  return `find_${sha256(`${input.kind}|${input.sourceId ?? ""}|${input.field}|${input.message}`).slice(0, 24)}`;
}
