/**
 * Geo-restriction hooks for staking and token claims (docs/10-BUILD-PLAN.md Phase 6). The country
 * comes from one header set by the CDN in front of the web app — configure which with
 * GEO_COUNTRY_HEADER (Cloudflare `cf-ipcountry`, Vercel `x-vercel-ip-country`, CloudFront
 * `cloudfront-viewer-country`). Only trust a header your CDN overwrites: clients can send any header.
 * The contracts stay permissionless; this only changes what the UI offers. Exits (unstake, withdraw,
 * claiming earned USDC) are never restricted.
 */

export interface Geo {
  country: string | null;
  restricted: boolean;
}

export const DEFAULT_COUNTRY_HEADER = "cf-ipcountry";

/** "US, cu ,IR" → ["US", "CU", "IR"]. */
export function parseCountryList(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z][A-Z0-9]$/.test(c));
}

export function geoFor(countryHeader: string | null | undefined, restrictedList: readonly string[]): Geo {
  const raw = countryHeader?.trim().toUpperCase() ?? "";
  // Two characters: ISO 3166-1 alpha-2, plus CDN codes such as Cloudflare's T1 (Tor). "XX" = unknown.
  const country = /^[A-Z][A-Z0-9]$/.test(raw) && raw !== "XX" ? raw : null;
  return { country, restricted: country !== null && restrictedList.includes(country) };
}

/** Server side: read the configured header from the incoming request. */
export function geoFromHeaders(headers: { get(name: string): string | null }, env: Record<string, string | undefined> = process.env): Geo {
  const header = (env["GEO_COUNTRY_HEADER"] || DEFAULT_COUNTRY_HEADER).toLowerCase();
  return geoFor(headers.get(header), parseCountryList(env["GEO_RESTRICTED_COUNTRIES"]));
}
