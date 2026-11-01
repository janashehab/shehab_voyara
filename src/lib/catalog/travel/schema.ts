import { z } from "zod";

/**
 * Editorial approval and supplier freshness are different fields.
 * Approving a property does not make a historical amount current.
 *
 * Approval transitions are applied by `src/server/services/catalog-approval`.
 * This import does not approve records, and supplier sync cannot approve them.
 *
 * Supplier refresh is applied by `src/server/sync`, not by this import.
 * When a refresh fails, it sets lastCheckedAt and freshness to
 * refresh_failed, appends an update whose next payload is null, and leaves
 * the previous payload in place.
 * lastVerifiedAt stays at the previous successful verification.
 * expiresAt stays at the offer expiry from that success.
 * Those two timestamps are not substitutes for each other.
 */
export const FAILED_REFRESH_RULE =
  "A failed refresh preserves lastVerifiedAt from the previous successful verification, preserves expiresAt as the offer expiry from that success, and records freshness refresh_failed separately from both timestamps.";

export const approvalStateValues = ["draft", "in_review", "approved", "archived"] as const;
export const freshnessValues = [
  "unverified",
  "fresh",
  "stale",
  "expired",
  "refresh_failed",
] as const;
export const shortlistBandValues = [
  "cheapest_budget",
  "recommended",
  "premium",
  "four_star",
  "higher_priced",
  "mid_range",
  "upper_mid",
  "luxury",
] as const;
export const recommendationTierValues = ["cheapest", "recommended", "premium", "luxury"] as const;
export const breakfastValues = ["included", "not_included", "unknown"] as const;
export const journeyValues = ["return", "multi_city", "one_way"] as const;
export const flightOptionValues = ["cheapest", "better_timing", "alternative"] as const;
export const amountPresentationValues = ["historical_reference", "dated_offer"] as const;
export const supplierDomainValues = [
  "flights",
  "accommodation",
  "weather",
  "activities",
  "other",
] as const;

/**
 * Future adapter names. They are not registered and they do not call a network.
 * flight_shopping and hotel_shopping map to the policy domains flights and
 * accommodation. flight_status and mapping map to other. activities stays
 * activities. An adapter may refresh dynamic facts on an approved record.
 * It may not create or approve a catalog entity.
 */
export const futureSupplierAdapters = [
  "flight_shopping",
  "hotel_shopping",
  "flight_status",
  "mapping",
  "activities",
] as const;

const approvalStateSchema = z.enum(approvalStateValues);
const freshnessSchema = z.enum(freshnessValues);
const countryIdSchema = z.string().regex(/^cty_[a-z0-9_]+$/);
const regionIdSchema = z.string().regex(/^rgn_[a-z0-9_]+$/);
const stayBaseIdSchema = z.string().regex(/^dst_[a-z0-9_]+$/);
const areaIdSchema = z.string().regex(/^area_[a-z0-9_]+$/);
const propertyIdSchema = z.string().regex(/^sty_[a-z0-9_]+$/);
const rateIdSchema = z.string().regex(/^rate_[a-z0-9_]+$/);
const flightIdSchema = z.string().regex(/^flt_[a-z0-9_]+$/);
const amountIdSchema = z.string().regex(/^amt_[a-z0-9_]+$/);
const profileIdSchema = z.string().regex(/^prf_[a-z0-9_]+$/);
const recommendationIdSchema = z.string().regex(/^rec_[a-z0-9_]+$/);
const provenanceIdSchema = z.string().regex(/^prv_[a-z0-9_]+$/);
const sourceIdSchema = z.string().regex(/^(?:TH-F|BK-H|PH-H|KR-H|CM-H)\d{3}[A-Z]?$/);

export const countrySchema = z.object({
  id: countryIdSchema,
  approval: approvalStateSchema,
  name: z.string().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});

export const regionSchema = z.object({
  id: regionIdSchema,
  countryId: countryIdSchema,
  approval: approvalStateSchema,
  name: z.string().min(1),
});

