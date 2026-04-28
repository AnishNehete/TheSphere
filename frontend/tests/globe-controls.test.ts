import { PerspectiveCamera, Vector3 } from "three";

import { GlobeControls } from "@/engine/controls";

function createPointerEvent(type: string, init: MouseEventInit & { pointerId: number }) {
  const PointerEventCtor = window.PointerEvent ?? window.MouseEvent;
  const event = new PointerEventCtor(type, init) as PointerEvent;
  if (!("pointerId" in event)) {
    Object.defineProperty(event, "pointerId", {
      configurable: true,
      value: init.pointerId,
    });
  }
  return event;
}

describe("globe controls", () => {
  it("keeps drag handedness aligned with the cinematic camera rig", () => {
    const controls = new GlobeControls();
    const domElement = document.createElement("div");
    const capturedPointers = new Set<number>();

    Object.defineProperties(domElement, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointers.add(pointerId);
        },
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointers.delete(pointerId);
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.has(pointerId),
      },
    });

    document.body.appendChild(domElement);
    controls.connect(domElement);
    controls.applyPreset({
      enabled: true,
      allowAutoRotate: false,
      target: new Vector3(0, 0, 0),
      radius: 2,
      minRadius: 1.2,
      maxRadius: 4,
    });

    const camera = new PerspectiveCamera(33, 1, 0.01, 120);
    camera.position.set(2, 0, 0);
    const target = new Vector3(0, 0, 0);
    controls.syncFromCamera(camera, target);

    domElement.dispatchEvent(
      createPointerEvent("pointerdown", {
        button: 0,
        buttons: 1,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      })
    );
    window.dispatchEvent(
      createPointerEvent("pointermove", {
        buttons: 1,
        pointerId: 1,
        clientX: 140,
        clientY: 124,
      })
    );
    window.dispatchEvent(
      createPointerEvent("pointerup", {
        button: 0,
        pointerId: 1,
        clientX: 140,
        clientY: 124,
      })
    );

    controls.update(camera, 1);

    expect(camera.position.z).toBeLessThan(0);
    expect(camera.position.y).toBeGreaterThan(0);

    controls.dispose();
    domElement.remove();
  });
});
