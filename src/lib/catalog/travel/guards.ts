import type {
  CatalogAmount,
  ImportFinding,
  TravelCatalog,
} from "./schema";

export type TravelIssueCode =
  | "duplicate_id"
  | "missing_subject"
  | "area_base_mismatch"
  | "region_mismatch"
  | "historical_amount_presented_as_current"
  | "editorial_marked_verified"
  | "prohibited_content"
  | "import_approved"
  | "supplier_mapping_created"
  | "empty_subject";

export type TravelIssue = {
  code: TravelIssueCode;
  recordId: string;
  message: string;
};

const PROHIBITED_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "clock time", pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/ },
  { label: "currency symbol", pattern: /[€$£]/ },
  { label: "PIN", pattern: /\bPIN\b/ },
  { label: "confirmation number", pattern: /confirmation number/i },
  { label: "booking reference", pattern: /booking reference/i },
  { label: "last train", pattern: /last train/i },
];

export function isLiveQuote(amount: CatalogAmount): boolean {
  return (
    amount.presentation === "dated_offer" &&
    amount.liveQuote &&
    amount.freshness === "fresh" &&
    amount.lastVerifiedAt !== null &&
    amount.expiresAt !== null
  );
}

export function checkTravelCatalog(catalog: TravelCatalog): TravelIssue[] {
  const issues: TravelIssue[] = [];
  const countries = indexById(catalog.countries);
  const regions = indexById(catalog.regions);
  const stayBases = indexById(catalog.stayBases);
  const areas = indexById(catalog.areas);
  const properties = indexById(catalog.properties);
  const rates = indexById(catalog.rates);
  const flights = indexById(catalog.flightTemplates);

  issues.push(
    ...duplicateIds(catalog.countries.map((record) => record.id), "country"),
    ...duplicateIds(catalog.regions.map((record) => record.id), "region"),
    ...duplicateIds(catalog.stayBases.map((record) => record.id), "stay base"),
    ...duplicateIds(catalog.areas.map((record) => record.id), "area"),
    ...duplicateIds(catalog.properties.map((record) => record.id), "property"),
    ...duplicateIds(catalog.rates.map((record) => record.id), "rate"),
    ...duplicateIds(catalog.flightTemplates.map((record) => record.id), "flight template"),
    ...duplicateIds(catalog.amounts.map((record) => record.id), "amount"),
    ...duplicateIds(catalog.referenceProfiles.map((record) => record.id), "profile"),
    ...duplicateIds(catalog.recommendations.map((record) => record.id), "recommendation"),
    ...duplicateIds(catalog.provenance.map((record) => record.id), "provenance"),
    ...duplicateIds(catalog.provenance.map((record) => record.sourceId), "source"),
  );

  const rateKeys = new Set<string>();
  for (const rate of catalog.rates) {
    const rateKey = `${rate.sourceId}:${rate.rateKey}`;
    if (rateKeys.has(rateKey)) {
      issues.push({
        code: "duplicate_id",
        recordId: rate.id,
        message: `Duplicate rate key for ${rate.sourceId}.`,
      });
    }
    rateKeys.add(rateKey);

    const property = properties.get(rate.propertyId);
    if (!property) {
      issues.push({
        code: "missing_subject",
        recordId: rate.id,
        message: `Rate references missing property ${rate.propertyId}.`,
      });
    } else if (!property.sourceIds.includes(rate.sourceId)) {
      issues.push({
        code: "missing_subject",
        recordId: rate.id,
        message: `Rate source ${rate.sourceId} is not on its property.`,
      });
    }
  }

  for (const property of catalog.properties) {
    if (!countries.has(property.countryId)) {
      issues.push({
        code: "missing_subject",
        recordId: property.id,
        message: `Property references missing country ${property.countryId}.`,
      });
    }
    const region = regions.get(property.regionId);
    if (!region) {
      issues.push({
        code: "missing_subject",
        recordId: property.id,
        message: `Property references missing region ${property.regionId}.`,
      });
    }
    if (property.stayBaseId === null) {
      if (property.areaId !== null) {
        issues.push({
          code: "area_base_mismatch",
          recordId: property.id,
          message: "An area requires a stay base.",
        });
      }
    } else {
      const stayBase = stayBases.get(property.stayBaseId);
      if (!stayBase) {
        issues.push({
          code: "missing_subject",
          recordId: property.id,
          message: `Property references missing stay base ${property.stayBaseId}.`,
        });
      } else if (stayBase.regionId !== property.regionId) {
        issues.push({
          code: "region_mismatch",
          recordId: property.id,
          message: "Property region does not match its stay base.",
        });
      }
    }
    if (property.areaId !== null) {
      const area = areas.get(property.areaId);
      if (!area) {
        issues.push({
          code: "missing_subject",
          recordId: property.id,
          message: `Property references missing area ${property.areaId}.`,
        });
      } else if (area.stayBaseId !== property.stayBaseId) {
        issues.push({
          code: "area_base_mismatch",
          recordId: property.id,
          message: "Property area belongs to a different stay base.",
        });
      }
    }
  }

  for (const area of catalog.areas) {
    if (!stayBases.has(area.stayBaseId)) {
      issues.push({
        code: "missing_subject",
        recordId: area.id,
        message: `Area references missing stay base ${area.stayBaseId}.`,
      });
    }
  }

  for (const stayBase of catalog.stayBases) {
    const region = regions.get(stayBase.regionId);
    if (!region || region.countryId !== stayBase.countryId || !countries.has(stayBase.countryId)) {
      issues.push({
        code: "region_mismatch",
        recordId: stayBase.id,
        message: "Stay base country and region do not match.",
      });
    }
  }

  for (const flight of catalog.flightTemplates) {
    for (const leg of flight.legs) {
      if (leg.endpointStayBaseId !== null && !stayBases.has(leg.endpointStayBaseId)) {
        issues.push({
          code: "missing_subject",
          recordId: flight.id,
          message: `Leg references missing stay base ${leg.endpointStayBaseId}.`,
        });
      }
    }
  }

  const amountsBySubject = new Map<string, number>();
  for (const amount of catalog.amounts) {
    const subjectKey = `${amount.subject.type}:${amount.subject.id}`;
    amountsBySubject.set(subjectKey, (amountsBySubject.get(subjectKey) ?? 0) + 1);
    const subjectExists =
      amount.subject.type === "stay_rate"
        ? rates.has(amount.subject.id)
        : flights.has(amount.subject.id);
    if (!subjectExists) {
      issues.push({
        code: "missing_subject",
        recordId: amount.id,
        message: "Amount references a missing rate or flight template.",
      });
    }
    issues.push(...historicalAmountIssues(amount));
    if ((amount.amountMinor === null) !== (amount.currency === null)) {
      issues.push({
        code: "historical_amount_presented_as_current",
        recordId: amount.id,
        message: "A reference amount needs both a minor-unit value and a currency, or neither.",
      });
    }
  }

  for (const rate of catalog.rates) {
    if ((amountsBySubject.get(`stay_rate:${rate.id}`) ?? 0) !== 1) {
      issues.push({
        code: "missing_subject",
        recordId: rate.id,
        message: "Each stay rate has one historical amount row.",
      });
    }
  }
  for (const flight of catalog.flightTemplates) {
    if ((amountsBySubject.get(`flight_template:${flight.id}`) ?? 0) !== 1) {
      issues.push({
        code: "missing_subject",
        recordId: flight.id,
        message: "Each flight template has one historical amount row.",
      });
    }
  }

  for (const profile of catalog.referenceProfiles) {
    if (!properties.has(profile.propertyId)) {
      issues.push({
        code: "missing_subject",
        recordId: profile.id,
        message: `Profile references missing property ${profile.propertyId}.`,
      });
    }
    if (profile.verified || profile.provenance === "supplier" || profile.guestScoreScale !== null) {
      issues.push({
        code: "editorial_marked_verified",
        recordId: profile.id,
        message: "A supplied guest score is not a verified supplier rating.",
      });
    }
  }

  for (const recommendation of catalog.recommendations) {
    if (recommendation.verified) {
      issues.push({
        code: "editorial_marked_verified",
        recordId: recommendation.id,
        message: "An editorial recommendation is not an independently verified fact.",
      });
    }
    if (
      recommendation.propertyIds.length === 0 &&
      recommendation.stayBaseId === null &&
      recommendation.regionId === null
    ) {
      issues.push({
        code: "empty_subject",
        recordId: recommendation.id,
        message: "Recommendation has no subject.",
      });
    }
    for (const propertyId of recommendation.propertyIds) {
      if (!properties.has(propertyId)) {
        issues.push({
          code: "missing_subject",
          recordId: recommendation.id,
          message: `Recommendation references missing property ${propertyId}.`,
        });
      }
    }
    if (recommendation.stayBaseId !== null && !stayBases.has(recommendation.stayBaseId)) {
      issues.push({
        code: "missing_subject",
        recordId: recommendation.id,
        message: `Recommendation references missing stay base ${recommendation.stayBaseId}.`,
      });
    }
    if (recommendation.regionId !== null && !regions.has(recommendation.regionId)) {
      issues.push({
        code: "missing_subject",
        recordId: recommendation.id,
        message: `Recommendation references missing region ${recommendation.regionId}.`,
      });
    }
  }

  issues.push(...prohibitedText(editorialText(catalog)));
  return issues;
}

