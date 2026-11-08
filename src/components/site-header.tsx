import type { ReactNode } from "react";
import Link from "next/link";

export type HeaderLink = {
  href: string;
  label: string;
  current?: boolean;
};

export function SiteHeader({
  links,
  leading = null,
}: {
  links: readonly HeaderLink[];
  leading?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <Link href="/" className="font-display text-xl text-ink">
          Voyara
        </Link>
        {leading || links.length > 0 ? (
          <nav aria-label="Primary" className="flex items-center gap-5">
            {leading}
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.current ? "page" : undefined}
                className="text-sm font-semibold text-mist"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
