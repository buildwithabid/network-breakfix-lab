import { useEffect, useState } from "react";
import { mmss } from "../lib/format.js";

/** Countdown to the deadline, corrected for the difference between server and browser clocks. */
export function Timer({ deadlineAt, clockOffset }: { deadlineAt: number; clockOffset: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = deadlineAt - (now + clockOffset);
  const tone = left <= 60_000 ? "timer-bad" : left <= 5 * 60_000 ? "timer-warn" : "";
  return (
    <div className={`timer ${tone}`} role="timer" aria-live="off" data-testid="timer">
      <span className="timer-label">Time left</span>
      <span className="timer-value">{mmss(left)}</span>
    </div>
  );
}
