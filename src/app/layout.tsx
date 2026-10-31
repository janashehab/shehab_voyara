import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voyara",
  description: "AI travel planning grounded in a curated catalog.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="bg-zinc-50 text-zinc-950 antialiased">{children}</body>
    </html>
  );
}
