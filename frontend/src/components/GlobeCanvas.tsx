"use client";

import { useEffect, useRef } from "react";

import { SphereEngine } from "@/engine";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

export function GlobeCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const engine = SphereEngine.getInstance();
    engine.mount(container);
    engine.syncState(useAppStore.getState());
    engine.syncData(useDataStore.getState());

    const resize = () => {
      const rect = container.getBoundingClientRect();
      engine.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);

    const unsubscribeApp = useAppStore.subscribe((state) => {
      engine.syncState(state);
    });
    const unsubscribeData = useDataStore.subscribe((state) => {
      engine.syncData(state);
    });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      unsubscribeApp();
      unsubscribeData();
    };
  }, []);

  return <div ref={containerRef} className="globe-canvas-shell" data-testid="globe-canvas" />;
}
