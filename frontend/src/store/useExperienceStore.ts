import { create } from "zustand";

import type { ExperiencePhase } from "@/lib/types";

interface ExperienceState {
  phase: ExperiencePhase;
  introProgress: number;
  isTransitionLocked: boolean;
  setIntroProgress: (value: number) => void;
  setTransitionLocked: (locked: boolean) => void;
  setPhase: (phase: ExperiencePhase) => void;
  startIntro: () => void;
  completeIntro: () => void;
  enterLive: () => void;
}

export const useExperienceStore = create<ExperienceState>((set) => ({
  phase: "boot",
  introProgress: 0,
  isTransitionLocked: true,

  setIntroProgress: (introProgress) =>
    set(() => ({
      introProgress: Math.max(0, Math.min(1, introProgress)),
    })),

  setTransitionLocked: (isTransitionLocked) =>
    set(() => ({
      isTransitionLocked,
    })),

  setPhase: (phase) =>
    set(() => ({
      phase,
    })),

  startIntro: () =>
    set(() => ({
      phase: "intro",
      introProgress: 0,
      isTransitionLocked: true,
    })),

  completeIntro: () =>
    set(() => ({
      phase: "handoff",
      introProgress: 1,
      isTransitionLocked: true,
    })),

  enterLive: () =>
    set(() => ({
      phase: "live",
      introProgress: 1,
      isTransitionLocked: false,
    })),
}));
