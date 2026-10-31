import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DestinationPage } from "@/features/destinations/destination-page";
import {
  approvedDestinationSlugs,
  getDestinationPage,
} from "@/features/destinations/queries";
import { regionName } from "@/lib/format";

type DestinationRouteProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return approvedDestinationSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: DestinationRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getDestinationPage(slug);

  if (!page) {
    return { title: "Not found" };
  }

  const region = regionName(page.destination.countryCode);

  return {
    title: page.destination.name,
    description: `${page.destination.name} in ${region}. ${page.destination.vibeTags.join(", ")}.`,
  };
}

export default async function Page({ params }: DestinationRouteProps) {
  const { slug } = await params;
  const page = getDestinationPage(slug);

  if (!page) {
    notFound();
  }

  return <DestinationPage page={page} />;
}
