import type { ShortlistBand } from "../../travel/schema";

const SOURCE_ID = /\b((?:TH-F|BK-H|PH-H|KR-H|CM-H)\d{3}[A-Z]?)\b/;

export type StaySection = "bangkok" | "phuket" | "krabi" | "chiang_mai";
export type FieldPresence = "stated" | "not_provided" | "absent";
export type BreakfastInclusion = "included" | "not_included" | "unknown";

export type ParsedFlight = {
  sourceId: string;
  raw: string;
  header: string;
  routeText: string | null;
  airlineText: string;
  amountDollars: number;
  optionText: string;
};

export type ParsedPrice = {
  dollars: number;
  breakfast: BreakfastInclusion;
};

export type ParsedStay = {
  sourceId: string;
  raw: string;
  name: string;
  section: StaySection;
  band: ShortlistBand | null;
  areaText: string | null;
  areaPresence: FieldPresence;
  stars: number | null;
  starsPresence: FieldPresence;
  rating: number | null;
  ratingPresence: FieldPresence;
  roomSquareMeters: number | null;
  roomPresence: FieldPresence;
  prices: ParsedPrice[];
  pricePresence: FieldPresence;
  notes: string[];
  qualityReview: boolean;
};

export type ParsedTierNote = {
  section: StaySection;
  lines: string[];
};

export type StatedCounts = {
  documentTotal: number | null;
  flights: number | null;
  bangkok: number | null;
  phuket: number | null;
  krabi: number | null;
  chiangMai: number | null;
};

export type ParsedInventory = {
  flights: ParsedFlight[];
  stays: ParsedStay[];
  tierNotes: ParsedTierNote[];
  stated: StatedCounts;
};

type Section = "preamble" | "flights" | StaySection | "rules";

export function expectedSourceIds(): string[] {
  const ids: string[] = [];
  const add = (prefix: string, from: number, to: number) => {
    for (let number = from; number <= to; number += 1) {
      ids.push(`${prefix}${String(number).padStart(3, "0")}`);
    }
  };

  add("TH-F", 1, 16);
  add("BK-H", 1, 10);
  add("PH-H", 1, 13);
  ids.push("PH-H014A", "PH-H014B");
  add("PH-H", 15, 16);
  add("KR-H", 1, 22);
  add("CM-H", 1, 73);
  ids.push("CM-H063B");
  return ids;
}

export function parseThailandInventory(markdown: string): ParsedInventory {
  const lines = markdown.split(/\r?\n/);
  let section: Section = "preamble";
  let band: ShortlistBand | null = null;
  let flightHeader: string | null = null;
  let collectingTier = false;
  const flights: ParsedFlight[] = [];
  const stays: ParsedStay[] = [];
  const tierNotes: ParsedTierNote[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const plain = stripMarks(lines[index] ?? "");
    if (plain.length === 0) {
      continue;
    }

    const nextSection = detectSection(plain);
    if (nextSection) {
      section = nextSection;
      band = null;
      flightHeader = null;
      collectingTier = false;
      continue;
    }

    if (isTierHeading(plain) && isStaySection(section)) {
      collectingTier = true;
      tierNotes.push({ section, lines: [] });
      continue;
    }

    if (collectingTier) {
      const current = tierNotes[tierNotes.length - 1];
      if (current) {
        current.lines.push(plain);
      }
      continue;
    }

    if (section === "flights" && isFlightHeader(plain)) {
      flightHeader = plain;
      continue;
    }

    const nextBand = detectBand(plain);
    if (nextBand && !SOURCE_ID.test(plain)) {
      band = nextBand;
      continue;
    }

    const idMatch = plain.match(SOURCE_ID);
    const sourceId = idMatch?.[1];
    if (!sourceId) {
      continue;
    }

    const block = [plain];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextPlain = stripMarks(lines[cursor] ?? "");
      if (nextPlain.length === 0) {
        cursor += 1;
        continue;
      }
      if (
        SOURCE_ID.test(nextPlain) ||
        detectSection(nextPlain) ||
        isTierHeading(nextPlain) ||
        (section === "flights" && isFlightHeader(nextPlain)) ||
        (detectBand(nextPlain) !== null && !SOURCE_ID.test(nextPlain))
      ) {
        break;
      }
      block.push(nextPlain);
      cursor += 1;
    }
    index = cursor - 1;

    if (sourceId.startsWith("TH-F")) {
      if (flightHeader === null) {
        throw new Error(`Flight ${sourceId} has no route heading.`);
      }
      flights.push(parseFlight(sourceId, block, flightHeader));
      continue;
    }

    if (!isStaySection(section)) {
      throw new Error(`Stay ${sourceId} is outside an accommodation section.`);
    }
    stays.push(parseStay(sourceId, block, section, band));
  }

  const found = flights.map((flight) => flight.sourceId).concat(stays.map((stay) => stay.sourceId));
  assertSourceIds(found);

  return {
    flights,
    stays,
    tierNotes,
    stated: statedCounts(markdown),
  };
}

