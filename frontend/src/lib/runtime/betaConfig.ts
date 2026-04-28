// Phase 16 — beta readiness env gate.
//
// One small module so the workspace shell, demo onboarding, and rail
// surfaces can read the same flags. Defaults are conservative — anything
// unset behaves like a production deploy.

export interface BetaConfig {
  /** Show the demo portfolio banner / CTA on a public deploy. */
  demoPortfolioEnabled: boolean;
  /**
   * When true, the date/replay control shows additional dev hints (zone
   * abbrev, tick interval). Otherwise the control sticks to operator copy.
   */
  showRuntimeHints: boolean;
  /**
   * When true, the rail surfaces a per-domain feed-health row. We turn it
   * on by default for beta deploys so evaluators can see freshness state
   * without opening devtools.
   */
  feedHealthVisible: boolean;
  /** Cosmetic banner copy (when demo portfolio is exposed publicly). */
  demoBannerCopy: string | null;
}

function readEnv(name: string): string | undefined {
  // Next.js inlines NEXT_PUBLIC_* at build time. We read defensively so a
  // server build without these vars doesn't crash on initial render.
  try {
    if (typeof process === "undefined" || !process.env) return undefined;
    return process.env[name];
  } catch {
    return undefined;
  }
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

let cached: BetaConfig | null = null;

export function getBetaConfig(): BetaConfig {
  if (cached) return cached;
  const demoPortfolioEnabled = asBool(
    readEnv("NEXT_PUBLIC_SPHERE_DEMO_PORTFOLIO"),
    // We default-on demo for a public deploy *only* when the build flag is
    // set; otherwise leave it off so internal builds don't accidentally
    // expose demo affordances to the wrong audience.
    false,
  );
  const showRuntimeHints = asBool(
    readEnv("NEXT_PUBLIC_SPHERE_SHOW_RUNTIME_HINTS"),
    false,
  );
  const feedHealthVisible = asBool(
    readEnv("NEXT_PUBLIC_SPHERE_FEED_HEALTH"),
    true,
  );
  cached = {
    demoPortfolioEnabled,
    showRuntimeHints,
    feedHealthVisible,
    demoBannerCopy: demoPortfolioEnabled
      ? "Public beta · demo portfolio enabled. Holdings are illustrative."
      : null,
  };
  return cached;
}

/** Test-only — reset the cached config. */
export function resetBetaConfigCache(): void {
  cached = null;
}
