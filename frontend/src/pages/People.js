import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Mail, Plus, Search, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { dateTime, timeAgo } from "../lib/format";
import { useToast } from "../components/Toast";
import { Avatar, AvatarStack, Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../components/ui";
import { ColorPicker } from "../components/ColorPicker";
const ROLE_TONE = { owner: "info", admin: "info", limited_admin: "info", technician: "success",
    operator: "success", custom: "success", requester: "warning", viewer: "neutral" };
function useRoles() { return useQuery({ queryKey: ["roles"], queryFn: () => api("/roles"), staleTime: 60_000 }); }
/** Roles this person may hand out; the server has the final say (nobody grants more than they have). */
function assignableRoles(roles, myRole) {
    return (roles ?? []).filter((r) => !r.deleted && (myRole === "owner" || (r.key !== "owner" && (myRole === "admin" || !["admin", "limited_admin"].includes(r.key)))));
}
const keyOf = (m) => m.role_key ?? m.role;
export function People() {
    const { tab = "users", id } = useParams();
    const { can } = useSession();
    const canUsers = can("users.view");
    const t = tab === "teams" || !canUsers ? "teams" : "users";
    return (_jsxs("div", { className: "split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools", style: { paddingBottom: 0 }, children: [_jsx("div", { className: "row", style: { justifyContent: "space-between" }, children: _jsx("h1", { children: "Teams & Users" }) }), _jsxs("div", { className: "tabs", role: "tablist", children: [canUsers && _jsxs(NavLink, { to: "/people/users", className: () => "tab" + (t === "users" ? " active" : ""), role: "tab", "aria-selected": t === "users", children: [_jsx(Users, { size: 15 }), "Users"] }), _jsx(NavLink, { to: "/people/teams", className: () => "tab" + (t === "teams" ? " active" : ""), role: "tab", "aria-selected": t === "teams", children: "Teams" })] })] }), t === "users" ? _jsx(UserList, { selected: id }) : _jsx(TeamList, { selected: id })] }), _jsx("div", { className: "split-detail", children: id ? (t === "users" ? _jsx(UserDetail, { id: id }) : _jsx(TeamDetail, { id: id }))
                    : _jsx(EmptyState, { icon: _jsx(Users, { size: 28 }), title: t === "users" ? "Select a person" : "Select a team", children: t === "users" ? "Pick someone from the list to see their role, teams and activity." : "Pick a team to see and manage its members." }) })] }));
}
// ---------------------------------------------------------------- users
function UserList({ selected }) {
    const [q, setQ] = useState("");
    const [role, setRole] = useState("");
    const [params, setParams] = useSearchParams();
    const roles = useRoles();
    const { can } = useSession();
    const users = useQuery({ queryKey: ["users", q, role], queryFn: () => api(`/users?q=${encodeURIComponent(q)}&role=${role}`), placeholderData: (p) => p });
    const inviting = params.get("invite") === "1";
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", children: [_jsxs("div", { className: "grow", style: { position: "relative" }, children: [_jsx(Search, { size: 15, className: "faint", style: { position: "absolute", left: 10, top: 10 } }), _jsx(Input, { placeholder: "Search name, email or job title", value: q, onChange: (e) => setQ(e.target.value), style: { paddingLeft: 32 }, "aria-label": "Search users" })] }), can("users.manage") && _jsxs(Button, { variant: "primary", onClick: () => setParams({ invite: "1" }), "aria-label": "Invite", children: [_jsx(UserPlus, { size: 16 }), _jsx("span", { className: "desktop-only", children: "Invite" })] })] }), _jsxs(Select, { value: role, onChange: (e) => setRole(e.target.value), "aria-label": "Filter by role", children: [_jsx("option", { value: "", children: "All roles" }), roles.data?.filter((r) => !r.deleted).map((r) => _jsxs("option", { value: r.key, children: [r.label, r.custom ? " (custom)" : ""] }, r.key))] }), _jsx("div", { className: "small muted", children: users.data ? `${users.data.total} ${users.data.total === 1 ? "person" : "people"}` : " " })] }), _jsx("div", { className: "list", role: "list", children: users.isLoading ? _jsx(ListSkeleton, {}) : users.data?.items.length === 0 ? _jsx(EmptyState, { title: "Nobody matches", children: "Try a different name or role." })
                    : users.data?.items.map((u) => (_jsxs(Link, { to: `/people/users/${u.id}`, className: "list-row" + (u.id === selected ? " active" : ""), role: "listitem", children: [_jsx(Avatar, { name: u.name, initials: u.initials, src: u.avatar_url }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "t", children: u.name }), _jsx("div", { className: "s", children: u.job_title || u.email })] }), _jsx(Pill, { tone: ROLE_TONE[u.role], children: u.role_label })] }, u.id))) }), inviting && _jsx(InviteModal, { onClose: () => setParams({}) })] }));
}
function InviteModal({ onClose }) {
    const roles = useRoles();
    const { session } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const [f, setF] = useState({ email: "", name: "", role: "technician", job_title: "" });
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => api("/users", { method: "POST", body: f }),
        onSuccess: (u) => { qc.invalidateQueries({ queryKey: ["users"] }); toast(`Invitation sent to ${u.email}`); onClose(); nav(`/people/users/${u.id}`); },
        onError: (e) => setErr(e.message),
    });
    const assignable = assignableRoles(roles.data, session.role);
    return (_jsxs(Modal, { title: "Invite a person", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.email || m.isPending, onClick: () => m.mutate(), children: m.isPending ? "Sending…" : "Send invitation" })] }), children: [_jsx("p", { className: "muted", children: "They'll get an email with a link to set their password. Requesters are free and unlimited." }), _jsx(Field, { label: "Email", children: (id) => _jsx(Input, { id: id, type: "email", value: f.email, onChange: (e) => setF({ ...f, email: e.target.value }) }) }), _jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, onChange: (e) => setF({ ...f, name: e.target.value }) }) }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Role", children: (id) => _jsx(Select, { id: id, value: f.role, onChange: (e) => setF({ ...f, role: e.target.value }), children: assignable.map((r) => _jsxs("option", { value: r.key, children: [r.label, r.custom ? " (custom)" : ""] }, r.key)) }) }), _jsx(Field, { label: "Job title (optional)", children: (id) => _jsx(Input, { id: id, value: f.job_title, onChange: (e) => setF({ ...f, job_title: e.target.value }) }) })] }), _jsx("p", { className: "small muted", children: roles.data?.find((r) => r.key === f.role)?.description }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
