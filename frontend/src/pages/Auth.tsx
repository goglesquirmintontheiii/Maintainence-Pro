import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, FlaskConical } from "lucide-react";
import { api, ApiError, type Session } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input } from "../components/ui";
import { LogoMark } from "../components/Logo";

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-brand" aria-hidden="true">
        <div className="row" style={{ gap: 12 }}><LogoMark size={44} /><span style={{ fontWeight: 700, fontSize: 18 }}>Maintenance Pro</span></div>
        <div>
          <h1>Maintenance work,<br /><b>on your own servers.</b></h1>
          <p>Work orders, assets, preventive maintenance and parts, in a layout your team already knows.</p>
        </div>
        <div className="small" style={{ color: "#b9cdf5" }}>Self-hosted CMMS · Python · Flask · PostgreSQL</div>
      </section>
      <section className="auth-form"><div className="auth-card">{children}</div></section>
    </div>
  );
}

export function Login() {
  const { session, set } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const s = await api<Session>("/auth/login", { method: "POST", body: { email, password, remember } });
      set(s);
      nav(params.get("next") || "/", { replace: true });
    } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <div><h1>Sign in</h1><p className="muted" style={{ marginTop: 6 }}>Welcome back to Maintenance Pro.</p></div>
      {session.test_build && session.demo_login && (
        <div className="banner info"><FlaskConical size={18} />
          <div className="grow"><b>Test build.</b> Sign in with the demo administrator <span className="mono">{session.demo_login.email}</span> / <span className="mono">{session.demo_login.password}</span>.
            <div style={{ marginTop: 6 }}><button className="linkbtn" onClick={() => { setEmail(session.demo_login!.email); setPassword(session.demo_login!.password); }}>Fill in the demo login</button></div></div>
        </div>)}
      <form className="stack" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label className="row small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in</label>
          <Link to="/forgot-password" className="small">Forgot password?</Link>
        </div>
        {error && <div className="banner warning" role="alert">{error}</div>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="small faint">MPro {session.version} · {session.edition === "cloud" ? "MPro Cloud" : "Self-hosted"}</p>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/auth/password/forgot", { method: "POST", body: { email } }); setSent(true); }
    catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <div><h1>Reset your password</h1><p className="muted" style={{ marginTop: 6 }}>Enter your email and we'll send you a link to set a new password.</p></div>
      {sent ? (
        <div className="banner info" role="status"><CheckCircle2 size={18} /><div>If <b>{email}</b> has an account, a reset link is on its way. It works for 1 hour.
          <div className="small muted" style={{ marginTop: 6 }}>No email server set up yet? An administrator can find the link in Settings → Email outbox.</div></div></div>
      ) : (
        <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
          <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
          {error && <div className="banner warning" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block disabled={busy || !email}>{busy ? "Sending…" : "Send reset link"}</Button>
        </form>
      )}
      <Link to="/login" className="small">Back to sign in</Link>
    </AuthLayout>
  );
}

export function ResetPassword() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const { set } = useSession();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ email: string; name: string; purpose: string } | null>(null);
  const [bad, setBad] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ email: string; name: string; purpose: string }>("/auth/password/check", { method: "POST", body: { token } })
      .then(setInfo).catch((e) => setBad((e as ApiError).message));
  }, [token]);
  const invite = info?.purpose === "invite" || params.get("invite") === "1";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) { setError("The two passwords don't match."); return; }
    setBusy(true); setError("");
    try { set(await api<Session>("/auth/password/reset", { method: "POST", body: { token, password: pw } })); nav("/", { replace: true }); }
    catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <div><h1>{invite ? "Welcome to Maintenance Pro" : "Choose a new password"}</h1>
        {info && <p className="muted" style={{ marginTop: 6 }}>{invite ? `Hi ${info.name}, set a password to finish creating your account.` : `For ${info.email}.`}</p>}</div>
      {bad ? <><div className="banner warning" role="alert">{bad}</div><Link to="/forgot-password">Ask for a new link</Link></> : (
        <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
          <Field label="New password" hint="At least 8 characters.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />}</Field>
          <Field label="Repeat the password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
          {error && <div className="banner warning" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block disabled={busy || !info || pw.length < 8}>{busy ? "Saving…" : invite ? "Set password and sign in" : "Save new password"}</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function NoOrganization() {
  const { session, set } = useSession();
  return (
    <AuthLayout>
      <h1>You're not in an organization</h1>
      <p className="muted">{session.user?.email} isn't a member of any organization right now. Ask an administrator to invite you again.</p>
      <Button onClick={async () => set(await api<Session>("/auth/logout", { method: "POST" }))}>Sign out</Button>
    </AuthLayout>
  );
}
