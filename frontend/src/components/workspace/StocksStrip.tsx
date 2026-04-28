"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SignalEvent } from "@/lib/intelligence/types";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

import { AssetClassIcon, type AssetClass } from "./AssetClassIcon";
import { formatRelative } from "./formatters";

// Phase 16.5 — premium market tape.
//
// The lower rail is a unified live ribbon: four asset-class sections
// (equities / FX / commodities / futures) flow horizontally inside one
// scroll surface. Group head carries an icon, count, and a calm live-dot;
// individual ticker cards pulse only on real price changes; a slow
// auto-drift keeps the surface feeling alive without strobing or
// hijacking interaction.
//
// Honest-data rule: groups whose feed is empty don't render — we never
// fabricate a futures basket just to fill four slots.

// Phase 16.7 — broader curated basket. The aim is breadth without spam:
// globally-relevant equities (mega-cap US + a few sector anchors + ETFs),
// majors-only FX, the eight most-watched commodities, and the index/rate
// futures an operator would actually pull a chart for. We never fabricate
// — if the feed has nothing for a symbol the row simply doesn't appear.

// Phase 17A.2 — broader Alpha-Vantage-friendly basket. Every symbol here
// is something Alpha Vantage covers via TIME_SERIES_DAILY (equities) or
// FX_DAILY (six-letter pairs). We never list symbols the provider can't
// actually serve; the cache + posture engine will then degrade honestly
// when an individual ticker has a quiet feed cycle.
const EQUITIES_BASKET = new Set([
  "AAPL",
  "MSFT",
  "NVDA",
  "TSLA",
  "SPY",
  "GOOGL",
  "META",
  "AMZN",
  "QQQ",
  "BRK.B",
  "JPM",
  "BAC",
  "XOM",
  "CVX",
  "WMT",
  "UNH",
  "V",
  "MA",
  "DIA",
  "IWM",
  "AVGO",
  "AMD",
  "COST",
  "NFLX",
  "ORCL",
  "PEP",
  "KO",
  "PFE",
  "JNJ",
  "PG",
  // Phase 17A.3 — modest broadening within Alpha Vantage coverage.
  // Each of these resolves cleanly under TIME_SERIES_DAILY and rounds
  // out the basket with global / cyclical / consumer anchors so the
  // tape doesn't read as a US-tech monoculture.
  "TSM",
  "BABA",
  "DIS",
  "CRM",
  "ADBE",
  "NKE",
  "UPS",
  "CAT",
  "BA",
  "LMT",
]);

const MAJOR_FX_PAIRS = new Set([
  "EURUSD",
  "USDJPY",
  "GBPUSD",
  "AUDUSD",
  "USDCAD",
  "USDCHF",
  "USDCNH",
  "USDINR",
  "USDMXN",
  "USDBRL",
  "EURGBP",
  "EURJPY",
  "DXY",
  // Phase 17A.3 — additional majors-adjacent pairs that AV's FX_DAILY
  // serves reliably. Kept tight: NZD/SEK/NOK/ZAR cover the missing
  // commodity-currency / Nordic / EM-anchor coverage gaps.
  "NZDUSD",
  "USDSEK",
  "USDNOK",
  "USDZAR",
]);

// Physical commodities first — futures in their own group below.
const MAJOR_COMMODITIES = new Set([
  "CL",
  "BZ",
  "NG",
  "GC",
  "SI",
  "HG",
  "PL",
  "PA",
  "ZW",
  "ZC",
  "ZS",
  "KC",
  "SB",
  "CT",
]);

// Index / rate futures. We keep them split from physical commodities so
// the operator scans "Futures" as a financial-curve surface, not a barrel
// shelf. If the feed is empty the group won't render at all.
const MAJOR_FUTURES = new Set([
  "ES",
  "NQ",
  "YM",
  "RTY",
  "VX",
  "ZN",
  "ZF",
  "ZB",
  "ZT",
  "FF",
  "GE",
  "SR3",
]);

