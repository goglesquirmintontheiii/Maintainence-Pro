import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Automation tree (0.5.0, MP-129): the trigger → conditions → actions of one automation as a collapsible tree, each
// node in plain words. Used on the automation page and live in the builder; empty branches say what's missing.
import { useState } from "react";
import { ChevronDown, ChevronRight, Filter, ListTree, Play, Zap } from "lucide-react";
import { ACTION_LABEL, ASSET_STATUS, COND_LABEL, RECURRING, TRIGGER_LABEL, WEEKDAYS, WO_STATUS, minutesText, } from "./types";
const list = (xs, none) => (xs.length ? xs.join(" or ") : none);
export function triggerText(d) {
    const t = d.trigger;
    if (t.type === "meter_reading") {
        const v = String(t.value ?? "").trim();
        if (!v)
            return "A meter reading: pick a value to compare with";
        return `A meter reading ${COND_LABEL[t.condition].toLowerCase()} ${v}${RECURRING.includes(t.condition) && t.first_at !== undefined && t.first_at !== "" ? `, starting at ${t.first_at}` : ""}`;
    }
    if (t.type === "asset_status")
        return `An asset goes from ${list(t.from.map((s) => ASSET_STATUS[s]), "any status")} to ${list(t.to.map((s) => ASSET_STATUS[s]), "any status")}`;
    const extra = [t.priorities.length ? `priority ${t.priorities.join(" or ")}` : "", t.categories.length ? `${t.categories.length} categor${t.categories.length === 1 ? "y" : "ies"}` : ""].filter(Boolean);
    return `A work order goes from ${list(t.from.map((s) => WO_STATUS[s]), "any status")} to ${list(t.to.map((s) => WO_STATUS[s]), "any status")}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}
function sensitivityText(d) {
    const s = d.sensitivity ?? {};
    if (s.mode === "once")
        return "Only the first time it happens, until it goes back";
    if (s.mode === "n_of_m")
        return `When it happens ${s.n ?? "?"} times in the last ${s.m ?? "?"} readings`;
    if (s.mode === "duration")
        return `When it stays that way for ${minutesText(s.minutes) || "a while"}`;
    return "Every time it happens";
}
export function conditionText(c) {
    if (c.type === "asset_status")
        return c.in.length ? `The asset is ${list(c.in.map((s) => ASSET_STATUS[s]), "")}` : "The asset is in… (pick a status)";
    if (c.type === "weekday")
        return c.days.length ? `It's ${c.days.map((d) => WEEKDAYS[d] ?? d).join(", ")}` : "It's one of… (pick days)";
    return c.from && c.to ? `Between ${c.from} and ${c.to}` : "Between… (pick the times)";
}
export function actionText(a) {
    if (a.type === "create_work_order") {
        const what = a.title?.trim() ? `“${a.title.trim()}”` : a.template_id ? "from a template" : "(add a title or template)";
        const who = a.assignees?.length ? `, assigned to ${a.assignees.length}` : "";
        const due = a.due_in_days !== undefined && a.due_in_days !== "" ? `, due in ${a.due_in_days} day${a.due_in_days === 1 ? "" : "s"}` : "";
        return `Create a work order ${what}${who}${due}`;
    }
    if (a.type === "change_asset_status")
        return `Set the asset to ${ASSET_STATUS[a.status]}${a.downtime_type ? ` (${a.downtime_type} downtime)` : ""}${a.reason ? `: ${a.reason}` : ""}`;
    return a.recipients.length ? `Email ${a.recipients.length} recipient${a.recipients.length === 1 ? "" : "s"}${a.subject ? `: “${a.subject}”` : ""}` : "Send an email (add recipients)";
}
function Node({ icon, title, children, empty, open: start = true }) {
    const [open, setOpen] = useState(start);
    const kids = (children ?? []).filter(Boolean);
    return (_jsxs("li", { className: "atree-node", children: [_jsxs("button", { type: "button", className: "atree-head", "aria-expanded": open, onClick: () => setOpen(!open), children: [open ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }), icon, _jsx("span", { children: title }), _jsx("span", { className: "atree-count", children: kids.length })] }), open && (kids.length ? _jsx("ul", { children: kids }) : _jsx("div", { className: "atree-empty" + (empty?.startsWith("Missing") ? " missing" : ""), children: empty }))] }));
}
const Leaf = ({ text, sub, missing }) => (_jsxs("li", { className: "atree-leaf" + (missing ? " missing" : ""), children: [_jsx("span", { children: text }), sub && _jsx("span", { className: "small faint", children: sub })] }));
export function AutomationTree({ doc, targetNames, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    const kind = doc.trigger.type === "meter_reading" ? "meter" : "asset";
    const targets = targetNames?.length ? targetNames.slice(0, 5).join(", ") + (targetNames.length > 5 ? ` and ${targetNames.length - 5} more` : "")
        : doc.targets.length ? `${doc.targets.length} ${kind}${doc.targets.length === 1 ? "" : "s"}` : "";
    return (_jsxs("section", { className: "card atree", "aria-label": "How this automation works", children: [_jsxs("button", { type: "button", className: "atree-top", "aria-expanded": open, onClick: () => setOpen(!open), children: [open ? _jsx(ChevronDown, { size: 16 }) : _jsx(ChevronRight, { size: 16 }), _jsx(ListTree, { size: 16, "aria-hidden": true }), _jsx("span", { children: "How it works" }), _jsxs("span", { className: "small faint", children: [TRIGGER_LABEL[doc.trigger.type], " \u2192 ", doc.conditions.length, " condition", doc.conditions.length === 1 ? "" : "s", " \u2192 ", doc.actions.length, " action", doc.actions.length === 1 ? "" : "s"] })] }), open && _jsxs("ul", { className: "atree-root", children: [_jsx(Node, { icon: _jsx(Zap, { size: 14, "aria-hidden": true }), title: "When", empty: "", children: [_jsx(Leaf, { text: triggerText(doc), missing: doc.trigger.type === "meter_reading" && !String(doc.trigger.value ?? "").trim() }, "t"), doc.trigger.type === "work_order_status"
                                ? _jsx(Leaf, { text: targets ? `Work orders on ${targets}` : "Work orders on any asset" }, "g")
                                : _jsx(Leaf, { text: targets ? `On ${targets}` : `Missing: pick one or more ${kind}s`, missing: !targets }, "g"),
                            doc.trigger.type === "meter_reading" ? _jsx(Leaf, { text: sensitivityText(doc) }, "s") : null] }), _jsx(Node, { icon: _jsx(Filter, { size: 14, "aria-hidden": true }), title: "Only if", empty: "No conditions: it runs every time the trigger fires.", children: doc.conditions.map((c, i) => _jsx(Leaf, { text: conditionText(c), missing: conditionText(c).includes("pick") }, i)) }), _jsx(Node, { icon: _jsx(Play, { size: 14, "aria-hidden": true }), title: "Then", empty: "Missing: add at least one action.", children: doc.actions.map((a, i) => _jsx(Leaf, { text: actionText(a), sub: ACTION_LABEL[a.type], missing: /\(add/.test(actionText(a)) }, i)) }), doc.rerun_minutes > 0 && _jsx(Leaf, { text: `Then waits ${minutesText(doc.rerun_minutes)} before it can run again` })] })] }));
}
