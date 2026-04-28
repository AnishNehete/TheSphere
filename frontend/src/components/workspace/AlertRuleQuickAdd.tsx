"use client";

import { useCallback, useState } from "react";

import {
  createAlertRule,
  type AlertRuleKind,
} from "@/lib/intelligence/alerts";
import type { PostureAssetClass } from "@/lib/intelligence/types";

// Phase 17C.3 — inline quick-add for alert rules.
//
// Mounts beside the MarketPostureCard. Two buttons cover the entire
// MVP rule surface: "Alert on band change" and "Alert on confidence
// drop". The bound symbol comes from the parent posture card so the
// rule is always anchored to the symbol the operator is currently
// looking at — no symbol picker, no free-form fields, no risk of
// drift from the canonical selection.
//
// Honest-data: the "Saved" affordance only flips after the backend
// 201 response lands. Failures surface inline; the saved-investigation
// menu and bell are unaffected.

interface AlertRuleQuickAddProps {
  symbol: string;
  assetClass: PostureAssetClass;
  testId?: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

interface PendingState {
  kind: AlertRuleKind;
  state: SaveState;
  message: string | null;
}

const INITIAL: PendingState = { kind: "posture_band_change", state: "idle", message: null };

export function AlertRuleQuickAdd({
  symbol,
  assetClass,
  testId = "alert-quick-add",
}: AlertRuleQuickAddProps) {
  const [pending, setPending] = useState<PendingState>(INITIAL);

  const submit = useCallback(
    async (kind: AlertRuleKind) => {
      setPending({ kind, state: "saving", message: null });
      try {
        const name =
          kind === "posture_band_change"
            ? `${symbol} posture changes`
            : `${symbol} confidence drop`;
        await createAlertRule({
          name,
          kind,
          symbol,
          asset_class: assetClass,
        });
        setPending({ kind, state: "saved", message: null });
        window.setTimeout(() => setPending(INITIAL), 2000);
      } catch (err) {
        setPending({
          kind,
          state: "error",
          message: err instanceof Error ? err.message : "Save failed",
        });
      }
    },
    [symbol, assetClass],
  );

  const labelFor = (kind: AlertRuleKind, base: string) => {
    if (pending.kind !== kind) return base;
    if (pending.state === "saving") return "Saving…";
    if (pending.state === "saved") return "Watching";
    return base;
  };

  return (
    <div
      className="ws-alert-quickadd"
      data-testid={testId}
      data-symbol={symbol}
    >
      <span className="ws-alert-quickadd__label">Alert me when:</span>
      <button
        type="button"
        className="ws-alert-quickadd__btn"
        onClick={() => submit("posture_band_change")}
        disabled={pending.state === "saving"}
        data-state={
          pending.kind === "posture_band_change" ? pending.state : "idle"
        }
        data-testid={`${testId}-band`}
      >
        {labelFor("posture_band_change", "posture changes")}
      </button>
      <button
        type="button"
        className="ws-alert-quickadd__btn"
        onClick={() => submit("confidence_drop")}
        disabled={pending.state === "saving"}
        data-state={
          pending.kind === "confidence_drop" ? pending.state : "idle"
        }
        data-testid={`${testId}-confidence`}
      >
        {labelFor("confidence_drop", "confidence drops")}
      </button>
      {pending.state === "error" && pending.message ? (
        <span
          className="ws-alert-quickadd__err"
          role="status"
          data-testid={`${testId}-error`}
        >
          {pending.message}
        </span>
      ) : null}
    </div>
  );
}
