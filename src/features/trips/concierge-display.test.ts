import assert from "node:assert/strict";
import test from "node:test";

import {
  clarificationFocus,
  beforeYouGoNotices,
  dayCommitmentNotices,
  describeCurrentTrip,
  draftSummary,
  describeMobility,
  describeTripPace,
  developmentPreviewExamples,
  displayedBrief,
  initialConciergeAnswers,
  pendingAnswersCopy,
  reduceBrief,
  reconcilePending,
  lockStopName,
  lockStopNote,
  lockedStopStatus,
  replacementDialog,
  replacementFailureMessage,
  replacementKeptDraft,
  startOverDialog,
  startOverMessage,
  undoButtonLabel,
  undoExplanation,
  type TripBrief,
} from "./concierge-display";

test("current pace stays distinct from the first questionnaire answer", () => {
  const same = describeTripPace("steady", "steady");
  assert.equal(same.currentLabel, "Steady");
  assert.equal(same.initialNote, null);

  const relaxed = describeTripPace("unhurried", "steady");
  assert.equal(relaxed.currentLabel, "Unhurried");
  assert.equal(relaxed.initialNote, "Your first answer was Steady.");
  assert.equal(describeTripPace("steady", "full").initialNote, "Your first answer was Full.");
  assert.equal(describeMobility("limited_walking"), "Walking preference: limited walking. Distance and access are not verified.");
  assert.equal(describeMobility(null), null);
});

test("start over clears the questionnaire and the follow-up note", () => {
  const dirty = initialConciergeAnswers();
  dirty.step = "plan";
  dirty.dayCount = 7;
  dirty.interests = ["museums"];
  dirty.initialPace = "full";
  dirty.selectedDay = 3;
  dirty.note = "replace a museum";

  assert.deepEqual(initialConciergeAnswers(), {
    step: "place",
    dayCount: null,
    interests: [],
    initialPace: null,
    selectedDay: 1,
    note: "",
  });
  assert.equal(dirty.initialPace, "full");
  assert.equal(clarificationFocus(["pace", "dayCount"]), "days");
  assert.equal(clarificationFocus(["interests"]), "interests");
  assert.equal(clarificationFocus(["pace"]), "pace");
  assert.equal(clarificationFocus([]), null);
  assert.equal(developmentPreviewExamples.includes("two food days"), true);
});

const steadyTrip: TripBrief = {
  dayCount: 2,
  interests: ["landmarks"],
  pace: "steady",
};

test("a clean questionnaire matches the draft and does not request replacement", () => {
  const sameDay = reduceBrief(steadyTrip, null, { type: "day", dayCount: 2 });
  assert.equal(sameDay.pending, null);
  assert.equal(sameDay.replace, false);
  assert.deepEqual(displayedBrief(steadyTrip, null), steadyTrip);
  assert.equal(describeCurrentTrip(steadyTrip), "2 days. Landmarks. Pace: Steady.");
  assert.equal(describeCurrentTrip({ dayCount: 1, interests: ["food", "museums"], pace: "unhurried" }), "1 day. Museums, Food. Pace: Unhurried.");

  const unchangedInterests = reduceBrief(steadyTrip, null, { type: "interests", interests: ["landmarks"] });
  assert.equal(unchangedInterests.pending, null);
  assert.equal(reduceBrief(steadyTrip, null, { type: "confirm" }).replace, false);
});

test("edited answers stay pending until replacement is confirmed", () => {
  const longer = reduceBrief(steadyTrip, null, { type: "day", dayCount: 3 });
  assert.deepEqual(longer.pending, { dayCount: 3 });
  assert.equal(longer.replace, false);
  assert.equal(displayedBrief(steadyTrip, longer.pending).dayCount, 3);
  assert.equal(displayedBrief(steadyTrip, longer.pending).pace, "steady");

  const withPace = reduceBrief(steadyTrip, longer.pending, { type: "pace", pace: "full" });
  assert.deepEqual(withPace.pending, { dayCount: 3, pace: "full" });
  assert.equal(displayedBrief(steadyTrip, withPace.pending).pace, "full");

  const paceRestored = reduceBrief(steadyTrip, withPace.pending, { type: "pace", pace: "steady" });
  assert.deepEqual(paceRestored.pending, { dayCount: 3 });

  const cancelled = reduceBrief(steadyTrip, paceRestored.pending, { type: "cancel" });
  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.replace, false);
  assert.deepEqual(displayedBrief(steadyTrip, cancelled.pending), steadyTrip);

  const pending = reduceBrief(steadyTrip, null, { type: "day", dayCount: 4 }).pending;
  const escaped = reduceBrief(steadyTrip, pending, { type: "escape" });
  assert.equal(escaped.replace, false);
  assert.deepEqual(escaped.pending, pending);

  const confirmed = reduceBrief(steadyTrip, pending, { type: "confirm" });
  assert.equal(confirmed.replace, true);
  assert.deepEqual(confirmed.pending, pending);
  assert.equal(replacementDialog.body.includes("Locked stops"), true);
  assert.equal(replacementDialog.body.includes("follow-up changes"), true);
  assert.equal(pendingAnswersCopy.stays.includes("locked stops"), true);
});

