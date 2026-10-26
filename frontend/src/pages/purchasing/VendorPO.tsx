// The vendor's purchase-order page (r261): opened from the link in the PO email, no sign-in. The vendor reads the
// order and acknowledges it, proposes a delivery date, or declines it with a note.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { currency, timeAgo } from "../../lib/format";
import { LogoMark } from "../../components/Logo";
import { Button, EmptyState, Field, Input, ListSkeleton, Pill } from "../../components/ui";
import "./purchasing.css";

type Answer = { response: string | null; response_label: string; responder_name: string; proposed_date: string | null; note: string; responded_at: string | null };
type VendorPO = {
  organization: string; number: string; title: string; status: string; currency: string; due_on: string | null;
  ship_to: Record<string, string> | null; subtotal: string; total: string; answer: Answer | null;
  lines: { description: string; part_number: string; unit: string; quantity: string; unit_cost: string; amount: string }[];
  costs: { label: string; amount: string }[];
};
type Choice = "acknowledged" | "proposed_date" | "declined";

const day = (d: string) => new Date(d + "T00:00").toLocaleDateString();

export function VendorPOPage() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const key = ["vendor-po", token];
  const q = useQuery({ queryKey: key, queryFn: () => api<VendorPO>(`/vendor-po/${encodeURIComponent(token)}`), retry: false });
  const [choice, setChoice] = useState<Choice | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const send = useMutation({
    mutationFn: () => api<{ answer: Answer }>(`/vendor-po/${encodeURIComponent(token)}/respond`, { method: "POST", body: { response: choice, name, date: date || undefined, note } }),
    onSuccess: (r) => { qc.setQueryData<VendorPO>(key, (d) => (d ? { ...d, answer: r.answer } : d)); setChoice(null); setErr(""); },
    onError: (e) => setErr((e as ApiError).message),
  });
  if (q.isLoading) return <div className="pq-page"><div className="pq-card"><ListSkeleton rows={5} /></div></div>;
  if (q.isError || !q.data) return <div className="pq-page"><div className="pq-card"><EmptyState title="This link doesn't work any more">The order may be complete or canceled, or a newer copy was sent. Ask the buyer for the latest email.</EmptyState></div></div>;
  const d = q.data;
  const a = d.answer;
  const ready = !!name.trim() && (choice !== "proposed_date" || !!date) && (choice !== "declined" || !!note.trim());
  return (
    <div className="pq-page">
      <div className="pq-card">
        <div className="row" style={{ gap: 10 }}><LogoMark size={28} /><b className="grow">{d.organization}</b></div>
        <div>
          <div className="small muted">Purchase order {d.number}</div>
          <h1 className="wo-title" style={{ margin: "4px 0" }}>{d.title || `Purchase order ${d.number}`}</h1>
          <div className="row wrap" style={{ gap: 6 }}>
            {a?.response ? <Pill tone={a.response === "declined" ? "danger" : "success"}>{a.response_label}</Pill> : <Pill tone="info">Waiting for your answer</Pill>}
            {d.due_on && <span className="small muted">Needed by {day(d.due_on)}</span>}
          </div>
        </div>
        {d.ship_to && <div className="small"><b>Ship to</b><div className="muted prewrap">{[d.ship_to.company, d.ship_to.attention, d.ship_to.line1, d.ship_to.line2,
          [d.ship_to.city, d.ship_to.region, d.ship_to.postal_code].filter(Boolean).join(" "), d.ship_to.country, d.ship_to.phone].filter(Boolean).join("\n")}</div></div>}
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
          <tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.description}{l.part_number && <span className="small faint" style={{ display: "block" }}>{l.part_number}</span>}</td>
            <td className="num">{+Number(l.quantity).toFixed(4)}{l.unit && l.unit !== "each" ? ` ${l.unit}` : ""}</td><td className="num">{currency(l.unit_cost, d.currency)}</td><td className="num">{currency(l.amount, d.currency)}</td></tr>)}</tbody>
        </table></div>
        <div className="po-totals">
          <div><span>Subtotal</span><span>{currency(d.subtotal, d.currency)}</span></div>
          {d.costs.map((c, i) => <div key={i}><span>{c.label}</span><span>{currency(c.amount, d.currency)}</span></div>)}
          <div className="tot"><span>Total</span><span>{currency(d.total, d.currency)}</span></div>
        </div>
        {a?.response && <div className={"banner " + (a.response === "declined" ? "warning" : "info")} role="status">
          {a.response_label} by {a.responder_name}{a.responded_at ? `, ${timeAgo(a.responded_at)}` : ""}{a.proposed_date ? ` · delivery by ${day(a.proposed_date)}` : ""}{a.note ? `: “${a.note}”` : ""}
          <span className="small" style={{ display: "block" }}>You can change your answer below.</span></div>}
        <section className="stack" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button variant={choice === "acknowledged" ? "primary" : undefined} aria-pressed={choice === "acknowledged"} onClick={() => setChoice("acknowledged")}><Check size={15} />Acknowledge</Button>
            <Button variant={choice === "proposed_date" ? "primary" : undefined} aria-pressed={choice === "proposed_date"} onClick={() => setChoice("proposed_date")}><CalendarClock size={15} />Propose a delivery date</Button>
            <Button variant={choice === "declined" ? "danger" : undefined} aria-pressed={choice === "declined"} onClick={() => setChoice("declined")}><X size={15} />Decline</Button>
          </div>
          {choice && <>
            <Field label="Your name">{(id) => <Input id={id} value={name} maxLength={200} autoComplete="name" onChange={(e) => setName(e.target.value)} />}</Field>
            {choice === "proposed_date" && <Field label="We can deliver by">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>}
            <Field label={choice === "declined" ? "Why can't you fill it?" : "Note for the buyer (optional)"}>{(id) => <textarea id={id} className="input" rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />}</Field>
            {err && <div className="banner warning" role="alert">{err}</div>}
            <div><Button variant="primary" disabled={!ready || send.isPending} onClick={() => send.mutate()}>Send answer</Button></div>
          </>}
        </section>
      </div>
    </div>
  );
}