export function checkThailandImport(catalog: TravelCatalog): TravelIssue[] {
  const issues: TravelIssue[] = [];
  const approvals = [
    ...catalog.countries,
    ...catalog.regions,
    ...catalog.stayBases,
    ...catalog.areas,
    ...catalog.properties,
    ...catalog.rates,
    ...catalog.flightTemplates,
    ...catalog.amounts,
    ...catalog.recommendations,
  ];

  for (const record of approvals) {
    if (record.approval === "approved") {
      issues.push({
        code: "import_approved",
        recordId: record.id,
        message: "Imported Thailand records stay unapproved.",
      });
    }
  }

  if (
    catalog.supplierLinks.length > 0 ||
    catalog.dynamicUpdates.length > 0 ||
    catalog.suggestions.length > 0
  ) {
    issues.push({
      code: "supplier_mapping_created",
      recordId: "import",
      message: "The markdown import does not create supplier links, refreshes, or suggestions.",
    });
  }

  for (const amount of catalog.amounts) {
    if (amount.presentation !== "historical_reference" || amount.source.retrievedBy !== "manual") {
      issues.push({
        code: "historical_amount_presented_as_current",
        recordId: amount.id,
        message: "Imported amounts are manual historical references.",
      });
    }
  }

  return issues;
}

