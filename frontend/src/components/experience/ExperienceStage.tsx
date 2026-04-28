"use client";

import { GlobeCanvas } from "@/components/globe/GlobeCanvas";
import { HUDRoot } from "@/components/hud/HUDRoot";
import { useExperienceStore } from "@/store/useExperienceStore";

export function ExperienceStage() {
  const phase = useExperienceStore((state) => state.phase);

  return (
    <main className={`experience-stage experience-stage--${phase}`}>
      <GlobeCanvas />
      <HUDRoot />
    </main>
  );
}
