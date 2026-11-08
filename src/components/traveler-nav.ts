import type { HeaderLink } from "@/components/site-header";

/**
 * Primary links for the public traveler pages. SiteHeader renders these
 * through PageShell and sets aria-current from the current flag.
 */
export function travelerNav(input: {
  current?: "destination" | "plan";
  destination: { href: string; label: string } | null;
}): HeaderLink[] {
  const links: HeaderLink[] = [];

  if (input.destination) {
    links.push({
      href: input.destination.href,
      label: input.destination.label,
      current: input.current === "destination",
    });
  }

  links.push({
    href: "/plan",
    label: "Concierge",
    current: input.current === "plan",
  });

  return links;
}
