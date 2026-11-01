import type {
  ApprovalState,
  BreakfastInclusion,
  CatalogAmount,
  CuratedRecommendation,
  FlightTemplate,
  ImportFinding,
  RecommendationTier,
  StayProperty,
  StayRate,
  TravelCatalog,
} from "../../travel/schema";
import { normalizeName, slugToken, toEditorialText } from "../../travel/text";
import {
  expectedSourceIds,
  type ParsedFlight,
  type ParsedInventory,
  type ParsedStay,
  type ParsedTierNote,
  type StaySection,
} from "./parse";

const SOURCE_PATH = "docs/inventory/thailand.md" as const;

const SHARED_PROPERTIES = [
  {
    id: "sty_ph_mazi_design_hotel",
    name: "Mazi Design Hotel by Kalima",
    sourceIds: ["PH-H014A", "PH-H014B"],
  },
  {
    id: "sty_cm_on_thapae_gate",
    name: "ON Thapae Gate Chiang Mai",
    sourceIds: ["CM-H062", "CM-H063", "CM-H063B"],
  },
] as const;

const SIMILAR_PROPERTY_NAMES = [
  ["Astra Sky River Chiang Mai", "Astra Sky River Panorama"],
  ["BED Phra Singh Adults Only Hotel", "BED Chiang Mai Gate Adults Only"],
  ["De Chai Colonial Hotel", "De Chai The Deco Chiang Mai"],
  ["GLOW Sukhumvit Hotel", "GLOW Ao Nang Krabi"],
  ["Galleria 12 Sukhumvit", "Galleria 10 Hotel Bangkok"],
] as const;

const CITY_STAY_BASE: Readonly<Record<string, string | null>> = {
  Bangkok: "dst_bangkok",
  Phuket: "dst_phuket",
  "Chiang Mai": "dst_chiang_mai",
  Cairo: null,
  Krabi: null,
};

type StayPlacement = {
  stayBaseId: string | null;
  areaId: string | null;
  regionId: string;
};

export function normalizeThailandInventory(parsed: ParsedInventory): TravelCatalog {
  const findings: ImportFinding[] = [];
  const properties: StayProperty[] = [];
  const rates: StayRate[] = [];
  const amounts: CatalogAmount[] = [];
  const profiles: TravelCatalog["referenceProfiles"] = [];
  const recommendations: CuratedRecommendation[] = [];
  const provenance: TravelCatalog["provenance"] = [];
  const flightTemplates: FlightTemplate[] = [];
  const propertyBySource = new Map<string, StayProperty>();

  pushCountFindings(parsed, findings);

  for (const flight of parsed.flights) {
    const template = flightTemplateFrom(flight, findings);
    flightTemplates.push(template);
    amounts.push(flightAmount(flight, template.id));
    provenance.push(provenanceRow(flight.sourceId, flight.raw));
  }

  const grouped = new Map<string, ParsedStay[]>();
  for (const stay of parsed.stays) {
    const propertyId = propertyIdFor(stay);
    const group = grouped.get(propertyId) ?? [];
    group.push(stay);
    grouped.set(propertyId, group);
  }

  for (const [propertyId, stays] of grouped) {
    const property = propertyFrom(propertyId, stays, findings);
    properties.push(property);
    for (const stay of stays) {
      propertyBySource.set(stay.sourceId, property);
      profiles.push(profileFrom(stay, property.id));
      provenance.push(provenanceRow(stay.sourceId, stay.raw));
      const stayRates = ratesFrom(stay, property, findings);
      rates.push(...stayRates);
      for (const rate of stayRates) {
        amounts.push(rateAmount(stay, rate));
      }
      recommendations.push(...noteRecommendations(stay, property.id));
    }
  }

  recommendations.push(...tierRecommendations(parsed.tierNotes, properties, findings));
  pushSharedPropertyFindings(properties, findings);
  pushSimilarNameFindings(properties, findings);
  pushCatalogFindings(findings);

  const accommodationSourceRecords = parsed.stays.length;
  return {
    countries: [
      {
        id: "cty_thailand",
        approval: "draft",
        name: "Thailand",
        countryCode: "TH",
      },
    ],
    regions: [
      { id: "rgn_bangkok", countryId: "cty_thailand", approval: "draft", name: "Bangkok" },
      { id: "rgn_phuket", countryId: "cty_thailand", approval: "draft", name: "Phuket" },
      { id: "rgn_chiang_mai", countryId: "cty_thailand", approval: "draft", name: "Chiang Mai" },
      { id: "rgn_krabi", countryId: "cty_thailand", approval: "draft", name: "Krabi" },
    ],
    stayBases: [
      stayBase("dst_bangkok", "rgn_bangkok", "Bangkok", "bangkok", "Planning base in Thailand.", []),
      stayBase("dst_phuket", "rgn_phuket", "Phuket", "phuket", "Planning base in Thailand.", []),
      stayBase(
        "dst_chiang_mai",
        "rgn_chiang_mai",
        "Chiang Mai",
        "chiang-mai",
        "Planning base in Thailand.",
        [],
      ),
      stayBase(
        "dst_ao_nang",
        "rgn_krabi",
        "Ao Nang",
        "ao-nang",
        "Mainland Krabi planning base in Thailand.",
        ["Mainland Krabi"],
      ),
      stayBase(
        "dst_koh_lanta",
        "rgn_krabi",
        "Koh Lanta",
        "koh-lanta",
        "Island planning base in Krabi, Thailand.",
        [],
      ),
    ],
    areas: [
      area("area_phuket_patong", "dst_phuket", "Patong", "patong"),
      area("area_phuket_karon", "dst_phuket", "Karon", "karon"),
      area("area_phuket_kamala", "dst_phuket", "Kamala", "kamala"),
      area("area_phuket_bang_tao", "dst_phuket", "Bang Tao", "bang-tao"),
      area("area_ao_nang_beach", "dst_ao_nang", "Ao Nang Beach", "ao-nang-beach"),
    ],
    properties,
    rates,
    flightTemplates,
    amounts,
    referenceProfiles: profiles,
    recommendations,
    provenance,
    supplierLinks: [],
    dynamicUpdates: [],
    suggestions: [],
    findings,
    totals: {
      sourceRecords: expectedSourceIds().length,
      flightTemplates: flightTemplates.length,
      accommodationSourceRecords,
      properties: properties.length,
      rateVariants: rates.length,
      statedDocumentTotal: parsed.stated.documentTotal,
    },
  };
}

