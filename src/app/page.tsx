import { Suspense } from "react";
import { CatalogOpening } from "@/components/catalog-opening";
import { getHomeFeature } from "@/features/destinations/queries";
import { HomePage } from "@/features/home/home-page";
import { loadPublicEditorialCatalog } from "@/server/catalog/public-editorial";

export default function Home() {
  return (
    <Suspense fallback={<CatalogOpening />}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const feature = getHomeFeature(await loadPublicEditorialCatalog());
  return <HomePage feature={feature} />;
}
