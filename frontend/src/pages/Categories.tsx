import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Tags, Trash2 } from "lucide-react";
import { api, ApiError, type Category } from "../lib/api";
import { useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal } from "../components/ui";

const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#b8560b", "#c37a06", "#7a52c9", "#c4302b", "#3d6fb6", "#5d6880"];

export function Categories() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Category | "new" | null>(null);
  const [del, setDel] = useState<Category | null>(null);
  const data = useQuery({ queryKey: ["categories", q], queryFn: () => api<{ items: Category[]; total: number }>(`/categories?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  const remove = useMutation({ mutationFn: (c: Category) => api(`/categories/${c.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); setDel(null); toast("Category deleted"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const manage = can("categories.manage");
  return (
    <div className="page">
      <div className="page-head"><div><h1>Categories</h1><p className="sub">Label work orders by type of work, so you can filter, report and route them. A work order can have several.</p></div>
        {manage && <Button variant="primary" onClick={() => setEdit("new")}><Plus size={16} />New category</Button>}</div>
      <div className="search-in" style={{ maxWidth: 360 }}><Search size={15} className="faint" /><Input placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search categories" /></div>
      <section className="card">
        {data.isLoading ? <ListSkeleton /> : data.data?.items.length === 0 ? <EmptyState icon={<Tags size={26} />} title="No categories">{q ? "Nothing matches." : "Create categories like Electrical, Safety or Inspection."}</EmptyState> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Description</th><th className="num">Work orders</th>{manage && <th />}</tr></thead>
            <tbody>{data.data?.items.map((c) => (
              <tr key={c.id}>
                <td><span className="row"><span className="sw lg" style={{ background: c.color }} /><b>{c.name}</b></span></td>
                <td className="muted">{c.description || <span className="faint">—</span>}</td>
                <td className="num"><Link to={`/work-orders?view=table`} onClick={() => { try { sessionStorage.setItem("wo.filters", JSON.stringify([{ field: "category", op: "in", value: [c.id] }])); } catch { /* ignore */ } }}>{c.work_order_count ?? 0}</Link></td>
                {manage && <td className="num" style={{ whiteSpace: "nowrap" }}><Button size="sm" variant="ghost" icon aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)}><Pencil size={14} /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={`Delete ${c.name}`} onClick={() => setDel(c)}><Trash2 size={14} /></Button></td>}
              </tr>))}</tbody>
          </table></div>)}
      </section>
      {edit && <CategoryModal cat={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
      {del && <Modal title={`Delete ${del.name}?`} onClose={() => setDel(null)} footer={<><Button onClick={() => setDel(null)}>Keep it</Button><Button variant="danger" className="solid" onClick={() => remove.mutate(del)}>Delete</Button></>}>
        <p>It will be removed from {del.work_order_count ?? 0} work order{del.work_order_count === 1 ? "" : "s"}. Their history keeps the old label.</p></Modal>}
    </div>
  );
}

function CategoryModal({ cat, onClose }: { cat?: Category; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState({ name: cat?.name ?? "", color: cat?.color ?? COLORS[0], description: cat?.description ?? "" });
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => cat ? api(`/categories/${cat.id}`, { method: "PATCH", body: f }) : api("/categories", { method: "POST", body: f }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); toast(cat ? "Category saved" : "Category created"); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={cat ? "Edit category" : "New category"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>{cat ? "Save" : "Create"}</Button></>}>
      <Field label="Name">{(id) => <Input id={id} value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Pneumatics" />}</Field>
      <Field label="Description (optional)">{(id) => <Input id={id} value={f.description} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <div className="field"><span className="label">Colour</span><div className="row wrap">{COLORS.map((c) => (
        <button key={c} type="button" aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} className={"swatch-btn" + (f.color === c ? " on" : "")} style={{ background: c }} />))}</div></div>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
