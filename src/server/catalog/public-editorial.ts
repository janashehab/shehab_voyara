import "server-only";

import { cache } from "react";
import { io } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import type { CatalogSnapshot } from "@/lib/catalog";
import { getDatabase } from "@/server/db";
import { loadApprovedEditorialCatalog } from "@/server/catalog/planner-snapshot";
import { readApprovedPublicCatalog } from "@/server/catalog/public-read";

/**
 * Approved editorial snapshot for the public pages.
 * A failure stays on this read: draft rows and the in-memory fixture are not substitutes.
 */
export const loadPublicEditorialCatalog = cache(async (): Promise<CatalogSnapshot> => {
  await io();
  return readApprovedPublicCatalog(
    () => loadApprovedEditorialCatalog(getDatabase()),
    unstable_rethrow,
  );
});
