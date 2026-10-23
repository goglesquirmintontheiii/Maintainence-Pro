import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Pickers used across work orders: assignees (people + teams), categories, generic multi-select,
// a signature pad and a comment box with @mentions.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Users, X } from "lucide-react";
import { Avatar, Button, useClickAway } from "./ui";
export function MultiPicker({ options, value, onChange, placeholder, label, renderValue, single = false, disabled = false, searchPlaceholder = "Search", id }) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const [hi, setHi] = useState(0);
    const ref = useClickAway(open, () => setOpen(false));
    const input = useRef(null);
    useEffect(() => { if (open) {
        setQ("");
        setHi(0);
        setTimeout(() => input.current?.focus(), 0);
    } }, [open]);
    const shown = useMemo(() => options.filter((o) => !q || (o.label + " " + (o.sub ?? "")).toLowerCase().includes(q.toLowerCase())), [options, q]);
    const sel = options.filter((o) => value.includes(o.key));
    const toggle = (k) => {
        if (single) {
            onChange(value[0] === k ? [] : [k]);
            setOpen(false);
            return;
        }
        onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
    };
    return (_jsxs("div", { className: "picker", ref: ref, children: [_jsxs("button", { type: "button", id: id, className: "picker-btn input", "aria-label": id ? undefined : label, "aria-haspopup": "listbox", "aria-expanded": open, disabled: disabled, onClick: () => setOpen((o) => !o), children: [_jsx("span", { className: "grow picker-val", children: sel.length ? (renderValue ? renderValue(sel) : sel.map((s) => s.label).join(", ")) : _jsx("span", { className: "faint", children: placeholder }) }), _jsx(ChevronDown, { size: 15, className: "faint" })] }), open && (_jsxs("div", { className: "menu picker-menu", role: "listbox", "aria-label": label, "aria-multiselectable": !single, children: [_jsxs("div", { className: "picker-search", children: [_jsx(Search, { size: 14, className: "faint" }), _jsx("input", { ref: input, value: q, onChange: (e) => { setQ(e.target.value); setHi(0); }, placeholder: searchPlaceholder, "aria-label": searchPlaceholder, onKeyDown: (e) => {
                                    if (e.key === "ArrowDown") {
                                        e.preventDefault();
                                        setHi((h) => Math.min(shown.length - 1, h + 1));
                                    }
                                    else if (e.key === "ArrowUp") {
                                        e.preventDefault();
                                        setHi((h) => Math.max(0, h - 1));
                                    }
                                    else if (e.key === "Enter") {
                                        e.preventDefault();
                                        if (shown[hi])
                                            toggle(shown[hi].key);
                                    }
                                    else if (e.key === "Escape") {
                                        e.preventDefault();
                                        e.nativeEvent.preventDefault();
                                        setOpen(false);
                                    }
                                } })] }), _jsxs("div", { className: "picker-list", children: [shown.length === 0 && _jsx("div", { className: "small faint", style: { padding: 10 }, children: "No matches" }), shown.map((o, i) => (_jsxs("button", { type: "button", role: "option", "aria-selected": value.includes(o.key), className: "menu-item" + (i === hi ? " hi" : ""), onMouseEnter: () => setHi(i), onClick: () => toggle(o.key), children: [o.icon, _jsxs("span", { className: "grow", children: [_jsx("span", { children: o.label }), o.sub && _jsx("span", { className: "small faint", style: { display: "block" }, children: o.sub })] }), value.includes(o.key) && _jsx(Check, { size: 15, className: "r", color: "var(--c-primary)" })] }, o.key)))] }), !single && value.length > 0 && _jsxs("div", { className: "picker-foot", children: [_jsx("button", { type: "button", className: "linkbtn small", onClick: () => onChange([]), children: "Clear" }), _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setOpen(false), children: "Done" })] })] }))] }));
}
export function assigneeOptions(o) {
    if (!o)
        return [];
    return [
        ...o.people.filter((p) => p.assignable).map((p) => ({ key: `user:${p.id}`, label: p.name, icon: _jsx(Avatar, { name: p.name, initials: p.initials, src: p.avatar_url, size: "sm" }) })),
        ...o.teams.map((t) => ({ key: `team:${t.id}`, label: t.name, sub: "Team", icon: _jsx("span", { className: "team-ic", style: { background: t.color }, children: _jsx(Users, { size: 12 }) }) })),
    ];
}
export function AssigneeChips({ items, max = 3 }) {
    if (!items.length)
        return _jsx("span", { className: "faint", children: "Unassigned" });
    return (_jsxs("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: [items.slice(0, max).map((a) => a.type === "user"
                ? _jsxs("span", { className: "chip", children: [_jsx(Avatar, { name: a.name, initials: a.initials, src: a.avatar_url, size: "sm" }), a.name] }, a.id)
                : _jsxs("span", { className: "chip", children: [_jsx("span", { className: "team-ic", style: { background: a.color }, children: _jsx(Users, { size: 11 }) }), a.name] }, a.id)), items.length > max && _jsxs("span", { className: "chip", children: ["+", items.length - max] })] }));
}
export function AssigneePicker({ options, value, onChange, disabled, id }) {
    return _jsx(MultiPicker, { id: id, label: "Assignees", placeholder: "Assign people or teams", options: assigneeOptions(options), value: value, onChange: onChange, disabled: disabled, searchPlaceholder: "Search people and teams", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) });
}
export function CategoryChips({ items }) {
    return _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: items.map((c) => _jsxs("span", { className: "chip", children: [_jsx("span", { className: "sw", style: { background: c.color } }), c.name] }, c.id)) });
}
export function CategoryPicker({ options, value, onChange, disabled, id }) {
    const opts = (options?.categories ?? []).map((c) => ({ key: c.id, label: c.name, icon: _jsx("span", { className: "sw lg", style: { background: c.color } }) }));
    return _jsx(MultiPicker, { id: id, label: "Categories", placeholder: "Add categories", options: opts, value: value, onChange: onChange, disabled: disabled, searchPlaceholder: "Search categories", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) });
}
// ---------------------------------------------------------------- signature
export function SignaturePad({ onChange }) {
    const canvas = useRef(null);
    const drawing = useRef(false);
    const dirty = useRef(false);
    useEffect(() => {
        const c = canvas.current;
        const ratio = window.devicePixelRatio || 1;
        c.width = c.clientWidth * ratio;
        c.height = c.clientHeight * ratio;
        const ctx = c.getContext("2d");
        ctx.scale(ratio, ratio);
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#111827";
    }, []);
    const pos = (e) => { const r = canvas.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const clear = () => { const c = canvas.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null); };
    return (_jsxs("div", { className: "sigpad", children: [_jsx("canvas", { ref: canvas, "aria-label": "Signature area. Draw your signature with a mouse, finger or pen.", role: "img", onPointerDown: (e) => { drawing.current = true; canvas.current.setPointerCapture(e.pointerId); const ctx = canvas.current.getContext("2d"); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }, onPointerMove: (e) => { if (!drawing.current)
                    return; const ctx = canvas.current.getContext("2d"); const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); dirty.current = true; }, onPointerUp: () => { drawing.current = false; if (dirty.current)
                    onChange(toPng(canvas.current)); } }), _jsxs("div", { className: "row small", style: { justifyContent: "space-between" }, children: [_jsx("span", { className: "faint", children: "Sign above" }), _jsx("button", { type: "button", className: "linkbtn small", onClick: clear, children: "Clear" })] })] }));
}
function toPng(c) {
    // white background so the signature reads in PDFs and dark mode alike
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    return out.toDataURL("image/png");
}
export function MentionBox({ value, onChange, options, placeholder, onSubmit, autoFocus, rows = 2 }) {
    // The textarea shows "@Name"; we keep a map so we can turn it into @[Name](user:id) markup on send.
    const ta = useRef(null);
    const caret = useRef(null);
    const [query, setQuery] = useState(null);
    useLayoutEffect(() => {
        if (caret.current !== null && ta.current) {
            ta.current.selectionStart = ta.current.selectionEnd = caret.current;
            caret.current = null;
        }
    }, [value]);
    const [hi, setHi] = useState(0);
    const all = useMemo(() => [
        ...(options?.people ?? []).map((p) => ({ kind: "user", id: p.id, name: p.name, initials: p.initials })),
        ...(options?.teams ?? []).map((t) => ({ kind: "team", id: t.id, name: t.name, color: t.color })),
    ], [options]);
    const matches = query === null ? [] : all.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
    const onInput = (v) => {
        onChange(v);
        const caret = ta.current?.selectionStart ?? v.length;
        const before = v.slice(0, caret);
        const m = /(^|\s)@([\w .'-]{0,30})$/.exec(before);
        setQuery(m ? m[2] : null);
        setHi(0);
    };
    const pick = (m) => {
        const el = ta.current;
        const pos = el.selectionStart;
        const before = value.slice(0, pos).replace(/@([\w .'-]{0,30})$/, `@[${m.name}](${m.kind}:${m.id}) `);
        const next = before + value.slice(pos);
        caret.current = before.length;
        onChange(next);
        setQuery(null);
        el.focus();
    };
    return (_jsxs("div", { className: "mention-wrap", children: [_jsx("textarea", { ref: ta, className: "textarea", rows: rows, value: value, placeholder: placeholder, autoFocus: autoFocus, "aria-label": placeholder ?? "Comment", onChange: (e) => onInput(e.target.value), onKeyDown: (e) => {
                    if (matches.length) {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setHi((h) => Math.min(matches.length - 1, h + 1));
                            return;
                        }
                        if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setHi((h) => Math.max(0, h - 1));
                            return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            pick(matches[hi]);
                            return;
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            e.nativeEvent.preventDefault();
                            setQuery(null);
                            return;
                        }
                    }
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
                        e.preventDefault();
                        onSubmit();
                    }
                } }), matches.length > 0 && (_jsx("div", { className: "menu mention-menu", role: "listbox", "aria-label": "Mention someone", children: matches.map((m, i) => (_jsxs("button", { type: "button", className: "menu-item" + (i === hi ? " hi" : ""), role: "option", "aria-selected": i === hi, onMouseDown: (e) => { e.preventDefault(); pick(m); }, children: [m.kind === "user" ? _jsx(Avatar, { name: m.name, initials: m.initials, size: "sm" }) : _jsx("span", { className: "team-ic", style: { background: m.color }, children: _jsx(Users, { size: 12 }) }), m.name, m.kind === "team" && _jsx("span", { className: "small faint r", children: "Team" })] }, m.kind + m.id))) }))] }));
}
/** Renders comment text with mention markup as highlighted names. */
export function RichText({ text }) {
    const parts = [];
    let last = 0;
    const re = /@\[([^\]]{1,200})\]\((user|team):([0-9a-fA-F-]{36})\)/g;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last)
            parts.push(text.slice(last, m.index));
        parts.push(_jsxs("span", { className: "mention", children: ["@", m[1]] }, m.index));
        last = m.index + m[0].length;
    }
    if (last < text.length)
        parts.push(text.slice(last));
    return _jsx("span", { className: "richtext", children: parts });
}
export function RemovableChip({ children, onRemove }) {
    return _jsxs("span", { className: "chip", children: [children, _jsx(Button, { variant: "ghost", size: "sm", icon: true, "aria-label": "Remove", onClick: onRemove, style: { width: 18, height: 18, minHeight: 0 }, children: _jsx(X, { size: 12 }) })] });
}
