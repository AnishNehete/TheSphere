import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  Quaternion,
  Raycaster,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";

import { createAtmosphereMaterial } from "@/engine/atmosphere";
import { createCloudMaterial, createEarthMaterial, createHeatmapMaterial, createLabelTexture } from "@/engine/globeMaterials";
import { PlaceLabelLayer } from "@/engine/placeLabels";
import { buildAnalystSummary, buildSignalRows, filterRowsByFocus, type SignalRow } from "@/components/hud/signalRows";
import type { PlaceLabel } from "@/lib/three/placeGazetteer";
import { createArcCurve } from "@/lib/three/curveFactory";
import { latLonToVector3, vector3ToLatLon } from "@/lib/three/coordinate";
import {
  buildBorderLineGeometry,
  buildCountryBorderGeometry,
  buildCountryFillGeometry,
  buildRegionBorderGeometry,
  buildRegionFillGeometry,
  findCountryAtLatLon,
} from "@/lib/three/geo";
import {
  CLOUD_LAYER_DEFINITIONS,
  COUNTRY_BORDER_RADIUS,
  COUNTRY_FILL_RADIUS,
  GLOBE_RADIUS,
  REGION_FILL_RADIUS,
  REGION_LINE_RADIUS,
  SCENE_RENDER_ORDER,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";
import type { GlobeTextureSet } from "@/lib/three/textureManager";
import type { AppState, HoverTooltipPayload } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

function disposeMaterialHost(object: Mesh | LineSegments | Points) {
  const material = object.material;
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }

  material.dispose();
}

function buildLabelEntries(state: AppState, dataState: ReturnType<typeof useDataStore.getState>) {
  if (state.activeLayer === "flights") {
    return dataState.flights.slice(0, 6).map((signal) => ({
      id: signal.id,
      text: signal.callsign,
      lat: signal.position.lat,
      lon: signal.position.lon,
      severity: signal.severity,
    }));
  }

  if (state.activeLayer === "weather") {
    return dataState.weather.slice(0, 6).map((signal) => ({
      id: signal.id,
      text: signal.label,
      lat: signal.center.lat,
      lon: signal.center.lon,
      severity: signal.severity,
    }));
  }

  if (state.activeLayer === "conflict") {
    return dataState.conflicts.slice(0, 5).map((signal) => ({
      id: signal.id,
      text: signal.label,
      lat: signal.center.lat,
      lon: signal.center.lon,
      severity: signal.severity,
    }));
  }

  return dataState.health.slice(0, 5).map((signal) => ({
    id: signal.id,
    text: signal.label,
    lat: signal.center.lat,
    lon: signal.center.lon,
    severity: signal.severity,
  }));
}

function normalizeOffset(offset: number) {
  return ((offset % 1) + 1) % 1;
}

export class GlobeSystem {
  readonly group = new Group();

  private readonly raycaster = new Raycaster();

  private readonly pointer = new Vector2();

  private readonly earthGeometry = new SphereGeometry(GLOBE_RADIUS, 192, 192);

  private readonly cloudGeometries = CLOUD_LAYER_DEFINITIONS.map(
    (layer) => new SphereGeometry(layer.radius, 160, 160)
  );

  private readonly atmosphereGeometry = new SphereGeometry(GLOBE_RADIUS * 1.05, 192, 192);

  private readonly earthMesh: Mesh<SphereGeometry, MeshBasicMaterial | ShaderMaterial> = new Mesh(
    this.earthGeometry,
    new MeshBasicMaterial({
      color: new Color("#061423"),
    })
  );

