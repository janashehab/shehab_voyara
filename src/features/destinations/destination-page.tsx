import { Button } from "@/components/button";
import { DestinationHero } from "@/components/destination-hero";
import { EditorialFigures } from "@/components/editorial-figures";
import { ItineraryPreview } from "@/components/itinerary-preview";
import { PageShell } from "@/components/page-shell";
import { TipNote } from "@/components/tip-note";
import { travelerNav } from "@/components/traveler-nav";
import type { DestinationPageData } from "@/features/destinations/queries";
import { sampleDaysLabel } from "@/lib/format";

export function DestinationPage({ page }: { page: DestinationPageData }) {
  const href = `/destinations/${page.destination.slug}`;
  const dayCount = page.days.length;
  const canPlan = page.destination.id === "dst_paris";

  return (
    <PageShell
      links={travelerNav({
        current: "destination",
        destination: { href, label: page.destination.name },
      })}
    >
      <DestinationHero
        destination={page.destination}
        photo={page.cover}
        routeHref={dayCount > 0 ? "#route" : null}
        routeLabel={dayCount > 0 ? sampleDaysLabel(dayCount, "The") : null}
      />
      <section aria-label="About this place" className="mx-auto max-w-3xl px-5 py-16">
        <p className="max-w-xl text-lg leading-8 text-ink">{page.destination.editorialSummary}</p>
        {canPlan ? (
          <div className="mt-8">
            <Button href="/plan">Plan my Paris trip</Button>
            <p className="mt-4 max-w-xl text-sm leading-6 text-ink-muted">
              You choose the length, interests, and pace. Prices, opening hours, and travel times stay
              unknown.
            </p>
          </div>
        ) : null}
      </section>
      {page.itinerary ? (
        <section
          id="route"
          aria-labelledby="route-heading"
          className="mx-auto max-w-3xl scroll-mt-24 px-5 pb-16"
        >
          <ItineraryPreview
            title={page.itinerary.title}
            note={page.itinerary.editorialNote}
            days={page.days}
            additions={page.additions}
            highlights={page.highlights}
          />
        </section>
      ) : null}
      {page.tips.length > 0 ? (
        <section aria-labelledby="notes-heading" className="mx-auto max-w-3xl px-5 pb-16">
          <h2 id="notes-heading" className="font-display text-3xl text-ink">
            Notes
          </h2>
          <div className="mt-6 grid gap-4">
            {page.tips.map((tip) => (
              <TipNote key={tip.id} tip={tip} />
            ))}
          </div>
        </section>
      ) : null}
      <EditorialFigures photos={page.editorial} placeName={page.destination.name} />
    </PageShell>
  );
}