function parseFlight(sourceId: string, block: string[], header: string): ParsedFlight {
  const line = block[0];
  if (!line) {
    throw new Error(`Flight ${sourceId} is empty.`);
  }
  const after = line.slice(line.indexOf(sourceId) + sourceId.length).trim();
  const domestic = after.match(/^(.+?→.+?)\s+(.+?)\s+\$(\d+)\s+(.+)$/);
  const priced = domestic ?? after.match(/^(.+?)\s+\$(\d+)\s+(.+)$/);
  if (!priced) {
    throw new Error(`Flight ${sourceId} could not be read: ${line}`);
  }

  const routeText = domestic ? (priced[1]?.trim() ?? null) : null;
  const airlineText = domestic ? (priced[2]?.trim() ?? "") : (priced[1]?.trim() ?? "");
  const dollars = Number(domestic ? priced[3] : priced[2]);
  const optionText = (domestic ? priced[4] : priced[3])?.trim() ?? "";
  if (!Number.isInteger(dollars) || airlineText.length === 0 || optionText.length === 0) {
    throw new Error(`Flight ${sourceId} is missing an airline, price, or option.`);
  }

  return {
    sourceId,
    raw: block.join("\n"),
    header,
    routeText,
    airlineText,
    amountDollars: dollars,
    optionText,
  };
}

function parseStay(
  sourceId: string,
  block: string[],
  section: StaySection,
  band: ShortlistBand | null,
): ParsedStay {
  const first = block[0];
  if (!first) {
    throw new Error(`Stay ${sourceId} is empty.`);
  }
  const name = nameFromLine(first, sourceId);
  const raw = block.join("\n");
  const stars = parseStars(raw);
  const rating = parseRating(raw);
  const room = parseRoom(raw);
  const area = parseArea(block, section);
  const notes = notesFrom(block);
  const prices = pricesFrom(block, notes.notes);
  const pricePresence: FieldPresence =
    prices.length > 0 ? "stated" : /price not provided/i.test(raw) ? "not_provided" : "absent";

  return {
    sourceId,
    raw,
    name,
    section,
    band,
    areaText: area.text,
    areaPresence: area.presence,
    stars: stars.value,
    starsPresence: stars.presence,
    rating: rating.value,
    ratingPresence: rating.presence,
    roomSquareMeters: room.value,
    roomPresence: room.presence,
    prices,
    pricePresence,
    notes: notes.notes,
    qualityReview: notes.qualityReview,
  };
}

