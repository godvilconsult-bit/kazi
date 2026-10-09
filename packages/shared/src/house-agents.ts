import { SERVICE_FEE_PROVIDER_SLUG } from "./quote";

/**
 * Kazi's first-party providers (docs/06-ROUTER.md §7). Single source for the DB seed and the
 * house-agents service, so listings and the agents' manifests can't drift apart.
 */

export interface HouseAgentListing {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly languages: readonly string[];
  readonly pricing: {
    readonly model: "per_unit" | "fixed";
    readonly unit?: string;
    readonly price: string;
    readonly currency: "USDC";
    readonly minimum?: string;
  };
  readonly mode: "sync" | "async";
  readonly timeoutSec: number;
}

export const HOUSE_AGENT_LISTINGS: readonly HouseAgentListing[] = [
  {
    slug: "house-translator-en-sw",
    name: "Kazi Translator (EN ⇄ SW)",
    description:
      "Kazi house agent: translates business documents between English and Swahili, keeping formatting.",
    capabilities: ["translate.en-sw", "translate.sw-en"],
    languages: ["en", "sw"],
    pricing: {
      model: "per_unit",
      unit: "1000_words",
      price: "0.80",
      currency: "USDC",
      minimum: "0.20",
    },
    mode: "async",
    timeoutSec: 600,
  },
  {
    slug: "house-business-plan-writer",
    name: "Kazi Business Plan Writer",
    description: "Kazi house agent: drafts structured business plans for SMEs and crypto projects.",
    capabilities: ["write.business_plan"],
    languages: ["en", "sw"],
    pricing: { model: "fixed", price: "6.00", currency: "USDC" },
    mode: "async",
    timeoutSec: 900,
  },
  {
    slug: "house-market-research",
    name: "Kazi Market Researcher",
    description:
      "Kazi house agent: researches a market with live web sources — size, customers, competitors, prices and risks — and cites them.",
    capabilities: ["research.market"],
    languages: ["en", "sw"],
    pricing: { model: "fixed", price: "4.00", currency: "USDC" },
    mode: "async",
    timeoutSec: 900,
  },
];

/** The router's service-fee milestone is paid to this provider (06-ROUTER §3). Never matched to work. */
export const SERVICE_FEE_PROVIDER = {
  slug: SERVICE_FEE_PROVIDER_SLUG,
  name: "Kazi service fee",
  description:
    "Kazi's router service fee. Paid to the Kazi treasury as its own milestone on each task.",
  pricing: { model: "fixed", price: "0.10", currency: "USDC" },
} as const;
