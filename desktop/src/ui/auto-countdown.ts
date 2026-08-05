import { useEffect, useRef, useState } from "react";

/** YOLO auto-approval countdown — returns whole seconds remaining (null when
 *  disabled) and fires `onExpire` once when the window elapses without a user
 *  pick. Deadline-based so parent re-renders (fresh callback identities, state
 *  churn from streaming deltas) never reset the clock. */
export function useAutoApproveCountdown(
  countdownMs: number | undefined,
  onExpire: () => void,
): number | null {
  const [remainingSec, setRemainingSec] = useState<number | null>(
    countdownMs && countdownMs > 0 ? Math.ceil(countdownMs / 1000) : null,
  );
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    if (!countdownMs || countdownMs <= 0) return;
    const deadline = Date.now() + countdownMs;
    const timer = window.setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        window.clearInterval(timer);
        setRemainingSec(0);
        onExpireRef.current();
      } else {
        setRemainingSec(Math.ceil(left / 1000));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [countdownMs]);
  return remainingSec;
}
