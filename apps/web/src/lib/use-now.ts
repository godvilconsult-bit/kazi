"use client";

import { useEffect, useState } from "react";

/** Unix seconds, refreshed every `intervalMs` (cooldown and warm-up countdowns). */
export function useNowSeconds(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
