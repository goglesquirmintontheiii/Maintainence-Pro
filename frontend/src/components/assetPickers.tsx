// Asset and location pickers (single or multi) and a date input with a compact clear button.
import { useMemo, type InputHTMLAttributes } from "react";
import { Boxes, MapPin, X } from "lucide-react";
import { MultiPicker } from "./pickers";
import { useAssetList, useLocationList, pathLabel } from "../lib/assets";

const dot = (status: string) => <span className={"astat-dot " + status} aria-hidden="true" />;

export function AssetPicker({ value, onChange, multi = false, disabled, id, placeholder = "Pick an asset", exclude = [] }: {
  value: string[]; onChange: (v: string[]) => void; multi?: boolean; disabled?: boolean; id?: string; placeholder?: string; exclude?: string[];
}) {
  const q = useAssetList();
  const opts = useMemo(() => (q.data?.items ?? []).filter((a) => !exclude.includes(a.id)).map((a) => ({
    key: a.id, label: a.name, sub: [a.path.length ? pathLabel(a.path.slice(-2), "").replace(/ › $/, "") : "", a.location?.name].filter(Boolean).join(" · ") || undefined,
    icon: dot(a.status),
  })), [q.data, exclude]);
  return <MultiPicker id={id} label="Asset" single={!multi} placeholder={placeholder} options={opts} value={value} onChange={onChange} disabled={disabled}
    searchPlaceholder="Search assets"
    renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip"><Boxes size={12} />{s.label}</span>)}</span>} />;
}

export function LocationPicker({ value, onChange, disabled, id, placeholder = "Pick a location", exclude = [] }: {
  value: string | null; onChange: (v: string | null) => void; disabled?: boolean; id?: string; placeholder?: string; exclude?: string[];
}) {
  const q = useLocationList();
  const opts = useMemo(() => (q.data?.items ?? []).filter((l) => !exclude.includes(l.id)).map((l) => ({
    key: l.id, label: l.name, sub: l.path.length ? l.path.map((p) => p.name).join(" › ") : undefined, icon: <MapPin size={14} className="faint" />,
  })), [q.data, exclude]);
  return <MultiPicker id={id} label="Location" single placeholder={placeholder} options={opts} value={value ? [value] : []}
    onChange={(v) => onChange(v[0] ?? null)} disabled={disabled} searchPlaceholder="Search locations"
    renderValue={(sel) => <span className="chip"><MapPin size={12} />{sel[0].label}</span>} />;
}

/** A date or datetime input with a small × to clear it (requested in the 0.2.0 review). */
export function ClearableDate({ value, onChange, label, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  value: string; onChange: (v: string) => void; label: string;
}) {
  return (
    <span className="clearable">
      <input {...rest} className={"input " + (rest.className ?? "")} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && !rest.disabled && (
        <button type="button" className="clear-x" aria-label={`Clear ${label}`} title={`Clear ${label}`} onClick={() => onChange("")}><X size={12} /></button>)}
    </span>
  );
}
