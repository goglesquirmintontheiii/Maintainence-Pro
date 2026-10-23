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
import { useFinanceMe, type FinanceMe } from "./types";
import "./finance.css";

type Summary = { receipts_new: number; tax_to_reclaim: number; reimbursements_requested: number; invoice_exceptions: number;
  invoices_unpaid: number; customer_overdue: number; certificates_expiring: number; unmatched_card_charges: number };

const TABS: { id: string; label: string; show: (m: FinanceMe) => boolean; count?: (s: Summary) => number }[] = [
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
  const summary = useQuery({ queryKey: ["finance", "summary"], queryFn: () => api<Summary>("/finance/summary"), enabled: isFinance,
    staleTime: 30_000 });
  const settingsOpen = tab === "settings";
  useEffect(() => { try { if (tab && tab !== "settings") sessionStorage.setItem("finance.tab", tab); } catch { /* private mode */ } }, [tab]);

  if (me.isLoading) return <div className="page"><ListSkeleton /></div>;
  if (me.isError || !me.data) {
    return <div className="page"><EmptyState title="Finance isn't available">You don't have access to Finance in this organization.</EmptyState></div>;
  }
  const m = me.data;
  const tabs = TABS.filter((t) => t.show(m));
  if (!tab || (!settingsOpen && !tabs.some((t) => t.id === tab))) {
    let last = "";
    try { last = sessionStorage.getItem("finance.tab") ?? ""; } catch { /* private mode */ }
    return <Navigate to={`/finance/${tabs.some((t) => t.id === last) ? last : tabs[0]?.id ?? "receipts"}`} replace />;
  }
  const active = settingsOpen ? (tabs[0]?.id ?? "receipts") : tab;
  // people with only finance.receipts get a single, simple screen (no tab strip with one tab)
  const strip = tabs.length > 1;
  return (
    <div className={"fin-page" + (id ? " has-id" : "")}>
      {strip && (
        <div className="fin-top">
          <div className="fin-tabs" role="tablist" aria-label="Finance">
            {tabs.map((t) => {
              const n = summary.data && t.count ? t.count(summary.data) : 0;
              return <Link key={t.id} to={`/finance/${t.id}`} role="tab" aria-selected={active === t.id}
                className={"tab" + (active === t.id ? " active" : "")}>{t.label}{n > 0 && <span className="tab-count">{n}</span>}</Link>;
            })}
          </div>
          {m.can["finance.export"] && <Button icon aria-label="Finance settings" title="Finance settings" onClick={() => nav("/finance/settings")}>
            <Settings2 size={17} /></Button>}
        </div>
      )}
      <div className="fin-body">
        {active === "receipts" && <ReceiptsTab me={m} id={id} single={!strip} />}
        {active === "vendor-invoices" && <VendorInvoicesTab me={m} id={id} />}
        {active === "customer-invoices" && <CustomerInvoicesTab me={m} id={id} />}
        {active === "certificates" && <CertificatesTab me={m} id={id} />}
        {active === "cards" && <CardsTab me={m} id={id} />}
        {active === "documents" && <DocumentsTab me={m} />}
        {active === "reports" && <ReportsTab me={m} />}
      </div>
      {settingsOpen && <FinanceSettingsDrawer onClose={() => nav(-1)} />}
    </div>
  );
}
