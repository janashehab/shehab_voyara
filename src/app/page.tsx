import { Suspense } from "react";
import { BrandHero } from "@/components/brand-hero";
import { PageShell } from "@/components/page-shell";
import { travelerNav } from "@/components/traveler-nav";
import { getHomeFeature } from "@/features/destinations/queries";
import { HomeCatalog, HomeDestinationLink, HomeHeroAction } from "@/features/home/home-page";
import { brandPhotograph } from "@/lib/media/travel-photos";
import { loadPublicEditorialCatalog } from "@/server/catalog/public-editorial";

export default function Home() {
  return (
    <PageShell
      links={travelerNav({ destination: null })}
      leading={
        <Suspense fallback={null}>
          <HomeDestinationNav />
        </Suspense>
      }
    >
      <BrandHero
        photo={brandPhotograph}
        action={
          <Suspense fallback={null}>
            <HomeHeroCta />
          </Suspense>
        }
      />
      <Suspense fallback={<CatalogSectionsOpening />}>
        <HomeCatalogContent />
      </Suspense>
    </PageShell>
  );
}

async function HomeDestinationNav() {
  const feature = getHomeFeature(await loadPublicEditorialCatalog());
  return <HomeDestinationLink feature={feature} />;
}

async function HomeHeroCta() {
  const feature = getHomeFeature(await loadPublicEditorialCatalog());
  return <HomeHeroAction feature={feature} />;
}

async function HomeCatalogContent() {
  const feature = getHomeFeature(await loadPublicEditorialCatalog());
  return <HomeCatalog feature={feature} />;
}

function CatalogSectionsOpening() {
  return <p className="mx-auto max-w-6xl px-5 py-16 text-ink-muted">Opening the catalog.</p>;
}
