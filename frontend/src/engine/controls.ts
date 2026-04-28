import { MathUtils, PerspectiveCamera, Vector2, Vector3 } from "three";

import { USER_IDLE_RESUME_MS } from "@/lib/three/globeSceneConfig";
import { clamp, damp } from "@/lib/three/easing";

interface GlobeControlsCallbacks {
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  onAutoRotateResumeRequest?: () => void;
}

interface GlobeControlsPreset {
  enabled: boolean;
  allowAutoRotate: boolean;
  target: Vector3;
  radius: number;
  minRadius: number;
  maxRadius: number;
  minPolar?: number;
  maxPolar?: number;
}

export class GlobeControls {
  private domElement: HTMLElement | null = null;

  private readonly callbacks: GlobeControlsCallbacks;

  private readonly pointer = new Vector2();

  private readonly previousPointer = new Vector2();

  private readonly currentTarget = new Vector3();

  private readonly desiredTarget = new Vector3();

  private enabled = false;

  private allowAutoRotate = false;

  private autoRotateSpeed = 0.08;

  private isPointerDown = false;

  private isInteracting = false;

  private suppressClickUntil = 0;

  private resumeTimer = 0;

  private azimuth = 0.72;

  private desiredAzimuth = 0.72;

  private polar = 1.08;

  private desiredPolar = 1.08;

  private radius = 3.8;

  private desiredRadius = 3.8;

  private minRadius = 1.45;

  private maxRadius = 5.2;

  private minPolar = 0.3;

  private maxPolar = Math.PI - 0.3;

  constructor(callbacks: GlobeControlsCallbacks = {}) {
    this.callbacks = callbacks;
  }

  connect(domElement: HTMLElement) {
    if (this.domElement === domElement) {
      return;
    }

    this.disconnect();
    this.domElement = domElement;
    this.domElement.style.touchAction = "none";
    this.domElement.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
    this.domElement.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
  }

  disconnect() {
    if (!this.domElement) {
      return;
    }

    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.domElement.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerUp);
    this.domElement = null;
  }

  dispose() {
    this.disconnect();
    if (this.resumeTimer) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = 0;
    }
  }

  applyPreset(preset: GlobeControlsPreset) {
    this.enabled = preset.enabled;
    this.allowAutoRotate = preset.allowAutoRotate;
    this.desiredTarget.copy(preset.target);
    this.minRadius = preset.minRadius;
    this.maxRadius = preset.maxRadius;
    this.minPolar = preset.minPolar ?? 0.3;
    this.maxPolar = preset.maxPolar ?? Math.PI - 0.3;
    this.desiredRadius = clamp(preset.radius, this.minRadius, this.maxRadius);
  }

  syncFromCamera(camera: PerspectiveCamera, target: Vector3) {
    const offset = camera.position.clone().sub(target);
    const sphericalRadius = Math.max(0.001, offset.length());
    const azimuth = Math.atan2(offset.z, offset.x);
    const polar = Math.acos(clamp(offset.y / sphericalRadius, -1, 1));

    this.currentTarget.copy(target);
    this.desiredTarget.copy(target);
    this.radius = sphericalRadius;
    this.desiredRadius = sphericalRadius;
    this.azimuth = azimuth;
    this.desiredAzimuth = azimuth;
    this.polar = polar;
    this.desiredPolar = polar;
  }

  shouldSuppressClick() {
    return performance.now() < this.suppressClickUntil;
  }

  get interacting() {
    return this.isInteracting || this.isPointerDown;
  }

  update(camera: PerspectiveCamera, deltaSeconds: number) {
    if (!this.enabled && !this.allowAutoRotate) {
      return;
    }

    if (this.allowAutoRotate && !this.isPointerDown && !this.isInteracting) {
      this.desiredAzimuth += this.autoRotateSpeed * deltaSeconds;
    }

    this.currentTarget.set(
      damp(this.currentTarget.x, this.desiredTarget.x, 5.6, deltaSeconds),
      damp(this.currentTarget.y, this.desiredTarget.y, 5.6, deltaSeconds),
      damp(this.currentTarget.z, this.desiredTarget.z, 5.6, deltaSeconds)
    );
    this.azimuth = damp(this.azimuth, this.desiredAzimuth, 7.2, deltaSeconds);
    this.polar = damp(this.polar, this.desiredPolar, 7.2, deltaSeconds);
    this.radius = damp(this.radius, this.desiredRadius, 6.4, deltaSeconds);

    const sinPolar = Math.sin(this.polar);
    camera.position.set(
      this.currentTarget.x + this.radius * sinPolar * Math.cos(this.azimuth),
      this.currentTarget.y + this.radius * Math.cos(this.polar),
      this.currentTarget.z + this.radius * sinPolar * Math.sin(this.azimuth)
    );
    camera.lookAt(this.currentTarget);
  }

  private beginInteraction(pointerId: number, clientX: number, clientY: number) {
    if (!this.domElement || !this.enabled) {
      return;
    }

    this.isPointerDown = true;
    this.pointer.set(clientX, clientY);
    this.previousPointer.copy(this.pointer);
    this.domElement.setPointerCapture(pointerId);

    if (this.resumeTimer) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = 0;
    }

    if (!this.isInteracting) {
      this.isInteracting = true;
      this.callbacks.onInteractionStart?.();
    }
  }

  private endInteraction(pointerId: number) {
    if (!this.domElement || !this.isPointerDown) {
      return;
    }

    this.isPointerDown = false;
    if (this.domElement.hasPointerCapture(pointerId)) {
      this.domElement.releasePointerCapture(pointerId);
    }

    if (this.isInteracting) {
      this.isInteracting = false;
      this.callbacks.onInteractionEnd?.();
      if (this.allowAutoRotate) {
        this.resumeTimer = window.setTimeout(() => {
          this.callbacks.onAutoRotateResumeRequest?.();
        }, USER_IDLE_RESUME_MS);
      }
    }
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.enabled) {
      return;
    }

    this.beginInteraction(event.pointerId, event.clientX, event.clientY);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.isPointerDown || !this.enabled) {
      return;
    }

    this.pointer.set(event.clientX, event.clientY);
    const deltaX = this.pointer.x - this.previousPointer.x;
    const deltaY = this.pointer.y - this.previousPointer.y;
    if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
      this.suppressClickUntil = performance.now() + 160;
    }

    this.desiredAzimuth -= deltaX * 0.0054;
    this.desiredPolar = clamp(this.desiredPolar - deltaY * 0.0054, this.minPolar, this.maxPolar);
    this.previousPointer.copy(this.pointer);
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    this.endInteraction(event.pointerId);
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (!this.enabled) {
      return;
    }

    event.preventDefault();
    const delta = MathUtils.clamp(event.deltaY * 0.0015, -0.4, 0.4);
    this.desiredRadius = clamp(this.desiredRadius + delta, this.minRadius, this.maxRadius);
  };
}
