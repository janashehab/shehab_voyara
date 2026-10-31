export type {
  ApproximateCoordinates,
  CatalogSnapshot,
  CatalogStatus,
  CuratedTip,
  CuratedTipId,
  Destination,
  DestinationId,
  DynamicFact,
  DynamicFactId,
  FactSource,
  FactSubject,
  Freshness,
  ItemRole,
  Place,
  PlaceId,
  PlaceKind,
  SampleItinerary,
  SampleItineraryId,
  SampleItineraryItem,
  SampleItineraryItemId,
} from "./types";

export {
  alternativeItemsForDay,
  approvedCatalog,
  approvedDestinations,
  approvedPlaces,
  approvedSampleItineraries,
  approvedTips,
  checkCatalogIntegrity,
  coreItemsForDay,
  editorialAdditionItems,
  isVerifiedDynamicFact,
  verifiedAmountMinor,
} from "./guards";

export type { CatalogIssue, CatalogIssueCode } from "./guards";

export { getPrototypeCatalog, parisCatalog } from "./fixtures";
