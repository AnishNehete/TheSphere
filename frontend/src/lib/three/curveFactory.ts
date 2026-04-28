import { CatmullRomCurve3, Vector3 } from "three";

export function createArcCurve(from: Vector3, to: Vector3, arcHeight = 0.18) {
  const midpoint = from.clone().add(to).multiplyScalar(0.5).normalize().multiplyScalar(1 + arcHeight);
  return new CatmullRomCurve3([from, midpoint, to]);
}
