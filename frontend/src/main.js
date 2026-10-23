import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { SessionProvider, useSession } from "./lib/session";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./shell/AppShell";
import { NAV } from "./shell/nav";
import { ForgotPassword, Login, NoOrganization, ResetPassword } from "./pages/Auth";
import { Overview } from "./pages/Overview";
import { ComingSoon, NotFound } from "./pages/ComingSoon";
import { People } from "./pages/People";
import { WorkOrdersPage } from "./pages/workorders/WorkOrders";
import { Categories } from "./pages/Categories";
import { Downloads } from "./pages/Downloads";
import { WorkOrderSettings } from "./pages/WorkOrderSettings";
import { AuditLog, DesignSystem, EmailOutbox, Jobs, OrganizationSettings, Profile, SettingsIndex, SettingsLayout } from "./pages/Settings";
import { LogoMark } from "./components/Logo";
import { AssetsPage } from "./pages/assets/Assets";
import { LocationsPage } from "./pages/assets/Locations";
import { AssetSettingsPage } from "./pages/assets/AssetSettings";
import { MetersPage } from "./pages/meters/Meters";
import { ScanPage } from "./pages/scan/Scan";
import { QrResolve } from "./pages/scan/QrResolve";
import { QrCodesPage } from "./pages/scan/QrCodes";
import { PMPage } from "./pages/pm/PM";
import { ProceduresPage } from "./pages/procedures/Procedures";
import { AutomationsPage } from "./pages/automations/Automations";
import { RolesPage } from "./pages/roles/Roles";
import { PartsPage } from "./pages/parts/Parts";
import { PartsSettingsPage } from "./pages/parts/PartsSettings";
import { PurchaseOrdersPage } from "./pages/purchasing/PurchaseOrders";
import { PurchasingSettingsPage } from "./pages/purchasing/PurchasingSettings";
import { VendorsPage } from "./pages/vendors/Vendors";
import { CustomersPage } from "./pages/vendors/Customers";
import { FinancePage } from "./pages/finance/Finance";
import { SupplierSettingsPage } from "./pages/suppliers/SupplierSettings";
import { ExternalWorkOrder } from "./pages/external/ExternalWorkOrder";
import { AssetHubPage } from "./pages/assets/AssetHub";
import { PublicQuotePage } from "./pages/vendors/PublicQuote";
import "./devtools/feedback"; // TEMPORARY Ctrl+Shift+F feedback capture (0.4.2). Remove by 1.9.0, see devtools/feedback/README.md
const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => n < 1 && e.status !== 404, refetchOnWindowFocus: false } } });
function Splash() {
    return _jsx("div", { style: { height: "100%", display: "grid", placeItems: "center" }, children: _jsx(LogoMark, { size: 56 }) });
}
function Gate() {
    const { session } = useSession();
    const loc = useLocation();
    const publicPaths = ["/login", "/forgot-password", "/reset-password"];
    const isPublic = publicPaths.some((p) => loc.pathname.startsWith(p));
    // a customer's quote link (r235) works signed in or out
    if (loc.pathname.startsWith("/quote/"))
        return _jsx(Routes, { children: _jsx(Route, { path: "/quote/:token", element: _jsx(PublicQuotePage, {}) }) });
    if (!session.authenticated) {
        return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(Login, {}) }), _jsx(Route, { path: "/forgot-password", element: _jsx(ForgotPassword, {}) }), _jsx(Route, { path: "/reset-password/:token", element: _jsx(ResetPassword, {}) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: `/login${loc.pathname !== "/" ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : ""}`, replace: true }) })] }));
    }
    if (isPublic && !loc.pathname.startsWith("/reset-password"))
        return _jsx(Navigate, { to: "/", replace: true });
    if (!session.org)
        return _jsxs(Routes, { children: [_jsx(Route, { path: "/reset-password/:token", element: _jsx(ResetPassword, {}) }), _jsx(Route, { path: "*", element: _jsx(NoOrganization, {}) })] });
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/reset-password/:token", element: _jsx(ResetPassword, {}) }), _jsxs(Route, { element: _jsx(AppShell, {}), children: [_jsx(Route, { index: true, element: _jsx(Overview, {}) }), _jsx(Route, { path: "people", element: _jsx(Navigate, { to: "/people/users", replace: true }) }), _jsx(Route, { path: "people/:tab", element: _jsx(People, {}) }), _jsx(Route, { path: "people/:tab/:id", element: _jsx(People, {}) }), _jsx(Route, { path: "work-orders", element: _jsx(WorkOrdersPage, {}) }), _jsx(Route, { path: "work-orders/:id", element: _jsx(WorkOrdersPage, {}) }), _jsx(Route, { path: "assets", element: _jsx(AssetsPage, {}) }), _jsx(Route, { path: "assets/:id", element: _jsx(AssetsPage, {}) }), _jsx(Route, { path: "assets/:id/:tab", element: _jsx(AssetsPage, {}) }), _jsx(Route, { path: "asset-hub", element: _jsx(AssetHubPage, {}) }), _jsx(Route, { path: "locations", element: _jsx(LocationsPage, {}) }), _jsx(Route, { path: "locations/:id", element: _jsx(LocationsPage, {}) }), _jsx(Route, { path: "locations/:id/:tab", element: _jsx(LocationsPage, {}) }), _jsx(Route, { path: "meters", element: _jsx(MetersPage, {}) }), _jsx(Route, { path: "meters/:id", element: _jsx(MetersPage, {}) }), _jsx(Route, { path: "preventive-maintenance", element: _jsx(PMPage, {}) }), _jsx(Route, { path: "preventive-maintenance/:id", element: _jsx(PMPage, {}) }), _jsx(Route, { path: "procedures", element: _jsx(ProceduresPage, {}) }), _jsx(Route, { path: "procedures/:id", element: _jsx(ProceduresPage, {}) }), _jsx(Route, { path: "procedures/:id/:mode", element: _jsx(ProceduresPage, {}) }), _jsx(Route, { path: "automations", element: _jsx(AutomationsPage, {}) }), _jsx(Route, { path: "automations/:id", element: _jsx(AutomationsPage, {}) }), _jsx(Route, { path: "parts", element: _jsx(PartsPage, {}) }), _jsx(Route, { path: "parts/:id", element: _jsx(PartsPage, {}) }), _jsx(Route, { path: "parts/:id/:tab", element: _jsx(PartsPage, {}) }), _jsx(Route, { path: "purchase-orders", element: _jsx(PurchaseOrdersPage, {}) }), _jsx(Route, { path: "purchase-orders/:id", element: _jsx(PurchaseOrdersPage, {}) }), _jsx(Route, { path: "vendors", element: _jsx(VendorsPage, {}) }), _jsx(Route, { path: "vendors/:id", element: _jsx(VendorsPage, {}) }), _jsx(Route, { path: "vendors/:id/:tab", element: _jsx(VendorsPage, {}) }), _jsx(Route, { path: "customers", element: _jsx(CustomersPage, {}) }), _jsx(Route, { path: "customers/:id", element: _jsx(CustomersPage, {}) }), _jsx(Route, { path: "customers/:id/:tab", element: _jsx(CustomersPage, {}) }), _jsx(Route, { path: "finance", element: _jsx(FinancePage, {}) }), _jsx(Route, { path: "finance/:tab", element: _jsx(FinancePage, {}) }), _jsx(Route, { path: "finance/:tab/:id", element: _jsx(FinancePage, {}) }), _jsx(Route, { path: "scan", element: _jsx(ScanPage, {}) }), _jsx(Route, { path: "q/:code", element: _jsx(QrResolve, {}) }), _jsx(Route, { path: "categories", element: _jsx(Categories, {}) }), _jsx(Route, { path: "downloads", element: _jsx(Downloads, {}) }), _jsxs(Route, { path: "settings", element: _jsx(SettingsLayout, {}), children: [_jsx(Route, { index: true, element: _jsx(SettingsIndex, {}) }), _jsx(Route, { path: "organization", element: _jsx(OrganizationSettings, {}) }), _jsx(Route, { path: "work-orders", element: _jsx(WorkOrderSettings, {}) }), _jsx(Route, { path: "assets", element: _jsx(AssetSettingsPage, {}) }), _jsx(Route, { path: "qr-codes", element: _jsx(QrCodesPage, {}) }), _jsx(Route, { path: "parts", element: _jsx(PartsSettingsPage, {}) }), _jsx(Route, { path: "purchasing", element: _jsx(PurchasingSettingsPage, {}) }), _jsx(Route, { path: "suppliers", element: _jsx(SupplierSettingsPage, {}) }), _jsx(Route, { path: "roles", element: _jsx(RolesPage, {}) }), _jsx(Route, { path: "audit-log", element: _jsx(AuditLog, {}) }), _jsx(Route, { path: "jobs", element: _jsx(Jobs, {}) }), _jsx(Route, { path: "email", element: _jsx(EmailOutbox, {}) }), _jsx(Route, { path: "design-system", element: _jsx(DesignSystem, {}) })] }), _jsx(Route, { path: "profile", element: _jsx(Profile, {}) }), NAV.filter((n) => n.phase).map((n) => _jsx(Route, { path: n.path.slice(1) + "/*", element: _jsx(ComingSoon, { item: n }) }, n.id)), _jsx(Route, { path: "*", element: _jsx(NotFound, {}) })] })] }));
}
createRoot(document.getElementById("root")).render(_jsx(StrictMode, { children: _jsx(QueryClientProvider, { client: qc, children: _jsx(BrowserRouter, { children: _jsx(ToastProvider, { children: window.location.pathname.startsWith("/x/") ? _jsx(ExternalWorkOrder, {}) /* public work order link, no login (0.5.0) */ : _jsx(SessionProvider, { fallback: _jsx(Splash, {}), children: _jsx(Gate, {}) }) }) }) }) }));
