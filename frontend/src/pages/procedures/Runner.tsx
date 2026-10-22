// Procedures on a work order (r076: several per work order, each its own section): fill in fields, see progress and
// score, create corrective work orders on Fail / Flag / low score (r044/r179), add a library or one-off procedure (r210).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardCheck, ClipboardList, MoreHorizontal, Plus, Search, Trash2, Wrench } from "lucide-react";
import { api, ApiError, type WODetail } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, Modal, Pill } from "../../components/ui";
import { FieldRow, type SaveBody } from "./Fields";
import { ItemsEditor } from "./Builder";
import { isField, scoreOf, useLibrary, visibleIds, type Answer, type Corrective, type Item, type Run, type Schema } from "./types";
import "../../styles/procedures.css";

type Props = { items: Item[]; answers: Record<string, Answer>; disabled?: boolean; preview?: boolean; tz?: string; refs?: Run["reference_files"];
  onSave: (fieldId: string, body: SaveBody) => Promise<unknown> | void };

/** Renders a procedure's items (headings, sections, nested procedures, fields), hiding what conditions hide. */
export function ProcedureForm({ items, answers, ...rest }: Props) {
  const values = useMemo(() => Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.skipped ? "__skipped__" : a.value])), [answers]);
  const vis = visibleIds(items, values);
  return <div className="pr-form">{items.filter((it) => vis.has(it.id)).map((it) => <ItemView key={it.id} it={it} vis={vis} answers={answers} {...rest} />)}</div>;
}

function ItemView({ it, vis, answers, onSave, ...rest }: Omit<Props, "items"> & { it: Item; vis: Set<string> }) {
  const [open, setOpen] = useState(true);
  if (it.type === "heading") return <h4 className="pr-heading">{it.label}</h4>;
  if (it.type === "section" || it.type === "procedure") {
    const kids = (it.items ?? []).filter((k) => vis.has(k.id));
    const fs = kids.filter((k) => isField(k.type));
    const done = fs.filter((k) => answers[k.id] && (answers[k.id].skipped || answers[k.id].value !== null && answers[k.id].value !== false)).length;
    return (
      <div className={"pr-section" + (it.type === "procedure" ? " nested" : "")}>
        <button type="button" className="pr-section-h" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="grow">{it.label || "Procedure"}</span>
          {fs.length > 0 && <span className="small faint">{done}/{fs.length}</span>}
        </button>
        {open && <div className="pr-section-b">{kids.map((k) => <ItemView key={k.id} it={k} vis={vis} answers={answers} onSave={onSave} {...rest} />)}
          {(it.items?.length ?? 0) === 0 && <div className="small faint">Empty section</div>}</div>}
      </div>);
  }
  return <FieldRow item={it} answer={answers[it.id]} onSave={(b) => onSave(it.id, b)} {...rest} />;
}

/** Live preview (builder and library): answers kept locally. */
export function PreviewForm({ schema, refs }: { schema: Schema; refs?: Run["reference_files"] }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const score = scoreOf(schema, Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.value])));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {schema.scoring?.enabled && <div className="row small muted" style={{ justifyContent: "space-between" }}><span>Score {score === null ? "—" : `${score}%`}</span>
        {schema.scoring.goal !== null && <span>Goal {schema.scoring.goal}%</span>}</div>}
      {schema.items.length === 0 ? <div className="small faint">Add fields to see them here.</div>
        : <ProcedureForm items={schema.items} answers={answers} preview refs={refs} onSave={(fid, b) => {
          if (!("value" in b)) return;
          const v = b.value;
          const result = typeof v === "string" && ["pass", "flag", "fail", "yes", "no", "na"].includes(v) ? v : "";
          setAnswers((a) => ({ ...a, [fid]: { value: v, result, note: String(b.note ?? a[fid]?.note ?? ""), files: [], skipped: false, answered_by: null, answered_at: null } }));
        }} />}
    </div>);
}