  private readonly cloudMeshes: Mesh<SphereGeometry, MeshBasicMaterial | ShaderMaterial>[] = this.cloudGeometries.map(
    (geometry) =>
      new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: new Color("#d8e4ee"),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      )
  );

  private readonly atmosphereMesh = new Mesh(this.atmosphereGeometry, createAtmosphereMaterial(SUN_DIRECTION));

  private readonly countryBorders = new LineSegments(
    buildBorderLineGeometry(COUNTRY_BORDER_RADIUS),
    new LineBasicMaterial({
      color: new Color("#9cb2c0"),
      transparent: true,
      opacity: 0.2,
      depthTest: true,
      depthWrite: false,
    })
  );

  private readonly hoveredFillMaterial = new MeshBasicMaterial({
    color: new Color("#5f90a7"),
    transparent: true,
    opacity: 0.06,
    depthTest: true,
    depthWrite: false,
  });

  private readonly selectedFillMaterial = new MeshBasicMaterial({
    color: new Color("#89c5dc"),
    transparent: true,
    opacity: 0.1,
    depthTest: true,
    depthWrite: false,
  });

  private readonly hoveredLineMaterial = new LineBasicMaterial({
    color: new Color("#acd2e0"),
    transparent: true,
    opacity: 0.4,
    depthTest: true,
    depthWrite: false,
  });

  private readonly selectedLineMaterial = new LineBasicMaterial({
    color: new Color("#def2fa"),
    transparent: true,
    opacity: 0.68,
    depthTest: true,
    depthWrite: false,
  });

  private readonly regionFillMaterial = new MeshBasicMaterial({
    color: new Color("#506673"),
    transparent: true,
    opacity: 0.06,
    depthTest: true,
    depthWrite: false,
  });

  private readonly regionLineMaterial = new LineBasicMaterial({
    color: new Color("#afbec7"),
    transparent: true,
    opacity: 0.26,
    depthTest: true,
    depthWrite: false,
  });

  private readonly flightArcMaterial = new LineBasicMaterial({
    color: new Color("#87a7b7"),
    transparent: true,
    opacity: 0.14,
    blending: AdditiveBlending,
    depthTest: true,
    depthWrite: false,
  });

  private readonly flightArcs = new LineSegments(new BufferGeometry(), this.flightArcMaterial);

  private readonly heatmapMaterial = createHeatmapMaterial(1080);

  private readonly heatmapPoints = new Points(new BufferGeometry(), this.heatmapMaterial);

  private readonly markerGeometry = new ConeGeometry(1, 2.2, 5);

  private readonly markerMaterial = new MeshStandardMaterial({
    color: new Color("#f28b6d"),
    emissive: new Color("#5a2018"),
    emissiveIntensity: 0.18,
    roughness: 0.54,
    metalness: 0.04,
  });

  private readonly markers = new InstancedMesh(this.markerGeometry, this.markerMaterial, 90);

  private readonly markerDummy = new Object3D();

  private readonly markerOrientation = new Quaternion();

  private readonly healthPulseGeometry = new TorusGeometry(1, 0.16, 12, 32);

  private readonly conflictPulseGeometry = new TorusGeometry(1, 0.08, 8, 24);

  private readonly healthPulseMaterial = new MeshBasicMaterial({
    color: new Color("#8ec8ba"),
    transparent: true,
    opacity: 0.09,
    depthTest: true,
    depthWrite: false,
  });

  private readonly conflictPulseMaterial = new MeshBasicMaterial({
    color: new Color("#f0a185"),
    transparent: true,
    opacity: 0.11,
    depthTest: true,
    depthWrite: false,
  });

  private readonly healthPulses = new InstancedMesh(this.healthPulseGeometry, this.healthPulseMaterial, 48);

  private readonly conflictPulses = new InstancedMesh(this.conflictPulseGeometry, this.conflictPulseMaterial, 36);

  private readonly pulseDummy = new Object3D();

  private readonly labelsGroup = new Group();

  private readonly placeLabelLayer = new PlaceLabelLayer();

  private dataState: ReturnType<typeof useDataStore.getState> | null = null;

  private hoveredFillMesh: Mesh | null = null;

  private selectedFillMesh: Mesh | null = null;

  private hoveredLineMesh: LineSegments | null = null;

  private selectedLineMesh: LineSegments | null = null;

  private regionFillMesh: Mesh | null = null;

  private regionLineMesh: LineSegments | null = null;

  private currentHighlightKey = "";

  private currentRegionKey = "";

  private currentOverlayKey = "";

  constructor() {
    this.group.name = "globe-root";
    this.earthMesh.renderOrder = SCENE_RENDER_ORDER.earth;
    this.atmosphereMesh.renderOrder = SCENE_RENDER_ORDER.atmosphere;
    this.countryBorders.renderOrder = SCENE_RENDER_ORDER.countryBorders;
    this.flightArcs.renderOrder = SCENE_RENDER_ORDER.flightArcs;
    this.heatmapPoints.renderOrder = SCENE_RENDER_ORDER.heatmap;
    this.markers.renderOrder = SCENE_RENDER_ORDER.markers;
    this.healthPulses.renderOrder = SCENE_RENDER_ORDER.pulsesHealth;
    this.conflictPulses.renderOrder = SCENE_RENDER_ORDER.pulsesConflict;
    this.labelsGroup.renderOrder = SCENE_RENDER_ORDER.labels;
    this.markers.frustumCulled = false;
    this.healthPulses.frustumCulled = false;
    this.conflictPulses.frustumCulled = false;
    this.heatmapPoints.frustumCulled = false;
    this.cloudMeshes.forEach((mesh, index) => {
      mesh.renderOrder = CLOUD_LAYER_DEFINITIONS[index]?.renderOrder ?? SCENE_RENDER_ORDER.clouds;
    });

    this.group.add(this.earthMesh);
    this.group.add(this.atmosphereMesh);
    this.cloudMeshes.forEach((mesh) => {
      this.group.add(mesh);
    });
    this.group.add(this.countryBorders);
    this.group.add(this.flightArcs);
    this.group.add(this.heatmapPoints);
    this.group.add(this.markers);
    this.group.add(this.healthPulses);
    this.group.add(this.conflictPulses);
    this.group.add(this.labelsGroup);
    this.group.add(this.placeLabelLayer.group);
  }

  setViewportHeight(height: number) {
    this.heatmapMaterial.uniforms.uViewportHeight.value = height;
  }

  setTextures(textures: GlobeTextureSet) {
    disposeMaterialHost(this.earthMesh);
    this.earthMesh.material = createEarthMaterial(textures);
    this.cloudMeshes.forEach((mesh, index) => {
      const layer = CLOUD_LAYER_DEFINITIONS[index] ?? CLOUD_LAYER_DEFINITIONS[0];
      disposeMaterialHost(mesh);
      mesh.material = createCloudMaterial(textures.clouds, layer);
    });
  }

  syncData(dataState: ReturnType<typeof useDataStore.getState>, state: AppState) {
    this.dataState = dataState;
    this.rebuildOverlays(state);
    this.rebuildRegionFocus(state);
  }

  syncState(state: AppState) {
    this.applyVisibility(state);
    this.rebuildCountryHighlights(state);
    this.rebuildRegionFocus(state);
    if (this.dataState) {
      this.rebuildOverlays(state);
    }

    const earthMaterial = this.earthMesh.material;
    if (earthMaterial instanceof ShaderMaterial) {
      earthMaterial.uniforms.uUvDebug.value = state.diagnosticsEnabled && state.diagnosticsView === "uv" ? 1 : 0;
    }
  }

  update(deltaSeconds: number, elapsedSeconds: number, state: AppState, cameraPosition?: Vector3) {
    if (cameraPosition) {
      this.placeLabelLayer.syncToCamera({ position: cameraPosition });
    }
    const materialTime = state.diagnosticsEnabled ? 0 : elapsedSeconds;
    const cloudMotionScale = state.reduceMotion ? 0.35 : 1;
    const cloudOffsets = CLOUD_LAYER_DEFINITIONS.map((layer) =>
      state.diagnosticsEnabled ? layer.offsetBias : normalizeOffset(layer.offsetBias - elapsedSeconds * layer.uvSpeed * cloudMotionScale)
    );

    if (this.earthMesh.material instanceof ShaderMaterial) {
      this.earthMesh.material.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
      this.earthMesh.material.uniforms.uTime.value = materialTime;
      this.earthMesh.material.uniforms.uCloudOffset0.value = cloudOffsets[0] ?? 0;
      this.earthMesh.material.uniforms.uCloudOffset1.value = cloudOffsets[1] ?? cloudOffsets[0] ?? 0;
    }

    // Earth shadow sampling reads these exact offsets too, so both projected shadows
    // and visible shells stay in the same geographic frame as they drift over time.
    this.cloudMeshes.forEach((mesh, index) => {
      if (!(mesh.material instanceof ShaderMaterial)) {
        return;
      }

      mesh.material.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
      mesh.material.uniforms.uTime.value = materialTime;
      mesh.material.uniforms.uCloudOffset.value = cloudOffsets[index] ?? 0;
    });

    if (this.atmosphereMesh.material instanceof ShaderMaterial) {
      this.atmosphereMesh.material.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
      this.atmosphereMesh.material.uniforms.uIntensity.value = state.interactionMode === "intro" ? 0.78 + state.introProgress * 0.28 : 1;
    }

    const pulse = 0.88 + Math.sin(elapsedSeconds * 1.8) * 0.12;
    this.selectedLineMaterial.opacity = 0.58 + pulse * 0.12;
    this.selectedFillMaterial.opacity = 0.08 + pulse * 0.02;

    if (this.dataState) {
      this.updatePulses(elapsedSeconds, state);
    }
  }

  pickPlaceLabel(
    clientX: number,
    clientY: number,
    camera: { position: Vector3 },
    domElement: HTMLCanvasElement | HTMLElement,
  ): PlaceLabel | null {
    return this.placeLabelLayer.pick(clientX, clientY, camera, domElement);
  }

  pickCountry(clientX: number, clientY: number, camera: { position: Vector3 }, domElement: HTMLCanvasElement | HTMLElement) {
    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera as never);

    const intersections = this.raycaster.intersectObject(this.earthMesh, false);
    if (intersections.length === 0) {
      return null;
    }

    const point = intersections[0].point;
    const latLon = vector3ToLatLon(point);
    const country = findCountryAtLatLon(latLon.lat, latLon.lon);
    if (!country) {
      return null;
    }

    return {
      country,
      latLon,
    };
  }

  dispose() {
    this.clearCountryHighlights();
    this.clearRegionFocus();
    this.clearLabels();
    this.placeLabelLayer.dispose();
    this.earthGeometry.dispose();
    this.cloudGeometries.forEach((geometry) => {
      geometry.dispose();
    });
    this.atmosphereGeometry.dispose();
    disposeMaterialHost(this.earthMesh);
    this.cloudMeshes.forEach((mesh) => {
      disposeMaterialHost(mesh);
    });
    disposeMaterialHost(this.atmosphereMesh);
    disposeMaterialHost(this.countryBorders);
    this.flightArcs.geometry.dispose();
    this.flightArcMaterial.dispose();
    this.heatmapPoints.geometry.dispose();
    this.heatmapMaterial.dispose();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.healthPulseGeometry.dispose();
    this.conflictPulseGeometry.dispose();
    this.healthPulseMaterial.dispose();
    this.conflictPulseMaterial.dispose();
    this.hoveredFillMaterial.dispose();
    this.selectedFillMaterial.dispose();
    this.hoveredLineMaterial.dispose();
    this.selectedLineMaterial.dispose();
    this.regionFillMaterial.dispose();
    this.regionLineMaterial.dispose();
  }

  private applyVisibility(state: AppState) {
    const showAll = !state.diagnosticsEnabled || state.diagnosticsView === "full";
    const showEarth = showAll || state.diagnosticsView === "earth" || state.diagnosticsView === "uv";
    const showBorders = state.showBorders && (showAll || state.diagnosticsView === "borders");
    const showDots = showAll || state.diagnosticsView === "dots";

    this.atmosphereMesh.visible = showEarth;
    this.cloudMeshes.forEach((mesh) => {
      mesh.visible = state.showClouds && showEarth;
    });
    this.countryBorders.visible = showBorders;
    this.flightArcs.visible = showDots && state.activeLayer === "flights";
    this.heatmapPoints.visible = showDots && state.showHeatmap && (state.activeLayer === "weather" || state.activeLayer === "health");
    this.markers.visible = showDots && state.activeLayer === "conflict";
    this.healthPulses.visible = showDots && (state.activeLayer === "health" || state.activeLayer === "conflict");
    this.conflictPulses.visible = showDots && (state.activeLayer === "health" || state.activeLayer === "conflict");
    this.labelsGroup.visible = state.showLabels && showAll;
    // Place labels respect the same showLabels toggle but stay independent of
    // the per-layer event labels — they reveal themselves based on camera
    // distance, not active layer.
    this.placeLabelLayer.setEnabled(state.showLabels && showAll);
  }

  private rebuildCountryHighlights(state: AppState) {
    const highlightKey = `${state.hoveredCountry ?? ""}:${state.selectedCountry ?? ""}`;
    if (highlightKey === this.currentHighlightKey) {
      return;
    }

    this.currentHighlightKey = highlightKey;
    this.clearCountryHighlights();

    if (state.hoveredCountry && state.hoveredCountry !== state.selectedCountry) {
      const fillGeometry = buildCountryFillGeometry(state.hoveredCountry, COUNTRY_FILL_RADIUS);
      const lineGeometry = buildCountryBorderGeometry(state.hoveredCountry, COUNTRY_BORDER_RADIUS + 0.0006);
      if (fillGeometry) {
        this.hoveredFillMesh = new Mesh(fillGeometry, this.hoveredFillMaterial);
        this.hoveredFillMesh.renderOrder = SCENE_RENDER_ORDER.hoveredCountryFill;
        this.group.add(this.hoveredFillMesh);
      }
      if (lineGeometry) {
        this.hoveredLineMesh = new LineSegments(lineGeometry, this.hoveredLineMaterial);
        this.hoveredLineMesh.renderOrder = SCENE_RENDER_ORDER.hoveredCountryLine;
        this.group.add(this.hoveredLineMesh);
      }
    }

    if (state.selectedCountry) {
      const fillGeometry = buildCountryFillGeometry(state.selectedCountry, COUNTRY_FILL_RADIUS + 0.0004);
      const lineGeometry = buildCountryBorderGeometry(state.selectedCountry, COUNTRY_BORDER_RADIUS + 0.001);
      if (fillGeometry) {
        this.selectedFillMesh = new Mesh(fillGeometry, this.selectedFillMaterial);
        this.selectedFillMesh.renderOrder = SCENE_RENDER_ORDER.selectedCountryFill;
        this.group.add(this.selectedFillMesh);
      }
      if (lineGeometry) {
        this.selectedLineMesh = new LineSegments(lineGeometry, this.selectedLineMaterial);
        this.selectedLineMesh.renderOrder = SCENE_RENDER_ORDER.selectedCountryLine;
        this.group.add(this.selectedLineMesh);
      }
    }
  }

  private rebuildRegionFocus(state: AppState) {
    if (!this.dataState) {
      return;
    }

    const regionKey = state.selectedRegionSlug ?? "";
    if (regionKey === this.currentRegionKey) {
      return;
    }

    this.currentRegionKey = regionKey;
    this.clearRegionFocus();
    if (!state.selectedRegionSlug) {
      return;
    }

    const region = this.dataState.regions.find((entry) => entry.slug === state.selectedRegionSlug);
    if (!region) {
      return;
    }

    const fillGeometry = buildRegionFillGeometry(region, REGION_FILL_RADIUS);
    const lineGeometry = buildRegionBorderGeometry(region, REGION_LINE_RADIUS);
    if (fillGeometry) {
      this.regionFillMesh = new Mesh(fillGeometry, this.regionFillMaterial);
      this.regionFillMesh.renderOrder = SCENE_RENDER_ORDER.regionFill;
      this.group.add(this.regionFillMesh);
    }
    if (lineGeometry) {
      this.regionLineMesh = new LineSegments(lineGeometry, this.regionLineMaterial);
      this.regionLineMesh.renderOrder = SCENE_RENDER_ORDER.regionLine;
      this.group.add(this.regionLineMesh);
    }
  }

  private rebuildOverlays(state: AppState) {
    if (!this.dataState) {
      return;
    }

    const overlayKey = [
      state.activeLayer,
      state.showHeatmap,
      state.showLabels,
      this.dataState.flights.length,
      this.dataState.weather.length,
      this.dataState.conflicts.length,
      this.dataState.health.length,
    ].join(":");

    if (overlayKey === this.currentOverlayKey) {
      return;
    }

    this.currentOverlayKey = overlayKey;
    this.rebuildFlightArcs();
    this.rebuildHeatmap();
    this.rebuildMarkers();
    this.rebuildLabels(state);
  }

  private rebuildFlightArcs() {
    const points: number[] = [];
    for (const flight of (this.dataState?.flights ?? []).slice(0, 120)) {
      const from = latLonToVector3(flight.originPoint.lat, flight.originPoint.lon, 1.012);
      const to = latLonToVector3(flight.destinationPoint.lat, flight.destinationPoint.lon, 1.012);
      const curve = createArcCurve(from, to, 0.09 + flight.severity * 0.05);
      const sampled = curve.getPoints(20);
      for (let index = 1; index < sampled.length; index += 1) {
        const previous = sampled[index - 1];
        const current = sampled[index];
        points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
      }
    }

    this.flightArcs.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
    this.flightArcs.geometry = geometry;
  }

  private rebuildHeatmap() {
    const positions: number[] = [];
    const sizes: number[] = [];
    const intensities: number[] = [];
    const items = [
      ...(this.dataState?.weather ?? []).map((item) => ({
        lat: item.center.lat,
        lon: item.center.lon,
        strength: item.severity,
        scale: 0.018 + item.radiusKm / 28000,
      })),
      ...(this.dataState?.health ?? []).map((item) => ({
        lat: item.center.lat,
        lon: item.center.lon,
        strength: item.severity,
        scale: 0.02 + item.spread / 2400,
      })),
    ].slice(0, 90);

    for (const item of items) {
      const point = latLonToVector3(item.lat, item.lon, 1.014);
      positions.push(point.x, point.y, point.z);
      sizes.push(Math.min(0.082, 0.04 + item.scale * 0.28 + item.strength * 0.02));
      intensities.push(item.strength);
    }

    this.heatmapPoints.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new Float32BufferAttribute(sizes, 1));
    geometry.setAttribute("aIntensity", new Float32BufferAttribute(intensities, 1));
    this.heatmapPoints.geometry = geometry;
  }

  private rebuildMarkers() {
    const items = (this.dataState?.conflicts ?? []).slice(0, 90);
    for (let index = 0; index < items.length; index += 1) {
      const marker = items[index];
      const normal = latLonToVector3(marker.center.lat, marker.center.lon, 1).normalize();
      const point = normal.clone().multiplyScalar(1.022);
      this.markerOrientation.setFromUnitVectors(Y_AXIS, normal);
      this.markerDummy.position.copy(point.add(normal.clone().multiplyScalar(0.008 + marker.severity * 0.009)));
      this.markerDummy.quaternion.copy(this.markerOrientation);
      this.markerDummy.scale.setScalar(Math.min(0.024, 0.01 + marker.severity * 0.01));
      this.markerDummy.updateMatrix();
      this.markers.setMatrixAt(index, this.markerDummy.matrix);
    }
    this.markers.count = items.length;
    this.markers.instanceMatrix.needsUpdate = true;
  }

  private rebuildLabels(state: AppState) {
    this.clearLabels();
    if (!this.dataState) {
      return;
    }

    const entries = buildLabelEntries(state, this.dataState);
    for (const entry of entries) {
      const texture = createLabelTexture(entry.text, entry.severity);
      const material = new SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0.68,
      });
      const sprite = new Sprite(material);
      sprite.scale.set(0.18, 0.046, 1);
      sprite.position.copy(latLonToVector3(entry.lat, entry.lon, 1.055));
      sprite.renderOrder = SCENE_RENDER_ORDER.labels;
      sprite.userData.texture = texture;
      this.labelsGroup.add(sprite);
    }
  }

  private updatePulses(elapsedSeconds: number, state: AppState) {
    const healthDescriptors = (this.dataState?.health ?? []).slice(0, 48).map((signal, index) => ({
      position: latLonToVector3(signal.center.lat, signal.center.lon, 1.024),
      orientation: new Quaternion().setFromUnitVectors(Z_AXIS, latLonToVector3(signal.center.lat, signal.center.lon, 1.024).normalize()),
      baseScale: Math.min(0.032, 0.014 + signal.severity * 0.026),
      speed: 0.7 + index * 0.02,
    }));

    const conflictDescriptors = (this.dataState?.conflicts ?? []).slice(0, 36).map((signal, index) => ({
      position: latLonToVector3(signal.center.lat, signal.center.lon, 1.026),
      orientation: new Quaternion().setFromUnitVectors(Z_AXIS, latLonToVector3(signal.center.lat, signal.center.lon, 1.026).normalize()),
      baseScale: Math.min(0.028, 0.013 + signal.severity * 0.018),
      speed: 1.15 + index * 0.03,
    }));

    const elapsed = state.diagnosticsEnabled ? 0 : elapsedSeconds;

    for (let index = 0; index < healthDescriptors.length; index += 1) {
      const pulse = healthDescriptors[index];
      const wave = 1 + Math.sin(elapsed * pulse.speed + index * 0.76) * 0.24;
      this.pulseDummy.position.copy(pulse.position);
      this.pulseDummy.quaternion.copy(pulse.orientation);
      this.pulseDummy.scale.setScalar(pulse.baseScale * wave);
      this.pulseDummy.updateMatrix();
      this.healthPulses.setMatrixAt(index, this.pulseDummy.matrix);
    }
    this.healthPulses.count = healthDescriptors.length;
    this.healthPulses.instanceMatrix.needsUpdate = true;

    for (let index = 0; index < conflictDescriptors.length; index += 1) {
      const pulse = conflictDescriptors[index];
      const impact = 0.82 + Math.pow(Math.abs(Math.sin(elapsed * pulse.speed + index)), 5) * 0.56;
      this.pulseDummy.position.copy(pulse.position);
      this.pulseDummy.quaternion.copy(pulse.orientation);
      this.pulseDummy.scale.setScalar(pulse.baseScale * impact);
      this.pulseDummy.updateMatrix();
      this.conflictPulses.setMatrixAt(index, this.pulseDummy.matrix);
    }
    this.conflictPulses.count = conflictDescriptors.length;
    this.conflictPulses.instanceMatrix.needsUpdate = true;
  }

  private clearCountryHighlights() {
    if (this.hoveredFillMesh) {
      this.group.remove(this.hoveredFillMesh);
      this.hoveredFillMesh.geometry.dispose();
      this.hoveredFillMesh = null;
    }
    if (this.selectedFillMesh) {
      this.group.remove(this.selectedFillMesh);
      this.selectedFillMesh.geometry.dispose();
      this.selectedFillMesh = null;
    }
    if (this.hoveredLineMesh) {
      this.group.remove(this.hoveredLineMesh);
      this.hoveredLineMesh.geometry.dispose();
      this.hoveredLineMesh = null;
    }
    if (this.selectedLineMesh) {
      this.group.remove(this.selectedLineMesh);
      this.selectedLineMesh.geometry.dispose();
      this.selectedLineMesh = null;
    }
  }

  private clearRegionFocus() {
    if (this.regionFillMesh) {
      this.group.remove(this.regionFillMesh);
      this.regionFillMesh.geometry.dispose();
      this.regionFillMesh = null;
    }
    if (this.regionLineMesh) {
      this.group.remove(this.regionLineMesh);
      this.regionLineMesh.geometry.dispose();
      this.regionLineMesh = null;
    }
  }

  private clearLabels() {
    for (const child of [...this.labelsGroup.children]) {
      const sprite = child as Sprite;
      const texture = sprite.userData.texture as Texture | undefined;
      texture?.dispose();
      sprite.material.dispose();
      this.labelsGroup.remove(sprite);
    }
  }
}