function stayBase(
  id: string,
  regionId: string,
  name: string,
  slug: string,
  summary: string,
  aliases: string[],
): TravelCatalog["stayBases"][number] {
  return {
    id,
    countryId: "cty_thailand",
    regionId,
    approval: "draft",
    name,
    slug,
    summary,
    aliases,
  };
}

function area(
  id: string,
  stayBaseId: string,
  name: string,
  slug: string,
): TravelCatalog["areas"][number] {
  return { id, stayBaseId, approval: "draft", name, slug };
}

function flightTemplateFrom(flight: ParsedFlight, findings: ImportFinding[]): FlightTemplate {
  const unresolved = /^not provided$/i.test(flight.airlineText) || /\bor\b/i.test(flight.airlineText);
  const carriers = unresolved && /^not provided$/i.test(flight.airlineText)
    ? []
    : flight.airlineText.split(/\s+or\s+/i).map((carrier) => carrier.trim());
  const legs = legsFrom(flight);
  const approval: ApprovalState = unresolved ? "in_review" : "draft";

  if (carriers.length === 0) {
    findings.push({
      kind: "missing",
      sourceId: flight.sourceId,
      field: "airline",
      message: "Airline was not provided.",
    });
  }
  if (unresolved && carriers.length > 1) {
    findings.push({
      kind: "ambiguous",
      sourceId: flight.sourceId,
      field: "airline",
      message: "The source names more than one airline for one route template.",
    });
  }
  const mentionsKrabi = legs.some((leg) => leg.origin === "Krabi" || leg.destination === "Krabi");
  const mentionsCairo = legs.some((leg) => leg.origin === "Cairo" || leg.destination === "Cairo");
  if (mentionsKrabi) {
    findings.push({
      kind: "ambiguous",
      sourceId: flight.sourceId,
      field: "route",
      message: "A Krabi endpoint does not choose Ao Nang or Koh Lanta.",
    });
  }
  if (mentionsCairo) {
    findings.push({
      kind: "missing",
      sourceId: flight.sourceId,
      field: "cairo_stay_base",
      message: "Cairo is a route label and has no stay base in this catalog.",
    });
  }

  return {
    id: entityId("flt", flight.sourceId),
    approval,
    sourceId: flight.sourceId,
    journey: flight.routeText ? "one_way" : flight.header.includes("↔") ? "return" : "multi_city",
    legs,
    carriers,
    carrierUnresolved: unresolved,
    optionLabel: optionLabel(flight.optionText, flight.sourceId),
  };
}

