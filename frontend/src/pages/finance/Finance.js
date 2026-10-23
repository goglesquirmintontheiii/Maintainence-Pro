import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Finance (0.5.0, MP-090–MP-094). Tabs: Receipts, Vendor invoices, Customer invoices, Tax certificates, Cards,
// Documents, Reports. Technicians (finance.receipts only) see Receipts — plus the exemption cards they may show.
// Phone-first (G-18): the list and the detail take the whole screen in turn; the tab strip scrolls sideways.
import { useEffect } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { api } from "../../lib/api";
import { Button, EmptyState, ListSkeleton } from "../../components/ui";
import { CardsTab } from "./Cards";
import { CertificatesTab } from "./Certificates";
import { CustomerInvoicesTab } from "./CustomerInvoices";
import { DocumentsTab } from "./Documents";
import { ReceiptsTab } from "./Receipts";
import { ReportsTab } from "./Reports";
import { FinanceSettingsDrawer } from "./Settings";
import { VendorInvoicesTab } from "./VendorInvoices";
import { useFinanceMe } from "./types";
import "./finance.css";
const TABS = [
    { id: "receipts", label: "Receipts", show: (m) => m.can["finance.receipts"], count: (s) => s.receipts_new },
    { id: "vendor-invoices", label: "Vendor invoices", show: (m) => m.can["finance.view"], count: (s) => s.invoice_exceptions },
    { id: "customer-invoices", label: "Customer invoices", show: (m) => m.can["finance.view"], count: (s) => s.customer_overdue },
    { id: "certificates", label: "Tax certificates", show: (m) => m.can["finance.tax_certificates"] || m.has_certificates,
        count: (s) => s.certificates_expiring },
    { id: "cards", label: "Cards", show: (m) => m.can["finance.view"], count: (s) => s.unmatched_card_charges },
    { id: "documents", label: "Documents", show: (m) => m.can["finance.view"] },
    { id: "reports", label: "Reports", show: (m) => m.can["finance.view"] },
];
export function FinancePage() {
    const { tab, id } = useParams();
    const nav = useNavigate();
    const me = useFinanceMe();
    const isFinance = !!me.data?.can["finance.view"];
    const summary = useQuery({ queryKey: ["finance", "summary"], queryFn: () => api("/finance/summary"), enabled: isFinance,
        staleTime: 30_000 });
    const settingsOpen = tab === "settings";
    useEffect(() => { try {
        if (tab && tab !== "settings")
            sessionStorage.setItem("finance.tab", tab);
    }
    catch { /* private mode */ } }, [tab]);
    if (me.isLoading)
        return _jsx("div", { className: "page", children: _jsx(ListSkeleton, {}) });
    if (me.isError || !me.data) {
        return _jsx("div", { className: "page", children: _jsx(EmptyState, { title: "Finance isn't available", children: "You don't have access to Finance in this organization." }) });
    }
    const m = me.data;
    const tabs = TABS.filter((t) => t.show(m));
    if (!tab || (!settingsOpen && !tabs.some((t) => t.id === tab))) {
        let last = "";
        try {
            last = sessionStorage.getItem("finance.tab") ?? "";
        }
        catch { /* private mode */ }
        return _jsx(Navigate, { to: `/finance/${tabs.some((t) => t.id === last) ? last : tabs[0]?.id ?? "receipts"}`, replace: true });
    }
    const active = settingsOpen ? (tabs[0]?.id ?? "receipts") : tab;
    // people with only finance.receipts get a single, simple screen (no tab strip with one tab)
    const strip = tabs.length > 1;
    return (_jsxs("div", { className: "fin-page" + (id ? " has-id" : ""), children: [strip && (_jsxs("div", { className: "fin-top", children: [_jsx("div", { className: "fin-tabs", role: "tablist", "aria-label": "Finance", children: tabs.map((t) => {
                            const n = summary.data && t.count ? t.count(summary.data) : 0;
                            return _jsxs(Link, { to: `/finance/${t.id}`, role: "tab", "aria-selected": active === t.id, className: "tab" + (active === t.id ? " active" : ""), children: [t.label, n > 0 && _jsx("span", { className: "tab-count", children: n })] }, t.id);
                        }) }), m.can["finance.export"] && _jsx(Button, { icon: true, "aria-label": "Finance settings", title: "Finance settings", onClick: () => nav("/finance/settings"), children: _jsx(Settings2, { size: 17 }) })] })), _jsxs("div", { className: "fin-body", children: [active === "receipts" && _jsx(ReceiptsTab, { me: m, id: id, single: !strip }), active === "vendor-invoices" && _jsx(VendorInvoicesTab, { me: m, id: id }), active === "customer-invoices" && _jsx(CustomerInvoicesTab, { me: m, id: id }), active === "certificates" && _jsx(CertificatesTab, { me: m, id: id }), active === "cards" && _jsx(CardsTab, { me: m, id: id }), active === "documents" && _jsx(DocumentsTab, { me: m }), active === "reports" && _jsx(ReportsTab, { me: m })] }), settingsOpen && _jsx(FinanceSettingsDrawer, { onClose: () => nav(-1) })] }));
}