export function buildTooltipForHit(
  hit: ReturnType<GlobeSystem["pickCountry"]>,
  dataState: ReturnType<typeof useDataStore.getState>
) {
  if (!hit) {
    return null;
  }

  const allRows = buildSignalRows(
    {
      flights: dataState.flights,
      weather: dataState.weather,
      conflicts: dataState.conflicts,
      health: dataState.health,
    },
    "global",
    400
  );
  const countryRows = allRows.filter((row) => row.iso3Hint === hit.country.iso3);
  const countryMetric = dataState.countryMetrics.find((entry) => entry.iso3 === hit.country.iso3) ?? null;
  const brief = buildAnalystSummary({
    label: hit.country.name,
    rows: countryRows,
    countryMetric,
  });

  return {
    allRows,
    payload: {
      iso3: hit.country.iso3,
      eyebrow: brief.signalCount > 0 ? `${brief.signalCount} live signals` : "Quiet watch posture",
      title: hit.country.name,
      score: brief.score,
      signalCount: brief.signalCount,
      summary: brief.summary,
      activeLayer: brief.dominantLayer,
    } satisfies Omit<HoverTooltipPayload, "x" | "y">,
  };
}

export function pickVisibleHotspotForLatLon(
  latLon: { lat: number; lon: number },
  activeLayer: AppState["activeLayer"],
  dataState: ReturnType<typeof useDataStore.getState>
) {
  if (activeLayer === "weather") {
    return pickNearestHotspot(
      dataState.weather.map((signal) => ({
        id: signal.id,
        layer: "weather" as const,
        iso3Hint: signal.iso3Hint,
        lat: signal.center.lat,
        lon: signal.center.lon,
        thresholdKm: signal.radiusKm,
      })),
      latLon
    );
  }

  if (activeLayer === "conflict") {
    return pickNearestHotspot(
      dataState.conflicts.map((signal) => ({
        id: signal.id,
        layer: "conflict" as const,
        iso3Hint: signal.iso3Hint,
        lat: signal.center.lat,
        lon: signal.center.lon,
        thresholdKm: 180,
      })),
      latLon
    );
  }

  if (activeLayer === "health") {
    return pickNearestHotspot(
      dataState.health.map((signal) => ({
        id: signal.id,
        layer: "health" as const,
        iso3Hint: signal.iso3Hint,
        lat: signal.center.lat,
        lon: signal.center.lon,
        thresholdKm: 180,
      })),
      latLon
    );
  }

  return null;
}