export const stayBaseSchema = z.object({
  id: stayBaseIdSchema,
  countryId: countryIdSchema,
  regionId: regionIdSchema,
  approval: approvalStateSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});

export const areaSchema = z.object({
  id: areaIdSchema,
  stayBaseId: stayBaseIdSchema,
  approval: approvalStateSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
});

export const stayPropertySchema = z.object({
  id: propertyIdSchema,
  countryId: countryIdSchema,
  regionId: regionIdSchema,
  stayBaseId: stayBaseIdSchema.nullable(),
  areaId: areaIdSchema.nullable(),
  approval: approvalStateSchema,
  name: z.string().min(1),
  sourceIds: z.array(sourceIdSchema).min(1),
  qualityReview: z.boolean(),
  editorialShortlistBands: z.array(z.enum(shortlistBandValues)),
});

export const stayRateSchema = z.object({
  id: rateIdSchema,
  propertyId: propertyIdSchema,
  approval: approvalStateSchema,
  sourceId: sourceIdSchema,
  rateKey: z.string().regex(/^[a-z0-9_]+$/),
  suppliedLabel: z.string().min(1).nullable(),
  roomSizeSquareMeters: z.number().int().positive().nullable(),
  roomCategory: z.string().min(1).nullable(),
  breakfast: z.enum(breakfastValues),
  occupancyKnown: z.boolean(),
  taxesKnown: z.boolean(),
  cancellationKnown: z.boolean(),
  stayDatesKnown: z.boolean(),
});

export const flightLegSchema = z.object({
  sequence: z.number().int().positive(),
  origin: z.string().min(1),
  destination: z.string().min(1),
  endpointStayBaseId: stayBaseIdSchema.nullable(),
});

export const flightTemplateSchema = z.object({
  id: flightIdSchema,
  approval: approvalStateSchema,
  sourceId: sourceIdSchema,
  journey: z.enum(journeyValues),
  legs: z.array(flightLegSchema).min(1),
  carriers: z.array(z.string().min(1)),
  carrierUnresolved: z.boolean(),
  optionLabel: z.enum(flightOptionValues),
});

export const catalogAmountSchema = z.object({
  id: amountIdSchema,
  approval: approvalStateSchema,
  sourceId: sourceIdSchema,
  presentation: z.enum(amountPresentationValues),
  liveQuote: z.boolean(),
  freshness: freshnessSchema,
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.literal("USD").nullable(),
  unit: z.enum(["per_night", "itinerary_total"]),
  lastCheckedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  note: z.string().min(1),
  subject: z.discriminatedUnion("type", [
    z.object({ type: z.literal("stay_rate"), id: rateIdSchema }),
    z.object({ type: z.literal("flight_template"), id: flightIdSchema }),
  ]),
  source: z.object({
    providerKey: z.string().min(1),
    externalId: sourceIdSchema,
    retrievedBy: z.enum(["manual", "sync", "revalidation"]),
  }),
});

export const referenceProfileSchema = z.object({
  id: profileIdSchema,
  propertyId: propertyIdSchema,
  sourceId: sourceIdSchema,
  statedStarRating: z.number().int().min(1).max(5).nullable(),
  guestScore: z.number().nullable(),
  guestScoreScale: z.string().min(1).nullable(),
  provenance: z.enum(["manual_import", "supplier"]),
  verified: z.boolean(),
});

export const recommendationSchema = z.object({
  id: recommendationIdSchema,
  approval: approvalStateSchema,
  verified: z.boolean(),
  tier: z.enum(recommendationTierValues).nullable(),
  qualityReview: z.boolean(),
  stance: z.string().min(1).nullable(),
  body: z.string().min(1),
  propertyIds: z.array(propertyIdSchema),
  stayBaseId: stayBaseIdSchema.nullable(),
  regionId: regionIdSchema.nullable(),
  sourceIds: z.array(sourceIdSchema),
});

