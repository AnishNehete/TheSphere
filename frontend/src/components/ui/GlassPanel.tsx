"use client";

import clsx from "clsx";
import { createElement, type CSSProperties, type HTMLAttributes } from "react";

import { colors, radius } from "@/styles/designSystem";

type GlassPanelTag = "div" | "header" | "aside" | "section" | "article";

interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: GlassPanelTag;
}

const BASE_STYLE: CSSProperties = {
  background:
    "linear-gradient(180deg, rgba(13, 18, 25, 0.72) 0%, rgba(6, 10, 15, 0.5) 100%), rgba(6, 10, 15, 0.42)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  border: `1px solid ${colors.borderSubtle}`,
  borderRadius: radius.md,
  boxShadow: "0 22px 70px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
};

export function GlassPanel({ as = "div", className, style, ...props }: GlassPanelProps) {
  return createElement(as, {
    ...props,
    className: clsx("glass-panel", className),
    style: {
      ...BASE_STYLE,
      ...style,
    },
  });
}
