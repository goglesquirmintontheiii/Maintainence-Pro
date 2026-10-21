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
import { AuditLog, DesignSystem, EmailOutbox, Jobs, OrganizationSettings, Profile, SettingsIndex, SettingsLayout } from "./pages/Settings";
import { LogoMark } from "./components/Logo";

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
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<SettingsIndex />} />
          <Route path="organization" element={<OrganizationSettings />} />
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
