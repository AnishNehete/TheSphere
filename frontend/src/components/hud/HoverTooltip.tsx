"use client";

import { AnimatePresence, motion as motionView } from "framer-motion";
import { useEffect, useState } from "react";

import { SystemIcon } from "@/components/ui/SystemIcon";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useUIStore } from "@/store/useUIStore";
import { motion } from "@/styles/designSystem";

export function HoverTooltip() {
  const tooltip = useUIStore((state) => state.hoverTooltip);
  const userInteracting = useGlobeStore((state) => state.userInteracting);
  const reduceMotion = useAccessibilityStore((state) => state.reduceMotion);
  const [renderedTooltip, setRenderedTooltip] = useState<typeof tooltip>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (userInteracting || !tooltip) {
      setIsVisible(false);
      setRenderedTooltip(null);
      return;
    }

    if (!isVisible) {
      const timer = window.setTimeout(() => {
        setRenderedTooltip(tooltip);
        setIsVisible(true);
      }, reduceMotion ? 0 : motion.tooltipDelayMs);

      return () => {
        window.clearTimeout(timer);
      };
    }

    setRenderedTooltip(tooltip);
  }, [isVisible, reduceMotion, tooltip, userInteracting]);

  const hasWindow = typeof window !== "undefined";
  const resolvedX = renderedTooltip ? Math.min(renderedTooltip.x, hasWindow ? window.innerWidth - 304 : renderedTooltip.x) : 0;
  const resolvedY = renderedTooltip
    ? Math.min(Math.max(20, renderedTooltip.y), hasWindow ? window.innerHeight - 184 : renderedTooltip.y)
    : 0;

  return (
    <AnimatePresence initial={false}>
      {isVisible && renderedTooltip ? (
        <motionView.div
          key="hover-tooltip"
          className="hover-tooltip"
          initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.98 }}
          animate={{
            opacity: 1,
            scale: 1,
            x: resolvedX,
            y: resolvedY,
          }}
          exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.98 }}
          transition={{
            duration: reduceMotion ? 0.1 : motion.durationFast,
            ease: motion.easeStandard,
          }}
        >
          <div className="hover-tooltip__eyebrow">{renderedTooltip.eyebrow}</div>
          <div className="hover-tooltip__header">
            <div className="hover-tooltip__title">{renderedTooltip.title}</div>
            <div className="hover-tooltip__score">
              {renderedTooltip.score === null ? "--" : renderedTooltip.score.toFixed(2)}
            </div>
          </div>
          <div className="hover-tooltip__summary">{renderedTooltip.summary}</div>
          <div className="hover-tooltip__footer">
            <span>{renderedTooltip.iso3}</span>
            <span>{renderedTooltip.signalCount} active</span>
            {renderedTooltip.activeLayer ? (
              <span className="hover-tooltip__layer">
                <SystemIcon name={renderedTooltip.activeLayer} />
              </span>
            ) : null}
          </div>
        </motionView.div>
      ) : null}
    </AnimatePresence>
  );
}