function historicalAmountIssues(amount: CatalogAmount): TravelIssue[] {
  if (amount.presentation !== "historical_reference") {
    return [];
  }

  const presentedAsCurrent =
    amount.liveQuote ||
    amount.freshness !== "unverified" ||
    amount.lastVerifiedAt !== null ||
    amount.expiresAt !== null ||
    amount.lastCheckedAt !== null;

  if (!presentedAsCurrent) {
    return [];
  }

  return [
    {
      code: "historical_amount_presented_as_current",
      recordId: amount.id,
      message: "A historical reference amount is not a current rate or a live quote.",
    },
  ];
}

function editorialText(catalog: TravelCatalog): readonly { id: string; value: string }[] {
  const values: { id: string; value: string }[] = [];
  const add = (id: string, value: string | null) => {
    if (value !== null && value.length > 0) {
      values.push({ id, value });
    }
  };

  for (const country of catalog.countries) {
    add(country.id, country.name);
  }
  for (const region of catalog.regions) {
    add(region.id, region.name);
  }
  for (const stayBase of catalog.stayBases) {
    add(stayBase.id, stayBase.name);
    add(stayBase.id, stayBase.summary);
    for (const alias of stayBase.aliases) {
      add(stayBase.id, alias);
    }
  }
  for (const area of catalog.areas) {
    add(area.id, area.name);
  }
  for (const property of catalog.properties) {
    add(property.id, property.name);
  }
  for (const rate of catalog.rates) {
    add(rate.id, rate.suppliedLabel);
    add(rate.id, rate.roomCategory);
  }
  for (const flight of catalog.flightTemplates) {
    for (const carrier of flight.carriers) {
      add(flight.id, carrier);
    }
    for (const leg of flight.legs) {
      add(flight.id, leg.origin);
      add(flight.id, leg.destination);
    }
  }
  for (const amount of catalog.amounts) {
    add(amount.id, amount.note);
  }
  for (const recommendation of catalog.recommendations) {
    add(recommendation.id, recommendation.body);
    add(recommendation.id, recommendation.stance);
  }
  for (const finding of catalog.findings) {
    add(finding.sourceId ?? finding.field, finding.message);
  }

  return values;
}

function prohibitedText(values: readonly { id: string; value: string }[]): TravelIssue[] {
  const issues: TravelIssue[] = [];
  for (const entry of values) {
    for (const rule of PROHIBITED_PATTERNS) {
      if (rule.pattern.test(entry.value)) {
        issues.push({
          code: "prohibited_content",
          recordId: entry.id,
          message: `Text includes a ${rule.label}.`,
        });
      }
    }
  }
  return issues;
}

function duplicateIds(ids: readonly string[], label: string): TravelIssue[] {
  const seen = new Set<string>();
  const issues: TravelIssue[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push({
        code: "duplicate_id",
        recordId: id,
        message: `Duplicate ${label} id.`,
      });
    }
    seen.add(id);
  }
  return issues;
}

function indexById<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

export function findingsFor(
  catalog: TravelCatalog,
  kind: ImportFinding["kind"],
  sourceId: string | null,
): readonly ImportFinding[] {
  return catalog.findings.filter(
    (finding) => finding.kind === kind && finding.sourceId === sourceId,
  );
}
