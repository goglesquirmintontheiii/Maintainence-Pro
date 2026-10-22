// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Ctrl+Shift+F: pick an element (like the browser's inspector) or drag over an area, write a note, get a code to paste
// into the release checklist's Requests tab.

import { useCallback, useEffect, useRef, useState } from "react";
import { describe, elementsIn, isOwn, pageContext, shortLabel, accessibleName, sectionsOf, type Box, type ElementInfo } from "./inspect";
import { appInfo, encode, screenshot, type Capture, type Kind, type Priority, type Shot } from "./pack";

type Mode = "off" | "pick" | "busy" | "form";
type Target =
  | { type: "element"; el: Element; info: ElementInfo; shot?: Shot }
  | { type: "area"; area: Box; shot: Shot; elements: ElementInfo[] };

const KINDS: [Kind, string][] = [["bug", "Bug"], ["feature", "Feature"], ["change", "Change"], ["note", "Note"]];
const PRIOS: [Priority, string][] = [["high", "High"], ["med", "Medium"], ["low", "Low"], ["none", "None"]];

const rectBox = (rc: DOMRect): Box => ({ x: rc.left, y: rc.top, w: rc.width, h: rc.height });
const clampToViewport = (b: Box, pad = 0): Box => {
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const x2 = Math.min(innerWidth, b.x + b.w + pad), y2 = Math.min(innerHeight, b.y + b.h + pad);
  return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(x2 - x)), h: Math.max(1, Math.round(y2 - y)) };
};
const kb = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

function scrollableParent(el: Element | null): Element | null {
  for (let cur = el; cur; cur = cur.parentElement) {
    const cs = getComputedStyle(cur);
    if ((/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight) || (/(auto|scroll)/.test(cs.overflowX) && cur.scrollWidth > cur.clientWidth)) return cur;
  }
  return document.scrollingElement;
}

