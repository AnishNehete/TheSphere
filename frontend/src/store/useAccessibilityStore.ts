import { create } from "zustand";

interface AccessibilityState {
  reduceMotion: boolean;
  setReduceMotion: (reduceMotion: boolean) => void;
}

export const REDUCE_MOTION_STORAGE_KEY = "the-sphere.reduce-motion";

export const useAccessibilityStore = create<AccessibilityState>((set) => ({
  reduceMotion: false,

  setReduceMotion: (reduceMotion) =>
    set(() => ({
      reduceMotion,
    })),
}));
