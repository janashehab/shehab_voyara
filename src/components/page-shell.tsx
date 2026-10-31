import type { ReactNode } from "react";
import { SkipLink } from "@/components/skip-link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader, type HeaderLink } from "@/components/site-header";

export function PageShell({
  links,
  children,
}: {
  links: readonly HeaderLink[];
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <SiteHeader links={links} />
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
