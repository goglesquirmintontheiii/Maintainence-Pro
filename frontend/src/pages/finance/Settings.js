import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Finance settings: matching tolerances, retention, the email-in mailbox, billing rates and tax, invoice numbering,
// reminders. Owners and admins.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, ListSkeleton, Toggle } from "../../components/ui";
const list = (v) => v.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
export function FinanceSettingsDrawer({ onClose }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["finance", "settings"], queryFn: () => api("/finance/settings") });
    const [f, setF] = useState({});
    useEffect(() => {
        const s = q.data;
        if (!s)
            return;
        setF({ price_tolerance_pct: s.price_tolerance_pct, quantity_tolerance: s.quantity_tolerance, retention_years: String(s.retention_years),
            invoice_prefix: s.invoice_prefix, invoice_due_days: String(s.invoice_due_days), invoice_footer: s.invoice_footer, labor_rate: s.labor_rate,
            parts_markup_pct: s.parts_markup_pct, default_tax_rate_pct: s.default_tax_rate_pct,
            tax_rates: Object.entries(s.tax_rates).map(([k, v]) => `${k}=${v}`).join(", "),
            reminder_days_after_due: s.reminder_days_after_due.join(", "), certificate_reminder_days: s.certificate_reminder_days.join(", "),
            expense_categories: s.expense_categories.join(", "), duplicate_window_days: String(s.duplicate_window_days),
            inbox_enabled: s.inbox_enabled, inbox_host: s.inbox_host, inbox_port: String(s.inbox_port), inbox_user: s.inbox_user, inbox_password: "",
            inbox_folder: s.inbox_folder, inbox_address: s.inbox_address });
    }, [q.data]);
    const save = useMutation({
        mutationFn: () => {
            const tax = {};
            for (const part of String(f.tax_rates || "").split(",")) {
                const [k, v] = part.split("=");
                if (k?.trim() && v?.trim())
                    tax[k.trim().toUpperCase()] = v.trim();
            }
            const body = { ...f, tax_rates: tax, retention_years: Number(f.retention_years), invoice_due_days: Number(f.invoice_due_days),
                duplicate_window_days: Number(f.duplicate_window_days), inbox_port: Number(f.inbox_port), reminder_days_after_due: list(String(f.reminder_days_after_due)),
                certificate_reminder_days: list(String(f.certificate_reminder_days)),
                expense_categories: String(f.expense_categories).split(",").map((x) => x.trim()).filter(Boolean) };
            if (!f.inbox_password)
                delete body.inbox_password; // keep the saved one
            return api("/finance/settings", { method: "PATCH", body });
        },
        onSuccess: (s) => { qc.setQueryData(["finance", "settings"], s); void qc.invalidateQueries({ queryKey: ["finance", "me"] }); toast("Settings saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const test = useMutation({ mutationFn: () => api("/finance/settings/inbox-test", { method: "POST", body: {} }),
        onSuccess: (r) => toast(`Mailbox read: ${r.created} new document${r.created === 1 ? "" : "s"}`), onError: (e) => toast(e.message, { kind: "error" }) });
    const regen = useMutation({ mutationFn: () => api("/finance/settings/inbox-secret", { method: "POST", body: {} }),
        onSuccess: (s) => { qc.setQueryData(["finance", "settings"], s); void qc.invalidateQueries({ queryKey: ["finance", "me"] }); toast("New email-in addresses made"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    const t = (k, label, hint, type = "text") => _jsx(Field, { label: label, hint: hint, children: (fid) => _jsx(Input, { id: fid, type: type, value: String(f[k] ?? ""), onChange: (e) => setF((x) => ({ ...x, [k]: e.target.value })) }) });
    return (_jsx(Drawer, { title: "Finance settings", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Close" }), _jsx(Button, { variant: "primary", onClick: () => save.mutate(), disabled: save.isPending || !q.data, children: "Save" })] }), children: !q.data ? _jsx(ListSkeleton, {}) : _jsxs("div", { className: "stack", children: [_jsx("h3", { className: "sec-h", children: "Invoice matching" }), _jsxs("div", { className: "fin-form-grid", children: [t("price_tolerance_pct", "Price tolerance (%)"), t("quantity_tolerance", "Quantity tolerance"), t("duplicate_window_days", "Duplicate receipts within (days)")] }), _jsx("h3", { className: "sec-h", children: "Customer invoices" }), _jsxs("div", { className: "fin-form-grid", children: [t("invoice_prefix", "Number prefix", "e.g. INV-"), t("invoice_due_days", "Due after (days)"), t("labor_rate", "Labour billing rate / hour", "Empty: each person's rate. Customers can have their own."), t("parts_markup_pct", "Parts markup (%)"), t("default_tax_rate_pct", "Default tax rate (%)"), t("reminder_days_after_due", "Reminders, days after due", "e.g. 7, 14, 30")] }), t("tax_rates", "Tax rate by region", "e.g. US-IL=6.25, US-OH=5.75, CA-ON=13"), t("invoice_footer", "Invoice footer"), q.data.payment_links && _jsxs("p", { className: "faint fin-small", children: ["Online payment links: ", q.data.payment_links.available ? "on" : q.data.payment_links.reason] }), _jsx("h3", { className: "sec-h", children: "Receipts and records" }), _jsxs("div", { className: "fin-form-grid", children: [t("retention_years", "Keep documents (years)"), t("certificate_reminder_days", "Certificate reminders (days before expiry)", "e.g. 60, 30, 7")] }), t("expense_categories", "Expense categories", "Comma-separated"), _jsx("h3", { className: "sec-h", children: "Email-in" }), _jsx(Toggle, { checked: !!f.inbox_enabled, onChange: (v) => setF((x) => ({ ...x, inbox_enabled: v })), label: "Read receipts and invoices from a mailbox", hint: q.data.receipts_address ? `People forward receipts to ${q.data.receipts_address} and invoices to ${q.data.invoices_address}.` : "Save the mailbox address to get the email-in addresses (they include a secret)." }), f.inbox_enabled && _jsxs(_Fragment, { children: [_jsxs("div", { className: "fin-form-grid", children: [t("inbox_address", "Mailbox address", "e.g. ap@yourcompany.com"), t("inbox_host", "IMAP server"), t("inbox_port", "Port"), t("inbox_user", "User name"), t("inbox_password", "Password", q.data.inbox_password_set ? "Saved (encrypted). Type to replace." : undefined, "password"), t("inbox_folder", "Folder")] }), q.data.inbox_help && _jsx("p", { className: "muted fin-small", children: q.data.inbox_help }), _jsxs("div", { className: "row", children: [_jsx(Button, { onClick: () => test.mutate(), disabled: test.isPending, children: "Check the mailbox now" }), _jsx(Button, { variant: "ghost", disabled: regen.isPending, onClick: () => { if (confirm("Make new email-in addresses? Mail sent to the current ones will be ignored."))
                                        regen.mutate(); }, children: "Regenerate addresses" })] })] })] }) }));
}
