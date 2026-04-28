"use client";

import { useCallback, useState } from "react";

import {
  createPortfolio,
  importPortfolioCsv,
} from "@/lib/intelligence/client";
import {
  isDemoEnv,
  seedDemoPortfolio,
} from "@/lib/intelligence/demoPortfolio";
import { useOverlayStore } from "@/store/useOverlayStore";

// Phase 15A — first-time / empty-state surface for Portfolio mode.
// Shown when the user has switched into Portfolio mode but no portfolio is
// selected (or no portfolios exist on the backend yet). Three explicit
// affordances keep the workflow obvious:
//   1. Create new portfolio (named, empty, then user adds holdings)
//   2. Import CSV
//   3. Use demo portfolio (dev / demo deployments only)
//
// The component intentionally does NOT live behind a modal — it occupies the
// portfolio overlay so the user is never lost in an empty workspace.

type Phase = "idle" | "creating" | "importing" | "seeding" | "error";

export function PortfolioOnboarding() {
  const openPortfolio = useOverlayStore((s) => s.openPortfolio);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [createName, setCreateName] = useState("");
  const [csvText, setCsvText] = useState("");

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      setError("Give the portfolio a name first.");
      return;
    }
    setPhase("creating");
    setError(null);
    try {
      const record = await createPortfolio({ name, base_currency: "USD" });
      openPortfolio(record.id, record, "portfolio");
      setShowCreate(false);
      setCreateName("");
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create portfolio.");
      setPhase("error");
    }
  }, [createName, openPortfolio]);

  const handleImport = useCallback(async () => {
    const csv = csvText.trim();
    if (!csv) {
      setError("Paste CSV content first.");
      return;
    }
    setPhase("importing");
    setError(null);
    try {
      // Two-step: create empty, then push CSV. Keeps the import flow
      // resilient if CSV parsing fails mid-import.
      const created = await createPortfolio({
        name: `Imported · ${new Date().toISOString().slice(0, 10)}`,
        base_currency: "USD",
      });
      await importPortfolioCsv(created.id, csv);
      openPortfolio(created.id, undefined, "portfolio");
      setShowImport(false);
      setCsvText("");
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV import failed.");
      setPhase("error");
    }
  }, [csvText, openPortfolio]);

  const handleSeedDemo = useCallback(async () => {
    setPhase("seeding");
    setError(null);
    try {
      const record = await seedDemoPortfolio();
      openPortfolio(record.id, record, "portfolio");
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo seed failed.");
      setPhase("error");
    }
  }, [openPortfolio]);

  const busy =
    phase === "creating" || phase === "importing" || phase === "seeding";

  return (
    <section
      className="ws-portfolio-onboard"
      data-testid="portfolio-onboarding"
      aria-busy={busy}
    >
      <header className="ws-portfolio-onboard__head">
        <span className="ws-eyebrow">Portfolio</span>
        <h2>Bring a portfolio into the investigation</h2>
        <p>
          Sphere ties macro signals, technical pressure, and dependency paths
          to the holdings you actually care about. Pick how you want to start.
        </p>
      </header>

      <div className="ws-portfolio-onboard__grid">
        <article className="ws-portfolio-onboard__card">
          <h3>Create new</h3>
          <p>Start empty and add positions one at a time.</p>
          {showCreate ? (
            <div className="ws-portfolio-onboard__form">
              <label>
                <span>Portfolio name</span>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Operational Risk Watchlist"
                  data-testid="onboard-create-name"
                />
              </label>
              <div className="ws-portfolio-onboard__row">
                <button
                  type="button"
                  className="ws-btn ws-btn--primary"
                  onClick={handleCreate}
                  disabled={busy}
                  data-testid="onboard-create-submit"
                >
                  {phase === "creating" ? "Creating…" : "Create portfolio"}
                </button>
                <button
                  type="button"
                  className="ws-btn ws-btn--ghost"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateName("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={() => setShowCreate(true)}
              disabled={busy}
              data-testid="onboard-create"
            >
              Create portfolio
            </button>
          )}
        </article>

        <article className="ws-portfolio-onboard__card">
          <h3>Import CSV</h3>
          <p>
            Paste rows of <code>symbol,quantity,average_cost,currency</code>.
          </p>
          {showImport ? (
            <div className="ws-portfolio-onboard__form">
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder="symbol,quantity,average_cost,currency&#10;AAPL,10,170,USD&#10;TSM,25,90,USD"
                data-testid="onboard-csv"
              />
              <div className="ws-portfolio-onboard__row">
                <button
                  type="button"
                  className="ws-btn ws-btn--primary"
                  onClick={handleImport}
                  disabled={busy}
                  data-testid="onboard-csv-submit"
                >
                  {phase === "importing" ? "Importing…" : "Import"}
                </button>
                <button
                  type="button"
                  className="ws-btn ws-btn--ghost"
                  onClick={() => {
                    setShowImport(false);
                    setCsvText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="ws-btn ws-btn--secondary"
              onClick={() => setShowImport(true)}
              disabled={busy}
              data-testid="onboard-import"
            >
              Import CSV
            </button>
          )}
        </article>

        {isDemoEnv() ? (
          <article className="ws-portfolio-onboard__card ws-portfolio-onboard__card--demo">
            <h3>Use demo portfolio</h3>
            <p>
              Pre-seeded global basket (US, EU, Asia · tech, energy,
              industrials, autos) for product walkthroughs.
            </p>
            <button
              type="button"
              className="ws-btn ws-btn--ghost"
              onClick={handleSeedDemo}
              disabled={busy}
              data-testid="onboard-demo"
            >
              {phase === "seeding" ? "Seeding…" : "Use demo portfolio"}
            </button>
          </article>
        ) : null}
      </div>

      {error ? (
        <p className="ws-portfolio-onboard__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
