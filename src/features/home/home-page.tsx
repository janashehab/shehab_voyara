import Link from "next/link";
import { Button } from "@/components/button";
import { FeaturedDestination } from "@/components/featured-destination";
import { ProcessSteps } from "@/components/process-steps";
import type { HomeFeature } from "@/features/destinations/queries";
import { featuredDestinationLink, homeProcessSteps } from "@/features/home/featured-link";

export function HomeDestinationLink({ feature }: { feature: HomeFeature }) {
  const destination = featuredDestinationLink(feature);
  if (!destination) {
    return null;
  }

  return (
    <Link href={destination.href} className="text-sm font-semibold text-mist">
      {destination.name}
    </Link>
  );
}

export function HomeHeroAction({ feature }: { feature: HomeFeature }) {
  const destination = featuredDestinationLink(feature);
  if (!destination) {
    return null;
  }

  return (
    <div className="mt-8">
      <Button href={destination.href}>{`Explore ${destination.name}`}</Button>
    </div>
  );
}

export function HomeCatalog({ feature }: { feature: HomeFeature }) {
  const { destinations } = feature;
  const steps = homeProcessSteps(feature);

  return (
    <>
      <section aria-labelledby="featured-heading" className="mx-auto max-w-6xl px-5 py-16">
        <h2 id="featured-heading" className="font-display text-3xl text-ink">
          A place we keep
        </h2>
        <div className="mt-8 grid gap-6">
          {destinations.map((item) => (
            <FeaturedDestination
              key={item.destination.id}
              destination={item.destination}
              cover={item.cover}
              itineraryTitle={item.itineraryTitle}
              sampleDayCount={item.sampleDayCount}
            />
          ))}
        </div>
      </section>
      <section aria-labelledby="works-heading" className="mx-auto max-w-6xl px-5 pb-20">
        <h2 id="works-heading" className="font-display text-3xl text-ink">
          How Voyara works
        </h2>
        <div className="mt-8">
          <ProcessSteps steps={steps} />
        </div>
      </section>
    </>
  );
}