export const provenanceSchema = z.object({
  id: provenanceIdSchema,
  sourceSystem: z.enum(["thailand_markdown", "thailand_json"]),
  sourcePath: z.enum([
    "docs/inventory/thailand.md",
    "docs/inventory/voyara_thailand_master_database.json",
  ]),
  sourceId: sourceIdSchema,
  excerpt: z.string().min(1),
});

export const supplierLinkSchema = z.object({
  id: z.string().regex(/^sup_[a-z0-9_]+$/),
  providerKey: z.string().min(1),
  externalId: z.string().min(1),
  domain: z.enum(supplierDomainValues),
  subjectType: z.enum(["stay_property", "flight_template", "stay_base"]),
  subjectId: z.string().min(1),
  mappedBy: z.literal("admin"),
});

export const dynamicUpdateSchema = z.object({
  id: z.string().regex(/^upd_[a-z0-9_]+$/),
  subjectId: z.string().min(1),
  attemptedAt: z.string().min(1),
  providerKey: z.string().min(1),
  externalId: z.string().nullable(),
  outcome: z.enum(["succeeded", "failed"]),
  errorCode: z.string().nullable(),
  changedFields: z.array(z.string()),
  previousPayload: z.unknown().nullable(),
  nextPayload: z.unknown().nullable(),
});

export const catalogSuggestionSchema = z.object({
  id: z.string().regex(/^sug_[a-z0-9_]+$/),
  status: z.enum(["pending", "approved", "rejected"]),
  proposedType: z.enum(["stay_property", "flight_template", "stay_base", "place"]),
  providerKey: z.string().min(1),
  externalId: z.string().min(1),
});

export const importFindingSchema = z.object({
  kind: z.enum(["missing", "ambiguous", "duplicate"]),
  sourceId: sourceIdSchema.nullable(),
  field: z.string().min(1),
  message: z.string().min(1),
});

export const importTotalsSchema = z.object({
  sourceRecords: z.number().int().nonnegative(),
  flightTemplates: z.number().int().nonnegative(),
  accommodationSourceRecords: z.number().int().nonnegative(),
  properties: z.number().int().nonnegative(),
  rateVariants: z.number().int().nonnegative(),
  statedDocumentTotal: z.number().int().nullable(),
});

export const travelCatalogSchema = z.object({
  countries: z.array(countrySchema),
  regions: z.array(regionSchema),
  stayBases: z.array(stayBaseSchema),
  areas: z.array(areaSchema),
  properties: z.array(stayPropertySchema),
  rates: z.array(stayRateSchema),
  flightTemplates: z.array(flightTemplateSchema),
  amounts: z.array(catalogAmountSchema),
  referenceProfiles: z.array(referenceProfileSchema),
  recommendations: z.array(recommendationSchema),
  provenance: z.array(provenanceSchema),
  supplierLinks: z.array(supplierLinkSchema),
  dynamicUpdates: z.array(dynamicUpdateSchema),
  suggestions: z.array(catalogSuggestionSchema),
  findings: z.array(importFindingSchema),
  totals: importTotalsSchema,
});

export type ApprovalState = z.infer<typeof approvalStateSchema>;
export type TravelCatalog = z.infer<typeof travelCatalogSchema>;
export type StayProperty = z.infer<typeof stayPropertySchema>;
export type StayRate = z.infer<typeof stayRateSchema>;
export type FlightTemplate = z.infer<typeof flightTemplateSchema>;
export type CatalogAmount = z.infer<typeof catalogAmountSchema>;
export type CuratedRecommendation = z.infer<typeof recommendationSchema>;
export type ImportFinding = z.infer<typeof importFindingSchema>;
export type ShortlistBand = (typeof shortlistBandValues)[number];
export type RecommendationTier = (typeof recommendationTierValues)[number];
export type BreakfastInclusion = (typeof breakfastValues)[number];