function legsFrom(flight: ParsedFlight): FlightTemplate["legs"] {
  if (flight.routeText) {
    const [origin, destination] = flight.routeText.split("→").map((part) => part.trim());
    return [leg(1, origin ?? "", destination ?? "")];
  }

  const withoutLabel = flight.header.replace(/^[A-F]\.\s*/, "");
  const route = withoutLabel.split("—")[0]?.trim() ?? "";
  if (route.includes("↔")) {
    const [origin, destination] = route.split("↔").map((part) => part.trim());
    return [leg(1, origin ?? "", destination ?? ""), leg(2, destination ?? "", origin ?? "")];
  }

  return route.split("/").map((piece, index) => {
    const [origin, destination] = piece.split("→").map((part) => part.trim());
    return leg(index + 1, origin ?? "", destination ?? "");
  });
}

function leg(sequence: number, origin: string, destination: string): FlightTemplate["legs"][number] {
  if (origin.length === 0 || destination.length === 0) {
    throw new Error(`Flight leg ${sequence} is missing a city.`);
  }
  if (!Object.hasOwn(CITY_STAY_BASE, origin) || !Object.hasOwn(CITY_STAY_BASE, destination)) {
    throw new Error(`Flight leg uses an unexpected city: ${origin} to ${destination}.`);
  }
  return {
    sequence,
    origin,
    destination,
    endpointStayBaseId: CITY_STAY_BASE[destination] ?? null,
  };
}

function optionLabel(text: string, sourceId: string): FlightTemplate["optionLabel"] {
  const value = text.toLowerCase();
  if (value.includes("cheapest")) {
    return "cheapest";
  }
  if (/better(?:\s+flight)?\s+timing/.test(value)) {
    return "better_timing";
  }
  if (value.includes("alternative")) {
    return "alternative";
  }
  throw new Error(`Flight ${sourceId} has an unknown option label: ${text}`);
}

function propertyIdFor(stay: ParsedStay): string {
  const shared = SHARED_PROPERTIES.find((group) =>
    (group.sourceIds as readonly string[]).includes(stay.sourceId),
  );
  if (!shared) {
    return entityId("sty", stay.sourceId);
  }
  if (!normalizeName(stay.name).startsWith(normalizeName(shared.name))) {
    throw new Error(`${stay.sourceId} was grouped with ${shared.name} but is named ${stay.name}.`);
  }
  return shared.id;
}

function propertyFrom(
  propertyId: string,
  stays: readonly ParsedStay[],
  findings: ImportFinding[],
): StayProperty {
  const first = stays[0];
  if (!first) {
    throw new Error(`Property ${propertyId} has no source rows.`);
  }
  const shared = SHARED_PROPERTIES.find((group) => group.id === propertyId);
  const placement = placementFor(first, findings);
  for (const stay of stays.slice(1)) {
    const next = placementFor(stay, findings);
    if (
      next.stayBaseId !== placement.stayBaseId ||
      next.areaId !== placement.areaId ||
      next.regionId !== placement.regionId
    ) {
      findings.push({
        kind: "ambiguous",
        sourceId: stay.sourceId,
        field: "property_location",
        message: "Rate rows grouped on one property do not state the same place.",
      });
    }
  }

  const needsReview = stays.some(
    (stay) => stay.qualityReview || placementNeedsReview(stay) || notesNeedReview(stay),
  );

  return {
    id: propertyId,
    countryId: "cty_thailand",
    regionId: placement.regionId,
    stayBaseId: placement.stayBaseId,
    areaId: placement.areaId,
    approval: needsReview ? "in_review" : "draft",
    name: shared?.name ?? first.name,
    sourceIds: stays.map((stay) => stay.sourceId),
    qualityReview: stays.some((stay) => stay.qualityReview),
    editorialShortlistBands: uniqueBands(stays),
  };
}

function placementFor(stay: ParsedStay, findings: ImportFinding[]): StayPlacement {
  if (stay.section === "bangkok") {
    return { stayBaseId: "dst_bangkok", areaId: null, regionId: "rgn_bangkok" };
  }
  if (stay.section === "chiang_mai") {
    return {
      stayBaseId: "dst_chiang_mai",
      areaId: null,
      regionId: "rgn_chiang_mai",
    };
  }
  if (stay.section === "phuket") {
    const areaId = phuketAreaId(stay.areaText);
    if (areaId === null) {
      findings.push({
        kind: stay.areaPresence === "not_provided" ? "missing" : "ambiguous",
        sourceId: stay.sourceId,
        field: "area",
        message: "Phuket area was not provided or still needs confirmation.",
      });
    }
    return {
      stayBaseId: "dst_phuket",
      areaId,
      regionId: "rgn_phuket",
    };
  }

  return krabiPlacement(stay, findings);
}

