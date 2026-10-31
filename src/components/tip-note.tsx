import type { CuratedTip } from "@/lib/catalog";

export function TipNote({ tip }: { tip: CuratedTip }) {
  return (
    <article className="rounded-frame border border-line bg-surface-raised p-5">
      <p className="text-base leading-7 text-ink">{tip.body}</p>
    </article>
  );
}