function nameFromLine(line: string, sourceId: string): string {
  const after = line.slice(line.indexOf(sourceId) + sourceId.length);
  const parts = after
    .split(" — ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const name = parts[0];
  if (!name) {
    throw new Error(`Stay ${sourceId} has no name.`);
  }
  return name;
}

function parseStars(block: string): { value: number | null; presence: FieldPresence } {
  if (/stars:?\s*not provided/i.test(block)) {
    return { value: null, presence: "not_provided" };
  }
  const match = block.match(/(\d)\s*★/);
  if (!match?.[1]) {
    return { value: null, presence: "absent" };
  }
  return { value: Number(match[1]), presence: "stated" };
}

function parseRating(block: string): { value: number | null; presence: FieldPresence } {
  if (/rating:?\s*not provided/i.test(block)) {
    return { value: null, presence: "not_provided" };
  }
  const match = block.match(/rating:?\s*(\d+(?:\.\d+)?)/i);
  if (!match?.[1]) {
    return { value: null, presence: "absent" };
  }
  return { value: Number(match[1]), presence: "stated" };
}

function parseRoom(block: string): { value: number | null; presence: FieldPresence } {
  if (/room(?:\s+size)?:?\s*not provided/i.test(block)) {
    return { value: null, presence: "not_provided" };
  }
  const match = block.match(/(\d+)\s*m²/);
  if (!match?.[1]) {
    return { value: null, presence: "absent" };
  }
  return { value: Number(match[1]), presence: "stated" };
}

function parseArea(
  block: string[],
  section: StaySection,
): { text: string | null; presence: FieldPresence } {
  if (section !== "phuket" && section !== "krabi") {
    return { text: null, presence: "absent" };
  }

  for (const line of block.slice(1)) {
    const labeled = line.match(/^Area:\s*(.+?)(?:\s·|$)/i);
    if (labeled?.[1]) {
      const text = labeled[1].trim();
      return {
        text,
        presence: /not provided/i.test(text) ? "not_provided" : "stated",
      };
    }
    const lead = line.split("·")[0]?.trim() ?? "";
    if (/^(Patong|Karon|Kamala|Bang Tao|Koh Lanta|Ko Lanta|Ao Nang)\b/i.test(lead)) {
      return { text: lead, presence: "stated" };
    }
  }

  return { text: null, presence: "absent" };
}

function notesFrom(block: string[]): { notes: string[]; qualityReview: boolean } {
  const notes: string[] = [];
  let qualityReview = false;

  for (const line of block) {
    if (/quality review|review quality/i.test(line)) {
      qualityReview = true;
    }
    const labeled = line.match(/^Notes:\s*(.+)$/i);
    if (labeled?.[1]) {
      notes.push(labeled[1].trim());
      continue;
    }
    if (
      /quality review|your recommended|your first|high recommendation|your premium|level 1 luxury|first choice if budget/i.test(
        line,
      )
    ) {
      notes.push(line.trim());
      continue;
    }
    if (line === block[0] || isMetaLine(line)) {
      continue;
    }
    notes.push(line.trim());
  }

  return { notes, qualityReview };
}

function isMetaLine(line: string): boolean {
  return (
    /★/.test(line) ||
    /\$\d/.test(line) ||
    /m²/.test(line) ||
    /^area:/i.test(line) ||
    /^room\b/i.test(line) ||
    /\brating\b/i.test(line) ||
    /\bstars?\b/i.test(line) ||
    /price not provided/i.test(line)
  );
}

function pricesFrom(block: string[], notes: readonly string[]): ParsedPrice[] {
  const noteLines = new Set(notes.map((note) => note.trim()));
  const prices: ParsedPrice[] = [];
  for (const line of block) {
    if (noteLines.has(line.trim())) {
      continue;
    }
    if (/price not provided/i.test(line) && !/\$\d/.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/\$(\d+)/g)) {
      const dollars = Number(match[1]);
      if (!Number.isInteger(dollars)) {
        continue;
      }
      let breakfast: BreakfastInclusion = "unknown";
      if (/without breakfast/i.test(line)) {
        breakfast = "not_included";
      } else if (/with breakfast/i.test(line)) {
        breakfast = "included";
      }
      prices.push({ dollars, breakfast });
    }
  }

  if (prices.length === 1) {
    const noteText = notes.join(" ");
    const price = prices[0];
    if (price && /breakfast not specified/i.test(noteText)) {
      price.breakfast = "unknown";
    } else if (price && /breakfast included/i.test(noteText)) {
      price.breakfast = "included";
    }
  }

  return prices;
}

