export function Tag({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-line px-3 py-1 text-xs font-semibold tracking-wide text-mist">
      {children}
    </span>
  );
}
