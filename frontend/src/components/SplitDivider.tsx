// Draggable, keyboard-accessible divider between a list and its detail pane (MP-105).
// The width is written to a CSS variable on the split container and remembered in localStorage.
import { useEffect, useRef, useState } from "react";

function read(key: string): number | null {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
function write(key: string, v: number | null) {
  try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, String(Math.round(v))); } catch { /* private mode */ }
}

/** Returns the remembered width (or null for the CSS default) plus the divider element. */
export function useSplitWidth(key: string, { min = 320, max = 960 }: { min?: number; max?: number } = {}) {
  const [width, setWidth] = useState<number | null>(() => read(key));
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, min), Math.min(max, window.innerWidth - 360)));
  const set = (w: number | null) => { const v = w === null ? null : clamp(w); setWidth(v); write(key, v); };
  return { width, set, clamp, min, max };
}

export function SplitDivider({ width, onChange, min, max, label = "Resize list" }: {
  width: number | null; onChange: (w: number | null) => void; min: number; max: number; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const current = () => width ?? (ref.current?.parentElement?.getBoundingClientRect().width ?? 600);
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("no-select");
    return () => { document.body.style.cursor = prev; document.body.classList.remove("no-select"); };
  }, [dragging]);
  return (
    <div ref={ref} className={"split-divider" + (dragging ? " on" : "")} role="separator" aria-orientation="vertical" aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(current())} tabIndex={0} title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: current() };
        setDragging(true);
      }}
      onPointerMove={(e) => { if (drag.current) onChange(drag.current.w + (e.clientX - drag.current.x)); }}
      onPointerUp={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") { e.preventDefault(); onChange(current() - step); }
        else if (e.key === "ArrowRight") { e.preventDefault(); onChange(current() + step); }
        else if (e.key === "Home") { e.preventDefault(); onChange(min); }
        else if (e.key === "End") { e.preventDefault(); onChange(max); }
        else if (e.key === "Enter") { e.preventDefault(); onChange(null); }
      }} />
  );
}