function phuketAreaId(areaText: string | null): string | null {
  const value = areaText?.trim().toLowerCase() ?? "";
  if (value.startsWith("patong")) {
    return "area_phuket_patong";
  }
  if (value.startsWith("karon")) {
    return "area_phuket_karon";
  }
  if (value.startsWith("kamala")) {
    return "area_phuket_kamala";
  }
  if (value.startsWith("bang tao")) {
    return "area_phuket_bang_tao";
  }
  return null;
}

function krabiPlacement(stay: ParsedStay, findings: ImportFinding[]): StayPlacement {
  const value = stay.areaText?.trim().toLowerCase() ?? "";
  if (value.startsWith("koh lanta") || value.startsWith("ko lanta")) {
    return {
      stayBaseId: "dst_koh_lanta",
      areaId: null,
      regionId: "rgn_krabi",
    };
  }
  if (value.startsWith("ao nang beach")) {
    return {
      stayBaseId: "dst_ao_nang",
      areaId: "area_ao_nang_beach",
      regionId: "rgn_krabi",
    };
  }
  if (value.startsWith("ao nang")) {
    const listingUnverified = /verify|confirm/.test(value);
    if (listingUnverified) {
      findings.push({
        kind: "ambiguous",
        sourceId: stay.sourceId,
        field: "listing",
        message: "The source names Ao Nang and also asks for the listing to be verified.",
      });
    }
    return {
      stayBaseId: "dst_ao_nang",
      areaId: null,
      regionId: "rgn_krabi",
    };
  }

  findings.push({
    kind: "missing",
    sourceId: stay.sourceId,
    field: "stay_base",
    message: "The Krabi section does not say whether this stay is Ao Nang or Koh Lanta.",
  });
  return { stayBaseId: null, areaId: null, regionId: "rgn_krabi" };
}

function placementNeedsReview(stay: ParsedStay): boolean {
  if (stay.section === "phuket") {
    return phuketAreaId(stay.areaText) === null;
  }
  if (stay.section !== "krabi") {
    return false;
  }
  const value = stay.areaText?.trim().toLowerCase() ?? "";
  if (value.startsWith("koh lanta") || value.startsWith("ko lanta") || value.startsWith("ao nang beach")) {
    return false;
  }
  if (value.startsWith("ao nang") && !/verify|confirm/.test(value)) {
    return false;
  }
  return true;
}

function notesNeedReview(stay: ParsedStay): boolean {
  return stay.notes.some((note) => /need confirmation|confirm exact/i.test(note));
}

function ratesFrom(
  stay: ParsedStay,
  property: StayProperty,
  findings: ImportFinding[],
): StayRate[] {
  pushStayFieldFindings(stay, findings);
  if (stay.prices.length === 0) {
    return [rateFrom(stay, property, "default", "unknown", null)];
  }
  if (stay.prices.length === 1) {
    const price = stay.prices[0];
    return [rateFrom(stay, property, "default", price?.breakfast ?? "unknown", null)];
  }

  findings.push({
    kind: "duplicate",
    sourceId: stay.sourceId,
    field: "rate",
    message: "One source id holds more than one historical rate variant.",
  });
  return stay.prices.map((price) => {
    const rateKey = price.breakfast === "not_included"
      ? "without_breakfast"
      : price.breakfast === "included"
        ? "with_breakfast"
        : null;
    if (rateKey === null) {
      throw new Error(`${stay.sourceId} has more than one price without a breakfast label.`);
    }
    return rateFrom(stay, property, rateKey, price.breakfast, rateKey.replaceAll("_", " "));
  });
}

function rateFrom(
  stay: ParsedStay,
  property: StayProperty,
  rateKey: string,
  breakfast: BreakfastInclusion,
  suppliedLabel: string | null,
): StayRate {
  const label = parentheticalLabel(stay.name) ?? suppliedLabel;
  return {
    id: rateKey === "default" ? entityId("rate", stay.sourceId) : `${entityId("rate", stay.sourceId)}_${rateKey}`,
    propertyId: property.id,
    approval: property.approval,
    sourceId: stay.sourceId,
    rateKey,
    suppliedLabel: label,
    roomSizeSquareMeters: stay.roomSquareMeters,
    roomCategory: null,
    breakfast,
    occupancyKnown: false,
    taxesKnown: false,
    cancellationKnown: false,
    stayDatesKnown: false,
  };
}

