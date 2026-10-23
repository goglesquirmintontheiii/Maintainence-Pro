import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, CornerDownLeft, Plus, Search, User, Users } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV, SETTINGS_NAV } from "./nav";
import { Avatar } from "../components/ui";
export function CommandPalette({ onClose }) {
    const [q, setQ] = useState("");
    const [remote, setRemote] = useState([]);
    const [loading, setLoading] = useState(false);
    const [sel, setSel] = useState(0);
    const nav = useNavigate();
    const { can } = useSession();
    const input = useRef(null);
    const list = useRef(null);
    useEffect(() => { input.current?.focus(); }, []);
    useEffect(() => {
        const term = q.trim();
        if (!term) {
            setRemote([]);
            return;
        }
        const ctl = new AbortController();
        setLoading(true);
        const t = setTimeout(() => {
            api(`/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
                .then((r) => setRemote(r.groups)).catch(() => { }).finally(() => setLoading(false));
        }, 140);
        return () => { clearTimeout(t); ctl.abort(); };
    }, [q]);
    const items = useMemo(() => {
        const term = q.trim().toLowerCase();
        const pages = [...NAV.filter((n) => !n.perm || can(n.perm)).map((n) => ({ ...n, sub: n.phase ? `Coming in ${n.phase}` : n.group === "hidden" ? "" : n.group || "Home" })),
            ...SETTINGS_NAV.filter((s) => !s.perm || can(s.perm)).map((s) => ({ id: s.path, label: s.label, path: s.path, icon: s.icon, sub: "Settings", keywords: "" }))]
            .filter((n) => !term || (n.label + " " + (n.keywords ?? "")).toLowerCase().includes(term))
            .slice(0, term ? 6 : 8)
            .map((n) => { const Icon = n.icon; return { key: "nav:" + n.path, group: "Go to", title: n.label, subtitle: n.sub, url: n.path, icon: _jsx(Icon, { size: 16 }) }; });
        const found = remote.flatMap((g) => g.results.map((r) => ({
            key: g.type + ":" + r.id, group: g.label, title: r.title, subtitle: r.subtitle, url: r.url,
            icon: g.type === "people" ? _jsx(Avatar, { name: r.title, initials: r.initials, size: "sm" }) : g.type === "work_orders" ? _jsx(ClipboardList, { size: 16 }) : g.type === "teams"
                ? _jsx("span", { className: "chip", style: { padding: 0, width: 28, justifyContent: "center", border: 0 }, children: _jsx(Users, { size: 15, color: r.color }) }) : _jsx(User, { size: 16 })
        })));
        const actions = can("wo.create") && (!term || "create new work order".includes(term) || term.startsWith("new"))
            ? [{ key: "act:new-wo", group: "Actions", title: "Create a work order", subtitle: "Shortcut: C", url: "/work-orders?new=1", icon: _jsx(Plus, { size: 16 }) }] : [];
        return [...found, ...actions, ...pages];
    }, [q, remote, can]);
    useEffect(() => { setSel(0); }, [items.length, q]);
    useEffect(() => { list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
    const go = (it) => { if (!it)
        return; onClose(); nav(it.url); };
    const onKey = (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
        }
        else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
        }
        else if (e.key === "Enter") {
            e.preventDefault();
            go(items[sel]);
        }
        else if (e.key === "Escape")
            onClose();
    };
    let lastGroup = "";
    return (_jsx("div", { className: "overlay", onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { className: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Search", children: [_jsxs("div", { className: "palette-input", children: [_jsx(Search, { size: 18, className: "faint" }), _jsx("input", { ref: input, value: q, onChange: (e) => setQ(e.target.value), onKeyDown: onKey, placeholder: "Search work orders (#1042), people, teams and pages\u2026", "aria-label": "Search", role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list" }), loading && _jsx("span", { className: "small faint", children: "Searching\u2026" })] }), _jsxs("div", { className: "palette-list", id: "palette-list", role: "listbox", ref: list, children: [items.length === 0 && _jsx("div", { className: "empty", style: { padding: 28 }, children: _jsxs("p", { children: ["Nothing matches \u201C", q, "\u201D. Assets and parts become searchable when their modules arrive."] }) }), items.map((it, i) => {
                            const head = it.group !== lastGroup ? _jsx("div", { className: "palette-group", children: (lastGroup = it.group) }) : null;
                            return (_jsxs("div", { children: [head, _jsxs("div", { className: "palette-item" + (i === sel ? " sel" : ""), role: "option", "aria-selected": i === sel, onMouseEnter: () => setSel(i), onClick: () => go(it), children: [_jsx("span", { className: "ic", children: it.icon }), _jsxs("span", { className: "grow", children: [_jsx("div", { style: { fontWeight: 600 }, children: it.title }), it.subtitle && _jsx("div", { className: "small muted", children: it.subtitle })] }), i === sel && _jsx(CornerDownLeft, { size: 14, className: "faint" })] })] }, it.key));
                        })] }), _jsxs("div", { className: "palette-foot", children: [_jsxs("span", { children: [_jsx("span", { className: "kbd", children: "\u2191" }), " ", _jsx("span", { className: "kbd", children: "\u2193" }), " to move"] }), _jsxs("span", { children: [_jsx("span", { className: "kbd", children: "Enter" }), " to open"] }), _jsxs("span", { children: [_jsx("span", { className: "kbd", children: "Esc" }), " to close"] })] })] }) }));
}