function UserDetail({ id }) {
    const { session, can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const roles = useRoles();
    const u = useQuery({ queryKey: ["user", id], queryFn: () => api(`/users/${id}`) });
    const [confirm, setConfirm] = useState(false);
    const [transfer, setTransfer] = useState(null);
    const { refresh } = useSession();
    const makeOwner = useMutation({
        mutationFn: (stay) => api("/org/transfer-ownership", { method: "POST", body: { user_id: id, stay_owner: stay } }),
        onSuccess: async (m) => {
            qc.setQueryData(["user", id], m);
            qc.invalidateQueries({ queryKey: ["users"] });
            qc.invalidateQueries({ queryKey: ["roles"] });
            setTransfer(null);
            toast(`${m.name} is now an Owner`);
            await refresh();
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const save = useMutation({
        mutationFn: (body) => api(`/users/${id}`, { method: "PATCH", body }),
        onSuccess: (m) => { qc.setQueryData(["user", id], m); qc.invalidateQueries({ queryKey: ["users"] }); toast("Saved"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const remove = useMutation({
        mutationFn: () => api(`/users/${id}`, { method: "DELETE" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast("Removed from the organization"); nav("/people/users"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (u.isError)
        return _jsx(EmptyState, { title: "Person not found", children: "They may have been removed from this organization." });
    if (!u.data)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 3 }) });
    const m = u.data;
    const manage = can("users.manage") && m.id !== session.user?.id;
    const assignable = assignableRoles(roles.data, session.role);
    return (_jsxs("div", { className: "detail", children: [_jsxs(Link, { to: "/people/users", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All people"] }), _jsxs("div", { className: "detail-head", children: [_jsx(Avatar, { name: m.name, initials: m.initials, size: "xl", src: m.avatar_url }), _jsxs("div", { className: "grow", children: [_jsx("h1", { children: m.name }), _jsx("div", { className: "muted", children: m.job_title || "No job title" }), _jsxs("div", { className: "row wrap", style: { marginTop: 8 }, children: [_jsx(Pill, { tone: ROLE_TONE[m.role], children: m.role_label }), !m.has_password && _jsx(Pill, { tone: "warning", children: "Invitation pending" })] })] }), _jsxs("a", { className: "btn", href: `mailto:${m.email}`, children: [_jsx(Mail, { size: 16 }), "Email"] })] }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { children: [_jsx("dt", { children: "Email" }), _jsx("dd", { children: m.email })] }), _jsxs("div", { children: [_jsx("dt", { children: "Last signed in" }), _jsx("dd", { title: dateTime(m.last_login_at), children: timeAgo(m.last_login_at) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Joined" }), _jsx("dd", { children: dateTime(m.joined_at) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Teams" }), _jsx("dd", { className: "row wrap", children: m.teams.length ? m.teams.map((t) => _jsxs(Link, { to: `/people/teams/${t.id}`, className: "chip", children: [_jsx("span", { className: "sw", style: { background: t.color } }), t.name] }, t.id)) : _jsx("span", { className: "faint", children: "None" }) })] })] }), manage && (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Role and details" }) }), _jsxs("div", { className: "card-body form-grid", children: [_jsx(Field, { label: "Role", hint: roles.data?.find((r) => r.key === keyOf(m))?.description, children: (fid) => (_jsx(Select, { id: fid, value: keyOf(m), disabled: save.isPending || !assignable.some((r) => r.key === keyOf(m)), onChange: (e) => save.mutate({ role: e.target.value }), children: (assignable.some((r) => r.key === keyOf(m)) ? assignable : roles.data ?? []).map((r) => _jsxs("option", { value: r.key, children: [r.label, r.custom ? " (custom)" : ""] }, r.key)) })) }), _jsx(Field, { label: "Job title", children: (fid) => _jsx(Input, { id: fid, defaultValue: m.job_title, onBlur: (e) => { if (e.target.value !== m.job_title)
                                        save.mutate({ job_title: e.target.value }); } }, m.job_title) })] }), session.role === "owner" && m.role !== "owner" && m.has_password && (_jsxs("div", { className: "card-body row wrap", style: { borderTop: "1px solid var(--c-border-soft)" }, children: [_jsx("span", { className: "grow small muted", children: "Owners can change organization settings, billing and roles. Every organization needs at least one." }), _jsxs(Button, { onClick: () => setTransfer({ stay: false }), children: ["Make ", m.name.split(" ")[0], " an Owner\u2026"] })] })), _jsx("div", { className: "card-body", style: { borderTop: "1px solid var(--c-border-soft)" }, children: confirm ? _jsxs("div", { className: "row wrap", children: [_jsxs("span", { className: "grow", children: ["Remove ", m.name, " from ", session.org?.name, "? Their history stays in the audit log."] }), _jsx(Button, { onClick: () => setConfirm(false), children: "Keep" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => remove.mutate(), disabled: remove.isPending, children: "Remove" })] })
                            : _jsxs(Button, { variant: "danger", onClick: () => setConfirm(true), children: [_jsx(Trash2, { size: 15 }), "Remove from organization"] }) })] })), can("wo.view") && ["owner", "admin", "limited_admin", "technician", "operator", "custom"].includes(m.role) && _jsx(WorkSettings, { userId: m.id, manage: can("users.manage") && !["owner", "admin"].includes(m.role), self: m.id === session.user?.id }), can("audit.view") && _jsx(Link, { to: `/settings/audit-log?entity_id=${m.id}`, className: "small", children: "See this person's history in the audit log" }), transfer && _jsxs(Modal, { title: `Make ${m.name} an Owner?`, onClose: () => setTransfer(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setTransfer(null), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: makeOwner.isPending, onClick: () => makeOwner.mutate(transfer.stay), children: "Make Owner" })] }), children: [_jsxs("p", { children: [m.name, " will get full access, including organization settings, billing and roles."] }), _jsxs("label", { className: "check", children: [_jsx("input", { type: "checkbox", checked: transfer.stay, onChange: (e) => setTransfer({ stay: e.target.checked }) }), _jsx("span", { children: "I stay an Owner too (otherwise I become an Administrator)" })] })] })] }));
}
// ---------------------------------------------------------------- teams
function TeamList({ selected }) {
    const [q, setQ] = useState("");
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const teams = useQuery({ queryKey: ["teams", q], queryFn: () => api(`/teams?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "list-tools", children: [_jsxs("div", { className: "row", children: [_jsxs("div", { className: "grow", style: { position: "relative" }, children: [_jsx(Search, { size: 15, className: "faint", style: { position: "absolute", left: 10, top: 10 } }), _jsx(Input, { placeholder: "Search teams", value: q, onChange: (e) => setQ(e.target.value), style: { paddingLeft: 32 }, "aria-label": "Search teams" })] }), can("teams.manage") && _jsxs(Button, { variant: "primary", onClick: () => setParams({ new: "1" }), "aria-label": "New team", children: [_jsx(Plus, { size: 16 }), _jsx("span", { className: "desktop-only", children: "New team" })] })] }), _jsx("div", { className: "small muted", children: teams.data ? `${teams.data.total} teams` : " " })] }), _jsx("div", { className: "list", role: "list", children: teams.isLoading ? _jsx(ListSkeleton, {}) : teams.data?.items.length === 0 ? _jsx(EmptyState, { title: "No teams yet", children: "Teams group people by trade or area so work can be assigned to the whole team." })
                    : teams.data?.items.map((t) => (_jsxs(Link, { to: `/people/teams/${t.id}`, className: "list-row" + (t.id === selected ? " active" : ""), role: "listitem", children: [_jsx("span", { className: "avatar", style: { background: t.color, borderRadius: 8 }, children: t.name.slice(0, 2).toUpperCase() }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "t", children: t.name }), _jsxs("div", { className: "s", children: [t.member_count, " ", t.member_count === 1 ? "member" : "members"] })] }), _jsx(AvatarStack, { people: t.members, max: 3 })] }, t.id))) }), params.get("new") === "1" && _jsx(TeamModal, { onClose: () => setParams({}) })] }));
}
const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#b8560b", "#7a52c9", "#c4302b", "#3d6fb6", "#5d6880"];
function TeamModal({ team, onClose }) {
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const [f, setF] = useState({ name: team?.name ?? "", description: team?.description ?? "", color: team?.color ?? COLORS[0] });
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => team ? api(`/teams/${team.id}`, { method: "PATCH", body: f }) : api("/teams", { method: "POST", body: f }),
        onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["teams"] }); qc.setQueryData(["team", t.id], t); toast(team ? "Team saved" : `Team ${t.name} created`); onClose(); if (!team)
            nav(`/people/teams/${t.id}`); },
        onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: team ? "Edit team" : "New team", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: team ? "Save" : "Create team" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, onChange: (e) => setF({ ...f, name: e.target.value }), placeholder: "e.g. Electrical" }) }), _jsx(Field, { label: "Description (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", value: f.description, onChange: (e) => setF({ ...f, description: e.target.value }) }) }), _jsxs("div", { className: "field", children: [_jsx("span", { className: "label", children: "Colour" }), _jsx(ColorPicker, { value: f.color, onChange: (c) => setF({ ...f, color: c }), presets: COLORS })] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
function TeamDetail({ id }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const t = useQuery({ queryKey: ["team", id], queryFn: () => api(`/teams/${id}`) });
    const users = useQuery({ queryKey: ["users", "", ""], queryFn: () => api("/users?q=&role="), enabled: can("teams.manage") && can("users.view") });
    const [edit, setEdit] = useState(false);
    const [add, setAdd] = useState("");
    const [confirm, setConfirm] = useState(false);
    useEffect(() => { setConfirm(false); setAdd(""); }, [id]);
    const done = (msg) => (team) => { qc.setQueryData(["team", id], team); qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["users"] }); toast(msg); };
    const err = (e) => toast(e.message, { kind: "error" });
    const addM = useMutation({ mutationFn: (uid) => api(`/teams/${id}/members`, { method: "POST", body: { user_id: uid } }), onSuccess: done("Added to the team"), onError: err });
    const rmM = useMutation({ mutationFn: (uid) => api(`/teams/${id}/members/${uid}`, { method: "DELETE" }), onSuccess: done("Removed from the team"), onError: err });
    const delM = useMutation({ mutationFn: () => api(`/teams/${id}`, { method: "DELETE" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); toast("Team deleted"); nav("/people/teams"); }, onError: err });
    const candidates = useMemo(() => (users.data?.items ?? []).filter((u) => !t.data?.members.some((m) => m.id === u.id)), [users.data, t.data]);
    if (t.isError)
        return _jsx(EmptyState, { title: "Team not found", children: "It may have been deleted." });
    if (!t.data)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 3 }) });
    const team = t.data;
    const manage = can("teams.manage");
    return (_jsxs("div", { className: "detail", children: [_jsxs(Link, { to: "/people/teams", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All teams"] }), _jsxs("div", { className: "detail-head", children: [_jsx("span", { className: "avatar xl", style: { background: team.color, borderRadius: 14 }, children: team.name.slice(0, 2).toUpperCase() }), _jsxs("div", { className: "grow", children: [_jsx("h1", { children: team.name }), _jsx("div", { className: "muted", children: team.description || "No description" })] }), manage && _jsx(Button, { onClick: () => setEdit(true), children: "Edit" })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsxs("h2", { children: ["Members ", _jsxs("span", { className: "faint tnum", children: ["(", team.member_count, ")"] })] }), manage && can("users.view") && _jsxs("div", { className: "row", children: [_jsxs(Select, { value: add, onChange: (e) => setAdd(e.target.value), "aria-label": "Person to add", style: { width: 220 }, children: [_jsx("option", { value: "", children: "Add a person\u2026" }), candidates.map((u) => _jsx("option", { value: u.id, children: u.name }, u.id))] }), _jsx(Button, { variant: "primary", disabled: !add || addM.isPending, onClick: () => { addM.mutate(add); setAdd(""); }, children: "Add" })] })] }), team.members.length === 0 ? _jsx(EmptyState, { title: "No members yet", children: "Add people so work can be assigned to the whole team." })
                        : team.members.map((m) => (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsx(Avatar, { name: m.name, initials: m.initials }), _jsxs("div", { className: "grow", children: [_jsx(Link, { to: `/people/users/${m.id}`, className: "t", style: { color: "var(--c-text)" }, children: m.name }), _jsx("div", { className: "s", children: m.email })] }), manage && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => rmM.mutate(m.id), "aria-label": `Remove ${m.name}`, children: "Remove" })] }, m.id)))] }), manage && (confirm ? _jsxs("div", { className: "row wrap card card-pad", children: [_jsxs("span", { className: "grow", children: ["Delete the ", team.name, " team? People stay in the organization."] }), _jsx(Button, { onClick: () => setConfirm(false), children: "Keep" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => delM.mutate(), children: "Delete team" })] })
                : _jsx("div", { children: _jsxs(Button, { variant: "danger", onClick: () => setConfirm(true), children: [_jsx(Trash2, { size: 15 }), "Delete team"] }) })), edit && _jsx(TeamModal, { team: team, onClose: () => setEdit(false) })] }));
}
function WorkSettings({ userId, manage, self }) {
    const { session } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const ws = useQuery({ queryKey: ["work-settings", userId], queryFn: () => api(`/users/${userId}/work-settings`) });
    const save = useMutation({
        mutationFn: (b) => api(`/users/${userId}/work-settings`, { method: "PATCH", body: b }),
        onSuccess: (x) => { qc.setQueryData(["work-settings", userId], x); toast("Saved"); }, onError: (e) => toast(e.message, { kind: "error" }),
    });
    if (!ws.data || (!manage && !ws.data.rates_visible && !self))
        return null;
    const w = ws.data;
    const cur = session.org?.currency ?? "USD";
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Work orders" }) }), _jsxs("div", { className: "card-body form-grid", children: [w.rates_visible && _jsx(Field, { label: `Hourly rate (${cur})`, hint: `Leave empty to use the default (${((w.default_hourly_rate_cents ?? 0) / 100).toFixed(2)}).`, children: (id) => (_jsx(Input, { id: id, type: "number", min: 0, step: "0.01", disabled: !manage, defaultValue: w.hourly_rate_cents === null ? "" : w.hourly_rate_cents / 100, onBlur: (e) => { const v = e.target.value === "" ? null : Math.round(Number(e.target.value) * 100); if (v !== w.hourly_rate_cents)
                                save.mutate({ hourly_rate_cents: v }); } }, String(w.hourly_rate_cents))) }), _jsx(Field, { label: "Work order visibility", hint: "Limited: sees only work they created or that's assigned to them or their teams.", children: (id) => (_jsxs(Select, { id: id, value: w.wo_visibility, disabled: !manage, onChange: (e) => save.mutate({ wo_visibility: e.target.value }), children: [_jsx("option", { value: "all", children: "All work orders" }), _jsx("option", { value: "limited", children: "Limited" })] })) })] })] }));
}
