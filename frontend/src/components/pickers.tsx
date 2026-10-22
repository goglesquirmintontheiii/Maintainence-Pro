// Pickers used across work orders: assignees (people + teams), categories, generic multi-select,
// a signature pad and a comment box with @mentions.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search, Users, X } from "lucide-react";
import type { Assignee, CategoryRef, WOOptions } from "../lib/api";
import { Avatar, Button, useClickAway } from "./ui";

type Opt = { key: string; label: string; sub?: string; icon?: ReactNode };

export function MultiPicker({ options, value, onChange, placeholder, label, renderValue, single = false, disabled = false, searchPlaceholder = "Search", id }: {
  options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; renderValue?: (sel: Opt[]) => ReactNode;
  single?: boolean; disabled?: boolean; searchPlaceholder?: string; id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useClickAway<HTMLDivElement>(open, () => setOpen(false));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setHi(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  const shown = useMemo(() => options.filter((o) => !q || (o.label + " " + (o.sub ?? "")).toLowerCase().includes(q.toLowerCase())), [options, q]);
  const sel = options.filter((o) => value.includes(o.key));
  const toggle = (k: string) => {
    if (single) { onChange(value[0] === k ? [] : [k]); setOpen(false); return; }
    onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  };
  return (
    <div className="picker" ref={ref}>
      <button type="button" id={id} className="picker-btn input" aria-label={id ? undefined : label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className="grow picker-val">{sel.length ? (renderValue ? renderValue(sel) : sel.map((s) => s.label).join(", ")) : <span className="faint">{placeholder}</span>}</span>
        <ChevronDown size={15} className="faint" />
      </button>
      {open && (
        <div className="menu picker-menu" role="listbox" aria-label={label} aria-multiselectable={!single}>
          <div className="picker-search"><Search size={14} className="faint" />
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); if (shown[hi]) toggle(shown[hi].key); }
                else if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.preventDefault(); setOpen(false); }
              }} />
          </div>
          <div className="picker-list">
            {shown.length === 0 && <div className="small faint" style={{ padding: 10 }}>No matches</div>}
            {shown.map((o, i) => (
              <button type="button" key={o.key} role="option" aria-selected={value.includes(o.key)} className={"menu-item" + (i === hi ? " hi" : "")}
                onMouseEnter={() => setHi(i)} onClick={() => toggle(o.key)}>
                {o.icon}<span className="grow"><span>{o.label}</span>{o.sub && <span className="small faint" style={{ display: "block" }}>{o.sub}</span>}</span>
                {value.includes(o.key) && <Check size={15} className="r" color="var(--c-primary)" />}
              </button>))}
          </div>
          {!single && value.length > 0 && <div className="picker-foot"><button type="button" className="linkbtn small" onClick={() => onChange([])}>Clear</button>
            <button type="button" className="linkbtn small" onClick={() => setOpen(false)}>Done</button></div>}
        </div>)}
    </div>
  );
}

export function assigneeOptions(o: WOOptions | undefined): Opt[] {
  if (!o) return [];
  return [
    ...o.people.filter((p) => p.assignable).map((p) => ({ key: `user:${p.id}`, label: p.name, icon: <Avatar name={p.name} initials={p.initials} src={p.avatar_url} size="sm" /> })),
    ...o.teams.map((t) => ({ key: `team:${t.id}`, label: t.name, sub: "Team", icon: <span className="team-ic" style={{ background: t.color }}><Users size={12} /></span> })),
  ];
}

export function AssigneeChips({ items, max = 3 }: { items: Assignee[]; max?: number }) {
  if (!items.length) return <span className="faint">Unassigned</span>;
  return (
    <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
      {items.slice(0, max).map((a) => a.type === "user"
        ? <span key={a.id} className="chip"><Avatar name={a.name} initials={a.initials} src={a.avatar_url} size="sm" />{a.name}</span>
        : <span key={a.id} className="chip"><span className="team-ic" style={{ background: a.color }}><Users size={11} /></span>{a.name}</span>)}
      {items.length > max && <span className="chip">+{items.length - max}</span>}
    </span>
  );
}

export function AssigneePicker({ options, value, onChange, disabled, id }: { options: WOOptions | undefined; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; id?: string }) {
  return <MultiPicker id={id} label="Assignees" placeholder="Assign people or teams" options={assigneeOptions(options)} value={value} onChange={onChange} disabled={disabled}
    searchPlaceholder="Search people and teams"
    renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />;
}

export function CategoryChips({ items }: { items: CategoryRef[] }) {
  return <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{items.map((c) => <span key={c.id} className="chip"><span className="sw" style={{ background: c.color }} />{c.name}</span>)}</span>;
}