// ------------------------------------------------------------------------------------------- on a work order
export function ProcedureRuns({ wo, onChange }: { wo: WODetail; onChange: () => void }) {
  const runs = (wo.procedures ?? []) as Run[];
  const { can, session } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState<{ run: Run; p: NonNullable<NonNullable<Corrective>["prompt"]> } | null>(null);
  const closed = wo.deleted || wo.status === "done" || wo.status === "canceled";
  const canFill = can("procedures.fill") && !closed;
  const canEdit = can("wo.edit") && !closed;
  if (!runs.length && !canEdit) return null;

  const setRun = (r: Run) => qc.setQueryData<WODetail>(["work-order", wo.id], (prev) => prev ? { ...prev, procedures: (prev.procedures ?? []).map((x) => (x as Run).id === r.id ? r : x) } : prev);
  const save = async (run: Run, fid: string, body: SaveBody) => {
    try {
      const res = await api<{ run: Run; corrective: Corrective }>(`/work-orders/${wo.id}/procedures/${run.id}/answers/${encodeURIComponent(fid)}`, { method: "PUT", body });
      setRun(res.run);
      if (res.corrective?.prompt) setPrompt({ run: res.run, p: res.corrective.prompt });
      if (res.corrective?.created) toast(`Created corrective work order #${res.corrective.created.number}`);
      onChange();
    } catch (e) {
      toast((e as ApiError).message, { kind: "error" });
      throw e;
    }
  };
  return (
    <section className="pr-runs" aria-label="Procedures">
      {runs.map((r) => <RunCard key={r.id} wo={wo} run={r} canFill={canFill} canEdit={canEdit} tz={session.org?.timezone} onSave={(fid, b) => save(r, fid, b)} onChange={onChange} />)}
      {canEdit && <div><Button size="sm" onClick={() => setAdding(true)}><Plus size={15} />Add procedure</Button></div>}
      {adding && <AddProcedureDialog wo={wo} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChange(); }} />}
      {prompt && <CorrectiveDialog wo={wo} run={prompt.run} p={prompt.p} onClose={() => setPrompt(null)} onCreated={() => { setPrompt(null); onChange(); }} />}
    </section>);
}

