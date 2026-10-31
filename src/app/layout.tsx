import type { Metadata } from "next";
import { fraunces, sourceSans } from "@/app/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Voyara",
    template: "%s · Voyara",
  },
  description:
    "Discover extraordinary places, explore curated experiences, and create adventures that feel like you.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${sourceSans.variable}`}>
      <body className="bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
