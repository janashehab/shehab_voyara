import { BrandHero } from "@/components/brand-hero";
import { FeaturedDestination } from "@/components/featured-destination";
import { PageShell } from "@/components/page-shell";
import { ProcessSteps, type ProcessStep } from "@/components/process-steps";
import type { HomeFeature } from "@/features/destinations/queries";

export function HomePage({ feature }: { feature: HomeFeature }) {
  const { destinations } = feature;
  const featured = destinations[0] ?? null;
  const featuredHref = featured ? `/destinations/${featured.destination.slug}` : null;
  const exploreLabel = featured ? `Explore ${featured.destination.name}` : null;

  const steps: ProcessStep[] = [
    {
      title: "Choose a place we keep",
      body: featured
        ? `${featured.destination.name} is the destination in the catalog today.`
        : "Approved destinations will appear here.",
      href: featuredHref ?? undefined,
      actionLabel: featured ? `See ${featured.destination.name}` : undefined,
    },
    {
      title: "Tell us about the trip",
      body: "Timing, pace, and who you travel with come in a later step.",
      later: true,
    },
    {
      title: "Follow the days",
      body: "A personal version of the route comes after planning exists.",
      later: true,
    },
  ];

  return (
    <PageShell
      links={
        featured
          ? [{ href: featuredHref ?? "/", label: featured.destination.name }]
          : []
      }
    >
      <BrandHero
        photo={featured?.cover ?? null}
        actionHref={featuredHref}
        actionLabel={exploreLabel}
      />
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
    </PageShell>
  );
}
