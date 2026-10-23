// Touch gestures for the floor plan viewer and editor (0.5.0, MP-128): pinch to zoom and two-finger pan; in the
// viewer one finger pans too. The point of the plan under your fingers stays under them while you zoom.
import { useEffect, useRef, type RefObject } from "react";

type Opts = {
  zoom: number; setZoom: (z: number) => void; min?: number; max?: number;
  /** one finger pans (viewer); in the editor one finger draws */
  panOneFinger: boolean;
  /** a second finger landed: cancel whatever the first finger started */
  onPinchStart?: () => void;
};

const mid = (t: TouchList): [number, number] => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

export function useTouchZoom(stage: RefObject<HTMLDivElement | null>, box: RefObject<HTMLDivElement | null>, opts: Opts) {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let pinch: { d0: number; z0: number; f: [number, number] } | null = null;
    let pan: [number, number] | null = null;
    let raf = 0;
    // keep the plan point `f` (fractions of the plan box) under the screen point `at`
    const anchor = (f: [number, number], at: [number, number]) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = box.current?.getBoundingClientRect();
        if (!r) return;
        el.scrollLeft += r.left + f[0] * r.width - at[0];
        el.scrollTop += r.top + f[1] * r.height - at[1];
      });
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const r = box.current?.getBoundingClientRect();
        const m = mid(e.touches);
        pinch = { d0: Math.max(1, dist(e.touches)), z0: o.current.zoom, f: r ? [(m[0] - r.left) / r.width, (m[1] - r.top) / r.height] : [0.5, 0.5] };
        pan = null;
        o.current.onPinchStart?.();
      } else if (e.touches.length === 1 && o.current.panOneFinger && !pinch) {
        pan = [e.touches[0].clientX, e.touches[0].clientY];
      }
    };
    const move = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const { min = 1, max = 6 } = o.current;
        const z = Math.min(max, Math.max(min, pinch.z0 * (dist(e.touches) / pinch.d0)));
        if (Math.abs(z - o.current.zoom) > 0.001) o.current.setZoom(z);
        anchor(pinch.f, mid(e.touches));
      } else if (pan && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        el.scrollLeft -= t.clientX - pan[0];
        el.scrollTop -= t.clientY - pan[1];
        pan = [t.clientX, t.clientY];
      }
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) pan = null;
    };
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [stage, box]);
}
