import type { DatedOffer, Freshness, SupplierFact } from "./types";

export function classifyFreshness(input: {
  now: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  latestAttemptFailed: boolean;
  staleAfterMs: number;
}): Freshness {
  if (input.latestAttemptFailed) {
    return "refresh_failed";
  }
  if (input.lastVerifiedAt === null) {
    return "unverified";
  }

  const now = Date.parse(input.now);
  const verified = Date.parse(input.lastVerifiedAt);
  if (Number.isNaN(now) || Number.isNaN(verified)) {
    return "unverified";
  }
  if (input.expiresAt !== null) {
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isNaN(expiry) && now >= expiry) {
      return "expired";
    }
  }
  if (now >= verified + input.staleAfterMs) {
    return "stale";
  }
  return "fresh";
}

export function isBookableOffer(offer: DatedOffer, now: string): boolean {
  if (offer.freshness !== "fresh" || offer.currency === null || offer.amountMinor === null) {
    return false;
  }
  const expiry = Date.parse(offer.expiresAt);
  const checked = Date.parse(now);
  if (Number.isNaN(expiry) || Number.isNaN(checked) || checked >= expiry) {
    return false;
  }
  if (offer.adapter === "activities") {
    return offer.payload.availability === true && typeof offer.payload.schedule === "string";
  }
  if (offer.adapter === "hotel_shopping") {
    return (
      offer.occupancy !== null &&
      offer.occupancy >= 1 &&
      offer.stayStart !== null &&
      offer.stayEnd !== null &&
      offer.payload.availability === true &&
      offer.payload.roomCount !== 0
    );
  }
  if (offer.adapter === "flight_shopping") {
    const seats = offer.payload.seats;
    const segments = offer.payload.segments;
    return typeof seats === "number" && seats >= 1 && Array.isArray(segments) && segments.length > 0;
  }
  return false;
}

export function isBookableFact(fact: SupplierFact): boolean {
  if (fact.adapter === "flight_status" || fact.adapter === "mapping") {
    return false;
  }
  return false;
}