function statedCounts(markdown: string): StatedCounts {
  const read = (pattern: RegExp) => {
    const match = markdown.match(pattern);
    return match?.[1] ? Number(match[1]) : null;
  };

  return {
    documentTotal: read(/Total:\s*(\d+)\s+flight and accommodation records/i),
    flights: read(/Flights:\s*(\d+)\s+options/i),
    bangkok: read(/Bangkok accommodation:\s*(\d+)\s+records/i),
    phuket: read(/Phuket accommodation:\s*(\d+)\s+rate records/i),
    krabi: read(/Krabi\s*\/\s*Koh Lanta accommodation:\s*(\d+)\s+records/i),
    chiangMai: read(/Chiang Mai accommodation:\s*(\d+)\s+records/i),
  };
}

function assertSourceIds(found: readonly string[]): void {
  const expected = expectedSourceIds();
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !foundSet.has(id));
  const unexpected = found.filter((id) => !expectedSet.has(id));
  const duplicates = found.filter((id, index) => found.indexOf(id) !== index);
  if (missing.length === 0 && unexpected.length === 0 && duplicates.length === 0) {
    return;
  }
  throw new Error(
    `Thailand source ids did not match the explicit list. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}. Duplicates: ${duplicates.join(", ") || "none"}.`,
  );
}

function stripMarks(value: string): string {
  return value
    .replace(/\*/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\u26A0\uFE0F?/g, "")
    .trim();
}

function detectSection(plain: string): Section | null {
  if (/\bFLIGHTS\b/i.test(plain) && /\b1\./.test(plain)) {
    return "flights";
  }
  if (/BANGKOK ACCOMMODATION/i.test(plain)) {
    return "bangkok";
  }
  if (/PHUKET ACCOMMODATION/i.test(plain)) {
    return "phuket";
  }
  if (/KRABI\s*&\s*KOH LANTA ACCOMMODATION/i.test(plain)) {
    return "krabi";
  }
  if (/CHIANG MAI ACCOMMODATION/i.test(plain)) {
    return "chiang_mai";
  }
  if (/VOYARA DATABASE/i.test(plain)) {
    return "rules";
  }
  return null;
}

function detectBand(plain: string): ShortlistBand | null {
  if (/^Cheapest\s*\/\s*Budget/i.test(plain) || /^A\.\s*Cheapest/i.test(plain)) {
    return "cheapest_budget";
  }
  if (/^Recommended\s*\/\s*Strong-value/i.test(plain)) {
    return "recommended";
  }
  if (/^Premium$/i.test(plain)) {
    return "premium";
  }
  if (/^Four-star options/i.test(plain)) {
    return "four_star";
  }
  if (/^Higher-priced/i.test(plain)) {
    return "higher_priced";
  }
  if (/^B\.\s*Mid-range/i.test(plain)) {
    return "mid_range";
  }
  if (/^C\.\s*Upper mid-range/i.test(plain)) {
    return "upper_mid";
  }
  if (/^D\.\s*Luxury/i.test(plain)) {
    return "luxury";
  }
  return null;
}

function isFlightHeader(plain: string): boolean {
  return /^[A-F]\.\s+/.test(plain) || /Domestic flights from Bangkok/i.test(plain);
}

function isTierHeading(plain: string): boolean {
  return /tier notes$/i.test(plain) || /initial recommendations$/i.test(plain);
}

function isStaySection(section: Section): section is StaySection {
  return (
    section === "bangkok" ||
    section === "phuket" ||
    section === "krabi" ||
    section === "chiang_mai"
  );
}
