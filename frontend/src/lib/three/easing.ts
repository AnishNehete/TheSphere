import { Vector3 } from "three";

export function damp(current: number, target: number, smoothing: number, deltaSeconds: number) {
  const alpha = 1 - Math.exp(-smoothing * deltaSeconds);
  return current + (target - current) * alpha;
}

/** Exponential damp a Vector3 in place. Mutates `current`. */
export function dampVec3(
  current: Vector3,
  target: Vector3,
  smoothing: number,
  deltaSeconds: number
): void {
  const alpha = 1 - Math.exp(-smoothing * deltaSeconds);
  current.x += (target.x - current.x) * alpha;
  current.y += (target.y - current.y) * alpha;
  current.z += (target.z - current.z) * alpha;
}

export function smoothstep(min: number, max: number, value: number) {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