function parentheticalLabel(name: string): string | null {
  const match = name.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() ?? null;
}

function rateAmount(stay: ParsedStay, rate: StayRate): CatalogAmount {
  const price = priceForRate(stay, rate.rateKey);
  return {
    id: entityId("amt", rate.id.replace(/^rate_/, "")),
    approval: rate.approval,
    sourceId: stay.sourceId,
    presentation: "historical_reference",
    liveQuote: false,
    freshness: "unverified",
    amountMinor: price === null ? null : price.dollars * 100,
    currency: price === null ? null : "USD",
    unit: "per_night",
    lastCheckedAt: null,
    lastVerifiedAt: null,
    expiresAt: null,
    note:
      price === null
        ? "Historical nightly reference. The source did not provide a price. Not a live quote."
        : "Historical nightly reference amount. Not a current rate or a live quote.",
    subject: { type: "stay_rate", id: rate.id },
    source: {
      providerKey: "thailand_markdown",
      externalId: stay.sourceId,
      retrievedBy: "manual",
    },
  };
}

function priceForRate(stay: ParsedStay, rateKey: string): ParsedStay["prices"][number] | null {
  if (stay.prices.length === 0) {
    return null;
  }
  if (stay.prices.length === 1) {
    return stay.prices[0] ?? null;
  }
  const breakfast = rateKey === "without_breakfast"
    ? "not_included"
    : rateKey === "with_breakfast"
      ? "included"
      : "unknown";
  return stay.prices.find((price) => price.breakfast === breakfast) ?? null;
}

function flightAmount(flight: ParsedFlight, flightId: string): CatalogAmount {
  return {
    id: entityId("amt", flight.sourceId),
    approval: /^not provided$/i.test(flight.airlineText) || /\bor\b/i.test(flight.airlineText)
      ? "in_review"
      : "draft",
    sourceId: flight.sourceId,
    presentation: "historical_reference",
    liveQuote: false,
    freshness: "unverified",
    amountMinor: flight.amountDollars * 100,
    currency: "USD",
    unit: "itinerary_total",
    lastCheckedAt: null,
    lastVerifiedAt: null,
    expiresAt: null,
    note: "Historical itinerary reference amount. Not a current fare or a live quote.",
    subject: { type: "flight_template", id: flightId },
    source: {
      providerKey: "thailand_markdown",
      externalId: flight.sourceId,
      retrievedBy: "manual",
    },
  };
}

function profileFrom(stay: ParsedStay, propertyId: string): TravelCatalog["referenceProfiles"][number] {
  return {
    id: entityId("prf", stay.sourceId),
    propertyId,
    sourceId: stay.sourceId,
    statedStarRating: stay.stars,
    guestScore: stay.rating,
    guestScoreScale: null,
    provenance: "manual_import",
    verified: false,
  };
}

function noteRecommendations(stay: ParsedStay, propertyId: string): CuratedRecommendation[] {
  return stay.notes.map((note, index) => {
    const stance = stanceFor(note);
    const tier = tierForStance(stance, note);
    return {
      id: `rec_${slugToken(stay.sourceId)}_${index + 1}`,
      approval: "draft",
      verified: false,
      tier,
      qualityReview: /quality review|review quality/i.test(note),
      stance,
      body: toEditorialText(note),
      propertyIds: [propertyId],
      stayBaseId: null,
      regionId: null,
      sourceIds: [stay.sourceId],
    };
  });
}

function stanceFor(note: string): string {
  const value = note.toLowerCase();
  if (value.includes("your recommended option")) {
    return "your_recommended";
  }
  if (value.includes("your first recommendation")) {
    return "first_recommendation";
  }
  if (value.includes("high recommendation")) {
    return "high_recommendation";
  }
  if (value.includes("your premium candidate")) {
    return "premium_candidate";
  }
  if (value.includes("level 1 luxury")) {
    return "level_1_luxury";
  }
  if (value.includes("first choice if budget allows")) {
    return "first_choice";
  }
  if (value.includes("quality review") || value.includes("review quality")) {
    return "quality_review";
  }
  if (value.includes("cheapest candidate")) {
    return "cheapest_candidate";
  }
  return "note";
}

