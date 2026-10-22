// Pick published procedures (work order form and work order templates).
import { ClipboardCheck } from "lucide-react";
import { MultiPicker } from "../../components/pickers";
import { useLibrary } from "./types";

export function ProcedurePicker({ value, onChange, id, disabled }: { value: string[]; onChange: (v: string[]) => void; id?: string; disabled?: boolean }) {
  const lib = useLibrary(true);
  const opts = (lib.data?.items ?? []).map((p) => ({ key: p.id, label: p.name, sub: `${p.field_count} fields${p.category ? ` · ${p.category}` : ""}`, icon: <ClipboardCheck size={14} className="faint" /> }));
  return <MultiPicker id={id} label="Procedures" placeholder="Add procedures" options={opts} value={value} onChange={onChange} disabled={disabled} searchPlaceholder="Search procedures"
    renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />;
}
