"use client";

import { AccessibilitySync } from "@/components/experience/AccessibilitySync";
import { BootGate } from "@/components/experience/BootGate";
import { ExperienceStage } from "@/components/experience/ExperienceStage";
import { RenderSettingsSync } from "@/components/experience/RenderSettingsSync";
import { TransitionController } from "@/components/experience/TransitionController";

export function ExperienceRoot() {
  return (
    <>
      <AccessibilitySync />
      <RenderSettingsSync />
      <ExperienceStage />
      <TransitionController />
      <BootGate />
    </>
  );
}
