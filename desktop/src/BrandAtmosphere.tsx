import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import "./BrandAtmosphere.css";

type BrandAtmosphereProps = { className?: string };

/** Decorative local illustration. No account data or live metrics are rendered. */
export function BrandAtmosphere({ className = "" }: BrandAtmosphereProps) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const bounds = useRef<DOMRect | null>(null);
  const motionAllowed = useRef(false);
  const tilt = useRef({ x: 0, y: 0 });

  function resetTilt() {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    bounds.current = null;
    root.current?.style.removeProperty("--brand-tilt-x");
    root.current?.style.removeProperty("--brand-tilt-y");
  }

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => {
      motionAllowed.current = !reduced.matches && pointer.matches;
      if (!motionAllowed.current) resetTilt();
    };
    update();
    reduced.addEventListener("change", update);
    pointer.addEventListener("change", update);
    return () => {
      reduced.removeEventListener("change", update);
      pointer.removeEventListener("change", update);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, []);

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (!motionAllowed.current || event.pointerType === "touch") return;
    const rect = bounds.current ?? event.currentTarget.getBoundingClientRect();
    bounds.current = rect;
    if (!rect.width || !rect.height) return;
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    tilt.current = { x: -y * 3, y: x * 3 };
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      root.current?.style.setProperty("--brand-tilt-x", `${tilt.current.x.toFixed(2)}deg`);
      root.current?.style.setProperty("--brand-tilt-y", `${tilt.current.y.toFixed(2)}deg`);
    });
  }

  return <div
    ref={root}
    className={`brand-atmosphere ${className}`.trim()}
    aria-hidden="true"
    onPointerEnter={(event) => { bounds.current = event.currentTarget.getBoundingClientRect(); }}
    onPointerMove={movePointer}
    onPointerLeave={resetTilt}
    onPointerCancel={resetTilt}
  >
    <div className="brand-atmosphere__scene">
      <img className="brand-atmosphere__map" src="./brand/workspace-map.svg" alt="" width="690" height="390" draggable={false} />
      <img className="brand-atmosphere__logo" src="./brand/toris-logo.png" alt="" width="512" height="512" draggable={false} decoding="async" />
    </div>
    <span className="brand-atmosphere__caption">Toris Studio</span>
  </div>;
}