test("a failed replacement keeps the pending answers and the current draft wording", () => {
  const pending = reduceBrief(steadyTrip, null, { type: "interests", interests: ["landmarks", "food"] }).pending;
  const refined = reconcilePending({ ...steadyTrip, pace: "unhurried" }, pending);
  assert.deepEqual(refined, { interests: ["landmarks", "food"] });
  assert.equal(displayedBrief({ ...steadyTrip, pace: "unhurried" }, refined).pace, "unhurried");
  assert.equal(displayedBrief({ ...steadyTrip, pace: "unhurried" }, refined).dayCount, 2);

  const message = replacementFailureMessage("The approved catalog could not be read.");
  assert.equal(message, `The approved catalog could not be read. ${replacementKeptDraft}`);
  assert.equal(replacementFailureMessage(message), message);
  assert.equal(replacementFailureMessage("Try again"), `Try again. ${replacementKeptDraft}`);
});

test("lock controls name the stop and explain what a lock survives", () => {
  assert.equal(lockStopName("Arc de Triomphe", false), "Lock Arc de Triomphe");
  assert.equal(lockStopName("Arc de Triomphe", true), "Unlock Arc de Triomphe");
  assert.equal(lockStopNote.includes("less walking"), true);
  assert.equal(lockStopNote.includes("replaces the whole plan"), true);
  assert.equal(lockedStopStatus, "Stays through a change.");
});

test("the draft summary follows the confirmed trip and not a pending edit", () => {
  const confirmed = { dayCount: 2, interests: ["landmarks"], pace: "steady" as const };
  const pending = { dayCount: 3, interests: ["museums", "food"], pace: "unhurried" as const };
  assert.equal(draftSummary(confirmed, "Paris"), "A 2-day Paris draft for Landmarks, at a steady pace.");
  assert.equal(draftSummary(pending, "Paris"), "A 3-day Paris draft for Museums, Food, at an unhurried pace.");
  assert.equal(
    draftSummary({ dayCount: 1, interests: ["museums", "food"], pace: "unhurried" }, "Paris"),
    "A 1-day Paris draft for Museums, Food, at an unhurried pace.",
  );
  assert.equal(draftSummary(confirmed, "Paris").includes("approved catalog places"), false);
});

test("planning assumptions stay trip-wide and full-day notices stay on their day", () => {
  const notices = [
    { code: "no_prices", message: "The catalog has no verified prices. This plan does not estimate cost.", dayIndex: null },
    { code: "no_opening_hours", message: "Opening hours and showtimes are unknown. This plan does not reserve a time.", dayIndex: null },
    { code: "no_travel_times", message: "Travel times are unknown. This plan does not estimate the journey between stops.", dayIndex: null },
    { code: "planning_heuristic", message: "Daily stop limits are a planning heuristic. They are not a promise that an itinerary is achievable.", dayIndex: null },
    { code: "catalog_gap", message: "This day is below the pace heuristic.", dayIndex: 1 },
    { code: "major_day_commitment", message: "Marne-la-Vallée is a full-day commitment. Opening hours and travel time are unknown, and the stops kept with it are not a timed schedule.", dayIndex: 2 },
    { code: "major_day_mixed", message: "Marne-la-Vallée shares this day with another stop that was kept on purpose. Travel time is unknown, and the mix is not a claim that the day works.", dayIndex: 2 },
  ];
  assert.deepEqual(beforeYouGoNotices(notices).map((notice) => notice.code), [
    "no_prices",
    "no_opening_hours",
    "no_travel_times",
    "planning_heuristic",
  ]);
  assert.deepEqual(dayCommitmentNotices(notices, 2).map((notice) => notice.code), [
    "major_day_commitment",
    "major_day_mixed",
  ]);
  assert.deepEqual(dayCommitmentNotices(notices, 1), []);
});

test("start over asks before clearing and uses the draft message only when a draft exists", () => {
  assert.equal(startOverMessage(false), startOverDialog.withoutDraft);
  assert.equal(startOverMessage(false).includes("Locked stops"), false);
  assert.equal(startOverMessage(true), startOverDialog.withDraft);
  assert.equal(startOverMessage(true).includes("Locked stops"), true);
  assert.equal(startOverDialog.keep, "Keep planning");
});

test("undo names the latest supported refinement and the locks it restores", () => {
  assert.equal(undoButtonLabel("less walking"), "Undo less walking");
  assert.equal(undoButtonLabel("more cafés"), "Undo more cafés");
  assert.equal(undoButtonLabel("museum"), "Undo the museum change");
  assert.equal(undoExplanation.includes("locks from that moment"), true);
  assert.equal(undoExplanation.includes("latest"), true);
});
