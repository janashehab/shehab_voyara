import type { ReactNode } from "react";
import { MediaFrame } from "@/components/media-frame";
import type { TravelPhoto } from "@/lib/media/travel-photos";

export function BrandHero({
  photo,
  action = null,
}: {
  photo: TravelPhoto | null;
  action?: ReactNode;
}) {
  return (
    <section className="mx-auto grid max-w-6xl items-stretch gap-0 lg:h-[calc(100svh-4.5rem)] lg:grid-cols-[minmax(0,768px)_1fr]">
      <MediaFrame
        photo={photo}
        label="Voyara"
        sizes="(min-width: 1024px) 768px, 100vw"
        priority
        objectPosition="center 48%"
        className="aspect-[3/4] w-full max-w-[768px] rounded-none lg:aspect-auto lg:h-full lg:max-h-full lg:rounded-br-frame"
      />
      <div className="hero-copy relative z-10 -mt-40 flex flex-col justify-end px-5 pt-16 pb-10 lg:mt-0 lg:h-full lg:px-12 lg:py-16">
        <p className="text-xs font-semibold tracking-[0.16em] text-mist uppercase">
          Voyara
        </p>
        <h1 className="font-display mt-3 max-w-xl text-4xl leading-none text-ink sm:text-6xl">
          The world made for you.
        </h1>
        <p className="mt-5 max-w-md text-lg leading-7 text-ink">
          Discover extraordinary places, explore curated experiences, and create
          adventures that feel like you.
        </p>
        {action}
      </div>
    </section>
  );
}