export function buildFocusedRows(
  state: AppState,
  dataState: ReturnType<typeof useDataStore.getState>,
  limit = 18
): SignalRow[] {
  const rows = buildSignalRows(
    {
      flights: dataState.flights,
      weather: dataState.weather,
      conflicts: dataState.conflicts,
      health: dataState.health,
    },
    state.activeLayer,
    limit
  );

  if (state.selectedSignalId) {
    return rows;
  }

  if (state.selectedCountry) {
    const countryRows = rows.filter((row) => row.iso3Hint === state.selectedCountry);
    return countryRows.length > 0 ? countryRows : rows;
  }

  if (state.selectedRegionSlug) {
    const region = dataState.regions.find((entry) => entry.slug === state.selectedRegionSlug) ?? null;
    return filterRowsByFocus(rows, null, region);
  }

  return rows;
}

function pickNearestHotspot(
  items: Array<{
    id: string;
    layer: "weather" | "conflict" | "health";
    iso3Hint?: string;
    lat: number;
    lon: number;
    thresholdKm: number;
  }>,
  target: { lat: number; lon: number }
) {
  let closest:
    | {
        id: string;
        layer: "weather" | "conflict" | "health";
        iso3Hint?: string;
        distanceKm: number;
      }
    | null = null;

  for (const item of items) {
    const distanceKm = haversineKm(target.lat, target.lon, item.lat, item.lon);
    if (distanceKm > item.thresholdKm) {
      continue;
    }

    if (!closest || distanceKm < closest.distanceKm) {
      closest = {
        id: item.id,
        layer: item.layer,
        iso3Hint: item.iso3Hint,
        distanceKm,
      };
    }
  }

  return closest;
}

function haversineKm(fromLat: number, fromLon: number, toLat: number, toLon: number) {
  const latDelta = degreesToRadians(toLat - fromLat);
  const lonDelta = degreesToRadians(toLon - fromLon);
  const startLat = degreesToRadians(fromLat);
  const endLat = degreesToRadians(toLat);
  const a =
    Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return 6371 * c;
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}