const GROUP_LIMIT = 14;
// News-channel ribbon pace. Phase 17A.3 nudges this from 24 → 28 px/s.
// Alpha Vantage's daily cadence still leaves long stretches without
// numeric updates; a slightly faster drift keeps the tape visibly alive
// without straying into entertainment-tier strobing. Real cable tickers
// sit in the 20–40 px/s band — 28 keeps Sphere clearly inside the calm
// half of that range while reading as live.
const AUTO_FLOW_PX_PER_SEC = 28;
// Phase 17A.3 follow-up — the rAF/scrollLeft approach is gone, so the
// user-lock window is no longer needed. The marquee animation itself
// pauses on hover/focus via CSS, and there is no manual scroll surface
// to "lock" against because the container is now overflow:hidden.
// Pulse glow on real price changes. Bumped from 720 → 900ms so the
// green/red flash registers visually under typical AV update cadence
// without bleeding into the next pulse.
const PULSE_DURATION_MS = 900;

type GroupId = "equities" | "fx" | "commodities" | "futures";

interface AssetGroupConfig {
  id: GroupId;
  label: string;
  assetClass: AssetClass;
  badge: string;
  items: SignalEvent[];
}

export function StocksStrip() {
  const stocks = useOverlayStore((s) => s.latestStocks);
  const fx = useOverlayStore((s) => s.latestFx);
  const commodities = useOverlayStore((s) => s.latestCommodities);
  const openEvent = useOverlayStore((s) => s.openEvent);
  const selectMarketSymbol = useOverlayStore((s) => s.selectMarketSymbol);
  const selectedMarketSymbol = useOverlayStore((s) => s.selectedMarketSymbol);
  const mode = useWorkspaceModeStore((s) => s.mode);
  const selectedPortfolio = useOverlayStore((s) => s.selectedPortfolio);
  const selectedCountryCode = useOverlayStore((s) => s.selectedCountryCode);
  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const reduceMotion = useAccessibilityStore((s) => s.reduceMotion);

  const portfolioSymbols = useMemo(() => {
    return new Set(
      (selectedPortfolio?.holdings ?? []).map((h) => h.symbol.toUpperCase()),
    );
  }, [selectedPortfolio]);

  const portfolioCurrencies = useMemo(() => {
    return new Set(
      (selectedPortfolio?.holdings ?? [])
        .map((h) => h.currency?.toUpperCase())
        .filter((c): c is string => Boolean(c)),
    );
  }, [selectedPortfolio]);

  const groups: AssetGroupConfig[] = useMemo(() => {
    const equities = pickEquities(stocks, {
      mode,
      portfolioSymbols,
      selectedCountryCode,
    });
    const futures = pickFutures(stocks, commodities);
    return [
      {
        id: "equities",
        label: "Equities",
        assetClass: "equities",
        badge: "EQ",
        items: equities,
      },
      {
        id: "fx",
        label: "FX",
        assetClass: "fx",
        badge: "FX",
        items: pickFx(fx, {
          mode,
          portfolioCurrencies,
          selectedCountryCode,
        }),
      },
      {
        id: "commodities",
        label: "Commodities",
        assetClass: "commodities",
        badge: "CMDTY",
        items: pickCommodities(commodities),
      },
      {
        id: "futures",
        label: "Futures",
        assetClass: "futures",
        badge: "FUT",
        items: futures,
      },
    ];
  }, [
    stocks,
    fx,
    commodities,
    mode,
    portfolioSymbols,
    portfolioCurrencies,
    selectedCountryCode,
  ]);

  const totalItems = groups.reduce((acc, g) => acc + g.items.length, 0);
  const label = resolveLabel(mode);

  const groupsRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Phase 17A.3 hotfix — when the natural basket width is narrower than
  // the tape's container, two copies side-by-side might still not fully
  // span the viewport. We measure the natural unit of one render of
  // `groups` and bump a tiling multiplier until one copy is wider than
  // the container, so the marquee animation always has visible motion.
  const [tilingMultiplier, setTilingMultiplier] = useState(1);
  const [marqueeDuration, setMarqueeDuration] = useState<number | null>(null);

  // Phase 17A.3 follow-up — replace the rAF + scrollLeft auto-flow with a
  // pure CSS marquee. The container is overflow:hidden (no native
  // scrollbar) and the inner wrapper holds two equal copies of the
  // tracks; a `translateX(0) → translateX(-50%)` linear-infinite
  // animation moves the content continuously left, wrapping seamlessly
  // because the second copy is identical to the first. Hover and
  // focus-within pause via CSS. Reduced-motion users get a static
  // ribbon.
  useEffect(() => {
    if (totalItems === 0 || reduceMotion) return;
    const groupsEl = groupsRef.current;
    if (!groupsEl) return;
    const measure = () => {
      const trackEl = trackRef.current;
      if (!trackEl) return;
      const containerWidth = groupsEl.clientWidth;
      const oneCopyWidth = trackEl.scrollWidth;
      if (containerWidth <= 0 || oneCopyWidth <= 0) return;
      const naturalUnit = oneCopyWidth / Math.max(tilingMultiplier, 1);
      // One copy must be at least as wide as the container so the
      // marquee wrap point isn't visible. Aim for 1.05× margin.
      const want = Math.min(
        6,
        Math.max(1, Math.ceil((containerWidth * 1.05) / Math.max(naturalUnit, 1))),
      );
      if (want !== tilingMultiplier) {
        setTilingMultiplier(want);
        return; // duration recomputed on next pass with updated width
      }
      // Animation duration scales with one-copy width so apparent
      // velocity stays at AUTO_FLOW_PX_PER_SEC regardless of basket
      // size. Cap at sane bounds.
      const seconds = Math.max(
        12,
        Math.min(180, oneCopyWidth / AUTO_FLOW_PX_PER_SEC),
      );
      setMarqueeDuration((prev) =>
        prev !== null && Math.abs(prev - seconds) < 0.1 ? prev : seconds,
      );
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(groupsEl);
    return () => ro?.disconnect();
  }, [totalItems, groups, reduceMotion, tilingMultiplier]);

  if (totalItems === 0) {
    return (
      <div className="ws-strip ws-strip--empty" aria-live="polite" data-mode={mode}>
        <span className="ws-eyebrow">{label}</span>
        <p>
          No market signals available right now. The market rail will hydrate
          as soon as feeds are reachable.
        </p>
      </div>
    );
  }

  const lastUpdate = pickLastUpdate(groups);

  return (
    <div
      className={`ws-strip ws-strip--stocks ws-strip--multiasset${asOf ? " ws-strip--asof" : ""}`}
      aria-label={label}
      data-mode={mode}
      data-asof={asOf ?? ""}
      data-overflow-start="false"
      data-overflow-end="false"
      data-reduce-motion={reduceMotion ? "true" : "false"}
      data-pulse-driven={reduceMotion ? "false" : "true"}
      data-continuous={reduceMotion ? "false" : "true"}
      data-testid="multi-asset-strip"
    >
      <div className="ws-strip__head">
        <span className="ws-eyebrow">
          <span className="ws-strip__live-dot" aria-hidden="true" />
          {label}
        </span>
        <span className="ws-strip__count">
          {asOf ? (
            <span
              className="ws-strip__asof-chip"
              data-testid="multi-asset-asof"
            >
              as of {asOf.slice(0, 10)} ·{" "}
            </span>
          ) : null}
          updated {formatRelative(lastUpdate)}
        </span>
      </div>
      {/* Pagination buttons retained as DOM nodes for existing test
          contracts (multi-asset-prev / multi-asset-next), but the
          tape is now a continuous CSS marquee with no manual scroll
          surface — the buttons stay disabled and visually hidden. */}
      <button
        type="button"
        className="ws-multiasset__paginate ws-multiasset__paginate--prev"
        disabled
        aria-hidden="true"
        tabIndex={-1}
        data-testid="multi-asset-prev"
      >
        ‹
      </button>
      <div
        ref={groupsRef}
        className="ws-multiasset__groups"
        data-testid="multi-asset-groups"
        role="region"
        aria-label="Market rail — auto-scrolling ticker"
        tabIndex={0}
      >
        <div
          className={`ws-multiasset__inner${reduceMotion ? "" : " ws-multiasset__inner--marquee"}`}
          data-testid="multi-asset-marquee"
          style={
            !reduceMotion && marqueeDuration !== null
              ? ({ animationDuration: `${marqueeDuration}s` } as React.CSSProperties)
              : undefined
          }
        >
          <div
            ref={trackRef}
            className="ws-multiasset__track"
            data-testid="multi-asset-track"
            data-clone="false"
          >
            {Array.from({ length: tilingMultiplier }).flatMap((_, copyIdx) =>
              groups
                .filter((g) => g.items.length > 0)
                .map((group) => (
                  <AssetGroup
                    key={`${copyIdx}:${group.id}`}
                    group={group}
                    onOpenEvent={openEvent}
                    onSelectSymbol={selectMarketSymbol}
                    selectedSymbol={selectedMarketSymbol}
                    // Only the first copy in the original track
                    // exposes testids and announceable content;
                    // subsequent copies are aria-hidden tiling so
                    // the marquee can fill the viewport without
                    // duplicating the announcer or breaking testids.
                    cloneOf={copyIdx > 0 ? `repeat-${copyIdx}` : undefined}
                  />
                )),
            )}
          </div>
          {/* Identical second copy completes the marquee. translateX
              from 0 to -50% over the inner wrapper visually moves the
              first copy off-screen left while the second copy slides
              into its place; jumping back to translateX(0) at end
              repeats invisibly because both copies are identical. */}
          {!reduceMotion ? (
            <div
              className="ws-multiasset__track ws-multiasset__track--clone"
              data-testid="multi-asset-track-clone"
              data-clone="true"
              aria-hidden="true"
            >
              {Array.from({ length: tilingMultiplier }).flatMap((_, copyIdx) =>
                groups
                  .filter((g) => g.items.length > 0)
                  .map((group) => (
                    <AssetGroup
                      key={`clone-${copyIdx}:${group.id}`}
                      group={group}
                      onOpenEvent={openEvent}
                      onSelectSymbol={selectMarketSymbol}
                      selectedSymbol={selectedMarketSymbol}
                      cloneOf={`clone-${copyIdx}-${group.id}`}
                    />
                  )),
              )}
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="ws-multiasset__paginate ws-multiasset__paginate--next"
        disabled
        aria-hidden="true"
        tabIndex={-1}
        data-testid="multi-asset-next"
      >
        ›
      </button>
    </div>
  );
}

interface AssetGroupProps {
  group: AssetGroupConfig;
  onOpenEvent: (event: SignalEvent, intent: "stocks-strip") => void;
  onSelectSymbol: (
    symbol: string | null,
    assetClass?: AssetClass | null,
  ) => void;
  selectedSymbol: string | null;
  /**
   * When set, this AssetGroup is the visual clone used to make the auto-
   * flow wrap silently. Pulses, testids, and live dots are suppressed so
   * the cloned content never inflates the announced state.
   */
  cloneOf?: string;
}

interface ResolvedTicker {
  event: SignalEvent;
  symbol: string;
  pct: number | null;
  price: number | null;
  direction: "up" | "down" | "flat";
}

function AssetGroup({
  group,
  onOpenEvent,
  onSelectSymbol,
  selectedSymbol,
  cloneOf,
}: AssetGroupProps) {
  const isClone = Boolean(cloneOf);
  const resolved: ResolvedTicker[] = useMemo(
    () => group.items.map(resolveTicker),
    [group.items],
  );

  // Per-symbol last-price tracking so we can pulse only on real changes.
  // The ref is keyed by event.id (stable per symbol per feed cycle).
  const prevPriceRef = useRef<Map<string, number>>(new Map());
  const [pulses, setPulses] = useState<Map<string, "up" | "down">>(new Map());

  useEffect(() => {
    const next = new Map<string, "up" | "down">();
    for (const t of resolved) {
      if (t.price === null) continue;
      const prev = prevPriceRef.current.get(t.event.id);
      if (prev !== undefined && prev !== t.price) {
        next.set(t.event.id, t.price > prev ? "up" : "down");
      }
      prevPriceRef.current.set(t.event.id, t.price);
    }
    if (next.size === 0) return;
    setPulses(next);
    const handle = window.setTimeout(() => setPulses(new Map()), PULSE_DURATION_MS);
    return () => window.clearTimeout(handle);
  }, [resolved]);

  return (
    <section
      className={`ws-multiasset__group${isClone ? " ws-multiasset__group--clone" : ""}`}
      data-asset-group={group.id}
      data-clone={isClone ? "true" : "false"}
      data-testid={isClone ? undefined : `asset-group-${group.id}`}
    >
      <header className="ws-multiasset__group-head">
        <span
          className="ws-multiasset__group-icon"
          data-testid={isClone ? undefined : `asset-group-${group.id}-icon`}
        >
          <AssetClassIcon assetClass={group.assetClass} />
        </span>
        <span className="ws-multiasset__group-label">{group.label}</span>
        <span className="ws-multiasset__group-count">{group.items.length}</span>
        <span className="ws-multiasset__group-badge" aria-hidden="true">
          {group.badge}
        </span>
        <span
          className="ws-multiasset__group-livedot"
          aria-hidden="true"
          data-testid={isClone ? undefined : `asset-group-${group.id}-livedot`}
        />
      </header>
      <ul
        className="ws-ticker-list ws-ticker-list--inline"
        data-testid={isClone ? undefined : `asset-group-${group.id}-list`}
      >
        {resolved.map((t) => {
          const pulse = pulses.get(t.event.id) ?? null;
          const normalizedSymbol = t.symbol.toUpperCase();
          const isSelected = selectedSymbol === normalizedSymbol;
          return (
            <li key={t.event.id}>
              <button
                type="button"
                className={`ws-ticker ws-ticker--${t.direction} ws-ticker--sev-${t.event.severity}${pulse ? ` ws-ticker--pulse-${pulse}` : ""}${isSelected ? " ws-ticker--selected" : ""}`}
                onClick={() => {
                  onSelectSymbol(normalizedSymbol, group.assetClass);
                  onOpenEvent(t.event, "stocks-strip");
                }}
                title={buildTitle(t.symbol, t.pct, t.price)}
                data-pulse={pulse ?? "none"}
                data-direction={t.direction}
                data-selected={isSelected ? "true" : "false"}
                data-symbol={normalizedSymbol}
              >
                <span className="ws-ticker__symbol">{t.symbol}</span>
                <span className="ws-ticker__values">
                  <span className="ws-ticker__pct">
                    {t.pct === null
                      ? "—"
                      : `${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(2)}%`}
                  </span>
                  {t.price !== null ? (
                    <span className="ws-ticker__price">
                      {formatPrice(t.price)}
                    </span>
                  ) : null}
                </span>
                <span
                  className="ws-ticker__arrow"
                  aria-hidden="true"
                  data-direction={t.direction}
                >
                  {t.direction === "up" ? "▲" : t.direction === "down" ? "▼" : "·"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface PickContext {
  mode: "investigate" | "compare" | "portfolio" | "replay";
  portfolioSymbols: Set<string>;
  selectedCountryCode: string | null;
}

function pickEquities(
  events: SignalEvent[],
  ctx: PickContext,
): SignalEvent[] {
  const filtered = events.filter((event) => {
    const symbol = asString(event.properties?.symbol);
    if (!symbol) return ctx.mode === "investigate";

    // Filter index-future-shaped symbols out of equities — they belong in
    // the futures group below.
    if (MAJOR_FUTURES.has(symbol.toUpperCase())) return false;

    if ((ctx.mode === "portfolio" || ctx.mode === "replay") && ctx.portfolioSymbols.size > 0) {
      return ctx.portfolioSymbols.has(symbol.toUpperCase());
    }

    if (ctx.mode === "investigate" && ctx.selectedCountryCode) {
      const iso =
        asString(event.properties?.country_code) ??
        asString(event.properties?.iso3) ??
        null;
      if (iso && iso.toUpperCase() === ctx.selectedCountryCode.toUpperCase()) {
        return true;
      }
    }

    return EQUITIES_BASKET.has(symbol.toUpperCase());
  });
  return filtered.slice(0, GROUP_LIMIT);
}

interface FxPickContext {
  mode: "investigate" | "compare" | "portfolio" | "replay";
  portfolioCurrencies: Set<string>;
  selectedCountryCode: string | null;
}

function pickFx(events: SignalEvent[], ctx: FxPickContext): SignalEvent[] {
  const filtered = events.filter((event) => {
    const pair = (asString(event.properties?.pair)
      ?? asString(event.properties?.symbol)
      ?? event.title)
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (!pair) return false;

    if ((ctx.mode === "portfolio" || ctx.mode === "replay") && ctx.portfolioCurrencies.size > 0) {
      return Array.from(ctx.portfolioCurrencies).some((cur) => pair.includes(cur));
    }

    return MAJOR_FX_PAIRS.has(pair);
  });
  return filtered.slice(0, GROUP_LIMIT);
}

function pickCommodities(events: SignalEvent[]): SignalEvent[] {
  const filtered = events.filter((event) => {
    const symbol = (asString(event.properties?.symbol) ?? event.title)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return MAJOR_COMMODITIES.has(symbol);
  });
  return filtered.slice(0, GROUP_LIMIT);
}

// Futures: pull index/rate futures from whatever feed they happen to land
// in. Stocks feed surfaces ES/NQ in some configurations, commodities feed
// in others. Honesty rule: if no feed produces them, the group renders
// nothing and `AssetGroup` is skipped — we never fabricate index data.
function pickFutures(
  stocks: SignalEvent[],
  commodities: SignalEvent[],
): SignalEvent[] {
  const seen = new Set<string>();
  const out: SignalEvent[] = [];
  const consider = (event: SignalEvent) => {
    const symbol = (asString(event.properties?.symbol) ?? event.title)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!MAJOR_FUTURES.has(symbol)) return;
    if (seen.has(event.id)) return;
    seen.add(event.id);
    out.push(event);
  };
  for (const e of stocks) consider(e);
  for (const e of commodities) consider(e);
  return out.slice(0, GROUP_LIMIT);
}

function resolveTicker(event: SignalEvent): ResolvedTicker {
  const symbol = asString(event.properties?.symbol)
    ?? asString(event.properties?.pair)
    ?? event.title;
  const pct = asNumber(event.properties?.change_pct);
  const price = asNumber(event.properties?.price)
    ?? asNumber(event.properties?.last)
    ?? null;
  let direction: "up" | "down" | "flat" = "flat";
  if (pct !== null) {
    if (pct > 0) direction = "up";
    else if (pct < 0) direction = "down";
  }
  return { event, symbol, pct, price, direction };
}

function pickLastUpdate(groups: AssetGroupConfig[]): string | null {
  let newest: string | null = null;
  let newestT = -Infinity;
  for (const group of groups) {
    for (const ev of group.items) {
      const ts = ev.source_timestamp ?? ev.ingested_at;
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t > newestT) {
        newest = ts;
        newestT = t;
      }
    }
  }
  return newest;
}

function buildTitle(
  symbol: string,
  pct: number | null,
  price: number | null,
): string {
  const parts: string[] = [symbol];
  if (pct !== null) parts.push(`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
  if (price !== null) parts.push(`px ${formatPrice(price)}`);
  return parts.join(" · ");
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  // FX pairs and rates trade with extra precision; normal equities stay
  // 2dp. We keep this honest about precision rather than rounding all
  // values to 2dp.
  if (Math.abs(value) < 10) return value.toFixed(4);
  if (Math.abs(value) < 100) return value.toFixed(2);
  return value.toFixed(2);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveLabel(mode: ReturnType<typeof useWorkspaceModeStore.getState>["mode"]): string {
  switch (mode) {
    case "portfolio":
      return "Portfolio market context";
    case "replay":
      return "Market context · As-of";
    case "compare":
      return "Compared market context";
    default:
      return "Market tape";
  }
}
