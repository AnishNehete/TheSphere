"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getMarketNarrative,
  getMarketPosture,
} from "@/lib/intelligence/client";
import {
  buildShareUrl,
  captureWith,
  deleteSavedInvestigation,
  describeAge,
  issueShareToken,
  listSavedInvestigations,
  revokeShareToken,
  saveInvestigation,
  getSavedInvestigation,
  restoreSnapshotIntoStores,
  type SavedInvestigationListItemWire,
} from "@/lib/intelligence/investigations";
import { useOverlayStore } from "@/store/useOverlayStore";

// Phase 17B.2 — top-shell saved-investigations dropdown.
//
// Three states the user can drive from here:
//   * Save current — composes a snapshot from the canonical stores and
//     posts it. The right panel's posture/narrative are not pulled in
//     here on purpose; the menu lives in the top shell and does not
//     own those fetches. A future enrichment hook (the right panel
//     calling captureWith with its known posture) is the natural way to
//     ship full snapshots — for 17B we ship lean snapshots that still
//     restore the canonical state cleanly.
//   * Open — restores the snapshot into canonical stores (no live re-fetch).
//   * Share — issues an unguessable share token and copies the /share URL.
//
// All three remain inside this single component so 17B does not sprout
// extra global menus.
export function SavedInvestigationsMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedInvestigationListItemWire[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [shareState, setShareState] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listSavedInvestigations();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setShareState(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const handleSave = useCallback(async () => {
    setSavingState("saving");
    setError(null);
    try {
      // Enrich at save time: when the workspace currently focuses a
      // market symbol, fetch the live posture + narrative so the
      // snapshot freezes a rich envelope. The fetch is at SAVE time
      // (intentional, freshest possible) — the no-silent-refetch rule
      // applies to RESTORE, not capture. If either fetch fails the
      // save still succeeds with a lean snapshot.
      const overlay = useOverlayStore.getState();
      const symbol = overlay.selectedMarketSymbol;
      const assetClass = overlay.selectedMarketAssetClass ?? undefined;
      let marketPosture = null;
      let marketNarrative = null;
      if (symbol) {
        const [postureResult, narrativeResult] = await Promise.allSettled([
          getMarketPosture(symbol, { asset_class: assetClass }),
          getMarketNarrative(symbol, { asset_class: assetClass }),
        ]);
        if (postureResult.status === "fulfilled") {
          marketPosture = postureResult.value;
        }
        if (narrativeResult.status === "fulfilled") {
          marketNarrative = narrativeResult.value.narrative;
        }
      }

      const snapshot = captureWith({ marketPosture, marketNarrative });
      const defaultName =
        snapshot.selection.market_symbol ??
        snapshot.selection.country_name ??
        snapshot.selection.event_summary ??
        "Investigation";
      const stamp = new Date().toLocaleString();
      await saveInvestigation({
        name: `${defaultName} — ${stamp}`,
        snapshot,
      });
      setSavingState("saved");
      await load();
      // Reset the "Saved" affordance shortly so the button reverts.
      window.setTimeout(() => setSavingState("idle"), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSavingState("idle");
    }
  }, [load]);

  const handleOpen = useCallback(async (id: string) => {
    setError(null);
    try {
      const record = await getSavedInvestigation(id);
      restoreSnapshotIntoStores(record.snapshot);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open");
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteSavedInvestigation(id);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete");
      }
    },
    [load],
  );

  const handleShare = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const updated = await issueShareToken(id);
        if (!updated.share_token) return;
        const url = buildShareUrl(updated.share_token);
        setShareState({ id, url });
        if (navigator?.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(url);
          } catch {
            // Non-fatal — the URL is still surfaced inline so the
            // analyst can copy it manually.
          }
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to share");
      }
    },
    [load],
  );

  const handleRevoke = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await revokeShareToken(id);
        setShareState((prev) => (prev?.id === id ? null : prev));
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke");
      }
    },
    [load],
  );

  const list = useMemo(() => items ?? [], [items]);

  const saveLabel =
    savingState === "saving"
      ? "Saving…"
      : savingState === "saved"
        ? "Saved"
        : "Save current";

  return (
    <div className="ws-saved" ref={popoverRef}>
      <button
        type="button"
        className="ws-saved__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="saved-investigations-trigger"
      >
        <span className="ws-saved__icon" aria-hidden>
          ❑
        </span>
        <span className="ws-saved__label">Saved</span>
        <span className="ws-saved__chev" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="ws-saved__popover" role="menu">
          <div className="ws-saved__header">
            <button
              type="button"
              className="ws-saved__action"
              onClick={handleSave}
              disabled={savingState === "saving"}
              data-testid="saved-investigations-save"
            >
              {saveLabel}
            </button>
          </div>
          {error ? (
            <div className="ws-saved__state ws-saved__state--err">{error}</div>
          ) : null}
          {loading ? (
            <div className="ws-saved__state">Loading…</div>
          ) : list.length === 0 ? (
            <div className="ws-saved__state">No saved investigations yet</div>
          ) : (
            <ul className="ws-saved__list">
              {list.map((item) => {
                const age = describeAge(item.captured_at);
                const sharing = shareState?.id === item.id;
                return (
                  <li key={item.id} className="ws-saved__item">
                    <div className="ws-saved__item-row">
                      <button
                        type="button"
                        className="ws-saved__item-open"
                        onClick={() => handleOpen(item.id)}
                      >
                        <span className="ws-saved__item-name">{item.name}</span>
                        <span className="ws-saved__item-meta">
                          {item.workspace_mode} · {item.primary_label} ·{" "}
                          {age.text}
                        </span>
                      </button>
                      <div className="ws-saved__item-actions">
                        {item.has_share || sharing ? (
                          <button
                            type="button"
                            className="ws-saved__icon-btn"
                            onClick={() => handleRevoke(item.id)}
                            title="Revoke share link"
                          >
                            ⊘
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ws-saved__icon-btn"
                            onClick={() => handleShare(item.id)}
                            title="Create share link"
                          >
                            ↗
                          </button>
                        )}
                        <button
                          type="button"
                          className="ws-saved__icon-btn"
                          onClick={() => handleDelete(item.id)}
                          title="Delete saved investigation"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    {sharing ? (
                      <div className="ws-saved__share-row">
                        <code className="ws-saved__share-url">
                          {shareState?.url}
                        </code>
                        <span className="ws-saved__share-hint">
                          read-only · copy this link to share
                        </span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
