import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { travelerNav } from "@/components/traveler-nav";
import { ConciergePanel } from "@/features/trips/concierge-panel";

export const metadata: Metadata = {
  title: "Concierge",
  description: "Plan a Paris itinerary from the approved Voyara catalog.",
};

export default function PlanPage() {
  return (
    <PageShell
      links={travelerNav({
        current: "plan",
        destination: { href: "/destinations/paris", label: "Paris" },
      })}
    >
      <ConciergePanel />
    </PageShell>
  );
}
