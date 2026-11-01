"use client";

import { Button } from "@/components/button";
import { PageShell } from "@/components/page-shell";

export default function CatalogError() {
  return (
    <PageShell links={[]}>
      <section className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-5 py-20">
        <h1 className="font-display text-5xl text-ink">The catalog could not be opened.</h1>
        <p className="mt-4 max-w-md text-lg leading-7 text-ink-muted">
          Voyara did not load the approved destinations. Unpublished places stay hidden.
        </p>
        <div className="mt-8">
          <Button href="/">Back to Voyara</Button>
        </div>
      </section>
    </PageShell>
  );
}
