import { Button } from "@/components/button";
import { MediaFrame } from "@/components/media-frame";
import { Tag } from "@/components/tag";
import { regionName } from "@/lib/format";
import type { Destination } from "@/lib/catalog";
import type { TravelPhoto } from "@/lib/media/travel-photos";

export function DestinationHero({
  destination,
  photo,
  routeHref,
  routeLabel,
}: {
  destination: Destination;
  photo: TravelPhoto | null;
  routeHref: string | null;
  routeLabel: string | null;
}) {
  return (
    <section className="mx-auto grid max-w-6xl items-stretch lg:h-[calc(100svh-4.5rem)] lg:grid-cols-[minmax(0,768px)_1fr]">
      <MediaFrame
        photo={photo}
        label={destination.name}
        sizes="(min-width: 1024px) 768px, 100vw"
        priority
        objectPosition="center 48%"
        className="aspect-[3/4] w-full max-w-[768px] rounded-none lg:aspect-auto lg:h-full lg:max-h-full lg:rounded-br-frame"
      />
      <div className="hero-copy relative z-10 -mt-36 flex flex-col justify-end px-5 pt-14 pb-10 lg:mt-0 lg:h-full lg:px-12 lg:py-16">
        <p className="text-xs font-semibold tracking-[0.16em] text-mist uppercase">
          {regionName(destination.countryCode)}
        </p>
        <h1 className="font-display mt-3 text-5xl leading-none text-ink sm:text-7xl">
          {destination.name}
        </h1>
        <div className="mt-5 flex flex-wrap gap-2">
          {destination.vibeTags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
        {routeHref && routeLabel ? (
          <div className="mt-8">
            <Button href={routeHref} variant="secondary">
              {routeLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
