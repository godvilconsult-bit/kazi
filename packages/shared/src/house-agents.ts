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
  {
    slug: "house-pitch-outline",
    name: "Kazi Pitch Deck Outliner",
    description:
      "Kazi house agent: turns a founder's facts into a slide-by-slide pitch deck outline — headline, points, evidence and speaker notes for each slide.",
    capabilities: ["write.pitch_deck_outline"],
    languages: ["en", "sw"],
    pricing: { model: "fixed", price: "3.00", currency: "USDC" },
    mode: "async",
    timeoutSec: 600,
  },
  {
    slug: "house-social-pack",
    name: "Kazi Social Media Pack",
    description:
      "Kazi house agent: ready-to-post social media packs for Instagram, X, LinkedIn, WhatsApp and TikTok, in natural English or Swahili.",
    capabilities: ["write.social_pack"],
    languages: ["en", "sw"],
    pricing: { model: "fixed", price: "2.50", currency: "USDC" },
    mode: "async",
    timeoutSec: 600,
  },
  {
    slug: "house-statement-reviewer",
    name: "Kazi Financial Statement Reviewer",
    description:
      "Kazi house agent: reviews income statements, balance sheets and cash flows — ratios with workings, consistency checks and plain-language findings. Not an audit.",
    capabilities: ["finance.statement_review"],
    languages: ["en", "sw"],
    pricing: { model: "per_unit", unit: "page", price: "0.60", currency: "USDC", minimum: "2.00" },
    mode: "async",
    timeoutSec: 900,
  },
  {
    slug: "house-bookkeeping-draft",
    name: "Kazi Bookkeeping Drafter",
    description:
      "Kazi house agent: turns bank and M-Pesa statements, receipts and sales notes into a traceable draft ledger, category totals and income statement for your accountant.",
    capabilities: ["finance.bookkeeping_draft"],
    languages: ["en", "sw"],
    pricing: { model: "per_unit", unit: "page", price: "0.40", currency: "USDC", minimum: "1.50" },
    mode: "async",
    timeoutSec: 900,
  },
  {
    slug: "house-tz-tax-draft",
    name: "Kazi TRA Tax Drafter",
    description:
      "Kazi house agent: draft Tanzanian tax workings (income tax, VAT, PAYE/SDL) with sourced rates. Every draft is reviewed by a licensed tax practitioner before filing.",
    capabilities: ["tax.tz_tra_draft"],
    languages: ["en", "sw"],
    pricing: { model: "fixed", price: "8.00", currency: "USDC" },
    mode: "async",
    timeoutSec: 900,
  },
  {
    slug: "house-solidity-prereview",
    name: "Kazi Solidity Pre-reviewer",
    description:
      "Kazi house agent: security pre-review of Solidity contracts — severity-ranked findings with fixes and a checklist, to prepare for a professional audit. Not an audit.",
    capabilities: ["code.solidity_review"],
    languages: ["en"],
    pricing: { model: "fixed", price: "12.00", currency: "USDC" },
    mode: "async",
    timeoutSec: 900,
  },
  {
    slug: "house-csv-cleaner",
    name: "Kazi CSV Cleaner",
    description:
      "Kazi house agent: cleans CSV files — consistent headers, ISO dates, international phone numbers, numeric amounts, duplicates removed — with every change reported.",
    capabilities: ["data.clean_csv"],
    languages: ["en", "sw"],
    pricing: { model: "per_unit", unit: "file", price: "1.50", currency: "USDC" },
    mode: "async",
    timeoutSec: 600,
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
