"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useOverlayStore } from "@/store/useOverlayStore";

interface OverlayPanelProps {
  title: string;
  eyebrow: ReactNode;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function OverlayPanel({ title, eyebrow, subtitle, children, footer }: OverlayPanelProps) {
  const isOpen = useOverlayStore((s) => s.isOpen);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const el = panelRef.current;
    if (el) {
      el.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, closeOverlay]);

  return (
    <aside
      className={`ws-overlay${isOpen ? " ws-overlay--open" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-hidden={!isOpen}
      aria-labelledby="ws-overlay-title"
      data-testid="workspace-overlay"
    >
      <div className="ws-overlay__frame" ref={panelRef} tabIndex={-1}>
        <header className="ws-overlay__head">
          <div className="ws-overlay__head-text">
            <span className="ws-eyebrow">{eyebrow}</span>
            <h2 id="ws-overlay-title" className="ws-overlay__title">
              {title}
            </h2>
            {subtitle ? <p className="ws-overlay__subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="ws-overlay__close"
            aria-label="Close intelligence overlay"
            onClick={closeOverlay}
          >
            <span aria-hidden>×</span>
          </button>
        </header>

        <div className="ws-overlay__scroll">{children}</div>

        {footer ? <footer className="ws-overlay__foot">{footer}</footer> : null}
      </div>
    </aside>
  );
}