function tierForStance(stance: string, note: string): RecommendationTier | null {
  if (stance === "premium_candidate" || /strong premium/i.test(note)) {
    return "premium";
  }
  if (stance === "level_1_luxury" || stance === "first_choice") {
    return "luxury";
  }
  if (stance === "your_recommended" || stance === "first_recommendation" || stance === "high_recommendation") {
    return "recommended";
  }
  if (stance === "cheapest_candidate") {
    return "cheapest";
  }
  return null;
}

function tierRecommendations(
  notes: readonly ParsedTierNote[],
  properties: readonly StayProperty[],
  findings: ImportFinding[],
): CuratedRecommendation[] {
  const created: CuratedRecommendation[] = [];
  for (const note of notes) {
    note.lines.forEach((line, index) => {
      const recommendation = tierLine(note.section, line, index, properties, findings);
      if (recommendation) {
        created.push(recommendation);
      }
    });
  }
  return created;
}

function tierLine(
  section: StaySection,
  line: string,
  index: number,
  properties: readonly StayProperty[],
  findings: ImportFinding[],
): CuratedRecommendation | null {
  const stayBaseId = stayBaseForSection(section);
  const regionId = section === "krabi" ? "rgn_krabi" : null;
  const body = toEditorialText(line);
  if (body.length === 0) {
    return null;
  }

  if (/^confirm\b/i.test(line)) {
    findings.push({
      kind: "missing",
      sourceId: null,
      field: "comparable_rate",
      message: `${sectionLabel(section)} still needs room type, taxes, cancellation, occupancy, breakfast, and travel dates confirmed.`,
    });
    return recommendationShell(`rec_${section}_confirm_${index + 1}`, null, null, body, [], stayBaseId, null, []);
  }

  if (/location strategy/i.test(line)) {
    return recommendationShell(`rec_${section}_areas_${index + 1}`, null, "areas_not_interchangeable", body, [], stayBaseId, null, []);
  }

  if (/important for itineraries/i.test(line)) {
    return recommendationShell(`rec_${section}_transfer_${index + 1}`, null, "separate_stay", body, [], null, regionId, []);
  }

  if (/starting candidates/i.test(line)) {
    findings.push({
      kind: "ambiguous",
      sourceId: null,
      field: "tier",
      message: "Chiang Mai tier notes are starting candidates, not verified rankings.",
    });
    return recommendationShell(`rec_${section}_unverified_${index + 1}`, null, "unverified_ranking", body, [], stayBaseId, null, []);
  }

  const labeled = line.match(/^(.*?):\s*(.+)$/);
  if (!labeled?.[1] || !labeled[2]) {
    findings.push({
      kind: "ambiguous",
      sourceId: null,
      field: "tier_note",
      message: `A ${sectionLabel(section)} tier line could not be matched to a property.`,
    });
    return recommendationShell(`rec_${section}_note_${index + 1}`, null, "note", body, [], stayBaseId, null, []);
  }

  const label = labeled[1].trim().toLowerCase();
  const rest = labeled[2].trim();
  const tier = tierFromLabel(label);
  const stance = stanceFromLabel(label);
  if (/no confirmed candidate|not yet confirmed/i.test(rest)) {
    findings.push({
      kind: "missing",
      sourceId: null,
      field: "luxury_candidate",
      message: `${sectionLabel(section)} has no confirmed luxury candidate.`,
    });
    return recommendationShell(
      `rec_${section}_luxury_unconfirmed`,
      "luxury",
      "unconfirmed",
      body,
      [],
      stayBaseId,
      section === "krabi" ? "rgn_krabi" : null,
      [],
    );
  }

  const matched = matchProperties(rest, properties);
  const propertyIds = matched.ids;
  if (matched.unmatched.length > 0) {
    findings.push({
      kind: "ambiguous",
      sourceId: null,
      field: "tier_note",
      message: `A ${sectionLabel(section)} tier line did not match: ${matched.unmatched.join("; ")}.`,
    });
  }
  const sourceIds = properties
    .filter((property) => propertyIds.includes(property.id))
    .flatMap((property) => property.sourceIds);

  return recommendationShell(
    `rec_${section}_${slugToken(label)}_${index + 1}`,
    tier,
    stance,
    body,
    propertyIds,
    stayBaseId,
    null,
    sourceIds,
  );
}