function RunCard({ wo, run, canFill, canEdit, tz, onSave, onChange }: { wo: WODetail; run: Run; canFill: boolean; canEdit: boolean; tz?: string;
  onSave: (fid: string, b: SaveBody) => Promise<unknown>; onChange: () => void }) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(true);
  const remove = useMutation({ mutationFn: () => api(`/work-orders/${wo.id}/procedures/${run.id}`, { method: "DELETE" }),
    onSuccess: () => { setConfirm(false); toast("Procedure removed"); onChange(); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const pct = run.progress.total ? Math.round((100 * run.progress.answered) / run.progress.total) : 0;
  const below = run.score !== null && run.goal !== null && run.score < run.goal;
  const answered = Object.keys(run.answers).length > 0;
  return (
    <div className="card pr-run">
      <div className="pr-run-head">
        <button type="button" className="pr-run-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
        <ClipboardCheck size={18} className="faint" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 className="pr-run-title">{run.procedure?.name ?? "Procedure"}</h3>
          <div className="small muted row wrap" style={{ gap: 8 }}>
            <span>{run.progress.answered} of {run.progress.total} done</span>
            {run.procedure && !run.procedure.one_off && <Link to={`/procedures/${run.procedure.id}`} className="faint">Version {run.version}</Link>}
            {run.procedure?.one_off && <span className="faint">Only on this work order</span>}
            {run.status === "done" && <Pill tone="success">Completed</Pill>}
          </div>
        </div>
        {run.score !== null && <div className={"pr-score" + (below ? " below" : "")} title={run.goal !== null ? `Goal ${run.goal}%` : undefined}>
          <b>{Math.round(run.score)}%</b>{run.goal !== null && <span className="small">goal {run.goal}%</span>}</div>}
        {canEdit && <Dropdown trigger={(_, t) => <Button variant="ghost" icon aria-label="Procedure actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={220}>
          {(close) => <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirm(true); }}><Trash2 size={15} />Remove from work order</button>}
        </Dropdown>}
      </div>
      <div className="pr-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Procedure progress"><span style={{ width: `${pct}%` }} /></div>
      {open && <div className="pr-run-body">
        <ProcedureForm items={run.schema.items} answers={run.answers} disabled={!canFill} tz={tz} refs={run.reference_files} onSave={onSave} />
        {run.progress.missing_required.length > 0 && canFill && <div className="small muted pr-missing">Still needed to complete: {run.progress.missing_required.slice(0, 6).join(", ")}{run.progress.missing_required.length > 6 ? "…" : ""}</div>}
      </div>}
      {confirm && <Modal title="Remove procedure?" onClose={() => setConfirm(false)}
        footer={<><Button onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</Button></>}>
        <p>“{run.procedure?.name}” comes off this work order{answered ? ", along with its answers" : ""}.</p></Modal>}
    </div>);
}

function CorrectiveDialog({ wo, run, p, onClose, onCreated }: { wo: WODetail; run: Run; p: NonNullable<NonNullable<Corrective>["prompt"]>; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState(p.title);
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => api<{ id: string; number: number; title: string }>(`/work-orders/${wo.id}/procedures/${run.id}/corrective`, { method: "POST", body: { field_id: p.field_id, title } }),
    onSuccess: (r) => { toast(`Created #${r.number}`, { action: { label: "Open", run: () => { window.location.assign(`/work-orders/${r.id}`); } } }); onCreated(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const what = p.result === "low_score" ? `scored ${p.score}%, below the ${p.goal}% goal` : `was marked ${p.result === "fail" ? "Fail" : "Flag"}`;
  return (
    <Modal title="Create a corrective work order?" onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Not now</Button><Button variant="primary" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}><Wrench size={15} />Create work order</Button></>}>
      <p><b>{p.label}</b> {what}. A follow-up work order keeps the fix from getting lost. It's linked to #{wo.number} with the same asset and location.</p>
      <Field label="Title">{(id) => <Input id={id} value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />}</Field>
    </Modal>);
}

export function AddProcedureDialog({ wo, onClose, onAdded }: { wo: WODetail; onClose: () => void; onAdded: () => void }) {
  const lib = useLibrary(true);
  const { can } = useSession();
  const { toast } = useToast();
  const [tab, setTab] = useState<"library" | "one_off">("library");
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const attached = new Set(((wo.procedures ?? []) as Run[]).map((r) => r.procedure?.id));
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Run>(`/work-orders/${wo.id}/procedures`, { method: "POST", body }),
    onSuccess: (r) => { toast(`Added ${r.procedure?.name ?? "procedure"}`); onAdded(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const shown = (lib.data?.items ?? []).filter((p) => !q || (p.name + " " + p.tags.join(" ") + " " + p.category).toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Add procedure" onClose={onClose} width={tab === "one_off" ? 760 : 560}
      footer={tab === "one_off" ? <><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim() || !items.some((i) => isField(i.type) || (i.items ?? []).length) || add.isPending}
          onClick={() => add.mutate({ name, schema: { items, scoring: { enabled: false, goal: null } } })}>Add to work order</Button></> : undefined}>
      <div className="seg" role="tablist" aria-label="Source" style={{ marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={tab === "library"} className={"seg-btn" + (tab === "library" ? " on" : "")} onClick={() => setTab("library")}>From the library</button>
        <button type="button" role="tab" aria-selected={tab === "one_off"} className={"seg-btn" + (tab === "one_off" ? " on" : "")} onClick={() => setTab("one_off")}>Just for this work order</button>
      </div>
      {tab === "library" ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Search procedures" aria-label="Search procedures" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
          <div className="pr-pick-list">
            {lib.isLoading ? <div className="small faint" style={{ padding: 12 }}>Loading…</div> : shown.length === 0
              ? <EmptyState icon={<ClipboardList size={24} />} title={q ? "No procedures match" : "No published procedures"}>
                {can("procedures.manage") ? <>Build one in <Link to="/procedures">Procedures</Link>, or make one just for this work order.</> : "Ask an administrator to publish one."}</EmptyState>
              : shown.map((p) => (
                <button key={p.id} type="button" className="pr-pick" disabled={add.isPending || attached.has(p.id)} onClick={() => add.mutate({ procedure_id: p.id })}>
                  <ClipboardCheck size={18} className="faint" />
                  <span className="grow" style={{ minWidth: 0 }}><b>{p.name}</b><span className="small muted" style={{ display: "block" }}>{p.field_count} fields{p.category ? ` · ${p.category}` : ""}{p.tags.length ? ` · ${p.tags.join(", ")}` : ""}</span></span>
                  {attached.has(p.id) ? <span className="small faint">Added</span> : <Plus size={16} className="faint" />}
                </button>))}
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <Field label="Name">{(id) => <Input id={id} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} placeholder="e.g. Extra checks for this job" />}</Field>
          <p className="small muted" style={{ margin: 0 }}>It's saved with this work order only and doesn't appear in the library.</p>
          <ItemsEditor items={items} onChange={setItems} scoring={false} compact />
        </div>)}
    </Modal>);
}
