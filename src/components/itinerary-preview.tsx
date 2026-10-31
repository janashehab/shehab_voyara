"use client";

import { useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { MediaFrame } from "@/components/media-frame";
import { PlaceRow } from "@/components/place-row";
import type { DayView, HighlightView, PlaceRowView } from "@/features/destinations/queries";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ItineraryPreview({
  title,
  note,
  days,
  additions,
  highlights,
}: {
  title: string;
  note: string | null;
  days: readonly DayView[];
  additions: readonly PlaceRowView[];
  highlights: readonly HighlightView[];
}) {
  const [selected, setSelected] = useState(days[0]?.dayIndex ?? 1);

  function selectDay(dayIndex: number) {
    setSelected(dayIndex);
  }

  function openHighlight(dayIndex: number, rowKey: string) {
    flushSync(() => setSelected(dayIndex));
    document.getElementById(rowKey)?.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "center",
    });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = days.findIndex((day) => day.dayIndex === selected);
    let next = index;

    if (event.key === "ArrowRight") {
      next = (index + 1) % days.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + days.length) % days.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = days.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const day = days[next];

    if (!day) {
      return;
    }

    setSelected(day.dayIndex);
    document.getElementById(`day-tab-${day.dayIndex}`)?.focus();
  }

  return (
    <div>
      {highlights.length > 0 ? (
        <ul className="mb-10 grid gap-4 sm:grid-cols-2">
          {highlights.map((highlight) => (
            <li key={highlight.rowKey}>
              <button
                type="button"
                className="grid w-full grid-cols-[7rem_minmax(0,1fr)] overflow-hidden rounded-frame border border-line bg-surface text-left"
                onClick={() => openHighlight(highlight.dayIndex, highlight.rowKey)}
              >
                <MediaFrame
                  photo={highlight.photo}
                  label={highlight.name}
                  sizes="112px"
                  objectPosition="center 20%"
                  className="aspect-[3/4] rounded-none"
                />
                <span className="flex flex-col justify-end p-4">
                  {highlight.areaLabel ? (
                    <span className="text-xs font-semibold tracking-[0.14em] text-mist uppercase">
                      {highlight.areaLabel}
                    </span>
                  ) : null}
                  <span className="font-display mt-1 text-2xl text-ink">{highlight.name}</span>
                  <span className="mt-2 text-sm text-peach">{`Day ${highlight.dayIndex}`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <h2 id="route-heading" className="font-display text-3xl text-ink">
        {title}
      </h2>
      {note ? <p className="mt-3 max-w-xl text-ink-muted">{note}</p> : null}

      <div
        role="tablist"
        aria-label="Days"
        className="mt-6 flex flex-wrap gap-2"
        onKeyDown={onTabKeyDown}
      >
        {days.map((day) => {
          const isSelected = day.dayIndex === selected;

          return (
            <button
              key={day.dayIndex}
              id={`day-tab-${day.dayIndex}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`day-panel-${day.dayIndex}`}
              tabIndex={isSelected ? 0 : -1}
              className={`min-h-11 rounded-full px-4 text-sm font-semibold ${
                isSelected ? "bg-peach text-canvas" : "border border-line text-mist"
              }`}
              onClick={() => selectDay(day.dayIndex)}
            >
              {`Day ${day.dayIndex}`}
            </button>
          );
        })}
      </div>

      {days.map((day) => {
        const isSelected = day.dayIndex === selected;

        return (
          <div
            key={day.dayIndex}
            id={`day-panel-${day.dayIndex}`}
            role="tabpanel"
            aria-labelledby={`day-tab-${day.dayIndex}`}
            hidden={!isSelected}
            className="mt-4"
          >
            <ol className="border-l border-line">
              {day.stops.map((stop) => (
                <PlaceRow key={stop.key} row={stop} />
              ))}
            </ol>
            {day.optional.length > 0 ? (
              <div className="mt-8">
                <h3 className="font-display text-2xl text-ink">Optional</h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">
                  These are suggestions for the day. The route does not require them.
                </p>
                <ol className="mt-2 border-l border-line">
                  {day.optional.map((stop) => (
                    <PlaceRow key={stop.key} row={stop} optional />
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        );
      })}

      {additions.length > 0 ? (
        <section aria-labelledby="additions-heading" className="mt-14">
          <h2 id="additions-heading" className="font-display text-3xl text-ink">
            Off the original route
          </h2>
          <p className="mt-3 max-w-xl text-ink-muted">
            Editorial additions. They are not scheduled into the original days.
          </p>
          <ol className="mt-4 border-l border-line">
            {additions.map((stop) => (
              <PlaceRow key={stop.key} row={stop} />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
