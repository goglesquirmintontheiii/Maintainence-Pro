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

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => n < 1 && (e as { status?: number }).status !== 404, refetchOnWindowFocus: false } } });

function Splash() {
  return <div style={{ height: "100%", display: "grid", placeItems: "center" }}><LogoMark size={56} /></div>;
}

function Gate() {
  const { session } = useSession();
  const loc = useLocation();
  const publicPaths = ["/login", "/forgot-password", "/reset-password"];
  const isPublic = publicPaths.some((p) => loc.pathname.startsWith(p));
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
        <Route path="locations" element={<LocationsPage />} />
        <Route path="locations/:id" element={<LocationsPage />} />
        <Route path="locations/:id/:tab" element={<LocationsPage />} />
        <Route path="meters" element={<MetersPage />} />
        <Route path="meters/:id" element={<MetersPage />} />
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
          <SessionProvider fallback={<Splash />}><Gate /></SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
