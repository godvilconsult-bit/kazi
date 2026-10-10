"use client";

import { createContext, useContext } from "react";
import { useTranslations } from "next-intl";
import type { Geo } from "@/lib/geo";
import { Notice } from "./ui";

export const GeoContext = createContext<Geo>({ country: null, restricted: false });

/** Whether staking and token claims are offered to this visitor (see lib/geo.ts). */
export function useGeo(): Geo {
  return useContext(GeoContext);
}

export function GeoNotice({ className }: { className?: string }) {
  const t = useTranslations("geo");
  const geo = useGeo();
  if (!geo.restricted) return null;
  return (
    <Notice tone="warn" className={className}>
      {t("restricted")}
    </Notice>
  );
}
