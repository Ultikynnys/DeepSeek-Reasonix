import { useEffect, useRef } from "react";

export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
}

/** A span that displays an auto-updating elapsed-time counter using direct
 *  DOM mutation. This avoids React re-renders on every tick — the timer
 *  update never cascades through the component tree. */
export function TimerSpan({
  active,
  startAt,
  className,
  format,
}: {
  active: boolean;
  startAt?: number;
  className?: string;
  format?: (ms: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const start = useRef<number | null>(null);
  const fmt = format ?? fmtElapsed;

  useEffect(() => {
    if (!active) {
      if (ref.current) ref.current.textContent = "";
      start.current = null;
      return;
    }
    start.current = startAt ?? performance.now();
    const id = setInterval(() => {
      if (start.current !== null && ref.current) {
        ref.current.textContent = fmt(performance.now() - start.current);
      }
    }, 250);
    return () => clearInterval(id);
  }, [active, startAt, fmt]);

  return <span ref={ref} className={className} />;
}
