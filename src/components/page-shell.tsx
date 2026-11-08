import type { ReactNode } from "react";
import { SkipLink } from "@/components/skip-link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader, type HeaderLink } from "@/components/site-header";

export function PageShell({
  links,
  leading = null,
  children,
}: {
  links: readonly HeaderLink[];
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <SiteHeader links={links} leading={leading} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
