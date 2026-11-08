import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CatalogOpening } from "@/components/catalog-opening";
import { DestinationPage } from "@/features/destinations/destination-page";
import { getDestinationPage } from "@/features/destinations/queries";
import { regionName } from "@/lib/format";
import { loadPublicEditorialCatalog } from "@/server/catalog/public-editorial";

type DestinationRouteProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return [{ slug: "paris" }];
}

export async function generateMetadata({ params }: DestinationRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getDestinationPage(await loadPublicEditorialCatalog(), slug);

  if (!page) {
    return { title: "Not found" };
  }

  const region = regionName(page.destination.countryCode);

  return {
    title: page.destination.name,
    description: `${page.destination.name} in ${region}. ${page.destination.vibeTags.join(", ")}.`,
  };
}

export default function Page({ params }: DestinationRouteProps) {
  return (
    <Suspense fallback={<CatalogOpening />}>
      <DestinationContent params={params} />
    </Suspense>
  );
}

async function DestinationContent({ params }: DestinationRouteProps) {
  const { slug } = await params;
  const page = getDestinationPage(await loadPublicEditorialCatalog(), slug);

  if (!page) {
    notFound();
  }

  return <DestinationPage page={page} />;
}
