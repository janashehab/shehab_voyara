import { readFileSync } from "node:fs";

import { checkThailandImport, checkTravelCatalog } from "../../travel/guards";
import { travelCatalogSchema, type TravelCatalog } from "../../travel/schema";
import { normalizeThailandInventory } from "./normalize";
import { parseThailandInventory } from "./parse";

export const thailandInventoryPath = "docs/inventory/thailand.md";

export function importThailandCatalog(markdown?: string): TravelCatalog {
  const source = markdown ?? readFileSync(thailandInventoryPath, "utf8");
  const catalog = travelCatalogSchema.parse(normalizeThailandInventory(parseThailandInventory(source)));
  const issues = [...checkTravelCatalog(catalog), ...checkThailandImport(catalog)];
  if (issues.length > 0) {
    throw new Error(
      issues.map((issue) => `${issue.code} ${issue.recordId}: ${issue.message}`).join("\n"),
    );
  }
  return catalog;
}
