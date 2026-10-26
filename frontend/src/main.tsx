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
import { RequestsPage } from "./pages/requests/Requests";
import { MessagesPage } from "./pages/messages/Messages";
import { NotificationsPage } from "./pages/notifications/Notifications";
import { ManagementPage } from "./pages/sysadmin/Management";
import "./devtools/feedback"; // TEMPORARY Ctrl+Shift+F feedback capture (0.4.2). Remove by 1.9.0, see devtools/feedback/README.md

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => n < 1 && (e as { status?: number }).status !== 404, refetchOnWindowFocus: false } } });

function Splash() {
  return <div style={{ height: "100%", display: "grid", placeItems: "center" }}><LogoMark size={56} /></div>;
}

function Gate() {
  const { session } = useSession();
  const loc = useLocation();
  const publicPaths = ["/login", "/forgot-password", "/reset-password"];
  const isPublic = publicPaths.some((p) => loc.pathname.startsWith(p));
  // a customer's quote link (r235) works signed in or out
  if (loc.pathname.startsWith("/quote/")) return <Routes><Route path="/quote/:token" element={<PublicQuotePage />} /></Routes>;
  if (!session.authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to={`/login${loc.pathname !== "/" ? `?next=${encodeURIComponent(loc.pathname + loc.search)}` : ""}`} replace />} />
      </Routes>
    );
  }
  if (isPublic && !loc.pathname.startsWith("/reset-password")) return <Navigate to="/" replace />;
  if (!session.org) return <Routes><Route path="/reset-password/:token" element={<ResetPassword />} /><Route path="*" element={<NoOrganization />} /></Routes>;
  return (
    <Routes>
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="people" element={<Navigate to="/people/users" replace />} />
        <Route path="people/:tab" element={<People />} />
        <Route path="people/:tab/:id" element={<People />} />
        <Route path="work-orders" element={<WorkOrdersPage />} />
        <Route path="work-orders/:id" element={<WorkOrdersPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="assets/:id" element={<AssetsPage />} />
        <Route path="assets/:id/:tab" element={<AssetsPage />} />
        <Route path="asset-hub" element={<AssetHubPage />} />
        <Route path="locations" element={<LocationsPage />} />
        <Route path="locations/:id" element={<LocationsPage />} />
        <Route path="locations/:id/:tab" element={<LocationsPage />} />
        <Route path="meters" element={<MetersPage />} />
        <Route path="meters/:id" element={<MetersPage />} />
        <Route path="preventive-maintenance" element={<PMPage />} />
        <Route path="preventive-maintenance/:id" element={<PMPage />} />
        <Route path="procedures" element={<ProceduresPage />} />
        <Route path="procedures/:id" element={<ProceduresPage />} />
        <Route path="procedures/:id/:mode" element={<ProceduresPage />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="automations/:id" element={<AutomationsPage />} />
        <Route path="parts" element={<PartsPage />} />
        <Route path="parts/:id" element={<PartsPage />} />
        <Route path="parts/:id/:tab" element={<PartsPage />} />
        <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
        <Route path="purchase-orders/:id" element={<PurchaseOrdersPage />} />
        <Route path="vendors" element={<VendorsPage />} />
        <Route path="vendors/:id" element={<VendorsPage />} />
        <Route path="vendors/:id/:tab" element={<VendorsPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomersPage />} />
        <Route path="customers/:id/:tab" element={<CustomersPage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="finance/:tab" element={<FinancePage />} />
        <Route path="finance/:tab/:id" element={<FinancePage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestsPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="messages/:id" element={<MessagesPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="mpro-management/*" element={<ManagementPage />} />
        <Route path="scan" element={<ScanPage />} />
        <Route path="q/:code" element={<QrResolve />} />
        <Route path="categories" element={<Categories />} />
        <Route path="downloads" element={<Downloads />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<SettingsIndex />} />
          <Route path="organization" element={<OrganizationSettings />} />
          <Route path="work-orders" element={<WorkOrderSettings />} />
          <Route path="assets" element={<AssetSettingsPage />} />
          <Route path="qr-codes" element={<QrCodesPage />} />
          <Route path="parts" element={<PartsSettingsPage />} />
          <Route path="purchasing" element={<PurchasingSettingsPage />} />
          <Route path="suppliers" element={<SupplierSettingsPage />} />
          <Route path="roles" element={<RolesPage />} />
          <Route path="audit-log" element={<AuditLog />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="email" element={<EmailOutbox />} />
          <Route path="design-system" element={<DesignSystem />} />
        </Route>
        <Route path="profile" element={<Profile />} />
        {NAV.filter((n) => n.phase).map((n) => <Route key={n.id} path={n.path.slice(1) + "/*"} element={<ComingSoon item={n} />} />)}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          {window.location.pathname.startsWith("/x/") ? <ExternalWorkOrder /> /* public work order link, no login (0.5.0) */ : <SessionProvider fallback={<Splash />}><Gate /></SessionProvider>}
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
