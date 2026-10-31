import { checkCatalogIntegrity } from "../guards";
import { parisCatalog } from "./paris";
import type { CatalogSnapshot } from "../types";

export { parisCatalog } from "./paris";

export function getPrototypeCatalog(): CatalogSnapshot {
  const issues = checkCatalogIntegrity(parisCatalog);

  if (issues.length > 0) {
    const details = issues
      .map((issue) => `${issue.code} ${issue.recordId}: ${issue.message}`)
      .join("\n");
    throw new Error(`Paris catalog fixture failed integrity checks:\n${details}`);
  }

  return parisCatalog;
}
