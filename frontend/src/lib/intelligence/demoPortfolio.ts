// Phase 15A — dev/demo portfolio seeding.
// Why this exists: Portfolio mode is empty by default until the user creates
// or imports a portfolio. That hurts both first-time UX and demo recordings.
// We expose a one-click seed that builds a recognizable, sector-diversified
// portfolio against the existing /api/intelligence/portfolios contract.
//
// Hard constraints (per project memory):
// - Never seed in production. The button that calls this should be hidden
//   unless isDemoEnv() returns true.
// - Never claim this is real production data — the portfolio is named and
//   tagged so it is obvious to an analyst that it is a demo seed.

import { createPortfolio } from "@/lib/intelligence/client";
import type { HoldingInput, PortfolioRecord } from "@/lib/intelligence/types";

const DEMO_NAME = "Demo · Global Operational Risk";
const DEMO_DESCRIPTION =
  "Pre-seeded demo portfolio used for product walkthroughs. Not a real book.";
const DEMO_TAGS = ["demo", "operational-risk"];

// Recognizable, geographically diverse, sector-spread basket so the rail and
// brief have something interesting to render. Country codes are ISO-3 to
// match the rest of the platform. Phase 19E: TSLA + a JPY-denominated FX
// pair anchor are present so the canonical demo queries
// ("why is TSLA down", "JPY weakening implications") immediately light
// up the portfolio impact card.
const DEMO_HOLDINGS: HoldingInput[] = [
  // US mega-cap anchors — query "why is TSLA down" / "AAPL outlook"
  { symbol: "AAPL", quantity: 25, average_cost: 175, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Technology" },
  { symbol: "MSFT", quantity: 18, average_cost: 320, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Technology" },
  { symbol: "NVDA", quantity: 12, average_cost: 450, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Technology" },
  { symbol: "TSLA", quantity: 15, average_cost: 240, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Consumer Cyclical" },
  // US energy / industrials — exposed to commodities + chokepoints
  { symbol: "XOM", quantity: 50, average_cost: 105, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Energy" },
  { symbol: "CAT", quantity: 8, average_cost: 270, currency: "USD", asset_type: "equity", country_code: "USA", sector: "Industrials" },
  // Europe — supply-chain / autos
  { symbol: "ASML", quantity: 4, average_cost: 720, currency: "USD", asset_type: "equity", country_code: "NLD", sector: "Technology" },
  { symbol: "VOW3.DE", quantity: 20, average_cost: 130, currency: "EUR", asset_type: "equity", country_code: "DEU", sector: "Consumer Cyclical" },
  // Asia — semis + shipping
  { symbol: "TSM", quantity: 30, average_cost: 95, currency: "USD", asset_type: "equity", country_code: "TWN", sector: "Technology" },
  { symbol: "7203.T", quantity: 200, average_cost: 2400, currency: "JPY", asset_type: "equity", country_code: "JPN", sector: "Consumer Cyclical" },
  // FX exposure — anchors USDJPY / JPY-flow demo queries
  { symbol: "USDJPY", quantity: 100000, average_cost: 145, currency: "JPY", asset_type: "fx", country_code: "JPN", sector: "Currency" },
  // Broad-market hedges
  { symbol: "SPY", quantity: 15, average_cost: 480, currency: "USD", asset_type: "etf", country_code: "USA", sector: "Index" },
];

export function isDemoEnv(): boolean {
  if (typeof process === "undefined") return false;
  if (process.env?.NODE_ENV !== "production") return true;
  // Allow explicit opt-in for staging / demo deployments.
  return process.env?.NEXT_PUBLIC_SPHERE_DEMO === "1";
}

export async function seedDemoPortfolio(): Promise<PortfolioRecord> {
  return createPortfolio({
    name: DEMO_NAME,
    description: DEMO_DESCRIPTION,
    base_currency: "USD",
    tags: DEMO_TAGS,
    holdings: DEMO_HOLDINGS,
  });
}

export const DEMO_PORTFOLIO_NAME = DEMO_NAME;
