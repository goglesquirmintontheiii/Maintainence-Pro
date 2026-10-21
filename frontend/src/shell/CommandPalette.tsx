import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, Search, User, Users } from "lucide-react";
import { api, type SearchGroup } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV, SETTINGS_NAV } from "./nav";
import { Avatar } from "../components/ui";

type Item = { key: string; group: string; title: string; subtitle?: string; url: string; icon?: React.ReactNode };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const { can } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setRemote([]); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api<{ groups: SearchGroup[] }>(`/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => setRemote(r.groups)).catch(() => {}).finally(() => setLoading(false));
    }, 140);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const pages = [...NAV.map((n) => ({ ...n, sub: n.phase ? `Coming in ${n.phase}` : n.group || "Home" })),
      ...SETTINGS_NAV.filter((s) => !s.perm || can(s.perm)).map((s) => ({ id: s.path, label: s.label, path: s.path, icon: s.icon, sub: "Settings", keywords: "" }))]
      .filter((n) => !term || (n.label + " " + (n.keywords ?? "")).toLowerCase().includes(term))
      .slice(0, term ? 6 : 8)
      .map<Item>((n) => { const Icon = n.icon; return { key: "nav:" + n.path, group: "Go to", title: n.label, subtitle: n.sub, url: n.path, icon: <Icon size={16} /> }; });
    const found = remote.flatMap((g) => g.results.map<Item>((r) => ({
      key: g.type + ":" + r.id, group: g.label, title: r.title, subtitle: r.subtitle, url: r.url,
      icon: g.type === "people" ? <Avatar name={r.title} initials={r.initials} size="sm" /> : g.type === "teams"
        ? <span className="chip" style={{ padding: 0, width: 28, justifyContent: "center", border: 0 }}><Users size={15} color={r.color} /></span> : <User size={16} /> })));
    return [...found, ...pages];
  }, [q, remote, can]);

  useEffect(() => { setSel(0); }, [items.length, q]);
  useEffect(() => { list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const go = (it?: Item) => { if (!it) return; onClose(); nav(it.url); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(items[sel]); }
    else if (e.key === "Escape") onClose();
  };

  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <Search size={18} className="faint" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search people, teams and pages…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="palette-list" />
          {loading && <span className="small faint">Searching…</span>}
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.length === 0 && <div className="empty" style={{ padding: 28 }}><p>Nothing matches “{q}”. Work orders, assets and parts become searchable as their modules arrive.</p></div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{(lastGroup = it.group)}</div> : null;
            return (
              <div key={it.key}>
                {head}
                <div className={"palette-item" + (i === sel ? " sel" : "")} role="option" aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
                  <span className="ic">{it.icon}</span>
                  <span className="grow"><div style={{ fontWeight: 600 }}>{it.title}</div>{it.subtitle && <div className="small muted">{it.subtitle}</div>}</span>
                  {i === sel && <CornerDownLeft size={14} className="faint" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span><span className="kbd">↑</span> <span className="kbd">↓</span> to move</span><span><span className="kbd">Enter</span> to open</span><span><span className="kbd">Esc</span> to close</span></div>
      </div>
    </div>
  );
}
