import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Bulk edit bar (MaintainX web To-Do / Table): status, priority, due date, assignees, categories, read, cancel, delete — with Undo.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CheckCheck, Download, Flag, Tags, Trash2, UserPlus, X } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { atTime, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Modal } from "../../components/ui";
import { ClearableDate } from "../../components/assetPickers";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { ExportDialog } from "./WorkOrders";
export function BulkBar({ ids, items, onDone }) {
    const { can } = useSession();
    const opts = useWOOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [dialog, setDialog] = useState(null);
    const [val, setVal] = useState([]);
    const [text, setText] = useState("");
    const run = useMutation({
        mutationFn: (b) => api("/work-orders/bulk", { method: "POST", body: { ids, ...b } }),
        onSuccess: (r, b) => {
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            qc.invalidateQueries({ queryKey: ["work-order"] });
            qc.invalidateQueries({ queryKey: ["wo-stats"] });
            setDialog(null);
            setVal([]);
            setText("");
            const n = r.updated.length;
            if (r.errors.length)
                toast(`${n} updated. ${r.errors.length} couldn't be: ${r.errors.slice(0, 2).map((e) => `#${e.number} ${e.message}`).join(" ")}`, { kind: "error" });
            else if (b.action !== "revert") {
                const canUndo = b.action === "delete" || (b.action !== "mark_read" && b.action !== "mark_unread" && r.undo.length);
                toast(`Updated ${n} work order${n === 1 ? "" : "s"}`, canUndo ? { action: { label: "Undo", run: () => {
                            if (b.action === "delete")
                                run.mutate({ action: "restore", ids: r.updated });
                            else
                                run.mutate({ action: "revert", value: r.undo, ids: r.updated });
                        } } } : undefined);
            }
            if (b.action === "delete")
                onDone();
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const statuses = (opts.data?.statuses ?? []).filter((s) => s.id !== "canceled");
    const sel = items.filter((w) => ids.includes(w.id));
    return (_jsxs("div", { className: "bulkbar", role: "toolbar", "aria-label": "Bulk actions", children: [_jsxs("span", { className: "small", children: [_jsx("b", { children: ids.length }), " selected"] }), can("wo.edit") && _jsxs(_Fragment, { children: [_jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(Flag, { size: 14 }), "Status"] }), children: (close) => statuses.map((s) => _jsx("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "set_status", value: s.id }); }, children: s.label }, s.id)) }), _jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsx(Button, { size: "sm", onClick: t, children: "Priority" }), children: (close) => (opts.data?.priorities ?? []).map((p) => _jsx("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "set_priority", value: p.id }); }, children: p.label }, p.id)) }), _jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(UserPlus, { size: 14 }), "Assign"] }), children: (close) => _jsxs(_Fragment, { children: [_jsx("button", { className: "menu-item", onClick: () => { close(); setDialog("assign"); }, children: "Add assignees\u2026" }), _jsx("button", { className: "menu-item", onClick: () => { close(); setDialog("unassign"); }, children: "Remove assignees\u2026" })] }) }), _jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(Tags, { size: 14 }), "Categories"] }), children: (close) => _jsxs(_Fragment, { children: [_jsx("button", { className: "menu-item", onClick: () => { close(); setDialog("cats"); }, children: "Add categories\u2026" }), _jsx("button", { className: "menu-item", onClick: () => { close(); setDialog("uncats"); }, children: "Remove categories\u2026" })] }) }), _jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(CalendarClock, { size: 14 }), "Dates"] }), children: (close) => _jsxs(_Fragment, { children: [_jsx("button", { className: "menu-item", onClick: () => { close(); setDialog("due"); }, children: "Change due date\u2026" }), _jsx("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "clear_due" }); }, children: "Remove due date" }), _jsx("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "clear_start" }); }, children: "Remove start date" })] }) })] }), _jsx(Dropdown, { up: true, align: "left", trigger: (_, t) => _jsx(Button, { size: "sm", onClick: t, children: "More" }), children: (close) => _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "mark_read" }); }, children: [_jsx(CheckCheck, { size: 14 }), "Mark as read"] }), _jsx("button", { className: "menu-item", onClick: () => { close(); run.mutate({ action: "mark_unread" }); }, children: "Mark as unread" }), can("exports.use") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setDialog("export"); }, children: [_jsx(Download, { size: 14 }), "Export selected\u2026"] }), can("wo.edit") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setDialog("cancel"); }, children: [_jsx(Ban, { size: 14 }), "Cancel\u2026"] }), can("wo.delete") && _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setDialog("delete"); }, children: [_jsx(Trash2, { size: 14 }), "Delete\u2026"] })] }) }), _jsx("span", { className: "grow" }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Clear selection", onClick: onDone, children: _jsx(X, { size: 16 }) }), (dialog === "assign" || dialog === "unassign") && _jsx(Modal, { title: dialog === "assign" ? "Add assignees" : "Remove assignees", onClose: () => setDialog(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDialog(null), children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: !val.length, onClick: () => run.mutate({ action: dialog === "assign" ? "add_assignees" : "remove_assignees", value: val }), children: ["Apply to ", ids.length] })] }), children: _jsx(AssigneePicker, { options: opts.data, value: val, onChange: setVal }) }), (dialog === "cats" || dialog === "uncats") && _jsx(Modal, { title: dialog === "cats" ? "Add categories" : "Remove categories", onClose: () => setDialog(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDialog(null), children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: !val.length, onClick: () => run.mutate({ action: dialog === "cats" ? "add_categories" : "remove_categories", value: val }), children: ["Apply to ", ids.length] })] }), children: _jsx(CategoryPicker, { options: opts.data, value: val, onChange: setVal }) }), dialog === "due" && _jsx(Modal, { title: "Change due date", onClose: () => setDialog(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDialog(null), children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: !text, onClick: () => run.mutate({ action: "set_due", value: atTime(text, opts.data?.settings.default_due_time ?? "12:00") }), children: ["Apply to ", ids.length] })] }), children: _jsx(Field, { label: "Due date", children: (id) => _jsx(ClearableDate, { id: id, label: "due date", type: "date", value: text, onChange: setText, autoFocus: true }) }) }), dialog === "cancel" && _jsxs(Modal, { title: `Cancel ${ids.length} work order${ids.length === 1 ? "" : "s"}`, onClose: () => setDialog(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDialog(null), children: "Back" }), _jsx(Button, { variant: "danger", className: "solid", disabled: opts.data?.settings.comment_on_cancel === "mandatory" && !text.trim(), onClick: () => run.mutate({ action: "cancel", comment: text }), children: "Cancel work orders" })] }), children: [_jsx(Field, { label: "Reason" + (opts.data?.settings.comment_on_cancel === "mandatory" ? " *" : " (optional)"), children: (id) => _jsx("textarea", { id: id, className: "textarea", value: text, onChange: (e) => setText(e.target.value), autoFocus: true }) }), _jsx("p", { className: "small muted", children: "Canceled work orders stay in reports." })] }), dialog === "delete" && _jsx(Modal, { title: `Delete ${ids.length} work order${ids.length === 1 ? "" : "s"}?`, onClose: () => setDialog(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDialog(null), children: "Keep them" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => run.mutate({ action: "delete" }), children: "Delete" })] }), children: _jsxs("p", { children: [sel.slice(0, 5).map((w) => `#${w.number} ${w.title}`).join(", "), sel.length > 5 ? ` and ${sel.length - 5} more` : "", ". You can undo right after, or restore them later from Table \u2192 Show deleted."] }) }), dialog === "export" && _jsx(ExportDialog, { query: { filters: [], q: "" }, ids: ids, onClose: () => setDialog(null) })] }));
}
