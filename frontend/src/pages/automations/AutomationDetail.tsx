// One automation: summary, on/off, counters, what fires next, targets, and the run history with work-order links.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, CheckCircle2, Copy, Gauge, MinusCircle, MoreHorizontal, Pencil, Trash2, Workflow, XCircle } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { AutomationBuilder } from "./Builder";
import { AutomationTree } from "./Tree";
import { ACTION_LABEL, TRIGGER_LABEL, minutesText, type Automation, type Run } from "./types";

export function AutomationDetail({ id }: { id: string }) {
  const { can, session } = useSession();
  const tz = session.org?.timezone;
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const manage = can("automations.manage");
  const q = useQuery({ queryKey: ["automation", id], queryFn: () => api<Automation>(`/automations/${id}`) });
  const [status, setStatus] = useState("");
  const runs = useQuery({ queryKey: ["automation", id, "runs", status, q.dataUpdatedAt], placeholderData: (p) => p,
    queryFn: () => api<{ items: Run[]; total: number }>(`/automations/${id}/runs?per_page=100${status ? `&status=${status}` : ""}`) });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["automations"] }); qc.invalidateQueries({ queryKey: ["automation", id] }); };
  const toggle = useMutation({ mutationFn: (active: boolean) => api(`/automations/${id}`, { method: "PATCH", body: { active } }),
    onSuccess: (_, active) => { refresh(); toast(active ? "Automation turned on" : "Automation turned off"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const copy = useMutation({ mutationFn: () => api<Automation>(`/automations/${id}/copy`, { method: "POST" }),
    onSuccess: (a) => { refresh(); toast("Copied. The copy is off until you turn it on."); nav(`/automations/${a.id}`); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const del = useMutation({ mutationFn: () => api(`/automations/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["automations"] }); toast("Automation deleted"); nav("/automations"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });

  if (q.isError) return <EmptyState icon={<Workflow size={26} />} title="Automation not found">It may have been deleted, or you don't have access to it.</EmptyState>;
  if (!q.data) return <div className="detail"><ListSkeleton rows={4} /></div>;
  const a = q.data;
  const names = new Map(a.targets.map((t, i) => [t, a.target_names[i] ?? ""]));
  const targetLink = (tid: string) => tid === "*" ? <span className="faint">No asset</span>
    : <Link to={a.target_kind === "meter" ? `/meters/${tid}` : `/assets/${tid}`}>{names.get(tid) || (a.target_kind === "meter" ? "Meter" : "Asset")}</Link>;
  const showNext = (a.next_expected ?? []).some((n) => n.value !== undefined && n.value !== null || n.at);
  return (
    <div className="detail wo-detail auto-detail">
      <Link to="/automations" className="row small mobile-only"><ArrowLeft size={14} />All automations</Link>
      <div className="wo-head">
        <div className="grow">
          <div className="row small muted wrap" style={{ gap: 8 }}>
            {a.target_kind === "meter" ? <Gauge size={13} /> : <Boxes size={13} />}{TRIGGER_LABEL[a.trigger.type]}
            {a.legacy && <Pill tone="info">Converted from a meter trigger</Pill>}
          </div>
          <h1 className="wo-title">{a.name}</h1>
        </div>
        <div className="row">
          {manage && <Button onClick={() => setEditing(true)} aria-label="Edit"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          {manage && <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={200}>
            {(close) => <>
              <button className="menu-item" onClick={() => { close(); copy.mutate(); }}><Copy size={15} />Copy</button>
              <div className="menu-sep" />
              <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button>
            </>}
          </Dropdown>}
        </div>
      </div>

      <AutomationTree doc={a} targetNames={a.target_names} />
      <div className="card card-pad auto-summary-card">
        <p className="auto-summary-text">{a.summary}</p>
        <div className="row wrap" style={{ gap: 12, justifyContent: "space-between" }}>
          {manage ? <Toggle checked={a.active} onChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} label={a.active ? "On" : "Off"} />
            : <Pill tone={a.active ? "success" : "neutral"}>{a.active ? "On" : "Off"}</Pill>}
          {a.rerun_minutes > 0 && <span className="small muted">Waits {minutesText(a.rerun_minutes)} before running again</span>}
        </div>
        {a.description && <p className="small muted prewrap" style={{ marginTop: 8 }}>{a.description}</p>}
      </div>

      <div className="auto-stats">
        <div className="card tile"><div className="k">Ran</div><div className="v">{a.run_count}</div>
          <div className="small muted">{a.last_run_at ? <span title={dateTime(a.last_run_at, tz)}>Last {timeAgo(a.last_run_at)}</span> : "Not yet"}</div></div>
        <div className="card tile"><div className="k">Skipped</div><div className="v">{a.skip_count}</div><div className="small muted">Conditions, re-run wait or an open work order</div></div>
        <div className="card tile"><div className="k">Failed</div><div className={"v" + (a.fail_count ? " danger" : "")}>{a.fail_count}</div><div className="small muted">See the history below</div></div>
      </div>

      <section className="card">
        <div className="card-head"><h2>{a.target_kind === "meter" ? "Meters" : "Assets"} <span className="muted small">{a.targets.length || "Any"}</span></h2></div>
        {a.targets.length === 0 ? <div className="card-body small muted">Runs for any asset.</div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{a.target_kind === "meter" ? "Meter" : "Asset"}</th>{showNext && <th>Next trigger</th>}</tr></thead>
            <tbody>{a.targets.slice(0, 50).map((tid) => {
              const n = a.next_expected?.find((x) => x.target_id === tid);
              return <tr key={tid}><td>{targetLink(tid)}</td>
                {showNext && <td className="small">{n?.at ? <>After {dateTime(n.at, tz)}</> : n?.value !== undefined && n?.value !== null ? <>At {n.value}</> : "—"}</td>}</tr>;
            })}</tbody></table>
            {a.targets.length > 50 && <div className="small faint" style={{ padding: 10 }}>and {a.targets.length - 50} more</div>}</div>)}
      </section>

      <section className="card">
        <div className="card-head"><h2>History</h2>
          <Select aria-label="Show runs" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }}>
            <option value="">All runs</option><option value="ok">Ran</option><option value="skipped">Skipped</option><option value="failed">Failed</option></Select></div>
        {runs.isLoading ? <div className="card-body"><ListSkeleton rows={3} /></div> : !runs.data?.items.length
          ? <div className="card-body small muted">{status ? "No runs like that." : "Nothing yet. Runs show up here with links to the work orders they create."}</div>
          : <ul className="auto-runs">{runs.data.items.map((r) => (
            <li key={r.id} className="auto-run">
              <span className={"auto-run-ic " + r.status} aria-label={r.status}>{r.status === "ok" ? <CheckCircle2 size={16} /> : r.status === "failed" ? <XCircle size={16} /> : <MinusCircle size={16} />}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}><b className="small">{r.status === "ok" ? "Ran" : r.status === "failed" ? "Failed" : "Skipped"}</b>
                  <span className="small">{targetLink(r.target_id)}</span>
                  <span className="small faint" title={dateTime(r.at, tz)}>{timeAgo(r.at)}</span></div>
                {r.results.length ? r.results.map((x, i) => (
                  <div key={i} className="small muted">{ACTION_LABEL[x.action]}: {x.work_order_id
                    ? <Link to={`/work-orders/${x.work_order_id}`}>{x.ok ? `Created #${x.work_order_number ?? ""}` : `#${x.work_order_number ?? ""}`}</Link> : null}
                    {x.work_order_id && !x.ok ? ` ${x.message.toLowerCase()}` : x.work_order_id ? null : x.message}</div>))
                  : <div className="small muted">{r.message}</div>}
              </div>
            </li>))}</ul>}
      </section>

      {editing && <AutomationBuilder edit={a} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {confirmDelete && <Modal title="Delete automation?" onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>“{a.name}” stops running. Work orders it already created are kept.</p></Modal>}
    </div>
  );
}
