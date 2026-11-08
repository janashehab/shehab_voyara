import type { Interest } from "@/features/trips/schemas";
import { interestValues } from "@/features/trips/schemas";
import { durationLabel } from "@/lib/format";
import { placeMatchesInterest } from "@/server/services/planner/categories";
import type { RetrievalPlace } from "@/server/services/planner/retrieve";
import { interestLabels } from "@/features/trips/concierge-display";

/**
 * Notes that only make sense inside the founder sample's day order.
 * A generated draft does not follow that order.
 */
const sampleSequenceNote = /\boriginal\b|\bsequence\b|\bday \d+\b/i;

export function interestExplanation(
  place: { vibeTags: readonly string[]; majorDayCommitment: boolean },
  interests: readonly Interest[],
): string | null {
  const selected = new Set(interests);
  const matched = interestValues.filter(
    (interest) => selected.has(interest) && placeMatchesInterest(retrievalPlace(place), interest),
  );
  if (matched.length === 0) {
    return null;
  }
  const labels = matched.map((interest) => interestLabels[interest]);
  if (labels.length === 1) {
    return `Matches your interest: ${labels[0]}`;
  }
  return `Matches your interests: ${labels.join(", ")}`;
}

export function editorialVisitEstimate(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return null;
  }
  const label = durationLabel(minutes);
  if (!label) {
    return null;
  }
  return `Editorial visit estimate: ${label}`;
}

/**
 * One approved sample note, unchanged, when it is still meaningful on a
 * generated stop. Conflicting, duplicate, and sample-sequence notes are omitted.
 */
export function eligibleSampleNote(
  notes: readonly (string | null)[],
  editorialSummary: string,
): string | null {
  if (notes.length !== 1) {
    return null;
  }
  const note = notes[0]?.trim() ?? "";
  if (!note || sampleSequenceNote.test(note)) {
    return null;
  }
  if (normalizeCopy(editorialSummary).includes(normalizeCopy(note))) {
    return null;
  }
  return note;
}

function retrievalPlace(place: { vibeTags: readonly string[]; majorDayCommitment: boolean }): RetrievalPlace {
  return {
    id: "plc_explanation",
    name: "",
    kind: "poi",
    areaLabel: null,
    vibeTags: place.vibeTags,
    approximateDurationMinutes: null,
    coordinates: null,
    majorDayCommitment: place.majorDayCommitment,
  };
}

function normalizeCopy(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