function recommendationShell(
  id: string,
  tier: RecommendationTier | null,
  stance: string | null,
  body: string,
  propertyIds: string[],
  stayBaseId: string | null,
  regionId: string | null,
  sourceIds: string[],
): CuratedRecommendation {
  return {
    id,
    approval: "draft",
    verified: false,
    tier,
    qualityReview: false,
    stance,
    body,
    propertyIds,
    stayBaseId,
    regionId,
    sourceIds,
  };
}

function matchProperties(
  text: string,
  properties: readonly StayProperty[],
): { ids: string[]; unmatched: string[] } {
  const items = text
    .split(/\s*;\s*|\s*,\s*(?=[A-Z])/)
    .map(itemName)
    .filter((item) => item.length >= 4);
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const item of items) {
    const matches = properties.filter((property) => namesMatch(item, property.name));
    if (matches.length === 1 && matches[0]) {
      ids.push(matches[0].id);
    } else {
      unmatched.push(item);
    }
  }
  return { ids: [...new Set(ids)], unmatched };
}

function itemName(item: string): string {
  return normalizeName(
    item
      .replace(/\(.*?\)/g, " ")
      .replace(/\$\s?\d+(?:\s*\/\s*\$?\s?\d+)?/g, " ")
      .split(/—|–/)[0] ?? "",
  )
    .replace(/[,.].*$/, "")
    .replace(/\d+\s*★.*/, "")
    .trim();
}

function namesMatch(item: string, propertyName: string): boolean {
  const name = normalizeName(propertyName);
  return name === item || name.startsWith(`${item} `) || item.startsWith(`${name} `);
}

function tierFromLabel(label: string): RecommendationTier | null {
  if (label === "cheapest") {
    return "cheapest";
  }
  if (label === "recommended" || label === "recommended starting point") {
    return "recommended";
  }
  if (label === "premium") {
    return "premium";
  }
  if (label === "luxury") {
    return "luxury";
  }
  return null;
}

function stanceFromLabel(label: string): string {
  if (label === "recommended starting point") {
    return "starting_point";
  }
  if (label === "pool option") {
    return "pool_option";
  }
  if (label === "breakfast option") {
    return "breakfast_option";
  }
  return label.replace(/\s+/g, "_");
}

function stayBaseForSection(section: StaySection): string | null {
  if (section === "bangkok") {
    return "dst_bangkok";
  }
  if (section === "phuket") {
    return "dst_phuket";
  }
  if (section === "chiang_mai") {
    return "dst_chiang_mai";
  }
  return null;
}

function sectionLabel(section: StaySection): string {
  if (section === "bangkok") {
    return "Bangkok";
  }
  if (section === "phuket") {
    return "Phuket";
  }
  if (section === "krabi") {
    return "Krabi and Koh Lanta";
  }
  return "Chiang Mai";
}

function pushStayFieldFindings(stay: ParsedStay, findings: ImportFinding[]): void {
  if (stay.stars === null) {
    findings.push({
      kind: "missing",
      sourceId: stay.sourceId,
      field: "star_rating",
      message: stay.starsPresence === "not_provided"
        ? "Star category was not provided."
        : "Star category is absent.",
    });
  }
  if (stay.rating === null) {
    findings.push({
      kind: "missing",
      sourceId: stay.sourceId,
      field: "guest_score",
      message: stay.ratingPresence === "not_provided"
        ? "Guest score was not provided."
        : "Guest score is absent.",
    });
  }
  if (stay.roomSquareMeters === null) {
    findings.push({
      kind: "missing",
      sourceId: stay.sourceId,
      field: "room_size",
      message: stay.roomPresence === "not_provided"
        ? "Room size was not provided."
        : "Room size is absent.",
    });
  }
  if (stay.prices.length === 0) {
    findings.push({
      kind: "missing",
      sourceId: stay.sourceId,
      field: "price",
      message: "Price was not provided.",
    });
  }
  if (stay.prices.every((price) => price.breakfast === "unknown")) {
    findings.push({
      kind: "missing",
      sourceId: stay.sourceId,
      field: "breakfast",
      message: "Breakfast inclusion was not stated.",
    });
  }
  if (stay.notes.some((note) => /some cheaper options/i.test(note))) {
    findings.push({
      kind: "ambiguous",
      sourceId: stay.sourceId,
      field: "note",
      message: "The note about cheaper options may refer to the whole band, not only this property.",
    });
  }
  if (stay.notes.some((note) => /above this range/i.test(note))) {
    findings.push({
      kind: "ambiguous",
      sourceId: stay.sourceId,
      field: "shortlist_band",
      message: "The source lists this record in a band and also says the price sits above that band.",
    });
  }
  if (stay.notes.some((note) => /need confirmation|confirm exact room/i.test(note))) {
    findings.push({
      kind: "ambiguous",
      sourceId: stay.sourceId,
      field: "room_category",
      message: "Room category and inclusions still need confirmation.",
    });
  }
  const neighborhood = stay.name.match(
    /\b(Watket|Prasingh|Prasing|Thapae|Thaphae|Wualai|Nana|Sukhumvit)\b/i,
  );
  if (stay.section === "chiang_mai" && neighborhood?.[1]) {
    findings.push({
      kind: "ambiguous",
      sourceId: stay.sourceId,
      field: "area",
      message: `The name mentions ${neighborhood[1]}, which is not stored as a confirmed area.`,
    });
  }
  if (stay.section === "bangkok" && /sukhumvit/i.test(stay.name)) {
    findings.push({
      kind: "ambiguous",
      sourceId: stay.sourceId,
      field: "area",
      message: "The name mentions Sukhumvit, which is not stored as a confirmed area.",
    });
  }
}

