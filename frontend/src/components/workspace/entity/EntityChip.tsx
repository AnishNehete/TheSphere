"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// Phase 14 — graph-ready entity chip primitive.
// These primitives are the shared visual grammar for anything that will
// become a graph node later: entities, geography, assets, exposure nodes,
// dependency rows. They share the same base chip styling so a future graph
// phase can swap them into SVG/Canvas nodes with zero visual drift.

export type EntityChipKind =
  | "entity"
  | "geography"
  | "asset"
  | "exposure"
  | "theme";

export type EntityChipTone = "default" | "accent" | "warn" | "muted";

interface EntityChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: EntityChipKind;
  tone?: EntityChipTone;
  icon?: ReactNode;
  label: string;
  meta?: string;
}

export const EntityChip = forwardRef<HTMLButtonElement, EntityChipProps>(
  function EntityChip(
    { kind = "entity", tone = "default", icon, label, meta, className, ...rest },
    ref,
  ) {
    const base = `ws-entity-chip ws-entity-chip--${kind} ws-entity-chip--${tone}`;
    return (
      <button
        ref={ref}
        type="button"
        className={className ? `${base} ${className}` : base}
        data-kind={kind}
        data-tone={tone}
        {...rest}
      >
        {icon ? <span className="ws-entity-chip__icon" aria-hidden>{icon}</span> : null}
        <span className="ws-entity-chip__label">{label}</span>
        {meta ? <span className="ws-entity-chip__meta">{meta}</span> : null}
      </button>
    );
  },
);
