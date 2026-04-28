"use client";

// Phase 16.5 — premium market-tape iconography.
//
// Restrained monochrome glyphs per asset class. Stroke-only so the parent
// `currentColor` controls tint and the icons stay coherent with the rest
// of the operator shell (no cartoonish retail-finance fills).

import type { SVGProps } from "react";

export type AssetClass = "equities" | "fx" | "commodities" | "futures";

interface AssetClassIconProps extends SVGProps<SVGSVGElement> {
  assetClass: AssetClass;
}

export function AssetClassIcon({ assetClass, ...rest }: AssetClassIconProps) {
  const common: SVGProps<SVGSVGElement> = {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...rest,
  };

  switch (assetClass) {
    case "equities":
      // Compact bar chart — rising columns, no decorative flourish.
      return (
        <svg {...common}>
          <line x1="3" y1="13" x2="3" y2="9" />
          <line x1="6.5" y1="13" x2="6.5" y2="6" />
          <line x1="10" y1="13" x2="10" y2="3.5" />
          <line x1="13.5" y1="13" x2="13.5" y2="7.5" />
        </svg>
      );
    case "fx":
      // Two opposing arrows — currency exchange motion.
      return (
        <svg {...common}>
          <path d="M3 5h9" />
          <path d="M9 2.5 12 5l-3 2.5" />
          <path d="M13 11H4" />
          <path d="M7 8.5 4 11l3 2.5" />
        </svg>
      );
    case "commodities":
      // Layered diamond — physical asset, refined material.
      return (
        <svg {...common}>
          <path d="M8 2 13.5 7 8 14 2.5 7Z" />
          <path d="M2.5 7h11" />
        </svg>
      );
    case "futures":
      // Forward time arrow — contract pointing into the future.
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 4.5v3.5l2 1.5" />
        </svg>
      );
  }
}
