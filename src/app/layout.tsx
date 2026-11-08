import type { Metadata } from "next";
import { fraunces, sourceSans } from "@/app/fonts";
import { isPubliclyIndexable, NOINDEX_DIRECTIVE, readIndexingEnv, robotsMetadata } from "@/lib/indexing-policy";
import "./globals.css";

const indexingEnv = readIndexingEnv(process.env);

export const metadata: Metadata = {
  title: {
    default: "Voyara",
    template: "%s · Voyara",
  },
  description:
    "Discover extraordinary places, explore curated experiences, and create adventures that feel like you.",
  robots: robotsMetadata(indexingEnv),
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${fraunces.variable} ${sourceSans.variable}`}>
      <body className="bg-canvas text-ink antialiased">
        {isPubliclyIndexable(indexingEnv) ? null : <meta name="robots" content={NOINDEX_DIRECTIVE} />}
        {children}
      </body>
    </html>
  );
}
