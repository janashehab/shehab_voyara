import { Button } from "@/components/button";
import { PageShell } from "@/components/page-shell";

export default function NotFound() {
  return (
    <PageShell links={[]}>
      <section className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-5 py-20">
        <p className="text-xs font-semibold tracking-[0.16em] text-mist uppercase">404</p>
        <h1 className="font-display mt-3 text-5xl text-ink">That page is not in the catalog.</h1>
        <p className="mt-4 max-w-md text-lg leading-7 text-ink-muted">
          Voyara only opens destinations the team has approved.
        </p>
        <div className="mt-8">
          <Button href="/">Back to Voyara</Button>
        </div>
      </section>
    </PageShell>
  );
}
