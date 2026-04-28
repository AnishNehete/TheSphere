import { Clock } from "three";

import { CameraDirector } from "@/engine/camera";
import { GlobeControls } from "@/engine/controls";
import { buildTooltipForHit, GlobeSystem, pickVisibleHotspotForLatLon } from "@/engine/globe";
import { RendererLayer } from "@/engine/renderer";
import { SceneGraph } from "@/engine/scene";
import { loadGlobeTextures } from "@/lib/three/textureManager";
import { useAppStore, type AppState } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";
import { useOverlayStore } from "@/store/useOverlayStore";

declare global {
  interface Window {
    __THE_SPHERE_ENGINE__?: SphereEngine;
  }
}

export class SphereEngine {
  private readonly rendererLayer: RendererLayer;

  private readonly controls: GlobeControls;

  private readonly cameraDirector: CameraDirector;

  private readonly sceneGraph: SceneGraph;

  private readonly clock = new Clock();

  private stateSnapshot: AppState = useAppStore.getState();

  private dataSnapshot = useDataStore.getState();

  private container: HTMLElement | null = null;

  private animationFrame = 0;

  private assetsPromise: Promise<void> | null = null;

  private pointerBound = false;

  constructor() {
    this.controls = new GlobeControls({
      onInteractionStart: () => {
        const store = useAppStore.getState();
        store.setUserInteracting(true);
        store.setAutoRotate(false);
        store.setHoverTooltip(null);
      },
      onInteractionEnd: () => {
        useAppStore.getState().setUserInteracting(false);
      },
      onAutoRotateResumeRequest: () => {
        const state = useAppStore.getState();
        if (
          state.reduceMotion ||
          state.interactionMode !== "explore" ||
          state.selectedCountry ||
          state.selectedRegionSlug ||
          state.selectedSignalId
        ) {
          return;
        }

        useAppStore.getState().setAutoRotate(true);
      },
    });
    this.cameraDirector = new CameraDirector(this.controls);
    this.sceneGraph = new SceneGraph();
    this.rendererLayer = new RendererLayer();
    this.rendererLayer.setSceneCamera(this.sceneGraph.scene, this.cameraDirector.camera);
  }

  static getInstance() {
    if (typeof window === "undefined") {
      return new SphereEngine();
    }

    if (!window.__THE_SPHERE_ENGINE__) {
      window.__THE_SPHERE_ENGINE__ = new SphereEngine();
    }

    return window.__THE_SPHERE_ENGINE__;
  }

  mount(container: HTMLElement) {
    this.container = container;
    this.rendererLayer.attach(container);
    this.controls.connect(this.rendererLayer.domElement);
    if (!this.pointerBound) {
      this.bindPointerEvents();
      this.pointerBound = true;
    }
    this.ensureAssets();
    if (!this.animationFrame) {
      this.clock.start();
      this.loop();
    }
  }

  syncState(state: AppState) {
    this.stateSnapshot = state;
    this.rendererLayer.applySettings(state.qualityPreset, state.diagnosticsEnabled, state.diagnosticsView);
    this.sceneGraph.syncState(state);
  }

  syncData(dataState: typeof this.dataSnapshot) {
    this.dataSnapshot = dataState;
    this.sceneGraph.syncData(dataState, this.stateSnapshot);
  }

  resize(width: number, height: number, dpr: number) {
    this.cameraDirector.resize(width, height);
    this.rendererLayer.resize(width, height, dpr, this.stateSnapshot.qualityPreset);
    this.sceneGraph.setViewportHeight(height);
  }

  private ensureAssets() {
    if (this.assetsPromise) {
      return this.assetsPromise;
    }

    this.assetsPromise = (async () => {
      try {
        const textures = await loadGlobeTextures({
          maxAnisotropy: this.rendererLayer.maxAnisotropy,
          renderer: this.rendererLayer.renderer,
        });
        this.sceneGraph.globe.setTextures(textures);
        this.sceneGraph.setStarfieldTexture(textures.stars);
        useAppStore.getState().setEngineError(null);
        useAppStore.getState().setEngineReady(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load Earth assets.";
        useAppStore.getState().setEngineError(message);
      }
    })();

    return this.assetsPromise;
  }

  private loop = () => {
    const deltaSeconds = this.clock.getDelta();
    const elapsedSeconds = this.clock.elapsedTime;

    this.cameraDirector.update(deltaSeconds, elapsedSeconds, this.stateSnapshot, this.dataSnapshot);
    this.sceneGraph.update(deltaSeconds, elapsedSeconds, this.stateSnapshot, this.cameraDirector.camera.position);
    this.rendererLayer.render(!(this.stateSnapshot.diagnosticsEnabled && this.stateSnapshot.diagnosticsView !== "full"));
    this.animationFrame = window.requestAnimationFrame(this.loop);
  };

  private bindPointerEvents() {
    const domElement = this.rendererLayer.domElement;

    domElement.addEventListener("pointermove", (event) => {
      const state = useAppStore.getState();
      if (!state.engineReady || state.interactionMode === "intro" || this.controls.interacting) {
        state.setHoveredCountry(null);
        state.setHoverTooltip(null);
        return;
      }

      const hit = this.sceneGraph.globe.pickCountry(event.clientX, event.clientY, this.cameraDirector.camera, domElement);
      if (!hit) {
        state.setHoveredCountry(null);
        state.setHoverTooltip(null);
        return;
      }

      const tooltip = buildTooltipForHit(hit, this.dataSnapshot);
      state.setHoveredCountry(hit.country.iso3);
      state.setHoverTooltip(
        tooltip
          ? {
              ...tooltip.payload,
              x: event.clientX + 18,
              y: event.clientY - 18,
            }
          : null
      );
    });

    domElement.addEventListener("pointerleave", () => {
      const state = useAppStore.getState();
      state.setHoveredCountry(null);
      state.setHoverTooltip(null);
    });

    domElement.addEventListener("click", (event) => {
      const state = useAppStore.getState();
      if (
        !state.engineReady ||
        state.interactionMode === "intro" ||
        this.controls.interacting ||
        this.controls.shouldSuppressClick()
      ) {
        return;
      }

      // Place labels take precedence — clicking a city / port / chokepoint
      // routes the exact name through the agent so the backend PlaceResolver
      // does the canonical resolution. Falls back to country pick when the
      // user clicks empty space.
      const placeHit = this.sceneGraph.globe.pickPlaceLabel(
        event.clientX,
        event.clientY,
        this.cameraDirector.camera,
        domElement,
      );
      if (placeHit) {
        useOverlayStore
          .getState()
          .openQuery(`What is happening in ${placeHit.name}?`, undefined, "search");
        return;
      }

      const hit = this.sceneGraph.globe.pickCountry(event.clientX, event.clientY, this.cameraDirector.camera, domElement);
      if (!hit) {
        return;
      }

      const hotspot = pickVisibleHotspotForLatLon(hit.latLon, state.activeLayer, this.dataSnapshot);
      if (hotspot) {
        state.setActiveLayer(hotspot.layer);
        state.focusSignal(hotspot.id, hotspot.iso3Hint ?? null);
        state.clearQueryBrief();
        return;
      }

      state.focusCountry(hit.country.iso3);
      state.clearQueryBrief();
    });
  }
}
