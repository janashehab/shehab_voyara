import { Button } from "@/components/button";

export type ProcessStep = {
  title: string;
  body: string;
  href?: string;
  actionLabel?: string;
  later?: boolean;
};

export function ProcessSteps({ steps }: { steps: readonly ProcessStep[] }) {
  return (
    <ol className="grid gap-4 lg:grid-cols-3">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="flex flex-col rounded-frame border border-line bg-surface-raised p-5"
        >
          <p className="text-xs font-semibold tracking-[0.16em] text-mist uppercase">
            {step.later ? "Later" : "Now"} · {index + 1}
          </p>
          <h3 className="font-display mt-3 text-2xl text-ink">{step.title}</h3>
          <p className="mt-3 flex-1 text-base leading-7 text-ink-muted">{step.body}</p>
          {step.href && step.actionLabel ? (
            <div className="mt-6">
              <Button href={step.href} variant="secondary">
                {step.actionLabel}
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