export function FeedbackTool() {
  const [mode, setMode] = useState<Mode>("off");
  const [hover, setHover] = useState<Element | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [kind, setKind] = useState<Kind>("bug");
  const [prio, setPrio] = useState<Priority>("med");
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [, force] = useState(0);
  const down = useRef<{ x: number; y: number } | null>(null);
  const trail = useRef<Element[]>([]); // for ↓ after ↑ (back down to the child you came from)
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const reset = useCallback(() => {
    setHover(null); setDrag(null); setTarget(null); setCode(""); setCopied(false); setError("");
    down.current = null; trail.current = [];
  }, []);
  const exit = useCallback(() => { reset(); setText(""); setMode("off"); }, [reset]);
  const startPick = useCallback(() => { reset(); setMode("pick"); }, [reset]);

  // the hotkey works everywhere, even while typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === "KeyF" || e.key.toLowerCase() === "f")) {
        e.preventDefault(); e.stopPropagation();
        setMode((m) => { if (m === "off") { reset(); return "pick"; } reset(); setText(""); return "off"; });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reset]);

  // keep the highlight on the element while the page scrolls or resizes
  useEffect(() => {
    if (mode === "off") return;
    const rerender = () => force((n) => n + 1);
    window.addEventListener("scroll", rerender, true);
    window.addEventListener("resize", rerender);
    return () => { window.removeEventListener("scroll", rerender, true); window.removeEventListener("resize", rerender); };
  }, [mode]);

  const pickElement = useCallback(async (el: Element) => {
    setMode("busy");
    setTarget({ type: "element", el, info: describe(el) });
    setHover(null);
    setMode("form");
  }, []);

  const pickArea = useCallback(async (area: Box) => {
    setMode("busy"); setHover(null); setDrag(null);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the highlight disappear
      const shot = await screenshot(area);
      setTarget({ type: "area", area, shot, elements: elementsIn(area, shot.scale) });
      setMode("form");
    } catch (e) {
      setError("Couldn't take the screenshot: " + ((e as Error).message || e));
      setMode("pick");
    }
  }, []);

  // picking keys: Esc leaves, ↑ parent, ↓ back to the child, Enter picks
  useEffect(() => {
    if (mode !== "pick") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey) return;
      if (e.key === "Escape") { e.preventDefault(); exit(); }
      else if (e.key === "ArrowUp" && hover?.parentElement && hover.parentElement !== document.body) {
        e.preventDefault(); trail.current.push(hover); setHover(hover.parentElement);
      } else if (e.key === "ArrowDown" && hover) {
        e.preventDefault();
        const back = trail.current.pop();
        const next = back && hover.contains(back) ? back : hover.firstElementChild;
        if (next) setHover(next);
      } else if (e.key === "Enter" && hover) { e.preventDefault(); void pickElement(hover); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, hover, exit, pickElement]);

  useEffect(() => { if (mode === "form") setTimeout(() => textRef.current?.focus(), 0); }, [mode]);

  const under = (x: number, y: number) => document.elementsFromPoint(x, y).find((e) => !isOwn(e) && e !== document.documentElement && e !== document.body) ?? null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    down.current = { x: e.clientX, y: e.clientY };
    setError("");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = down.current;
    if (d && (Math.abs(e.clientX - d.x) > 5 || Math.abs(e.clientY - d.y) > 5)) {
      setHover(null);
      setDrag({ x: Math.min(d.x, e.clientX), y: Math.min(d.y, e.clientY), w: Math.abs(e.clientX - d.x), h: Math.abs(e.clientY - d.y) });
      return;
    }
    if (!d) { const el = under(e.clientX, e.clientY); if (el !== hover) { trail.current = []; setHover(el); } }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current; down.current = null;
    if (!d) return;
    if (drag && drag.w >= 8 && drag.h >= 8) { void pickArea(clampToViewport(drag)); return; }
    setDrag(null);
    const el = hover ?? under(e.clientX, e.clientY);
    if (el) void pickElement(el);
  };
  const onWheel = (e: React.WheelEvent) => { // let the page scroll underneath the picker
    const sc = scrollableParent(under(e.clientX, e.clientY));
    sc?.scrollBy({ left: e.deltaX, top: e.deltaY });
    setHover(under(e.clientX, e.clientY));
  };

  const addElementShot = async (on: boolean) => {
    if (!target || target.type !== "element") return;
    if (!on) { setTarget({ ...target, shot: undefined }); return; }
    setError("");
    try {
      const shot = await screenshot(clampToViewport(rectBox(target.el.getBoundingClientRect()), 8));
      setTarget({ ...target, shot });
    } catch (e) { setError("Couldn't take the screenshot: " + ((e as Error).message || e)); }
  };

  const copy = async (s: string) => {
    try { await navigator.clipboard.writeText(s); setCopied(true); return; } catch { /* not a secure context: fall back */ }
    const ta = codeRef.current;
    if (ta) { ta.focus(); ta.select(); try { setCopied(document.execCommand("copy")); } catch { setCopied(false); } }
  };

  const create = async () => {
    if (!target) return;
    if (!text.trim()) { textRef.current?.focus(); return; }
    setError("");
    const cap: Capture = {
      v: 1, tool: "mpro-feedback", created: new Date().toISOString(), kind, priority: prio, text: text.trim(),
      app: await appInfo(), page: pageContext(), target: target.type,
    };
    if (target.type === "element") { cap.element = target.info; if (target.shot) cap.shot = target.shot; }
    else { cap.area = target.area; cap.shot = target.shot; cap.elements = target.elements; }
    try {
      const s = await encode(cap);
      setCode(s);
      setTimeout(() => copy(s), 0);
    } catch (e) { setError("Couldn't build the code: " + ((e as Error).message || e)); }
  };

  if (mode === "off") return null;

  const hb = hover ? hover.getBoundingClientRect() : null;
  const tb = target?.type === "element" ? target.el.getBoundingClientRect() : target?.type === "area" ? null : null;
  const area = target?.type === "area" ? target.area : null;

  return (
    <>
      {mode === "pick" || mode === "busy" ? (
        <div className="fb-layer" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()} style={{ cursor: mode === "busy" ? "progress" : "crosshair" }} />
      ) : null}

      {mode !== "form" && (
        <div className="fb-banner" role="status">
          <b>Feedback mode</b>
          <span>{mode === "busy" ? "Taking the screenshot…" : "Click an element, or drag to select an area."}</span>
          {mode === "pick" && <span className="fb-keys"><kbd>↑</kbd><kbd>↓</kbd> parent / child · <kbd>Enter</kbd> pick · <kbd>Esc</kbd> exit</span>}
          {error && <span className="fb-err">{error}</span>}
          <button type="button" onClick={exit}>Exit</button>
        </div>
      )}

      {mode === "pick" && hb && !drag && (
        <>
          <div className="fb-hl" style={{ left: hb.left, top: hb.top, width: hb.width, height: hb.height }} />
          <div className="fb-tip" style={{ left: Math.min(Math.max(4, hb.left), innerWidth - 320), top: hb.top > 52 ? hb.top - 30 : Math.min(innerHeight - 30, hb.bottom + 6) }}>
            <code>{shortLabel(hover!)}</code>
            <span className="fb-dim">{Math.round(hb.width)}×{Math.round(hb.height)}</span>
            {accessibleName(hover!) && <span className="fb-name">{accessibleName(hover!).slice(0, 48)}</span>}
          </div>
        </>
      )}
      {drag && <div className="fb-hl fb-area" style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }}><span>{Math.round(drag.w)}×{Math.round(drag.h)}</span></div>}

      {mode === "form" && target && (
        <>
          {tb && <div className="fb-hl fb-picked" style={{ left: tb.left, top: tb.top, width: tb.width, height: tb.height }} />}
          {area && <div className="fb-hl fb-picked" style={{ left: area.x, top: area.y, width: area.w, height: area.h }} />}
          <div className="fb-panel" role="dialog" aria-label="Feedback capture"
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); exit(); }
              else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !code) { e.preventDefault(); void create(); }
            }}>
            <div className="fb-head">
              <b>{target.type === "area" ? "Area" : "Element"} captured</b>
              <button type="button" className="fb-x" aria-label="Close" onClick={exit}>×</button>
            </div>

            {target.type === "element" ? (
              <div className="fb-target">
                <code>{shortLabel(target.el)}</code>
                {target.info.name && <div className="fb-name">“{target.info.name}”</div>}
                {target.info.sections?.length ? <div className="fb-dim">{[pageContext().heading, ...sectionsOf(target.el)].filter(Boolean).join(" › ")}</div> : null}
                <label className="fb-check">
                  <input type="checkbox" checked={!!target.shot} onChange={(e) => void addElementShot(e.target.checked)} />
                  Add a screenshot of it
                </label>
                {target.shot && <img className="fb-shot" src={target.shot.data} alt="Screenshot of the element" />}
              </div>
            ) : (
              <div className="fb-target">
                <div className="fb-shotwrap">
                  <img className="fb-shot" src={target.shot.data} alt="Screenshot of the selected area" />
                  {target.elements.map((el) => el.box && (
                    <span key={el.n} className="fb-num" title={el.name || el.tag}
                      style={{ left: `${(el.box.x / target.shot.w) * 100}%`, top: `${(el.box.y / target.shot.h) * 100}%` }}>{el.n}</span>
                  ))}
                </div>
                <div className="fb-dim">{target.elements.length} labelled element{target.elements.length === 1 ? "" : "s"} · {target.shot.w}×{target.shot.h}px</div>
              </div>
            )}

            {!code ? (
              <>
                <div className="fb-row" role="radiogroup" aria-label="Type">
                  {KINDS.map(([k, t]) => (
                    <button key={k} type="button" role="radio" aria-checked={kind === k} className={`fb-seg fb-k-${k}`} onClick={() => setKind(k)}>{t}</button>
                  ))}
                  <select aria-label="Priority" value={prio} onChange={(e) => setPrio(e.target.value as Priority)}>
                    {PRIOS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                  </select>
                </div>
                <textarea ref={textRef} rows={5} value={text} onChange={(e) => setText(e.target.value)}
                  placeholder={"First line is the title\n\nDetails, steps, what you expected… (Markdown works)"} aria-label="What's the bug, feature, change or note?" />
                {error && <div className="fb-err">{error}</div>}
                <div className="fb-actions">
                  <button type="button" onClick={startPick}>Pick again</button>
                  <span className="fb-dim">Ctrl+Enter</span>
                  <button type="button" className="fb-primary" disabled={!text.trim()} onClick={() => void create()}>Create code</button>
                </div>
              </>
            ) : (
              <>
                <div className={copied ? "fb-ok" : "fb-dim"}>
                  {copied ? "Copied. " : "Copy this code. "}Paste it in the checklist: Requests → Paste a capture. ({kb(code.length)})
                </div>
                <textarea ref={codeRef} className="fb-code" readOnly rows={4} value={code} onFocus={(e) => e.currentTarget.select()} aria-label="Capture code" />
                <div className="fb-actions">
                  <button type="button" onClick={() => setCode("")}>Edit note</button>
                  <button type="button" onClick={() => { setText(""); startPick(); }}>New capture</button>
                  <button type="button" className="fb-primary" onClick={() => void copy(code)}>{copied ? "Copy again" : "Copy"}</button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
