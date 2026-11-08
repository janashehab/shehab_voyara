import type { HomeFeature } from "@/features/destinations/queries";

export type HomeProcessStep = {
  title: string;
  body: string;
  href?: string;
  actionLabel?: string;
};

/**
 * The first approved destination, if the catalog has one.
 * An empty result is not a destination to promote.
 */
export function featuredDestinationLink(
  feature: HomeFeature,
): { href: string; name: string } | null {
  const featured = feature.destinations[0] ?? null;
  if (!featured) {
    return null;
  }

  return {
    href: `/destinations/${featured.destination.slug}`,
    name: featured.destination.name,
  };
}

/**
 * Homepage process copy. Step 2 names a destination only when the approved
 * catalog has one to feature.
 */
export function homeProcessSteps(feature: HomeFeature): HomeProcessStep[] {
  const destination = featuredDestinationLink(feature);

  return [
    {
      title: "Choose a place we keep",
      body: destination
        ? `${destination.name} is the destination in the catalog today.`
        : "Approved destinations will appear here.",
      href: destination?.href,
      actionLabel: destination ? `See ${destination.name}` : undefined,
    },
    destination
      ? {
          title: "Tell us about the trip",
          body: `The concierge plans ${destination.name}. Choose a length, what the days lean toward, and a pace. The draft uses approved places only.`,
          href: "/plan",
          actionLabel: `Plan the ${destination.name} trip`,
        }
      : {
          title: "Tell us about the trip",
          body: "When a destination is approved, the concierge drafts the trip from approved places only.",
        },
    {
      title: "Follow the days",
      body: "The concierge lays that draft out day by day. A stop can be locked, or changed with one of the requests the concierge already understands. Prices, opening hours, and travel times stay unknown.",
    },
  ];
}
