import Link from "next/link";
import type { ReactNode } from "react";

const variants = {
  primary:
    "bg-peach text-canvas hover:bg-peach-deep",
  secondary:
    "border border-line bg-transparent text-ink hover:bg-surface",
  quiet: "bg-transparent text-mist underline-offset-4 hover:underline",
} as const;

type ButtonVariant = keyof typeof variants;

const base =
  "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-base font-semibold";

export function Button({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
}) {
  return (
    <Link href={href} className={`${base} ${variants[variant]}`}>
      {children}
    </Link>
  );
}
