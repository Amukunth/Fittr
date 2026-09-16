import { useEffect, useRef, useState } from 'react';

/**
 * Milliseconds elapsed since `anchorKey` last changed, ticking once a second
 * while `active`.
 *
 * Deliberately NOT "milliseconds remaining". The Streak countdowns are
 * decided by the server -- streak_preview() returns both the deadline and its
 * own now() -- and a phone's clock can be minutes out in either direction. So
 * the screen measures how long IT has been looking at the answer, and
 * remainingMs() in src/lib/soloModes.ts subtracts that from the server's own
 * (deadline - now). A hook that read Date.now() instead would hand a fighter
 * with a fast clock a window that had already closed, and one with a slow
 * clock a window that had not.
 *
 * Elapsed time comes from Date.now() DIFFERENCES rather than from counting
 * ticks: a backgrounded app does not get its interval called, and a screen
 * that counted ticks would come back believing no time had passed.
 *
 * `anchorKey` resets the clock -- pass whatever identifies the reading the
 * countdown belongs to (a run id, a server timestamp), so a refetch restarts
 * from the new answer instead of continuing to age the old one.
 */
export function useCountdown(anchorKey: string | null, active = true): number {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setElapsed(0);
  }, [anchorKey]);

  useEffect(() => {
    if (!active || anchorKey === null) {
      return;
    }
    const id = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(id);
  }, [active, anchorKey]);

  return elapsed;
}
