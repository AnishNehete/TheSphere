"use client";

import { AnimatePresence, motion } from "framer-motion";

import { useExperienceStore } from "@/store/useExperienceStore";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useUIStore } from "@/store/useUIStore";
import { motion as motionTokens } from "@/styles/designSystem";

import { BottomTimeline } from "./BottomTimeline";
import { HoverTooltip } from "./HoverTooltip";
import { IntelligenceSearchBar } from "./IntelligenceSearchBar";
import { IntroOverlay } from "./IntroOverlay";
import { LeftRail } from "./LeftRail";
import { RightInsightPanel } from "./RightInsightPanel";
import { TopBar } from "./TopBar";

export function HUDRoot() {
  const phase = useExperienceStore((state) => state.phase);
  const showHud = useUIStore((state) => state.showHud);
  const showIntroOverlay = useUIStore((state) => state.showIntroOverlay);
  const reduceMotion = useAccessibilityStore((state) => state.reduceMotion);

  return (
    <>
      <AnimatePresence initial={false}>
        {showHud ? (
          <motion.div
            key="hud"
            className={`hud-root hud-root--${phase}`}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            transition={{
              duration: reduceMotion ? motionTokens.durationFast : motionTokens.durationBase,
              ease: motionTokens.easeStandard,
            }}
          >
            <TopBar />
            <LeftRail />
            <RightInsightPanel />
            <IntelligenceSearchBar />
            <BottomTimeline />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {showIntroOverlay ? <IntroOverlay key="intro-overlay" /> : null}
      </AnimatePresence>
      <HoverTooltip />
    </>
  );
}
