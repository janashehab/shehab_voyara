import { MediaFrame } from "@/components/media-frame";
import { durationLabel } from "@/lib/format";
import type { PlaceRowView } from "@/features/destinations/queries";

export function PlaceRow({ row, optional = false }: { row: PlaceRowView; optional?: boolean }) {
  const duration = durationLabel(row.durationMinutes);
  const meta = [row.areaLabel, duration].filter(Boolean).join(" · ");

  return (
    <li id={row.key} className="relative scroll-mt-28 py-4 pl-6">
      <span
        aria-hidden
        className="absolute top-7 -left-[5px] h-2.5 w-2.5 rounded-full bg-peach"
      />
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
        <MediaFrame
          photo={row.photo}
          label={row.name}
          sizes="88px"
          objectPosition="center 20%"
          className="aspect-[3/4] w-full"
        />
        <div>
          {optional ? (
            <p className="text-xs font-semibold tracking-[0.14em] text-peach uppercase">
              Optional
            </p>
          ) : null}
          <h3 className="font-display text-2xl text-ink">{row.name}</h3>
          {meta ? <p className="mt-1 text-sm text-mist">{meta}</p> : null}
          <p className="mt-2 text-base leading-7 text-ink-muted">{row.summary}</p>
          {row.note ? <p className="mt-2 text-sm leading-6 text-mist">{row.note}</p> : null}
        </div>
      </div>
    </li>
  );
}
