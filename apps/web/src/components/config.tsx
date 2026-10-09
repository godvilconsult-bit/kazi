"use client";

import { createContext, useContext } from "react";
import type { PublicConfig } from "@/lib/types";

export const ConfigContext = createContext<PublicConfig | null>(null);

/** Chain, contracts and token decimals from GET /config (read once per page load). */
export function useKaziConfig(): PublicConfig {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error("Kazi config is not loaded");
  return cfg;
}
