import Link from "next/link";
import { MediaFrame } from "@/components/media-frame";
import { Tag } from "@/components/tag";
import { regionName, sampleDaysLabel } from "@/lib/format";
import type { TravelPhoto } from "@/lib/media/travel-photos";
import type { Destination } from "@/lib/catalog";

export function FeaturedDestination({
  destination,
  cover,
  itineraryTitle,
  sampleDayCount,
}: {
  destination: Destination;
  cover: TravelPhoto | null;
  itineraryTitle: string | null;
  sampleDayCount: number | null;
}) {
  const href = `/destinations/${destination.slug}`;

  return (
    <article>
      <Link
        href={href}
        className="grid overflow-hidden rounded-frame border border-line bg-surface sm:grid-cols-[minmax(0,280px)_1fr]"
      >
        <MediaFrame
          photo={cover}
          label={destination.name}
          sizes="(min-width: 640px) 280px, 100vw"
          objectPosition="center 48%"
          className="h-72 w-full rounded-none sm:aspect-[3/4] sm:h-auto sm:max-w-[280px]"
        />
        <div className="flex flex-col justify-end gap-4 p-5 sm:p-8">
          <p className="text-xs font-semibold tracking-[0.16em] text-mist uppercase">
            {regionName(destination.countryCode)}
          </p>
          <h3 className="font-display text-4xl text-ink">{destination.name}</h3>
          {itineraryTitle ? (
            <p className="text-ink-muted">{itineraryTitle}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {destination.vibeTags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
          {sampleDayCount !== null ? (
            <p className="text-sm font-semibold text-peach">{sampleDaysLabel(sampleDayCount, "Read")}</p>
          ) : null}
        </div>
      </Link>
    </article>
  );
}
