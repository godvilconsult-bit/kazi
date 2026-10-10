"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, apiUrl } from "./api";
import type { TaskEventView } from "./types";

/**
 * Live task activity over SSE (GET /tasks/:id/events). The server replays the log on every
 * (re)connect, so events are de-duplicated by id. Status-changing events refresh the task query.
 */
export function useTaskEvents(taskId: string, enabled = true) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<TaskEventView[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleRefresh = () => {
      if (refresh) return;
      refresh = setTimeout(() => {
        refresh = null;
        void qc.invalidateQueries({ queryKey: ["task", taskId] });
      }, 400);
    };

    const open = () => {
      source = new EventSource(apiUrl(`/tasks/${taskId}/events`), { withCredentials: true });
      source.onopen = () => setConnected(true);
      source.addEventListener("task", (msg) => {
        const e = JSON.parse((msg as MessageEvent<string>).data) as TaskEventView;
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        setEvents((prev) => [...prev, e]);
        scheduleRefresh();
      });
      source.onerror = () => {
        setConnected(false);
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          // Usually an expired access token: /me refreshes the session, then reconnect.
          retry = setTimeout(() => {
            void api("/me")
              .catch(() => undefined)
              .finally(() => {
                if (!stopped) open();
              });
          }, 3_000);
        }
      };
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (refresh) clearTimeout(refresh);
    };
  }, [taskId, enabled, qc]);

  return { events, connected };
}

/** Re-render every `ms` (countdowns, relative times). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
