import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, FlaskConical } from "lucide-react";
import { api, type Member, type Team } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV } from "../shell/nav";

const SHIPPED = [
  "Sign in, password reset and invitations",
  "Organizations, roles and multi-organization switching",
  "Teams & Users with the MaintainX list-and-detail layout",
  "Global search (Ctrl K) across people, teams and pages",
  "Org-wide audit log with CSV export",
  "Background jobs and an email outbox",
  "Light and dark themes, phone-friendly layout",
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Overview() {
  const { session, can } = useSession();
  const users = useQuery({ queryKey: ["users", ""], queryFn: () => api<{ items: Member[]; total: number }>("/users"), enabled: can("users.view") });
  const teams = useQuery({ queryKey: ["teams", ""], queryFn: () => api<{ items: Team[]; total: number }>("/teams") });
  const roles = (users.data?.items ?? []).reduce<Record<string, number>>((a, u) => ({ ...a, [u.role_label]: (a[u.role_label] ?? 0) + 1 }), {});
  const next = NAV.filter((n) => n.phase).sort((a, b) => a.phase!.localeCompare(b.phase!))[0];
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{greeting()}, {session.user?.name.split(" ")[0]}</h1><p className="sub">{session.org?.name} · {session.role_label}</p></div>
      </div>
      {session.test_build && <div className="banner info"><FlaskConical size={18} /><div><b>You're running a test build.</b> Data lives in a local SQLite file on this computer and the demo organization is pre-loaded. Use it to try things out, not for real work.</div></div>}
      <div className="tiles">
        <div className="card tile"><div className="k">People</div><div className="v">{can("users.view") ? users.data?.total ?? "–" : "–"}</div><div className="small muted">{Object.entries(roles).map(([k, v]) => `${v} ${k}`).join(" · ") || " "}</div></div>
        <div className="card tile"><div className="k">Teams</div><div className="v">{teams.data?.total ?? "–"}</div><div className="small muted">{teams.data?.items.map((t) => t.name).join(", ") || " "}</div></div>
        <div className="card tile"><div className="k">Open work orders</div><div className="v faint">–</div><div className="small muted">Arrives in 0.2.0</div></div>
        <div className="card tile"><div className="k">PM compliance</div><div className="v faint">–</div><div className="small muted">Arrives in 0.4.0</div></div>
      </div>
      <div className="form-grid" style={{ alignItems: "start" }}>
        <section className="card">
          <div className="card-head"><h2>What's in MPro {session.version}</h2></div>
          <div className="card-body"><ul className="checklist">{SHIPPED.map((s) => <li key={s}><CheckCircle2 size={18} color="var(--c-success)" /><span>{s}</span></li>)}</ul></div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Coming next</h2></div>
          <div className="card-body"><ul className="checklist">
            {NAV.filter((n) => n.phase).sort((a, b) => a.phase!.localeCompare(b.phase!)).slice(0, 7).map((n) => (
              <li key={n.id}><Circle size={18} className="faint" /><span className="grow"><Link to={n.path}>{n.label}</Link><div className="small muted">{n.blurb}</div></span><span className="mono faint">{n.phase}</span></li>))}
          </ul></div>
          {next && <div className="card-body" style={{ paddingTop: 0 }}><Link to={next.path} className="row small">See what {next.label} will do <ArrowRight size={14} /></Link></div>}
        </section>
      </div>
    </div>
  );
}
