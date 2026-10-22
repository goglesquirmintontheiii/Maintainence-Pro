// Bulk edit bar (MaintainX web To-Do / Table): status, priority, due date, assignees, categories, read, cancel, delete — with Undo.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CheckCheck, Download, Flag, Tags, Trash2, UserPlus, X } from "lucide-react";
import { api, ApiError, type WorkOrder } from "../../lib/api";
import { useSession } from "../../lib/session";
import { atTime, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Modal } from "../../components/ui";
import { ClearableDate } from "../../components/assetPickers";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { ExportDialog } from "./WorkOrders";

type BulkResult = { updated: string[]; errors: { id: string; number: number; message: string }[]; undo: Record<string, unknown>[] };

export function BulkBar({ ids, items, onDone }: { ids: string[]; items: WorkOrder[]; onDone: () => void }) {
  const { can } = useSession();
  const opts = useWOOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<null | "assign" | "unassign" | "cats" | "uncats" | "due" | "cancel" | "delete" | "export">(null);
  const [val, setVal] = useState<string[]>([]);
  const [text, setText] = useState("");
  const run = useMutation({
    mutationFn: (b: { action: string; value?: unknown; comment?: string; ids?: string[] }) => api<BulkResult>("/work-orders/bulk", { method: "POST", body: { ids, ...b } }),
    onSuccess: (r, b) => {
      qc.invalidateQueries({ queryKey: ["work-orders"] }); qc.invalidateQueries({ queryKey: ["work-order"] }); qc.invalidateQueries({ queryKey: ["wo-stats"] });
      setDialog(null); setVal([]); setText("");
      const n = r.updated.length;
      if (r.errors.length) toast(`${n} updated. ${r.errors.length} couldn't be: ${r.errors.slice(0, 2).map((e) => `#${e.number} ${e.message}`).join(" ")}`, { kind: "error" });
      else if (b.action !== "revert") {
        const canUndo = b.action === "delete" || (b.action !== "mark_read" && b.action !== "mark_unread" && r.undo.length);
        toast(`Updated ${n} work order${n === 1 ? "" : "s"}`, canUndo ? { action: { label: "Undo", run: () => {
          if (b.action === "delete") run.mutate({ action: "restore", ids: r.updated }); else run.mutate({ action: "revert", value: r.undo, ids: r.updated });
        } } } : undefined);
      }
      if (b.action === "delete") onDone();
    },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const statuses = (opts.data?.statuses ?? []).filter((s) => s.id !== "canceled");
  const sel = items.filter((w) => ids.includes(w.id));
  return (
    <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
      <span className="small"><b>{ids.length}</b> selected</span>
      {can("wo.edit") && <>
        <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}><Flag size={14} />Status</Button>}>
          {(close) => statuses.map((s) => <button key={s.id} className="menu-item" onClick={() => { close(); run.mutate({ action: "set_status", value: s.id }); }}>{s.label}</button>)}
        </Dropdown>
        <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}>Priority</Button>}>
          {(close) => (opts.data?.priorities ?? []).map((p) => <button key={p.id} className="menu-item" onClick={() => { close(); run.mutate({ action: "set_priority", value: p.id }); }}>{p.label}</button>)}
        </Dropdown>
        <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}><UserPlus size={14} />Assign</Button>}>
          {(close) => <><button className="menu-item" onClick={() => { close(); setDialog("assign"); }}>Add assignees…</button><button className="menu-item" onClick={() => { close(); setDialog("unassign"); }}>Remove assignees…</button></>}
        </Dropdown>
        <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}><Tags size={14} />Categories</Button>}>
          {(close) => <><button className="menu-item" onClick={() => { close(); setDialog("cats"); }}>Add categories…</button><button className="menu-item" onClick={() => { close(); setDialog("uncats"); }}>Remove categories…</button></>}
        </Dropdown>
        <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}><CalendarClock size={14} />Dates</Button>}>
          {(close) => <><button className="menu-item" onClick={() => { close(); setDialog("due"); }}>Change due date…</button>
            <button className="menu-item" onClick={() => { close(); run.mutate({ action: "clear_due" }); }}>Remove due date</button>
            <button className="menu-item" onClick={() => { close(); run.mutate({ action: "clear_start" }); }}>Remove start date</button></>}
        </Dropdown>
      </>}
      <Dropdown up align="left" trigger={(_, t) => <Button size="sm" onClick={t}>More</Button>}>
        {(close) => <>
          <button className="menu-item" onClick={() => { close(); run.mutate({ action: "mark_read" }); }}><CheckCheck size={14} />Mark as read</button>
          <button className="menu-item" onClick={() => { close(); run.mutate({ action: "mark_unread" }); }}>Mark as unread</button>
          {can("exports.use") && <button className="menu-item" onClick={() => { close(); setDialog("export"); }}><Download size={14} />Export selected…</button>}
          {can("wo.edit") && <button className="menu-item" onClick={() => { close(); setDialog("cancel"); }}><Ban size={14} />Cancel…</button>}
          {can("wo.delete") && <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setDialog("delete"); }}><Trash2 size={14} />Delete…</button>}
        </>}
      </Dropdown>
      <span className="grow" />
      <Button size="sm" variant="ghost" icon aria-label="Clear selection" onClick={onDone}><X size={16} /></Button>

      {(dialog === "assign" || dialog === "unassign") && <Modal title={dialog === "assign" ? "Add assignees" : "Remove assignees"} onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!val.length} onClick={() => run.mutate({ action: dialog === "assign" ? "add_assignees" : "remove_assignees", value: val })}>Apply to {ids.length}</Button></>}>
        <AssigneePicker options={opts.data} value={val} onChange={setVal} /></Modal>}
      {(dialog === "cats" || dialog === "uncats") && <Modal title={dialog === "cats" ? "Add categories" : "Remove categories"} onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!val.length} onClick={() => run.mutate({ action: dialog === "cats" ? "add_categories" : "remove_categories", value: val })}>Apply to {ids.length}</Button></>}>
        <CategoryPicker options={opts.data} value={val} onChange={setVal} /></Modal>}
      {dialog === "due" && <Modal title="Change due date" onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!text} onClick={() => run.mutate({ action: "set_due", value: atTime(text, opts.data?.settings.default_due_time ?? "12:00") })}>Apply to {ids.length}</Button></>}>
        <Field label="Due date">{(id) => <ClearableDate id={id} label="due date" type="date" value={text} onChange={setText} autoFocus />}</Field></Modal>}
      {dialog === "cancel" && <Modal title={`Cancel ${ids.length} work order${ids.length === 1 ? "" : "s"}`} onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Back</Button><Button variant="danger" className="solid" disabled={opts.data?.settings.comment_on_cancel === "mandatory" && !text.trim()} onClick={() => run.mutate({ action: "cancel", comment: text })}>Cancel work orders</Button></>}>
        <Field label={"Reason" + (opts.data?.settings.comment_on_cancel === "mandatory" ? " *" : " (optional)")}>{(id) => <textarea id={id} className="textarea" value={text} onChange={(e) => setText(e.target.value)} autoFocus />}</Field>
        <p className="small muted">Canceled work orders stay in reports.</p></Modal>}
      {dialog === "delete" && <Modal title={`Delete ${ids.length} work order${ids.length === 1 ? "" : "s"}?`} onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Keep them</Button><Button variant="danger" className="solid" onClick={() => run.mutate({ action: "delete" })}>Delete</Button></>}>
        <p>{sel.slice(0, 5).map((w) => `#${w.number} ${w.title}`).join(", ")}{sel.length > 5 ? ` and ${sel.length - 5} more` : ""}. You can undo right after, or restore them later from Table → Show deleted.</p></Modal>}
      {dialog === "export" && <ExportDialog query={{ filters: [], q: "" }} ids={ids} onClose={() => setDialog(null)} />}
    </div>
  );
}
