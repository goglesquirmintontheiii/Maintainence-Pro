import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// MPro component library: buttons, fields, pills, avatars, modals, menus, empty states, skeletons.
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { avatarColor } from "../lib/format";
export function Button({ variant = "default", size = "md", icon, block, className = "", ...rest }) {
    const cls = ["btn", variant !== "default" && variant, size !== "md" && size, icon && "icon", block && "block", className].filter(Boolean).join(" ");
    return _jsx("button", { type: "button", className: cls, ...rest });
}
export function Field({ label, hint, error, children, className = "" }) {
    const id = useId();
    return (_jsxs("div", { className: "field " + className, children: [_jsx("label", { htmlFor: id, children: label }), children(id), error ? _jsx("span", { className: "err", role: "alert", children: error }) : hint ? _jsx("span", { className: "hint", children: hint }) : null] }));
}
export const Input = (p) => _jsx("input", { ...p, className: "input " + (p.className ?? "") });
export const Select = (p) => _jsx("select", { ...p, className: "select " + (p.className ?? "") });
export const STATUS = { open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done", canceled: "Canceled" };
export function StatusPill({ status, sub }) {
    return _jsxs("span", { className: "pill " + status, title: sub || undefined, children: [_jsx("span", { className: "dot" }), STATUS[status], sub ? _jsxs("span", { className: "sub", children: ["\u00B7 ", sub] }) : null] });
}
export const PRIORITY = { none: "None", low: "Low", medium: "Medium", high: "High" };
export function PriorityBadge({ priority }) {
    return _jsxs("span", { className: "prio " + priority, children: [_jsxs("span", { className: "bars", "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {})] }), PRIORITY[priority]] });
}
export function Pill({ tone = "neutral", children }) {
    return _jsx("span", { className: "pill " + tone, children: children });
}
export function Avatar({ name, initials, size = "md", src }) {
    const ini = initials ?? name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
    const [failed, setFailed] = useState(false);
    if (src && !failed)
        return _jsx("img", { className: "avatar photo " + (size !== "md" ? size : ""), src: src, alt: name, title: name, loading: "lazy", onError: () => setFailed(true) });
    return _jsx("span", { className: "avatar " + (size !== "md" ? size : ""), style: { background: avatarColor(name) }, title: name, "aria-label": name, children: ini });
}
export function AvatarStack({ people, max = 4 }) {
    const extra = people.length - max;
    return (_jsxs("span", { className: "avatars", children: [people.slice(0, max).map((p) => _jsx(Avatar, { name: p.name, initials: p.initials, src: p.avatar_url, size: "sm" }, p.name)), extra > 0 && _jsxs("span", { className: "avatar sm", style: { background: "var(--c-text-3)" }, children: ["+", extra] })] }));
}
export function Modal({ title, onClose, children, footer, width }) {
    const ref = useRef(null);
    useEffect(() => {
        const k = (e) => { if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            onClose();
        } };
        window.addEventListener("keydown", k);
        const first = ref.current?.querySelector("input, select, textarea, button:not(.modal-x)");
        first?.focus();
        return () => window.removeEventListener("keydown", k);
    }, [onClose]);
    return (_jsx("div", { className: "overlay", onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { className: "modal", role: "dialog", "aria-modal": "true", "aria-label": title, ref: ref, style: width ? { width: `min(${width}px, 100%)` } : undefined, children: [_jsxs("div", { className: "modal-head", children: [_jsx("h2", { children: title }), _jsx(Button, { variant: "ghost", icon: true, className: "modal-x", "aria-label": "Close", onClick: onClose, children: _jsx(X, { size: 18 }) })] }), _jsx("div", { className: "modal-body", children: children }), footer && _jsx("div", { className: "modal-foot", children: footer })] }) }));
}
export function useClickAway(open, close) {
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const h = (e) => { if (ref.current && !ref.current.contains(e.target))
            close(); };
        const k = (e) => { if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            close();
        } };
        document.addEventListener("mousedown", h);
        document.addEventListener("keydown", k);
        return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
    }, [open, close]);
    return ref;
}
export function Dropdown({ trigger, children, align = "right", up = false, className = "", width }) {
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);
    const ref = useClickAway(open, close);
    return (_jsxs("div", { ref: ref, style: { position: "relative" }, className: className, children: [trigger(open, () => setOpen((o) => !o)), open && _jsx("div", { className: "menu", role: "menu", style: { [align]: 0, ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), width }, children: children(close) })] }));
}
export function Checkbox({ checked, onChange, label, disabled, indeterminate }) {
    const ref = useRef(null);
    useEffect(() => { if (ref.current)
        ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
    return (_jsxs("label", { className: "check", children: [_jsx("input", { ref: ref, type: "checkbox", checked: checked, disabled: disabled, onChange: (e) => onChange(e.target.checked) }), label && _jsx("span", { children: label })] }));
}
export function Toggle({ checked, onChange, label, hint, disabled }) {
    return (_jsxs("label", { className: "toggle-row", children: [_jsxs("span", { className: "grow", children: [_jsx("span", { className: "toggle-label", children: label }), hint && _jsx("span", { className: "hint", children: hint })] }), _jsx("input", { type: "checkbox", role: "switch", className: "switch", checked: checked, disabled: disabled, onChange: (e) => onChange(e.target.checked) })] }));
}
export function Drawer({ title, onClose, children, footer, width = 560 }) {
    const ref = useRef(null);
    useEffect(() => {
        const k = (e) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay")) {
            e.preventDefault();
            onClose();
        } };
        window.addEventListener("keydown", k);
        ref.current?.querySelector("input, textarea, select")?.focus();
        return () => window.removeEventListener("keydown", k);
    }, [onClose]);
    return (_jsx("div", { className: "drawer-wrap", onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("aside", { className: "drawer", role: "dialog", "aria-modal": "true", "aria-label": typeof title === "string" ? title : "Panel", ref: ref, style: { width: `min(${width}px, 100%)` }, children: [_jsxs("div", { className: "drawer-head", children: [_jsx("h2", { children: title }), _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Close", onClick: onClose, children: _jsx(X, { size: 18 }) })] }), _jsx("div", { className: "drawer-body", children: children }), footer && _jsx("div", { className: "drawer-foot", children: footer })] }) }));
}
export function EmptyState({ icon, title, children, action }) {
    return (_jsxs("div", { className: "empty", children: [icon && _jsx("div", { className: "empty-icon", children: icon }), _jsx("h2", { children: title }), children && _jsx("p", { children: children }), action] }));
}
export function Skeleton({ w = "100%", h = 14 }) {
    return _jsx("span", { className: "skeleton", style: { display: "block", width: w, height: h } });
}
export function ListSkeleton({ rows = 6 }) {
    return _jsx("div", { "aria-busy": "true", "aria-label": "Loading", children: Array.from({ length: rows }, (_, i) => (_jsxs("div", { className: "list-row", children: [_jsx("span", { className: "skeleton", style: { width: 32, height: 32, borderRadius: "50%" } }), _jsxs("div", { className: "grow stack", style: { gap: 6 }, children: [_jsx(Skeleton, { w: "60%" }), _jsx(Skeleton, { w: "40%", h: 11 })] })] }, i))) });
}