export function CategoryPicker({ options, value, onChange, disabled, id }: { options: WOOptions | undefined; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; id?: string }) {
  const opts = (options?.categories ?? []).map((c) => ({ key: c.id, label: c.name, icon: <span className="sw lg" style={{ background: c.color }} /> }));
  return <MultiPicker id={id} label="Categories" placeholder="Add categories" options={opts} value={value} onChange={onChange} disabled={disabled} searchPlaceholder="Search categories"
    renderValue={(sel) => <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>{sel.map((s) => <span key={s.key} className="chip">{s.icon}{s.label}</span>)}</span>} />;
}

// ---------------------------------------------------------------- signature
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111827";
  }, []);
  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const clear = () => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null); };
  return (
    <div className="sigpad">
      <canvas ref={canvas} aria-label="Signature area. Draw your signature with a mouse, finger or pen." role="img"
        onPointerDown={(e) => { drawing.current = true; canvas.current!.setPointerCapture(e.pointerId); const ctx = canvas.current!.getContext("2d")!; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const ctx = canvas.current!.getContext("2d")!; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); dirty.current = true; }}
        onPointerUp={() => { drawing.current = false; if (dirty.current) onChange(toPng(canvas.current!)); }} />
      <div className="row small" style={{ justifyContent: "space-between" }}><span className="faint">Sign above</span><button type="button" className="linkbtn small" onClick={clear}>Clear</button></div>
    </div>
  );
}

function toPng(c: HTMLCanvasElement): string {
  // white background so the signature reads in PDFs and dark mode alike
  const out = document.createElement("canvas");
  out.width = c.width; out.height = c.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(c, 0, 0);
  return out.toDataURL("image/png");
}

// ---------------------------------------------------------------- mentions
type Mentionable = { kind: "user" | "team"; id: string; name: string; initials?: string; color?: string };

export function MentionBox({ value, onChange, options, placeholder, onSubmit, autoFocus, rows = 2 }: {
  value: string; onChange: (v: string) => void; options: WOOptions | undefined; placeholder?: string; onSubmit?: () => void; autoFocus?: boolean; rows?: number;
}) {
  // The textarea shows "@Name"; we keep a map so we can turn it into @[Name](user:id) markup on send.
  const ta = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  useLayoutEffect(() => { // put the caret after an inserted mention before the next keystroke lands
    if (caret.current !== null && ta.current) { ta.current.selectionStart = ta.current.selectionEnd = caret.current; caret.current = null; }
  }, [value]);
  const [hi, setHi] = useState(0);
  const all: Mentionable[] = useMemo(() => [
    ...(options?.people ?? []).map((p) => ({ kind: "user" as const, id: p.id, name: p.name, initials: p.initials })),
    ...(options?.teams ?? []).map((t) => ({ kind: "team" as const, id: t.id, name: t.name, color: t.color })),
  ], [options]);
  const matches = query === null ? [] : all.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const onInput = (v: string) => {
    onChange(v);
    const caret = ta.current?.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = /(^|\s)@([\w .'-]{0,30})$/.exec(before);
    setQuery(m ? m[2] : null); setHi(0);
  };
  const pick = (m: Mentionable) => {
    const el = ta.current!;
    const pos = el.selectionStart;
    const before = value.slice(0, pos).replace(/@([\w .'-]{0,30})$/, `@[${m.name}](${m.kind}:${m.id}) `);
    const next = before + value.slice(pos);
    caret.current = before.length;
    onChange(next); setQuery(null); el.focus();
  };
  return (
    <div className="mention-wrap">
      <textarea ref={ta} className="textarea" rows={rows} value={value} placeholder={placeholder} autoFocus={autoFocus} aria-label={placeholder ?? "Comment"}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(matches.length - 1, h + 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[hi]); return; }
            if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.preventDefault(); setQuery(null); return; }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(); }
        }} />
      {matches.length > 0 && (
        <div className="menu mention-menu" role="listbox" aria-label="Mention someone">
          {matches.map((m, i) => (
            <button type="button" key={m.kind + m.id} className={"menu-item" + (i === hi ? " hi" : "")} role="option" aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}>
              {m.kind === "user" ? <Avatar name={m.name} initials={m.initials} size="sm" /> : <span className="team-ic" style={{ background: m.color }}><Users size={12} /></span>}
              {m.name}{m.kind === "team" && <span className="small faint r">Team</span>}
            </button>))}
        </div>)}
    </div>
  );
}

/** Renders comment text with mention markup as highlighted names. */
export function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  const re = /@\[([^\]]{1,200})\]\((user|team):([0-9a-fA-F-]{36})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<span key={m.index} className="mention">@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="richtext">{parts}</span>;
}

export function RemovableChip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return <span className="chip">{children}<Button variant="ghost" size="sm" icon aria-label="Remove" onClick={onRemove} style={{ width: 18, height: 18, minHeight: 0 }}><X size={12} /></Button></span>;
}
