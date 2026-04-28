"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { listPortfolios } from "@/lib/intelligence/client";
import type { PortfolioRecord } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

// Phase 14 — quick-access portfolio selector.
// Renders a compact chip that lists portfolios on click and opens the
// portfolio overlay without requiring the user to type a query.
export function PortfolioEntryButton() {
  const openPortfolio = useOverlayStore((s) => s.openPortfolio);
  const selectedPortfolio = useOverlayStore((s) => s.selectedPortfolio);
  const setMode = useWorkspaceModeStore((s) => s.setMode);

  const [portfolios, setPortfolios] = useState<PortfolioRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (portfolios !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listPortfolios();
      setPortfolios(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load portfolios");
    } finally {
      setLoading(false);
    }
  }, [loading, portfolios]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const handleSelect = useCallback(
    (id: string) => {
      openPortfolio(id, undefined, "portfolio");
      setMode("portfolio");
      setOpen(false);
    },
    [openPortfolio, setMode],
  );

  const label = selectedPortfolio?.name ?? "Portfolio";

  return (
    <div className="ws-portfolio-entry" ref={popoverRef}>
      <button
        type="button"
        className="ws-portfolio-entry__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="portfolio-entry-button"
      >
        <span className="ws-portfolio-entry__icon" aria-hidden>◧</span>
        <span className="ws-portfolio-entry__label">{label}</span>
        <span className="ws-portfolio-entry__chev" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="ws-portfolio-entry__popover" role="listbox">
          {loading ? (
            <div className="ws-portfolio-entry__state">Loading…</div>
          ) : error ? (
            <div className="ws-portfolio-entry__state ws-portfolio-entry__state--err">
              {error}
            </div>
          ) : portfolios && portfolios.length > 0 ? (
            <ul className="ws-portfolio-entry__list">
              {portfolios.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedPortfolio?.id === p.id}
                    onClick={() => handleSelect(p.id)}
                    className="ws-portfolio-entry__item"
                  >
                    <span className="ws-portfolio-entry__item-name">{p.name}</span>
                    {p.description ? (
                      <span className="ws-portfolio-entry__item-desc">
                        {p.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ws-portfolio-entry__state">No portfolios yet</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