function pushCountFindings(parsed: ParsedInventory, findings: ImportFinding[]): void {
  const stayCount = (section: StaySection) =>
    parsed.stays.filter((stay) => stay.section === section).length;
  const comparisons = [
    ["document_total", parsed.stated.documentTotal, expectedSourceIds().length],
    ["flights", parsed.stated.flights, parsed.flights.length],
    ["bangkok", parsed.stated.bangkok, stayCount("bangkok")],
    ["phuket", parsed.stated.phuket, stayCount("phuket")],
    ["krabi", parsed.stated.krabi, stayCount("krabi")],
    ["chiang_mai", parsed.stated.chiangMai, stayCount("chiang_mai")],
  ] as const;

  for (const [field, stated, actual] of comparisons) {
    if (stated !== null && stated !== actual) {
      findings.push({
        kind: "ambiguous",
        sourceId: null,
        field,
        message: `The document states ${stated} and the explicit ids total ${actual}. No id was discarded.`,
      });
    }
  }
}

function pushSharedPropertyFindings(properties: readonly StayProperty[], findings: ImportFinding[]): void {
  for (const property of properties) {
    if (property.sourceIds.length < 2) {
      continue;
    }
    findings.push({
      kind: "duplicate",
      sourceId: property.sourceIds[0] ?? null,
      field: "property",
      message: `${property.name} keeps source ids ${property.sourceIds.join(", ")} as one property.`,
    });
  }
}

function pushSimilarNameFindings(properties: readonly StayProperty[], findings: ImportFinding[]): void {
  const names = new Set(properties.map((property) => property.name));
  for (const [left, right] of SIMILAR_PROPERTY_NAMES) {
    if (names.has(left) && names.has(right)) {
      findings.push({
        kind: "ambiguous",
        sourceId: null,
        field: "property_name",
        message: `${left} and ${right} stay separate properties.`,
      });
    }
  }
}

function pushCatalogFindings(findings: ImportFinding[]): void {
  findings.push(
    {
      kind: "missing",
      sourceId: null,
      field: "guest_score_scale",
      message: "Guest scores have no stated scale, so none is assumed.",
    },
    {
      kind: "missing",
      sourceId: null,
      field: "coordinates",
      message: "No coordinates were provided.",
    },
    {
      kind: "missing",
      sourceId: null,
      field: "supplier_id",
      message: "No supplier property ids or flight numbers were provided, so nothing can be refreshed yet.",
    },
    {
      kind: "missing",
      sourceId: null,
      field: "comparable_conditions",
      message: "Stay dates, occupancy, taxes, and cancellation were not provided on any rate.",
    },
  );
}

function uniqueBands(stays: readonly ParsedStay[]): StayProperty["editorialShortlistBands"] {
  const bands: StayProperty["editorialShortlistBands"] = [];
  for (const stay of stays) {
    if (stay.band && !bands.includes(stay.band)) {
      bands.push(stay.band);
    }
  }
  return bands;
}

function provenanceRow(sourceId: string, excerpt: string): TravelCatalog["provenance"][number] {
  return {
    id: entityId("prv", sourceId),
    sourceSystem: "thailand_markdown",
    sourcePath: SOURCE_PATH,
    sourceId,
    excerpt,
  };
}

function entityId(prefix: string, sourceId: string): string {
  return `${prefix}_${sourceId.toLowerCase().replace(/-/g, "_")}`;
}
