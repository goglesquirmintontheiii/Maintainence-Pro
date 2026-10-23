import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Ctrl+Shift+F: pick an element (like the browser's inspector) or drag over an area, write a note, get a code to paste
// into the release checklist's Requests tab.
import { useCallback, useEffect, useRef, useState } from "react";
import { describe, elementsIn, isOwn, pageContext, shortLabel, accessibleName, sectionsOf } from "./inspect";
import { appInfo, encode, screenshot } from "./pack";
const KINDS = [["bug", "Bug"], ["feature", "Feature"], ["change", "Change"], ["note", "Note"]];
const PRIOS = [["high", "High"], ["med", "Medium"], ["low", "Low"], ["none", "None"]];
const rectBox = (rc) => ({ x: rc.left, y: rc.top, w: rc.width, h: rc.height });
const clampToViewport = (b, pad = 0) => {
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    const x2 = Math.min(innerWidth, b.x + b.w + pad), y2 = Math.min(innerHeight, b.y + b.h + pad);
    return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(x2 - x)), h: Math.max(1, Math.round(y2 - y)) };
};
const kb = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
function scrollableParent(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
        const cs = getComputedStyle(cur);
        if ((/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight) || (/(auto|scroll)/.test(cs.overflowX) && cur.scrollWidth > cur.clientWidth))
            return cur;
    }
    return document.scrollingElement;
}
export function FeedbackTool() {
    const [mode, setMode] = useState("off");
    const [hover, setHover] = useState(null);
    const [drag, setDrag] = useState(null);
    const [target, setTarget] = useState(null);
    const [kind, setKind] = useState("bug");
    const [prio, setPrio] = useState("med");
    const [text, setText] = useState("");
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState("");
    const [, force] = useState(0);
    const down = useRef(null);
    const trail = useRef([]); // for ↓ after ↑ (back down to the child you came from)
    const codeRef = useRef(null);
    const textRef = useRef(null);
    const lastText = useRef("");
    const reset = useCallback(() => {
        setHover(null);
        setDrag(null);
        setTarget(null);
        setCode("");
        setCopied(false);
        setError("");
        down.current = null;
        trail.current = [];
    }, []);
    // Leaving keeps a half-written note for next time; it's cleared once a code has been made from it.
    const exit = useCallback(() => { reset(); setMode("off"); }, [reset]);
    const startPick = useCallback(() => { reset(); setMode("pick"); }, [reset]);
    // the hotkey works everywhere, even while typing in a field
    useEffect(() => {
        const onKey = (e) => {
            if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === "KeyF" || e.key.toLowerCase() === "f")) {
                e.preventDefault();
                e.stopPropagation();
                setMode((m) => { reset(); return m === "off" ? "pick" : "off"; });
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [reset]);
    // keep the highlight on the element while the page scrolls or resizes
    useEffect(() => {
        if (mode === "off")
            return;
        const rerender = () => force((n) => n + 1);
        window.addEventListener("scroll", rerender, true);
        window.addEventListener("resize", rerender);
        return () => { window.removeEventListener("scroll", rerender, true); window.removeEventListener("resize", rerender); };
    }, [mode]);
    const pickElement = useCallback(async (el) => {
        setMode("busy");
        setTarget({ type: "element", el, info: describe(el) });
        setHover(null);
        setMode("form");
    }, []);
    const pickArea = useCallback(async (area) => {
        setMode("busy");
        setHover(null);
        setDrag(null);
        try {
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the highlight disappear
            const shot = await screenshot(area);
            setTarget({ type: "area", area, shot, ...elementsIn(area, shot.scale) });
            setMode("form");
        }
        catch (e) {
            setError("Couldn't take the screenshot: " + (e.message || e));
            setMode("pick");
        }
    }, []);
    // picking keys: Esc leaves, ↑ parent, ↓ back to the child, Enter picks
    useEffect(() => {
        if (mode !== "pick")
            return;
        const onKey = (e) => {
            if (e.ctrlKey && e.shiftKey)
                return;
            if (e.key === "Escape") {
                e.preventDefault();
                exit();
            }
            else if (e.key === "ArrowUp" && hover?.parentElement && hover.parentElement !== document.body) {
                e.preventDefault();
                trail.current.push(hover);
                setHover(hover.parentElement);
            }
            else if (e.key === "ArrowDown" && hover) {
                e.preventDefault();
                const back = trail.current.pop();
                const next = back && hover.contains(back) ? back : hover.firstElementChild;
                if (next)
                    setHover(next);
            }
            else if (e.key === "Enter" && hover) {
                e.preventDefault();
                void pickElement(hover);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [mode, hover, exit, pickElement]);
    useEffect(() => { if (mode === "form")
        setTimeout(() => textRef.current?.focus(), 0); }, [mode]);
    // Esc closes the panel wherever focus is (after "Create code" the button that had focus is gone)
    useEffect(() => {
        if (mode !== "form")
            return;
        const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            exit();
        } };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [mode, exit]);
    useEffect(() => { if (code)
        setTimeout(() => codeRef.current?.focus(), 0); }, [code]);
    const under = (x, y) => document.elementsFromPoint(x, y).find((e) => !isOwn(e) && e !== document.documentElement && e !== document.body) ?? null;
    const onPointerDown = (e) => {
        if (e.button !== 0)
            return;
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);
        down.current = { x: e.clientX, y: e.clientY };
        setError("");
    };
    const onPointerMove = (e) => {
        const d = down.current;
        if (d && (Math.abs(e.clientX - d.x) > 5 || Math.abs(e.clientY - d.y) > 5)) {
            setHover(null);
            setDrag({ x: Math.min(d.x, e.clientX), y: Math.min(d.y, e.clientY), w: Math.abs(e.clientX - d.x), h: Math.abs(e.clientY - d.y) });
            return;
        }
        if (!d) {
            const el = under(e.clientX, e.clientY);
            if (el !== hover) {
                trail.current = [];
                setHover(el);
            }
        }
    };
    const onPointerUp = (e) => {
        const d = down.current;
        down.current = null;
        if (!d)
            return;
        if (drag && drag.w >= 8 && drag.h >= 8) {
            void pickArea(clampToViewport(drag));
            return;
        }
        setDrag(null);
        const el = hover ?? under(e.clientX, e.clientY);
        if (el)
            void pickElement(el);
    };
    const onWheel = (e) => {
        const sc = scrollableParent(under(e.clientX, e.clientY));
        sc?.scrollBy({ left: e.deltaX, top: e.deltaY });
        setHover(under(e.clientX, e.clientY));
    };
    const addElementShot = async (on) => {
        if (!target || target.type !== "element")
            return;
        if (!on) {
            setTarget({ ...target, shot: undefined });
            return;
        }
        setError("");
        try {
            const shot = await screenshot(clampToViewport(rectBox(target.el.getBoundingClientRect()), 8));
            setTarget({ ...target, shot });
        }
        catch (e) {
            setError("Couldn't take the screenshot: " + (e.message || e));
        }
    };
    const copy = async (s) => {
        try {
            await navigator.clipboard.writeText(s);
            setCopied(true);
            return;
        }
        catch { /* not a secure context: fall back */ }
        const ta = codeRef.current;
        if (ta) {
            ta.focus();
            ta.select();
            try {
                setCopied(document.execCommand("copy"));
            }
            catch {
                setCopied(false);
            }
        }
    };
    const create = async () => {
        if (!target)
            return;
        if (!text.trim()) {
            textRef.current?.focus();
            return;
        }
        setError("");
        const cap = {
            v: 2, tool: "mpro-feedback", created: new Date().toISOString(), kind, priority: prio, text: text.trim(),
            app: await appInfo(), page: pageContext(), target: target.type,
        };
        if (target.type === "element") {
            cap.element = target.info;
            if (target.shot)
                cap.shot = target.shot;
        }
        else {
            cap.area = target.area;
            cap.shot = target.shot;
            cap.elements = target.elements;
            if (target.containers.length)
                cap.containers = target.containers;
            if (target.notes.length)
                cap.notes = target.notes;
        }
        lastText.current = text;
        try {
            const s = await encode(cap);
            setCode(s);
            setText("");
            setTimeout(() => copy(s), 0);
        }
        catch (e) {
            setError("Couldn't build the code: " + (e.message || e));
        }
    };
    if (mode === "off")
        return null;
    const hb = hover ? hover.getBoundingClientRect() : null;
    const tb = target?.type === "element" ? target.el.getBoundingClientRect() : target?.type === "area" ? null : null;
    const area = target?.type === "area" ? target.area : null;
    return (_jsxs(_Fragment, { children: [mode === "pick" || mode === "busy" ? (_jsx("div", { className: "fb-layer", onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp, onWheel: onWheel, onContextMenu: (e) => e.preventDefault(), style: { cursor: mode === "busy" ? "progress" : "crosshair" } })) : null, mode !== "form" && (_jsxs("div", { className: "fb-banner", role: "status", children: [_jsx("b", { children: "Feedback mode" }), _jsx("span", { children: mode === "busy" ? "Taking the screenshot…" : "Click an element, or drag to select an area." }), mode === "pick" && _jsxs("span", { className: "fb-keys", children: [_jsx("kbd", { children: "\u2191" }), _jsx("kbd", { children: "\u2193" }), " parent / child \u00B7 ", _jsx("kbd", { children: "Enter" }), " pick \u00B7 ", _jsx("kbd", { children: "Esc" }), " exit"] }), error && _jsx("span", { className: "fb-err", children: error }), _jsx("button", { type: "button", onClick: exit, children: "Exit" })] })), mode === "pick" && hb && !drag && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fb-hl", style: { left: hb.left, top: hb.top, width: hb.width, height: hb.height } }), _jsxs("div", { className: "fb-tip", style: { left: Math.min(Math.max(4, hb.left), innerWidth - 320), top: hb.top > 52 ? hb.top - 30 : Math.min(innerHeight - 30, hb.bottom + 6) }, children: [_jsx("code", { children: shortLabel(hover) }), _jsxs("span", { className: "fb-dim", children: [Math.round(hb.width), "\u00D7", Math.round(hb.height)] }), accessibleName(hover) && _jsx("span", { className: "fb-name", children: accessibleName(hover).slice(0, 48) })] })] })), drag && _jsx("div", { className: "fb-hl fb-area", style: { left: drag.x, top: drag.y, width: drag.w, height: drag.h }, children: _jsxs("span", { children: [Math.round(drag.w), "\u00D7", Math.round(drag.h)] }) }), mode === "form" && target && (_jsxs(_Fragment, { children: [tb && _jsx("div", { className: "fb-hl fb-picked", style: { left: tb.left, top: tb.top, width: tb.width, height: tb.height } }), area && _jsx("div", { className: "fb-hl fb-picked", style: { left: area.x, top: area.y, width: area.w, height: area.h } }), _jsxs("div", { className: "fb-panel", role: "dialog", "aria-label": "Feedback capture", onKeyDown: (e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !code) {
                                e.preventDefault();
                                void create();
                            }
                        }, children: [_jsxs("div", { className: "fb-head", children: [_jsxs("b", { children: [target.type === "area" ? "Area" : "Element", " captured"] }), _jsx("button", { type: "button", className: "fb-x", "aria-label": "Close", onClick: exit, children: "\u00D7" })] }), target.type === "element" ? (_jsxs("div", { className: "fb-target", children: [_jsx("code", { children: shortLabel(target.el) }), target.info.name && _jsxs("div", { className: "fb-name", children: ["\u201C", target.info.name, "\u201D"] }), (target.info.column || target.info.row) && _jsx("div", { className: "fb-dim", children: [target.info.row && "Row: " + target.info.row, target.info.column && "Column: " + target.info.column].filter(Boolean).join(" · ") }), target.info.sections?.length ? _jsx("div", { className: "fb-dim", children: [pageContext().heading, ...sectionsOf(target.el)].filter(Boolean).join(" › ") }) : null, _jsxs("label", { className: "fb-check", children: [_jsx("input", { type: "checkbox", checked: !!target.shot, onChange: (e) => void addElementShot(e.target.checked) }), "Add a screenshot of it"] }), target.shot && _jsx("img", { className: "fb-shot", src: target.shot.data, alt: "Screenshot of the element" })] })) : (_jsxs("div", { className: "fb-target", children: [_jsxs("div", { className: "fb-shotwrap", children: [_jsx("img", { className: "fb-shot", src: target.shot.data, alt: "Screenshot of the selected area" }), target.elements.map((el) => el.box && (_jsx("span", { className: "fb-num", title: el.name || el.tag, style: { left: `${(el.box.x / target.shot.w) * 100}%`, top: `${(el.box.y / target.shot.h) * 100}%` }, children: el.n }, el.n)))] }), _jsxs("div", { className: "fb-dim", children: [target.elements.length, " labelled element", target.elements.length === 1 ? "" : "s", " \u00B7 ", target.shot.w, "\u00D7", target.shot.h, "px", target.containers.length ? " · in " + target.containers.map((c) => c.name || c.tag).slice(-2).join(" › ") : ""] }), target.notes.map((n) => _jsx("div", { className: "fb-err", children: n }, n))] })), !code ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "fb-row", role: "radiogroup", "aria-label": "Type", children: [KINDS.map(([k, t]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": kind === k, className: `fb-seg fb-k-${k}`, onClick: () => setKind(k), children: t }, k))), _jsx("select", { "aria-label": "Priority", value: prio, onChange: (e) => setPrio(e.target.value), children: PRIOS.map(([k, t]) => _jsx("option", { value: k, children: t }, k)) })] }), _jsx("textarea", { ref: textRef, rows: 5, value: text, onChange: (e) => setText(e.target.value), placeholder: "First line is the title\n\nDetails, steps, what you expected… (Markdown works)", "aria-label": "What's the bug, feature, change or note?" }), error && _jsx("div", { className: "fb-err", children: error }), _jsxs("div", { className: "fb-actions", children: [_jsx("button", { type: "button", onClick: startPick, children: "Pick again" }), _jsx("span", { className: "fb-dim", children: "Ctrl+Enter" }), _jsx("button", { type: "button", className: "fb-primary", disabled: !text.trim(), onClick: () => void create(), children: "Create code" })] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: copied ? "fb-ok" : "fb-dim", children: [copied ? "Copied. " : "Copy this code. ", "Paste it in the checklist: Requests \u2192 Paste a capture. (", kb(code.length), ")"] }), _jsx("textarea", { ref: codeRef, className: "fb-code", readOnly: true, rows: 4, value: code, onFocus: (e) => e.currentTarget.select(), "aria-label": "Capture code" }), _jsxs("div", { className: "fb-actions", children: [_jsx("button", { type: "button", onClick: () => { setText(lastText.current); setCode(""); }, children: "Edit note" }), _jsx("button", { type: "button", onClick: startPick, children: "New capture" }), _jsx("button", { type: "button", className: "fb-primary", onClick: () => void copy(code), children: copied ? "Copy again" : "Copy" })] })] }))] })] }))] }));
}
