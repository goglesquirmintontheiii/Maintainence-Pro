// Company cards (MP-091): import the bank's statement CSV, match charges to receipts, and chase the card holder for
import { DropZone } from "../../components/DropZone";
// the receipts still missing. Approved reimbursements export to CSV for payroll from here too.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CreditCard, Download, FileUp, Mail, Plus, RefreshCw } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { day, money, postForm, type Card, type CardTxn, type FinanceMe } from "./types";

type UserLite = { id: string; name: string };

export function CardsTab({ me, id }: { me: FinanceMe; id?: string }) {
  const nav = useNavigate();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["finance", "cards"], queryFn: () => api<{ items: Card[] }>("/finance/cards") });
  const exportR = useMutation({ mutationFn: () => api("/finance/reimbursements/export", { method: "POST", body: {} }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <div className={"split fin-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}><h1>Cards</h1>
            {me.can["finance.invoices"] && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />Add card</Button>}</div>
          {me.can["finance.invoices.approve"] && <Button size="sm" onClick={() => exportR.mutate()}><Download size={14} />Export approved reimbursements</Button>}
        </div>
        <div className="list" aria-label="Cards">
          {list.isLoading ? <ListSkeleton /> : !list.data?.items.length ? <EmptyState icon={<CreditCard size={28} />} title="No company cards">
            Add a card, then import its statement to see which charges still need a receipt.</EmptyState>
            : list.data.items.map((c) => (
              <Link key={c.id} to={`/finance/cards/${c.id}`} className={"list-row" + (c.id === id ? " active" : "")}>
                <CreditCard size={18} />
                <div className="grow"><div className="t">{c.name} ••{c.last4}</div><div className="s">{c.holder?.name ?? "No holder"}{c.active ? "" : " · inactive"}</div></div>
                {c.unmatched > 0 && <Pill tone="warning">{c.unmatched} missing</Pill>}
              </Link>))}
        </div>
      </div>
      <div className="split-detail">{id ? <CardDetail id={id} me={me} onBack={() => nav("/finance/cards")} /> : <EmptyState title="Pick a card" />}</div>
      {adding && <CardForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); nav(`/finance/cards/${c.id}`); }} />}
    </div>
  );
}

function CardForm({ edit, onClose, onSaved }: { edit?: Card; onClose: () => void; onSaved: (c: Card) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users", "lite"], staleTime: 60_000, queryFn: () => api<{ items: UserLite[] }>("/users?per_page=500") });
  const [f, setF] = useState({ name: edit?.name ?? "", last4: edit?.last4 ?? "", holder_user_id: edit?.holder?.id ?? "" });
  const save = useMutation({ mutationFn: () => edit ? api<Card>(`/finance/cards/${edit.id}`, { method: "PATCH", body: f }) : api<Card>("/finance/cards", { method: "POST", body: f }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["finance", "cards"] }); onSaved(c); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <Modal title={edit ? "Edit card" : "Add company card"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></>}>
      <div className="fin-form-grid">
        <Field label="Name">{(fid) => <Input id={fid} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Maintenance Amex" />}</Field>
        <Field label="Last 4 digits">{(fid) => <Input id={fid} inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} />}</Field>
        <Field label="Card holder" hint="Gets the missing-receipt reminders">{(fid) => <Select id={fid} value={f.holder_user_id} onChange={(e) => setF({ ...f, holder_user_id: e.target.value })}>
          <option value="">—</option>{users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
      </div>
    </Modal>
  );
}

function CardDetail({ id, me, onBack }: { id: string; me: FinanceMe; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState("missing");
  const [edit, setEdit] = useState(false);
  const q = useQuery({ queryKey: ["finance", "card", id, filter], queryFn: () => api<{ card: Card; items: CardTxn[] }>(`/finance/cards/${id}/transactions?status=${filter}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["finance", "card", id] }); void qc.invalidateQueries({ queryKey: ["finance", "cards"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const imp = useMutation({ mutationFn: (file: File) => postForm<{ added: number; skipped: number; matched: number }>(`/finance/cards/${id}/statement`, { file }),
    onSuccess: (r) => { refresh(); toast(`Imported ${r.added} charge${r.added === 1 ? "" : "s"}; ${r.matched} matched a receipt${r.skipped ? `, ${r.skipped} skipped` : ""}.`); }, onError: err });
  const act = useMutation({ mutationFn: (path: string) => api<{ matched?: number; chased?: number }>(`/finance/cards/${id}/${path}`, { method: "POST", body: {} }),
    onSuccess: (r) => { refresh(); toast(r.chased !== undefined ? `Asked for ${r.chased} receipt${r.chased === 1 ? "" : "s"}` : `${r.matched ?? 0} matched`); }, onError: err });
  const setTxn = useMutation({ mutationFn: ({ tid, body }: { tid: string; body: unknown }) => api(`/finance/card-transactions/${tid}`, { method: "PATCH", body }), onSuccess: refresh, onError: err });
  const card = q.data?.card;
  const writer = me.can["finance.invoices"];
  return (
    <div className="detail fin-detail">
      <div className="detail-head">
        <Button icon className="fin-back" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></Button>
        <h2 className="grow">{card ? `${card.name} ••${card.last4}` : "Card"}</h2>
        {writer && card && <Button onClick={() => setEdit(true)}>Edit</Button>}
      </div>
      {writer && <DropZone accept=".csv,text/csv" multiple={false} label="Drop the statement CSV" onFiles={(fs) => imp.mutate(fs[0])}><div className="row wrap fin-actions">
        <label className="btn primary"><FileUp size={15} />Import statement (CSV)<input type="file" accept=".csv,text/csv" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ""; }} /></label>
        <Button onClick={() => act.mutate("reconcile")}><RefreshCw size={15} />Match receipts</Button>
        <Button onClick={() => act.mutate("chase")} disabled={!card?.holder}><Mail size={15} />Chase missing receipts</Button>
      </div></DropZone>}
      <div className="seg fin-seg" role="tablist" aria-label="Filter">
        {[["missing", "Missing receipt"], ["matched", "Matched"], ["ignored", "Ignored"], ["", "All"]].map(([k, l]) =>
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={"seg-btn" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      <section className="card">
        {q.isLoading ? <ListSkeleton rows={4} /> : !q.data?.items.length ? <EmptyState title={filter === "missing" ? "Nothing missing" : "No charges"}>Import the card statement to see its charges.</EmptyState>
          : <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Date</th><th>Merchant</th><th className="num">Amount</th><th>Receipt</th><th /></tr></thead>
            <tbody>{q.data.items.map((t) => <tr key={t.id}>
              <td>{day(t.posted_on)}</td><td>{t.merchant || "—"}</td><td className="num">{money(t.amount, t.currency)}</td>
              <td>{t.receipt_id ? <Link to={`/finance/receipts/${t.receipt_id}`}>Open</Link> : t.status === "chased" ? <Pill tone="warning">Asked {day(t.chased_at)}</Pill> : t.status === "ignored" ? <Pill>Ignored</Pill> : <Pill tone="warning">Missing</Pill>}</td>
              <td>{writer && (t.status === "ignored" ? <Button size="sm" variant="ghost" onClick={() => setTxn.mutate({ tid: t.id, body: { status: "unmatched" } })}>Undo</Button>
                : !t.receipt_id && <Button size="sm" variant="ghost" onClick={() => setTxn.mutate({ tid: t.id, body: { status: "ignored" } })}>Ignore</Button>)}</td>
            </tr>)}</tbody></table></div>}
      </section>
      {edit && card && <CardForm edit={card} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); refresh(); }} />}
    </div>
  );
}
