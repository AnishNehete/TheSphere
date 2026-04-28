"use client";

import { motion } from "framer-motion";

interface HeroSectionProps {
  onLaunch: () => void;
}

const FLOATING_POINTS = [
  { label: "Red Sea", value: "Critical", x: "12%", y: "28%", delay: 0.8 },
  { label: "Strait of Hormuz", value: "Watch", x: "78%", y: "22%", delay: 1.1 },
  { label: "South China Sea", value: "Elevated", x: "85%", y: "58%", delay: 1.4 },
  { label: "Baltic Region", value: "Monitoring", x: "8%", y: "68%", delay: 1.0 },
  { label: "Panama Canal", value: "Stable", x: "22%", y: "52%", delay: 1.3 },
] as const;

const STATUS_COLORS: Record<string, string> = {
  Critical: "var(--ds-danger)",
  Watch: "var(--ds-warning)",
  Elevated: "var(--ds-warning)",
  Monitoring: "var(--ds-accent)",
  Stable: "var(--ds-success)",
};

export function HeroSection({ onLaunch }: HeroSectionProps) {
  return (
    <section className="hero" data-phase="hero">
      {FLOATING_POINTS.map((point) => (
        <motion.div
          key={point.label}
          className="hero__float-point"
          style={{ left: point.x, top: point.y }}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, delay: point.delay, ease: [0.22, 1, 0.36, 1] }}
        >
          <span
            className="hero__float-dot"
            style={{ background: STATUS_COLORS[point.value] }}
          />
          <span className="hero__float-label">{point.label}</span>
          <span
            className="hero__float-value"
            style={{ color: STATUS_COLORS[point.value] }}
          >
            {point.value}
          </span>
        </motion.div>
      ))}

      <div className="hero__content">
        <motion.div
          className="hero__eyebrow"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="hero__eyebrow-line" />
          <span>Operational Risk Intelligence</span>
          <span className="hero__eyebrow-line" />
        </motion.div>

        <motion.h1
          className="hero__title"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          Investigate What&rsquo;s
          <br />
          <em>Happening</em>
        </motion.h1>

        <motion.p
          className="hero__subtitle"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.75, ease: [0.22, 1, 0.36, 1] }}
        >
          Trace disruptions, map dependencies, and export analyst
          <br />
          briefings with grounded evidence and confidence scoring.
        </motion.p>

        <motion.div
          className="hero__actions"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.95, ease: [0.22, 1, 0.36, 1] }}
        >
          <button type="button" className="hero__cta hero__cta--primary" onClick={onLaunch}>
            Start Investigation
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <a href="#features" className="hero__cta hero__cta--secondary">
            Explore Platform
          </a>
        </motion.div>
      </div>

      <motion.div
        className="hero__scroll-hint"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.6 }}
      >
        <span className="hero__scroll-label">01 / 03 &middot; Scroll down</span>
        <div className="hero__scroll-track">
          <motion.div
            className="hero__scroll-thumb"
            animate={{ y: [0, 12, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
      </motion.div>
    </section>
  );
}
