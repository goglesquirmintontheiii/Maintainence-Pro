import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, FlaskConical } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input } from "../components/ui";
import { LogoMark } from "../components/Logo";
function AuthLayout({ children }) {
    return (_jsxs("div", { className: "auth", children: [_jsxs("section", { className: "auth-brand", "aria-hidden": "true", children: [_jsxs("div", { className: "row", style: { gap: 12 }, children: [_jsx(LogoMark, { size: 44 }), _jsx("span", { style: { fontWeight: 700, fontSize: 18 }, children: "Maintenance Pro" })] }), _jsxs("div", { children: [_jsxs("h1", { children: ["Maintenance work,", _jsx("br", {}), _jsx("b", { children: "on your own servers." })] }), _jsx("p", { children: "Work orders, assets, preventive maintenance and parts, in a layout your team already knows." })] }), _jsx("div", { className: "small", style: { color: "#b9cdf5" }, children: "Self-hosted CMMS \u00B7 Python \u00B7 Flask \u00B7 PostgreSQL" })] }), _jsx("section", { className: "auth-form", children: _jsx("div", { className: "auth-card", children: children }) })] }));
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
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const s = await api("/auth/login", { method: "POST", body: { email, password, remember } });
            set(s);
            nav(params.get("next") || "/", { replace: true });
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs(AuthLayout, { children: [_jsxs("div", { children: [_jsx("h1", { children: "Sign in" }), _jsx("p", { className: "muted", style: { marginTop: 6 }, children: "Welcome back to Maintenance Pro." })] }), session.test_build && session.demo_login && (_jsxs("div", { className: "banner info", children: [_jsx(FlaskConical, { size: 18 }), _jsxs("div", { className: "grow", children: [_jsx("b", { children: "Test build." }), " Sign in with the demo administrator ", _jsx("span", { className: "mono", children: session.demo_login.email }), " / ", _jsx("span", { className: "mono", children: session.demo_login.password }), ".", _jsx("div", { style: { marginTop: 6 }, children: _jsx("button", { className: "linkbtn", onClick: () => { setEmail(session.demo_login.email); setPassword(session.demo_login.password); }, children: "Fill in the demo login" }) })] })] })), _jsxs("form", { className: "stack", style: { gap: 16 }, onSubmit: submit, noValidate: true, children: [_jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", autoComplete: "username", value: email, onChange: (e) => setEmail(e.target.value), required: true, autoFocus: true }) }), _jsx(Field, { label: "Password", children: (id) => _jsx(Input, { id: id, type: "password", autoComplete: "current-password", value: password, onChange: (e) => setPassword(e.target.value), required: true }) }), _jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("label", { className: "row small", children: [_jsx("input", { type: "checkbox", checked: remember, onChange: (e) => setRemember(e.target.checked) }), " Keep me signed in"] }), _jsx(Link, { to: "/forgot-password", className: "small", children: "Forgot password?" })] }), error && _jsx("div", { className: "banner warning", role: "alert", children: error }), _jsx(Button, { type: "submit", variant: "primary", size: "lg", block: true, disabled: busy || !email || !password, children: busy ? "Signing in…" : "Sign in" })] }), _jsxs("p", { className: "small faint", children: ["MPro ", session.version, " \u00B7 ", session.edition === "cloud" ? "MPro Cloud" : "Self-hosted"] })] }));
}
export function ForgotPassword() {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api("/auth/password/forgot", { method: "POST", body: { email } });
            setSent(true);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs(AuthLayout, { children: [_jsxs("div", { children: [_jsx("h1", { children: "Reset your password" }), _jsx("p", { className: "muted", style: { marginTop: 6 }, children: "Enter your email and we'll send you a link to set a new password." })] }), sent ? (_jsxs("div", { className: "banner info", role: "status", children: [_jsx(CheckCircle2, { size: 18 }), _jsxs("div", { children: ["If ", _jsx("b", { children: email }), " has an account, a reset link is on its way. It works for 1 hour.", _jsx("div", { className: "small muted", style: { marginTop: 6 }, children: "No email server set up yet? An administrator can find the link in Settings \u2192 Email outbox." })] })] })) : (_jsxs("form", { className: "stack", style: { gap: 16 }, onSubmit: submit, children: [_jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true, autoFocus: true }) }), error && _jsx("div", { className: "banner warning", role: "alert", children: error }), _jsx(Button, { type: "submit", variant: "primary", size: "lg", block: true, disabled: busy || !email, children: busy ? "Sending…" : "Send reset link" })] })), _jsx(Link, { to: "/login", className: "small", children: "Back to sign in" })] }));
}
export function ResetPassword() {
    const { token = "" } = useParams();
    const [params] = useSearchParams();
    const { set } = useSession();
    const nav = useNavigate();
    const [info, setInfo] = useState(null);
    const [bad, setBad] = useState("");
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        api("/auth/password/check", { method: "POST", body: { token } })
            .then(setInfo).catch((e) => setBad(e.message));
    }, [token]);
    const invite = info?.purpose === "invite" || params.get("invite") === "1";
    const submit = async (e) => {
        e.preventDefault();
        if (pw !== pw2) {
            setError("The two passwords don't match.");
            return;
        }
        setBusy(true);
        setError("");
        try {
            set(await api("/auth/password/reset", { method: "POST", body: { token, password: pw } }));
            nav("/", { replace: true });
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs(AuthLayout, { children: [_jsxs("div", { children: [_jsx("h1", { children: invite ? "Welcome to Maintenance Pro" : "Choose a new password" }), info && _jsx("p", { className: "muted", style: { marginTop: 6 }, children: invite ? `Hi ${info.name}, set a password to finish creating your account.` : `For ${info.email}.` })] }), bad ? _jsxs(_Fragment, { children: [_jsx("div", { className: "banner warning", role: "alert", children: bad }), _jsx(Link, { to: "/forgot-password", children: "Ask for a new link" })] }) : (_jsxs("form", { className: "stack", style: { gap: 16 }, onSubmit: submit, children: [_jsx(Field, { label: "New password", hint: "At least 8 characters.", children: (id) => _jsx(Input, { id: id, type: "password", autoComplete: "new-password", value: pw, onChange: (e) => setPw(e.target.value), autoFocus: true }) }), _jsx(Field, { label: "Repeat the password", children: (id) => _jsx(Input, { id: id, type: "password", autoComplete: "new-password", value: pw2, onChange: (e) => setPw2(e.target.value) }) }), error && _jsx("div", { className: "banner warning", role: "alert", children: error }), _jsx(Button, { type: "submit", variant: "primary", size: "lg", block: true, disabled: busy || !info || pw.length < 8, children: busy ? "Saving…" : invite ? "Set password and sign in" : "Save new password" })] }))] }));
}
export function NoOrganization() {
    const { session, set } = useSession();
    return (_jsxs(AuthLayout, { children: [_jsx("h1", { children: "You're not in an organization" }), _jsxs("p", { className: "muted", children: [session.user?.email, " isn't a member of any organization right now. Ask an administrator to invite you again."] }), _jsx(Button, { onClick: async () => set(await api("/auth/logout", { method: "POST" })), children: "Sign out" })] }));
}
