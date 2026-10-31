import { DestinationHero } from "@/components/destination-hero";
import { EditorialFigures } from "@/components/editorial-figures";
import { ItineraryPreview } from "@/components/itinerary-preview";
import { PageShell } from "@/components/page-shell";
import { TipNote } from "@/components/tip-note";
import type { DestinationPageData } from "@/features/destinations/queries";

export function DestinationPage({ page }: { page: DestinationPageData }) {
  const href = `/destinations/${page.destination.slug}`;

  return (
    <PageShell links={[{ href, label: page.destination.name, current: true }]}>
      <DestinationHero
        destination={page.destination}
        photo={page.cover}
        routeHref={page.itinerary ? "#route" : null}
      />
      {page.itinerary ? (
        <section
          id="route"
          aria-labelledby="route-heading"
          className="mx-auto max-w-3xl scroll-mt-24 px-5 py-16"
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
      <p className="mx-auto max-w-3xl px-5 pb-16 text-sm leading-6 text-ink-muted">
        A personal version of this route comes in a later step.
      </p>
    </PageShell>
  );
}
