"use client";

import { motion } from "framer-motion";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useExperienceStore } from "@/store/useExperienceStore";
import { motion as motionTokens } from "@/styles/designSystem";

export function IntroOverlay() {
  const phase = useExperienceStore((state) => state.phase);
  const introProgress = useExperienceStore((state) => state.introProgress);
  const completeIntro = useExperienceStore((state) => state.completeIntro);
  const setIntroProgress = useExperienceStore((state) => state.setIntroProgress);
  const reduceMotion = useAccessibilityStore((state) => state.reduceMotion);

  const skip = () => {
    if (phase !== "intro") {
      return;
    }
    setIntroProgress(1);
    completeIntro();
  };

  return (
    <motion.div
      className="intro-overlay"
      data-testid="intro-overlay"
      initial={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reduceMotion ? motionTokens.durationFast : motionTokens.durationBase,
        ease: motionTokens.easeStandard,
      }}
    >
      <GlassPanel className="intro-overlay__panel">
        <div className="intro-overlay__eyebrow">Orbital Disease Intelligence</div>
        <h1 className="intro-overlay__title">THE SPHERE</h1>
        <p className="intro-overlay__body">
          Geospatially locked outbreak, flight, weather, and conflict signals on a single cinematic globe.
        </p>
        <div className="intro-overlay__progress">
          <motion.div
            className="intro-overlay__progress-fill"
            animate={{ scaleX: Math.max(0.02, introProgress) }}
            transition={{
              duration: reduceMotion ? 0.1 : motionTokens.durationFast,
              ease: motionTokens.easeStandard,
            }}
            style={{ transformOrigin: "left center" }}
          />
        </div>
        <div className="intro-overlay__meta">
          <span>{`${Math.round(introProgress * 100)}%${reduceMotion ? " / reduced motion" : ""}`}</span>
          <button type="button" onClick={skip}>
            Open Live View
          </button>
        </div>
      </GlassPanel>
    </motion.div>
  );
}
