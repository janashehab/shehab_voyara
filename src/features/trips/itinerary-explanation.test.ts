import assert from "node:assert/strict";
import test from "node:test";

import { parisCatalog, type PlaceId } from "@/lib/catalog";
import {
  editorialVisitEstimate,
  eligibleSampleNote,
  interestExplanation,
} from "./itinerary-explanation";

test("an interest explanation names only the selected matches", () => {
  assert.equal(
    interestExplanation({ vibeTags: ["landmark", "views"], majorDayCommitment: false }, ["landmarks"]),
    "Matches your interest: Landmarks",
  );
  assert.equal(
    interestExplanation({ vibeTags: ["landmark", "gothic"], majorDayCommitment: false }, ["landmarks", "museums"]),
    "Matches your interests: Landmarks, Museums",
  );
  assert.equal(
    interestExplanation({ vibeTags: ["landmark", "views"], majorDayCommitment: false }, ["walks"]),
    null,
  );
  const ride = interestExplanation(
    { vibeTags: ["ride", "theme-park"], majorDayCommitment: true },
    ["theme_parks"],
  );
  assert.equal(ride, "Matches your interest: Theme parks");
  assert.equal(ride?.toLowerCase().includes("full"), false);
});

test("editorial visit estimates use the stored minutes and skip missing values", () => {
  assert.equal(editorialVisitEstimate(90), "Editorial visit estimate: 1 hr 30 min");
  assert.equal(editorialVisitEstimate(30), "Editorial visit estimate: 30 min");
  assert.equal(editorialVisitEstimate(null), null);
  assert.equal(editorialVisitEstimate(undefined), null);
  assert.equal(editorialVisitEstimate(0), null);
  assert.equal(editorialVisitEstimate(-15), null);
  assert.equal(editorialVisitEstimate(Number.NaN), null);
});

test("sample notes stay only when one approved note is useful off the sample route", () => {
  const places = new Map(parisCatalog.places.map((place) => [place.id, place]));
  const notesFor = (placeId: PlaceId) =>
    parisCatalog.sampleItineraryItems
      .filter((item) => item.placeId === placeId)
      .map((item) => item.editorialNote);
  const noteFor = (placeId: PlaceId) =>
    eligibleSampleNote(notesFor(placeId), places.get(placeId)?.editorialSummary ?? "");

  assert.equal(
    noteFor("plc_paris_rue_lepic"),
    "Walking route toward Montmartre, not a separate appointment.",
  );
  assert.equal(
    noteFor("plc_paris_pink_mamma"),
    "Optional dining suggestion. Choosing this does not require Bouillon Pigalle.",
  );
  assert.equal(noteFor("plc_paris_eiffel_tower"), null);
  assert.equal(noteFor("plc_paris_pigalle"), null);
  assert.equal(noteFor("plc_paris_disneyland_parade"), null);
  assert.equal(noteFor("plc_paris_sainte_chapelle"), null);
  assert.equal(noteFor("plc_paris_arc_de_triomphe"), null);
  assert.equal(
    noteFor("plc_paris_bouillon_pigalle"),
    "Optional dining suggestion. Choosing this does not require Pink Mamma.",
  );

  const bouillon = places.get("plc_paris_bouillon_pigalle");
  assert.ok(bouillon);
  assert.equal(
    eligibleSampleNote(["Optional dining suggestion for the first day."], bouillon.editorialSummary),
    null,
  );
});
