import "server-only";

import { getDatabase } from "@/server/db";

import {
  generateDeterministicItineraryFromApprovedCatalog,
  refineDeterministicItineraryFromApprovedCatalog,
} from "./deterministic-catalog";
import type { IdFactory } from "./ids";

/**
 * Server entry for a deterministic plan.
 * The catalog is loaded here from approved editorial rows. Callers do not
 * supply a catalog, a place list, or a price.
 */
export function generateApprovedDeterministicItinerary(input: {
  preferences: unknown;
  ids?: IdFactory;
}) {
  return generateDeterministicItineraryFromApprovedCatalog(getDatabase(), input);
}

export function refineApprovedDeterministicItinerary(input: {
  trip: unknown;
  instruction: unknown;
  ids?: IdFactory;
}) {
  return refineDeterministicItineraryFromApprovedCatalog(getDatabase(), input);
}
