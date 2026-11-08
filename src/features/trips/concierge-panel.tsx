"use client";

import { useEffect, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { nextTabIndex } from "@/components/day-tabs";
import { MediaFrame } from "@/components/media-frame";
import {
  clarificationFocus,
  describeCurrentTrip,
  describeMobility,
  describeTripPace,
  developmentPreviewExamples,
  developmentPreviewNotice,
  beforeYouGoNotices,
  dayCommitmentNotices,
  displayedBrief,
  draftSummary,
  initialConciergeAnswers,
  interestLabels,
  lockStopName,
  lockStopNote,
  lockedStopStatus,
  pendingAnswersCopy,
  planStorageCopy,
  reduceBrief,
  undoButtonLabel,
  undoExplanation,
  reconcilePending,
  replacementDialog,
  replacementFailureMessage,
  sampleRouteLabel,
  startOverDialog,
  startOverMessage,
  tripBrief,
  type ConciergeAnswers,
  type PendingBrief,
  type TripBrief,
} from "@/features/trips/concierge-display";
import type {
  ConciergeResult,
  ConciergeView,
  InterpretationSummary,
  InterpretedPlanDraft,
  InterpreterPreviewResult,
} from "@/features/trips/concierge-types";
import {
  clearPlan,
  isBlankPlan,
  readPlan,
  restoredSelectedDay,
  savedPlanDisposition,
  shouldApplyRestore,
  restoredUndo,
  storageWriteAllowed,
  undoForRefinement,
  undoLabelForInstruction,
  writePlan,
  type PlanStorage,
  type SavedPlan,
  type SavedUndo,
  type StorageMode,
} from "@/features/trips/plan-storage";
import type { TravelerPreferences, TripDocument } from "@/features/trips/schemas";
import {
  confirmParisInterpretation,
  confirmParisRefinement,
  planParisItinerary,
  previewParisInterpretation,
  previewParisRefinement,
  refineParisItinerary,
  replaceParisMuseumStop,
  revalidateParisItinerary,
  setParisStopLock,
} from "@/features/trips/actions";

const dayChoices = [1, 2, 3, 4, 5, 7] as const;

const interestChoices = (Object.keys(interestLabels) as (keyof typeof interestLabels)[]).map(
  (value) => [value, interestLabels[value]] as const,
);

const paceChoices = [
  ["unhurried", "Unhurried", "Fewer stops."],
  ["steady", "Steady", "A balanced day."],
  ["full", "Full", "More stops."],
] as const;

const refinements = [
  ["Less walking", "less walking"],
  ["More cafés", "more cafés"],
  ["Replace a museum", "replace a museum"],
] as const;

const prominentNotices = new Set([
  "catalog_gap",
  "thin_coverage",
  "mobility_unknown",
  "pace_overflow",
  "must_see_unscheduled",
  "major_day_commitment",
  "major_day_mixed",
  "exclusion_conflict",
  "excluded_omitted",
]);

type Step = ConciergeAnswers["step"];

type Session = { trip: TripDocument; view: ConciergeView };

type PanelError = { code: string; message: string };

type PlanAnswer = {
  destinationId?: "dst_paris";
  dayCount?: number;
  interests?: string[];
  pace?: TravelerPreferences["pace"];
};

type ConfirmRequest =
  | { kind: "plan-text"; text: string }
  | { kind: "plan-answer"; extracted: InterpretedPlanDraft; answer: PlanAnswer }
  | { kind: "refine-text"; text: string };

type ReadyPreview = {
  kind: "plan" | "refine";
  summary: InterpretationSummary;
  request: ConfirmRequest;
};

const choiceClass = "min-h-11 rounded-full px-4 text-sm font-semibold";
const selectedClass = "bg-peach text-canvas";
const idleClass = "border border-line text-mist";

export function ConciergePanel() {
  const blank = initialConciergeAnswers();
  const [step, setStep] = useState<Step>(blank.step);
  const [dayCount, setDayCount] = useState<number | null>(blank.dayCount);
  const [interests, setInterests] = useState<string[]>(blank.interests);
  const [pace, setPace] = useState<TravelerPreferences["pace"] | null>(blank.initialPace);
  const [session, setSession] = useState<Session | null>(null);
  const [selectedDay, setSelectedDay] = useState(blank.selectedDay);
  const [note, setNote] = useState(blank.note);
  const [previewText, setPreviewText] = useState("");
  const [draft, setDraft] = useState<InterpretedPlanDraft | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [ready, setReady] = useState<ReadyPreview | null>(null);
  const [understood, setUnderstood] = useState<InterpretationSummary | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [pendingBrief, setPendingBrief] = useState<PendingBrief | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("hold");
  const [restoring, setRestoring] = useState(true);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<SavedUndo | null>(null);
  const [pending, startTransition] = useTransition();
  const actionGeneration = useRef(0);
  const undoFocusRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const startOverDialogRef = useRef<HTMLDialogElement>(null);
  const startOverButtonRef = useRef<HTMLButtonElement>(null);
  const parisChoiceRef = useRef<HTMLButtonElement>(null);
  const restoreStartOverFocus = useRef(false);

  function noteUserAction() {
    actionGeneration.current += 1;
  }

  function capturedTrip(trip: TripDocument): Record<string, unknown> {
    return structuredClone(trip);
  }

  function browserStorage(): PlanStorage | null {
    try {
      if (typeof window === "undefined") {
        return null;
      }
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function apply(result: ConciergeResult, nextStep?: Step) {
    if (result.ok) {
      setSession({ trip: result.trip, view: result.view });
      setSelectedDay(result.view.days[0]?.dayIndex ?? 1);
      setError(null);
      if (nextStep) {
        setStep(nextStep);
      }
      const brief = tripBrief(result.trip.preferences);
      if (nextStep === "plan") {
        setPendingBrief(null);
        setReplaceOpen(false);
        setUndo(null);
        setPace(result.trip.preferences.pace);
        setDayCount(result.trip.preferences.dayCount);
        setInterests([...result.trip.preferences.interests]);
      } else if (brief) {
        setPendingBrief((current) => reconcilePending(brief, current));
      }
      return;
    }
    setError(result.error);
    if (result.trip && result.view) {
      setSession({ trip: result.trip, view: result.view });
      const brief = tripBrief(result.trip.preferences);
      if (brief) {
        setPendingBrief((current) => reconcilePending(brief, current));
      }
    }
  }

  function showClarification(result: Extract<InterpreterPreviewResult, { stage: "clarify" }>) {
    setQuestion(result.message);
    setError(null);
    setReady(null);
    setUnderstood(null);
    setMissing(result.missing);
    if (!result.extracted) {
      setDraft(null);
      return;
    }
    setDraft(result.extracted);
    setDayCount(result.extracted.dayCount);
    setInterests(result.extracted.interests);
    if (result.extracted.pace) {
      setPace(result.extracted.pace);
    } else if (result.missing.includes("pace")) {
      setPace(null);
    }
    const focus = clarificationFocus(result.missing);
    if (focus) {
      setStep(focus);
    }
  }

  function showReady(next: ReadyPreview) {
    setReady(next);
    setQuestion(null);
    setError(null);
    setDraft(null);
    setMissing([]);
    setUnderstood(null);
  }

  function replaceMuseum(itemId: string) {
    noteUserAction();
    if (!session) {
      return;
    }
    const previous = session.trip;
    startTransition(async () => {
      const result = await replaceParisMuseumStop({ trip: previous, itemId });
      setUndo((current) => undoForRefinement(current, capturedTrip(previous), "museum", result.ok));
      apply(result);
    });
  }

  function plan(nextPace: (typeof paceChoices)[number][0]) {
    setPace(nextPace);
    startTransition(async () => {
      const result = await planParisItinerary({
        destinationId: "dst_paris",
        dayCount,
        interests,
        pace: nextPace,
      });
      apply(result, "plan");
    });
  }

  function currentTrip(): TripBrief | null {
    return session ? tripBrief(session.trip.preferences) : null;
  }

  function choosePace(nextPace: (typeof paceChoices)[number][0]) {
    noteUserAction();
    if (ready) {
      return;
    }
    if (draft && missing.includes("pace")) {
      setPace(nextPace);
      submitAnswer({ pace: nextPace });
      return;
    }
    const trip = currentTrip();
    if (trip) {
      setError(null);
      setPendingBrief((current) => reduceBrief(trip, current, { type: "pace", pace: nextPace }).pending);
      return;
    }
    plan(nextPace);
  }

  function chooseDay(count: number) {
    noteUserAction();
    if (ready) {
      return;
    }
    if (draft && missing.includes("dayCount")) {
      setDayCount(count);
      submitAnswer({ dayCount: count });
      return;
    }
    const trip = currentTrip();
    if (trip) {
      setError(null);
      setPendingBrief((current) => reduceBrief(trip, current, { type: "day", dayCount: count }).pending);
      return;
    }
    setDayCount(count);
    setStep("interests");
  }

  function chooseInterest(value: string) {
    noteUserAction();
    if (draft && missing.includes("interests")) {
      setInterests((current) =>
        current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
      );
      return;
    }
    const trip = currentTrip();
    if (trip) {
      setError(null);
      setPendingBrief((current) => {
        const base = current?.interests ?? trip.interests;
        const next = base.includes(value) ? base.filter((item) => item !== value) : [...base, value];
        return reduceBrief(trip, current, { type: "interests", interests: next }).pending;
      });
      return;
    }
    setInterests((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  function cancelPending() {
    const trip = currentTrip();
    if (!trip || pending) {
      return;
    }
    setError(null);
    setPendingBrief(reduceBrief(trip, pendingBrief, { type: "cancel" }).pending);
  }

  function dismissReplacement() {
    const trip = currentTrip();
    if (!trip || pending) {
      return;
    }
    setPendingBrief(reduceBrief(trip, pendingBrief, { type: "escape" }).pending);
    setReplaceOpen(false);
  }

  function confirmReplacement() {
    noteUserAction();
    const trip = currentTrip();
    const decision = trip ? reduceBrief(trip, pendingBrief, { type: "confirm" }) : null;
    if (!trip || !decision?.replace || pending) {
      return;
    }
    const answers = displayedBrief(trip, decision.pending);
    if (answers.interests.length === 0) {
      return;
    }
    startTransition(async () => {
      const result = await planParisItinerary({
        destinationId: "dst_paris",
        dayCount: answers.dayCount,
        interests: [...answers.interests],
        pace: answers.pace,
      });
      if (result.ok) {
        setReplaceOpen(false);
        apply(result, "plan");
        return;
      }
      setReplaceOpen(false);
      setError({
        code: result.error.code,
        message: replacementFailureMessage(result.error.message),
      });
    });
  }

  function submitAnswer(answer: PlanAnswer) {
    if (!draft) {
      return;
    }
    const extracted = draft;
    startTransition(async () => {
      const result = await previewParisInterpretation({ extracted, answer });
      if (result.ok) {
        showReady({ kind: "plan", summary: result.summary, request: { kind: "plan-answer", extracted, answer } });
        return;
      }
      if (result.stage === "clarify") {
        showClarification(result);
        return;
      }
      setReady(null);
      setError(result.error);
    });
  }

  function submitPreview(text: string) {
    startTransition(async () => {
      const result = session
        ? await previewParisRefinement({ text, trip: session.trip })
        : await previewParisInterpretation({ text });
      if (result.ok) {
        showReady({
          kind: result.kind,
          summary: result.summary,
          request: session ? { kind: "refine-text", text } : { kind: "plan-text", text },
        });
        return;
      }
      if (result.stage === "clarify") {
        showClarification(result);
        return;
      }
      setReady(null);
      setError(result.error);
    });
  }

  function confirmReady() {
    noteUserAction();
    if (!ready) {
      return;
    }
    const pendingReady = ready;
    const previous = session?.trip ?? null;
    const label =
      pendingReady.kind === "refine" && pendingReady.request.kind === "refine-text"
        ? undoLabelForInstruction(pendingReady.request.text)
        : null;
    startTransition(async () => {
      const result =
        pendingReady.request.kind === "refine-text"
          ? await confirmParisRefinement({ text: pendingReady.request.text, trip: session?.trip })
          : pendingReady.request.kind === "plan-text"
            ? await confirmParisInterpretation({ text: pendingReady.request.text })
            : await confirmParisInterpretation({
                extracted: pendingReady.request.extracted,
                answer: pendingReady.request.answer,
              });
      setUndo((current) => undoForRefinement(current, previous ? capturedTrip(previous) : null, label, result.ok));
      apply(result, pendingReady.kind === "plan" ? "plan" : undefined);
      setReady(null);
      if (result.ok || result.error.code === "ambiguous_museum") {
        setUnderstood(pendingReady.summary);
        setQuestion(null);
        setDraft(null);
        setMissing([]);
      }
    });
  }

  function refine(instruction: string) {
    noteUserAction();
    if (!session) {
      return;
    }
    const previous = session.trip;
    const label = undoLabelForInstruction(instruction);
    startTransition(async () => {
      const result = await refineParisItinerary({ trip: previous, instruction });
      setUndo((current) => undoForRefinement(current, capturedTrip(previous), label, result.ok));
      apply(result);
    });
  }

  function undoLatest() {
    if (!undo || pending) {
      return;
    }
    noteUserAction();
    const snapshot = undo;
    startTransition(async () => {
      const result = await revalidateParisItinerary({ trip: snapshot.trip });
      if (!result.ok) {
        setError({
          code: result.error.code,
          message: result.error.code === "catalog_unavailable" ? planStorageCopy.catalog : planStorageCopy.undoFailed,
        });
        return;
      }
      undoFocusRef.current = true;
      setUndo(null);
      setSession({ trip: result.trip, view: result.view });
      setSelectedDay(restoredSelectedDay(selectedDay, result.view.days));
      setError(null);
      setStorageMessage(null);
    });
  }

  function toggleLock(itemId: string, locked: boolean) {
    noteUserAction();
    if (!session) {
      return;
    }
    startTransition(async () => {
      const result = await setParisStopLock({ trip: session.trip, itemId, locked });
      apply(result);
    });
  }

  function restart() {
    const next = initialConciergeAnswers();
    setStep(next.step);
    setDayCount(next.dayCount);
    setInterests(next.interests);
    setPace(next.initialPace);
    setSession(null);
    setSelectedDay(next.selectedDay);
    setNote(next.note);
    setPreviewText("");
    setDraft(null);
    setMissing([]);
    setQuestion(null);
    setReady(null);
    setUnderstood(null);
    setError(null);
    setPendingBrief(null);
    setReplaceOpen(false);
    setStartOverOpen(false);
    setUndo(null);
  }

  function dismissStartOver() {
    restoreStartOverFocus.current = true;
    setStartOverOpen(false);
  }

  function confirmStartOver() {
    if (pending) {
      return;
    }
    noteUserAction();
    const storage = browserStorage();
    if (storage) {
      clearPlan(storage);
    }
    setStorageMode("ready");
    setStorageMessage(null);
    restoreStartOverFocus.current = true;
    restart();
  }

  useEffect(() => {
    const node = dialogRef.current;
    if (!replaceOpen || !node) {
      return;
    }
    if (!node.open) {
      node.showModal();
    }
    return () => {
      if (node.open) {
        node.close();
      }
    };
  }, [replaceOpen]);

  useEffect(() => {
    const node = startOverDialogRef.current;
    if (!startOverOpen || !node) {
      return;
    }
    if (!node.open) {
      node.showModal();
    }
    return () => {
      if (node.open) {
        node.close();
      }
    };
  }, [startOverOpen]);

  useEffect(() => {
    if (startOverOpen || !restoreStartOverFocus.current) {
      return;
    }
    restoreStartOverFocus.current = false;
    const target = step === "place" ? parisChoiceRef.current : startOverButtonRef.current;
    target?.focus();
  }, [startOverOpen, step]);

  const view = session?.view ?? null;
  const activeTrip = session ? tripBrief(session.trip.preferences) : null;
  const shown = activeTrip ? displayedBrief(activeTrip, pendingBrief) : null;
  const activeDay = view?.days.find((day) => day.dayIndex === selectedDay) ?? view?.days[0];

  function onDayTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!view) {
      return;
    }
    const current = view.days.findIndex((day) => day.dayIndex === (activeDay?.dayIndex ?? 1));
    const next = nextTabIndex(current, view.days.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const day = view.days[next];
    if (!day) {
      return;
    }
    setSelectedDay(day.dayIndex);
    document.getElementById(`plan-day-tab-${day.dayIndex}`)?.focus();
  }

  useEffect(() => {
    const storage = browserStorage();
    const started = actionGeneration.current;
    const read = storage ? readPlan(storage) : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      if (!storage || !read || read.status === "unavailable") {
        setStorageMode("blocked");
        setRestoring(false);
        return;
      }
      if (!shouldApplyRestore(started, actionGeneration.current)) {
        setStorageMode("ready");
        setRestoring(false);
        return;
      }
      if (read.status === "empty") {
        setStorageMode("ready");
        setRestoring(false);
        return;
      }
      if (read.status === "rejected") {
        clearPlan(storage);
        setError({ code: "saved_plan", message: planStorageCopy.rejected });
        setStorageMode("ready");
        setRestoring(false);
        return;
      }
      const envelope = read.envelope;
      if (!envelope.trip) {
        setStep(envelope.questionnaire.step);
        setDayCount(envelope.questionnaire.dayCount);
        setInterests([...envelope.questionnaire.interests]);
        setPace(envelope.initialPace ?? envelope.questionnaire.pace);
        setStorageMessage(planStorageCopy.restoredAnswers);
        setStorageMode("ready");
        setRestoring(false);
        return;
      }
      void revalidateParisItinerary({ trip: envelope.trip }).then((result) => {
        if (cancelled || !shouldApplyRestore(started, actionGeneration.current)) {
          if (!cancelled) {
            setStorageMode("ready");
            setRestoring(false);
          }
          return;
        }
        if (result.ok) {
          const finish = (message: string, restoredUndoSnapshot: SavedUndo | null) => {
            setSession({ trip: result.trip, view: result.view });
            setSelectedDay(restoredSelectedDay(envelope.selectedDay, result.view.days));
            setPendingBrief(envelope.pending);
            setPace(envelope.initialPace);
            setDayCount(result.trip.preferences.dayCount);
            setInterests([...result.trip.preferences.interests]);
            setStep("plan");
            setUndo(restoredUndoSnapshot);
            setError(null);
            setStorageMessage(message);
            setStorageMode("ready");
            setRestoring(false);
          };
          if (!envelope.undo) {
            finish(planStorageCopy.restored, null);
            return;
          }
          const storedUndo = envelope.undo;
          void revalidateParisItinerary({ trip: storedUndo.trip }).then((undoResult) => {
            if (cancelled || !shouldApplyRestore(started, actionGeneration.current)) {
              if (!cancelled) {
                setStorageMode("ready");
                setRestoring(false);
              }
              return;
            }
            const decision = restoredUndo(
              storedUndo,
              undoResult.ok ? { ok: true, trip: { ...undoResult.trip } } : { ok: false, code: undoResult.error.code },
            );
            finish(decision.discarded ? planStorageCopy.undoDiscarded : planStorageCopy.restored, decision.undo);
          });
          return;
        }
        if (savedPlanDisposition(result.error.code) === "keep") {
          setError({ code: result.error.code, message: planStorageCopy.catalog });
          setStorageMode("hold");
          setRestoring(false);
          return;
        }
        clearPlan(storage);
        setError({
          code: result.error.code,
          message:
            result.error.code === "unapproved_place" ? planStorageCopy.unapproved : planStorageCopy.rejected,
        });
        setStorageMode("ready");
        setRestoring(false);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageWriteAllowed(storageMode)) {
      return;
    }
    const storage = browserStorage();
    if (!storage) {
      return;
    }
    const envelope: SavedPlan = {
      version: 1,
      trip: session ? { ...session.trip } : null,
      questionnaire: {
        step,
        dayCount,
        interests,
        pace,
      },
      selectedDay,
      initialPace: pace,
      pending: pendingBrief,
      undo,
    };
    if (isBlankPlan(envelope)) {
      clearPlan(storage);
      return;
    }
    const written = writePlan(storage, envelope);
    if (written === "saved") {
      return;
    }
    if (written === "trimmed") {
      queueMicrotask(() => {
        setUndo(null);
        setStorageMessage(planStorageCopy.undoTrimmed);
      });
      return;
    }
    queueMicrotask(() => {
      setStorageMode("blocked");
      setStorageMessage(planStorageCopy.notStored);
    });
  }, [storageMode, session, step, dayCount, interests, pace, selectedDay, pendingBrief, undo]);

  useEffect(() => {
    if (undo || !undoFocusRef.current) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      undoFocusRef.current = false;
      const button = [...document.querySelectorAll("#plan-refine-less-walking")].find(
        (node) => node instanceof HTMLElement && node.offsetWidth > 0,
      );
      if (button instanceof HTMLElement) {
        button.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [undo]);

  return (
    <section className="mx-auto max-w-3xl px-5 py-12" aria-busy={pending || restoring}>
      <p className="text-xs font-semibold tracking-[0.16em] text-peach uppercase">Concierge</p>
      <h1 className="font-display mt-3 text-5xl text-ink">Plan a few days in Paris</h1>
      <p className="mt-4 max-w-xl text-lg leading-8 text-ink-muted">
        A draft from the approved catalog. Prices, opening hours, and travel times stay unknown.
      </p>
      {storageMessage ? (
        <p role="status" className="mt-4 max-w-xl text-ink">
          {storageMessage}
        </p>
      ) : null}
      {session && storageMode === "ready" ? (
        <p className="mt-3 max-w-xl text-sm leading-6 text-ink-muted">{planStorageCopy.saved}</p>
      ) : null}
      {step !== "place" ? (
        <button
          ref={startOverButtonRef}
          type="button"
          className={`${choiceClass} mt-6 ${idleClass}`}
          disabled={pending}
          onClick={() => setStartOverOpen(true)}
        >
          Start over
        </button>
      ) : null}

      {activeTrip && view ? <CurrentSettings view={view} trip={activeTrip} initialPace={pace} /> : null}

      <div className="mt-10 space-y-8" aria-live="polite">
        <Prompt text="Where should we plan? Paris is the approved destination today.">
          <button
            ref={parisChoiceRef}
            type="button"
            className={`${choiceClass} ${step === "place" ? selectedClass : idleClass}`}
            disabled={pending}
            onClick={() => {
              noteUserAction();
              if (draft && missing.includes("destinationId")) {
                submitAnswer({ destinationId: "dst_paris" });
                return;
              }
              setStep("days");
            }}
          >
            Paris
          </button>
        </Prompt>

        {step !== "place" ? (
          <Prompt text="How many days should the plan cover?">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Trip length">
              {dayChoices.map((count) => (
                <button
                  key={count}
                  type="button"
                  aria-pressed={shown ? shown.dayCount === count : dayCount === count}
                  className={`${choiceClass} ${
                    (shown ? shown.dayCount === count : dayCount === count) ? selectedClass : idleClass
                  }`}
                  disabled={pending}
                  onClick={() => chooseDay(count)}
                >
                  {count === 1 ? "1 day" : `${count} days`}
                </button>
              ))}
            </div>
          </Prompt>
        ) : null}

        {step === "interests" || step === "pace" || step === "plan" ? (
          <Prompt text="What should the days lean toward? Choose at least one.">
            <fieldset className="min-w-0 border-0 p-0">
              <legend className="sr-only">Interests</legend>
              <div className="flex flex-wrap gap-2">
                {interestChoices.map(([value, label]) => {
                  const pressed = shown ? shown.interests.includes(value) : interests.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={pressed}
                      className={`${choiceClass} ${pressed ? selectedClass : idleClass}`}
                      disabled={pending}
                      onClick={() => chooseInterest(value)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {step === "interests" ? (
                <button
                  type="button"
                  className={`${choiceClass} mt-4 bg-peach text-canvas disabled:opacity-50`}
                  disabled={pending || interests.length === 0}
                  onClick={() => {
                    if (draft && missing.includes("interests")) {
                      submitAnswer({ interests });
                      return;
                    }
                    setStep("pace");
                  }}
                >
                  Continue
                </button>
              ) : null}
            </fieldset>
          </Prompt>
        ) : null}

        {step === "pace" || step === "plan" ? (
          <Prompt text="What pace should we follow? This changes how many stops we schedule. It is not a measured walk.">
            <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Pace">
              {paceChoices.map(([value, label, detail]) => {
                const pressed = shown ? shown.pace === value : pace === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={pressed}
                    className={`min-h-11 rounded-frame border px-4 py-3 text-left ${
                      pressed ? "border-peach bg-peach text-canvas" : "border-line text-ink"
                    }`}
                    disabled={pending}
                    onClick={() => choosePace(value)}
                  >
                    <span className="block font-semibold">{label}</span>
                    <span className={`mt-1 block text-sm ${pressed ? "text-canvas" : "text-ink-muted"}`}>
                      {detail}
                    </span>
                  </button>
                );
              })}
            </div>
          </Prompt>
        ) : null}
      </div>

      {shown && pendingBrief ? (
        <div id="pending-answers" role="status" className="mt-8 rounded-frame border border-line bg-surface px-4 py-4">
          <p className="text-ink">{pendingAnswersCopy.differs}</p>
          <p className="mt-2 text-ink">{describeCurrentTrip(shown)}</p>
          <p className="mt-2 text-sm text-ink-muted">{pendingAnswersCopy.stays}</p>
          {shown.interests.length === 0 ? (
            <p className="mt-2 text-sm text-ink">{pendingAnswersCopy.needInterest}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={`${choiceClass} bg-peach text-canvas disabled:opacity-50`}
              disabled={pending || shown.interests.length === 0}
              onClick={() => {
                setError(null);
                setReplaceOpen(true);
              }}
            >
              Update the draft
            </button>
            <button type="button" className={`${choiceClass} ${idleClass}`} disabled={pending} onClick={cancelPending}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {shown && !pendingBrief ? <p className="mt-8 text-sm text-ink-muted">{pendingAnswersCopy.matches}</p> : null}

      {pending ? <p className="mt-8 text-ink-muted">Planning the days.</p> : null}
      {question ? <p className="mt-8 text-ink">{question}</p> : null}
      {ready ? (
        <div className="mt-8 rounded-frame border border-line bg-surface px-4 py-4">
          <h2 className="font-display text-3xl text-ink">What we understood</h2>
          <InterpretationCopy summary={ready.summary} />
          <button type="button" className={`${choiceClass} mt-4 bg-peach text-canvas`} disabled={pending} onClick={confirmReady}>
            {ready.kind === "refine" ? "Apply this change" : "Create this draft"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-8 rounded-frame border border-line bg-surface px-4 py-3 text-ink">
          {error.message}
        </p>
      ) : null}
      {error?.code === "ambiguous_museum" && view && view.museumChoices.length > 0 ? (
        <div className="mt-4" role="group" aria-label="Museums you can replace">
          <p className="text-ink">Choose the museum to replace.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {view.museumChoices.map((choice) => (
              <button
                key={choice.itemId}
                type="button"
                className={`${choiceClass} ${idleClass}`}
                disabled={pending}
                onClick={() => replaceMuseum(choice.itemId)}
              >
                {choice.dayIndex === null ? choice.name : `${choice.name}, day ${choice.dayIndex}`}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {view ? (
        <div className="mt-12">
          <h2 className="font-display text-3xl text-ink">Your draft</h2>
          {understood ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold tracking-[0.14em] text-mist uppercase">What we understood</h3>
              <InterpretationCopy summary={understood} />
            </div>
          ) : null}
          {activeTrip ? <p className="mt-3 max-w-xl text-ink">{draftSummary(activeTrip, "Paris")}</p> : null}
          <BeforeYouGo notices={beforeYouGoNotices(view.notices)} />
          <NoticeList notices={view.notices.filter((notice) => prominentNotices.has(notice.code) && notice.dayIndex === null)} />

          <p id="lock-stop-note" className="mt-8 max-w-xl text-sm leading-6 text-ink-muted">
            {lockStopNote}
          </p>
          <div role="tablist" aria-label="Days" className="mt-4 flex flex-wrap gap-2" onKeyDown={onDayTabKeyDown}>
            {view.days.map((day) => {
              const isSelected = day.dayIndex === (activeDay?.dayIndex ?? 1);
              return (
                <button
                  key={day.dayIndex}
                  id={`plan-day-tab-${day.dayIndex}`}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={`plan-day-panel-${day.dayIndex}`}
                  tabIndex={isSelected ? 0 : -1}
                  className={`${choiceClass} ${isSelected ? selectedClass : idleClass}`}
                  onClick={() => setSelectedDay(day.dayIndex)}
                >
                  {`Day ${day.dayIndex}`}
                </button>
              );
            })}
          </div>

          {activeDay ? (
            <div
              id={`plan-day-panel-${activeDay.dayIndex}`}
              role="tabpanel"
              aria-labelledby={`plan-day-tab-${activeDay.dayIndex}`}
              className="mt-4"
            >
              {activeDay.notice ? <p className="mb-4 text-ink-muted">{activeDay.notice}</p> : null}
              {dayCommitmentNotices(view.notices, activeDay.dayIndex).map((notice) => (
                <p key={`${notice.code}-${notice.dayIndex}`} className="mb-4 text-ink-muted">
                  {notice.message}
                </p>
              ))}
              {activeDay.stops.length === 0 ? (
                <p className="text-ink-muted">No stops on this day.</p>
              ) : (
                <ol className="border-l border-line">
                  {activeDay.stops.map((stop) => (
                    <StopRow key={stop.itemId} stop={stop} pending={pending} onLock={toggleLock} />
                  ))}
                </ol>
              )}
            </div>
          ) : null}

          <section aria-labelledby="unscheduled-heading" className="mt-12">
            <h2 id="unscheduled-heading" className="font-display text-3xl text-ink">
              Unscheduled
            </h2>
            {view.unscheduled.length === 0 ? (
              <p className="mt-3 text-ink-muted">Nothing is waiting off the days.</p>
            ) : (
              <ol className="mt-4 border-l border-line">
                {view.unscheduled.map((stop) => (
                  <StopRow key={stop.itemId} stop={stop} pending={pending} onLock={toggleLock} />
                ))}
              </ol>
            )}
          </section>

          {undo ? (
            <div className="mt-12">
              <button
                type="button"
                className={`${choiceClass} ${idleClass}`}
                disabled={pending}
                aria-describedby="plan-undo-note"
                onClick={undoLatest}
              >
                {undoButtonLabel(undo.label)}
              </button>
              <p id="plan-undo-note" className="mt-3 max-w-xl text-sm leading-6 text-ink-muted">
                {undoExplanation}
              </p>
            </div>
          ) : null}

          <form
            className="mt-12"
            onSubmit={(event) => {
              event.preventDefault();
              const instruction = note.trim();
              if (!instruction) {
                setError({ code: "empty_note", message: "Type less walking, more cafés, or replace a museum." });
                return;
              }
              setNote("");
              refine(instruction);
            }}
          >
            <h2 className="font-display text-3xl text-ink">Ask for a change</h2>
            <p className="mt-3 max-w-xl text-ink-muted">
              Less walking, more cafés, and replace a museum are the requests this concierge understands.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {refinements.map(([label, instruction]) => (
                <button
                  key={instruction}
                  id={instruction === "less walking" ? "plan-refine-less-walking" : undefined}
                  type="button"
                  className={`${choiceClass} ${idleClass}`}
                  disabled={pending}
                  onClick={() => refine(instruction)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label htmlFor="concierge-note" className="mt-6 block text-sm font-semibold text-mist">
              Or type one of those requests
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="concierge-note"
                value={note}
                maxLength={500}
                disabled={pending}
                onChange={(event) => setNote(event.target.value)}
                className="min-h-11 flex-1 rounded-full border border-line bg-surface px-4 text-ink"
              />
              <button type="submit" className={`${choiceClass} bg-peach text-canvas`} disabled={pending}>
                Send
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {process.env.NODE_ENV === "development" ? (
        <details className="mt-16 border-t border-line pt-8">
          <summary className="min-h-11 cursor-pointer text-sm font-semibold text-mist">Development preview</summary>
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              const text = previewText.trim();
              if (!text) {
                setError({ code: "empty_note", message: "Type one of the development preview phrases." });
                return;
              }
              setPreviewText("");
              submitPreview(text);
            }}
          >
            <p className="max-w-xl text-ink-muted">{developmentPreviewNotice}</p>
            <p className="mt-3 max-w-xl text-ink-muted">{`Exact phrases include ${developmentPreviewExamples.join(", ")}.`}</p>
            <label htmlFor="development-interpreter-note" className="mt-4 block text-sm font-semibold text-mist">
              Development phrase
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="development-interpreter-note"
                value={previewText}
                maxLength={500}
                disabled={pending}
                onChange={(event) => setPreviewText(event.target.value)}
                className="min-h-11 flex-1 rounded-full border border-line bg-surface px-4 text-ink"
              />
              <button type="submit" className={`${choiceClass} bg-peach text-canvas`} disabled={pending}>
                Preview
              </button>
            </div>
          </form>
        </details>
      ) : null}

      {replaceOpen && shown ? (
        <dialog
          ref={dialogRef}
          aria-labelledby="replace-draft-title"
          aria-describedby="replace-draft-description"
          className="w-[min(32rem,calc(100%-2rem))] rounded-frame border border-line bg-surface p-6 text-ink backdrop:bg-[#091b25]/80"
          onCancel={(event) => {
            event.preventDefault();
            dismissReplacement();
          }}
          onClick={(event) => {
            if (event.target === dialogRef.current) {
              dismissReplacement();
            }
          }}
        >
          <h2 id="replace-draft-title" className="font-display text-3xl text-ink">
            {replacementDialog.title}
          </h2>
          <p id="replace-draft-description" className="mt-3 text-ink-muted">
            {replacementDialog.body}
          </p>
          <p className="mt-4 text-xs font-semibold tracking-[0.14em] text-mist uppercase">New draft</p>
          <p className="mt-2 text-ink">{describeCurrentTrip(shown)}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" className={`${choiceClass} ${idleClass}`} disabled={pending} autoFocus onClick={dismissReplacement}>
              {replacementDialog.keep}
            </button>
            <button
              type="button"
              className={`${choiceClass} bg-peach text-canvas disabled:opacity-50`}
              disabled={pending}
              onClick={confirmReplacement}
            >
              {replacementDialog.confirm}
            </button>
          </div>
        </dialog>
      ) : null}

      {startOverOpen ? (
        <dialog
          ref={startOverDialogRef}
          aria-labelledby="start-over-title"
          aria-describedby="start-over-description"
          className="w-[min(32rem,calc(100%-2rem))] rounded-frame border border-line bg-surface p-6 text-ink backdrop:bg-[#091b25]/80"
          onCancel={(event) => {
            event.preventDefault();
            dismissStartOver();
          }}
          onClick={(event) => {
            if (event.target === startOverDialogRef.current) {
              dismissStartOver();
            }
          }}
        >
          <h2 id="start-over-title" className="font-display text-3xl text-ink">
            {startOverDialog.title}
          </h2>
          <p id="start-over-description" className="mt-3 text-ink-muted">
            {startOverMessage(session !== null)}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" className={`${choiceClass} ${idleClass}`} autoFocus onClick={dismissStartOver}>
              {startOverDialog.keep}
            </button>
            <button type="button" className={`${choiceClass} bg-peach text-canvas`} disabled={pending} onClick={confirmStartOver}>
              {startOverDialog.confirm}
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}

function InterpretationCopy({ summary }: { summary: InterpretationSummary }) {
  return (
    <div className="mt-3 max-w-xl">
      <p className="text-ink">{summary.headline}</p>
      {summary.details.map((detail) => (
        <p key={detail} className="mt-2 text-ink-muted">
          {detail}
        </p>
      ))}
      <p className="mt-2 text-sm text-ink-muted">{summary.unaffected}</p>
    </div>
  );
}

function CurrentSettings({
  view,
  trip,
  initialPace,
}: {
  view: ConciergeView;
  trip: TripBrief;
  initialPace: TravelerPreferences["pace"] | null;
}) {
  const paceCopy = describeTripPace(view.pace, initialPace);
  const mobility = describeMobility(view.mobility);
  return (
    <div className="mt-8">
      <p className="text-xs font-semibold tracking-[0.14em] text-mist uppercase">Current trip</p>
      <p className="mt-2 text-ink">{describeCurrentTrip(trip)}</p>
      {paceCopy.initialNote ? <p className="mt-1 text-sm text-ink-muted">{paceCopy.initialNote}</p> : null}
      {mobility ? <p className="mt-1 text-sm text-ink-muted">{mobility}</p> : null}
    </div>
  );
}

function Prompt({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-lg text-ink">{text}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function BeforeYouGo({ notices }: { notices: ConciergeView["notices"] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="before-you-go" className="mt-8 max-w-xl">
      <h3 id="before-you-go" className="font-display text-2xl text-ink">
        Before you go
      </h3>
      <ul className="mt-3 space-y-2">
        {notices.map((notice) => (
          <li key={notice.code} className="text-sm leading-6 text-ink-muted">
            {notice.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoticeList({ notices }: { notices: ConciergeView["notices"] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <ul className="mt-6 space-y-2">
      {notices.map((notice) => (
        <li key={`${notice.code}-${notice.dayIndex ?? "all"}-${notice.message}`} className="text-sm leading-6 text-ink-muted">
          {notice.message}
        </li>
      ))}
    </ul>
  );
}

function StopRow({
  stop,
  pending,
  onLock,
}: {
  stop: ConciergeView["days"][number]["stops"][number];
  pending: boolean;
  onLock: (itemId: string, locked: boolean) => void;
}) {
  return (
    <li className="relative py-4 pl-6">
      <span aria-hidden className="absolute top-7 -left-[5px] h-2.5 w-2.5 rounded-full bg-peach" />
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
        <MediaFrame photo={stop.photo} label={stop.name} sizes="88px" objectPosition="center 20%" className="aspect-[3/4] w-full" />
        <div>
          {stop.areaLabel ? <p className="text-xs font-semibold tracking-[0.14em] text-mist uppercase">{stop.areaLabel}</p> : null}
          <h3 className="font-display text-2xl text-ink">{stop.name}</h3>
          {stop.reason ? <p className="mt-2 text-sm text-peach">{stop.reason}</p> : null}
          {stop.visitEstimate ? <p className="mt-2 text-sm text-mist">{stop.visitEstimate}</p> : null}
          {stop.summary ? <p className="mt-2 text-base leading-7 text-ink-muted">{stop.summary}</p> : null}
          {stop.routeNote ? (
            <p className="mt-2 text-sm leading-6 text-mist">
              <span className="font-semibold text-ink">{`${sampleRouteLabel}. `}</span>
              {stop.routeNote}
            </p>
          ) : null}
          <button
            type="button"
            aria-pressed={stop.locked}
            aria-label={lockStopName(stop.name, stop.locked)}
            aria-describedby="lock-stop-note"
            className={`${choiceClass} mt-3 ${stop.locked ? selectedClass : idleClass}`}
            disabled={pending}
            onClick={() => onLock(stop.itemId, !stop.locked)}
          >
            {stop.locked ? "Unlock" : "Lock"}
          </button>
          {stop.locked ? <p className="mt-2 text-sm text-peach">{lockedStopStatus}</p> : null}
        </div>
      </div>
    </li>
  );
}
