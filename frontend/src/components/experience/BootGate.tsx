"use client";

import { useEffect, useState } from "react";
import { WebGLRenderer } from "three";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { useFeedPolling } from "@/lib/data/polling/useFeedPolling";
import { loadGlobeTextures } from "@/lib/three/textureManager";
import { useExperienceStore } from "@/store/useExperienceStore";

export function BootGate() {
  const phase = useExperienceStore((state) => state.phase);
  const startIntro = useExperienceStore((state) => state.startIntro);
  const [texturesReady, setTexturesReady] = useState(false);
  const [textureError, setTextureError] = useState<string | null>(null);
  const { ready: feedsReady, error: feedError } = useFeedPolling();

  useEffect(() => {
    let active = true;
    const canvas = document.createElement("canvas");
    const renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });

    void loadGlobeTextures({
      maxAnisotropy: Math.max(4, renderer.capabilities.getMaxAnisotropy()),
    })
      .then(() => {
        if (!active) {
          return;
        }
        setTexturesReady(true);
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setTextureError(error instanceof Error ? error.message : "Failed to load globe textures.");
      })
      .finally(() => {
        renderer.dispose();
      });

    return () => {
      active = false;
      renderer.dispose();
    };
  }, []);

  const ready = texturesReady && feedsReady;

  useEffect(() => {
    if (!ready || phase !== "boot") {
      return;
    }
    startIntro();
  }, [phase, ready, startIntro]);

  if (phase !== "boot") {
    return null;
  }

  return (
    <div className="boot-gate" data-testid="boot-gate">
      <GlassPanel className="boot-gate__panel">
        <div className="boot-gate__eyebrow">The Sphere / System Boot</div>
        <h1 className="boot-gate__title">Initializing disease intelligence globe</h1>
        <p className="boot-gate__body">Loading Earth materials, geospatial layers, and live signal feeds.</p>
        <div className="boot-gate__status">
          <span>{texturesReady ? "Earth assets online" : "Loading Earth assets"}</span>
          <span>{feedsReady ? "Intelligence feeds online" : "Warming live feeds"}</span>
        </div>
        {textureError ? <p className="boot-gate__error">{textureError}</p> : null}
        {!textureError && feedError ? <p className="boot-gate__error">{feedError}</p> : null}
      </GlassPanel>
    </div>
  );
}
