// Shared colour picker (0.5.0, MP-123): a row of preset swatches plus a rainbow "Custom colour" button that opens a
// colour field, hue slider and hex box. Recent custom colours are remembered on this device.
//   <ColorPicker value={color} onChange={setColor} />                 presets default to PRESET_COLORS
//   <ColorPicker value={fill} onChange={…} presets={…} allowNone label="Fill colour" />
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useClickAway } from "./ui";
import "../styles/colorpicker.css";

export const PRESET_COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#b8560b", "#c37a06", "#7a52c9", "#c4302b", "#c43c5c", "#3d6fb6", "#5d6880"];
const RECENT_KEY = "mpro.recentColors";
const HEX = /^#[0-9a-f]{6}$/i;

// ---- colour maths

export function normalizeHex(v: string): string | null {
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
  return HEX.test(s) ? s : null;
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
}
function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function luminance(hex: string) {
  const ch = hexToRgb(hex).map((c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** Black or white text, whichever reads better on `bg` (WCAG contrast). */
export function readableText(bg: string): "#111827" | "#ffffff" {
  const hex = normalizeHex(bg);
  if (!hex) return "#111827";
  const l = luminance(hex);
  return (1.05) / (l + 0.05) >= (l + 0.05) / (0.0168 + 0.05) ? "#ffffff" : "#111827";
}

function loadRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string" && HEX.test(x)).slice(0, 8) : []; }
  catch { return []; }
}
function rememberRecent(c: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...loadRecent().filter((x) => x !== c)].slice(0, 8))); } catch { /* private mode */ }
}

// ---- component

export function ColorPicker({ value, onChange, presets = PRESET_COLORS, allowNone, label = "Colour", size = "md" }: {
  value: string; onChange: (color: string) => void; presets?: string[]; allowNone?: boolean; label?: string; size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickAway<HTMLDivElement>(open, close);
  const isPreset = presets.some((p) => p.toLowerCase() === value.toLowerCase());
  const custom = !isPreset && value !== "none" && !!normalizeHex(value);
  return (
    <div className={"cp" + (size === "sm" ? " sm" : "")} role="radiogroup" aria-label={label} ref={ref}>
      {allowNone && (
        <button type="button" role="radio" aria-checked={value === "none"} aria-label="None" title="None"
          className={"cp-sw none" + (value === "none" ? " on" : "")} onClick={() => onChange("none")} />
      )}
      {presets.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c.toLowerCase()} aria-label={c} title={c}
          className={"cp-sw" + (value.toLowerCase() === c.toLowerCase() ? " on" : "")} style={{ background: c, color: readableText(c) }} onClick={() => onChange(c)}>
          {value.toLowerCase() === c.toLowerCase() && <Check size={size === "sm" ? 12 : 14} aria-hidden />}
        </button>
      ))}
      {custom && (
        <button type="button" role="radio" aria-checked className="cp-sw on" aria-label={`Custom colour ${value}`} title={value}
          style={{ background: value, color: readableText(value) }} onClick={() => setOpen(true)}><Check size={size === "sm" ? 12 : 14} aria-hidden /></button>
      )}
      <button type="button" className={"cp-sw cp-rainbow" + (open ? " on" : "")} aria-label="Custom colour" title="Custom colour" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} />
      {open && <CustomPanel value={normalizeHex(value) ?? presets[0] ?? "#1b5bd4"} onPick={(c) => { onChange(c); }} onDone={(c) => { rememberRecent(c); close(); }} />}
    </div>
  );
}

function CustomPanel({ value, onPick, onDone }: { value: string; onPick: (c: string) => void; onDone: (c: string) => void }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(value));
  const [hex, setHex] = useState(value);
  const [recent] = useState(loadRecent);
  const field = useRef<HTMLDivElement>(null);
  const cur = hsvToHex(...hsv);

  useEffect(() => { setHex(cur); }, [cur]);

  const set = (h: [number, number, number]) => { setHsv(h); onPick(hsvToHex(...h)); };
  const fromPointer = (e: React.PointerEvent) => {
    const r = field.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    set([hsv[0], s, v]);
  };
  const onFieldKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const [h, s, v] = hsv;
    const k: Record<string, [number, number, number]> = {
      ArrowLeft: [h, Math.max(0, s - step), v], ArrowRight: [h, Math.min(1, s + step), v],
      ArrowUp: [h, s, Math.min(1, v + step)], ArrowDown: [h, s, Math.max(0, v - step)],
    };
    if (k[e.key]) { e.preventDefault(); set(k[e.key]); }
  };
  return (
    <div className="cp-panel" role="dialog" aria-label="Custom colour" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); onDone(cur); } }}>
      <div ref={field} className="cp-field" style={{ background: `hsl(${hsv[0]} 100% 50%)` }} tabIndex={0} role="slider"
        aria-label="Saturation and brightness" aria-valuetext={`${Math.round(hsv[1] * 100)}% saturation, ${Math.round(hsv[2] * 100)}% brightness`}
        onKeyDown={onFieldKey}
        onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); fromPointer(e); }}
        onPointerMove={(e) => { if (e.buttons) fromPointer(e); }}>
        <span className="cp-dot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: cur }} />
      </div>
      <input type="range" className="cp-hue" min={0} max={359} value={Math.round(hsv[0])} aria-label="Hue"
        onChange={(e) => set([Number(e.target.value), hsv[1] || 0.8, hsv[2] || 0.8])} />
      <div className="cp-row">
        <span className="cp-preview" style={{ background: cur, color: readableText(cur) }}>Aa</span>
        <input className="input cp-hex" value={hex} aria-label="Hex colour" maxLength={7} spellCheck={false}
          onChange={(e) => { setHex(e.target.value); const n = normalizeHex(e.target.value); if (n) { setHsv(hexToHsv(n)); onPick(n); } }} />
        <button type="button" className="btn primary sm" onClick={() => onDone(cur)}>Done</button>
      </div>
      {recent.length > 0 && (
        <div className="cp-recent" aria-label="Recent custom colours" role="group">
          {recent.map((c) => <button key={c} type="button" className="cp-sw sm" style={{ background: c }} aria-label={c} title={c}
            onClick={() => { setHsv(hexToHsv(c)); onPick(c); }} />)}
        </div>
      )}
    </div>
  );
}
