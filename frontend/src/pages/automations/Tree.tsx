// Automation tree (0.5.0, MP-129): the trigger → conditions → actions of one automation as a collapsible tree, each
// node in plain words. Used on the automation page and live in the builder; empty branches say what's missing.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Filter, ListTree, Play, Zap } from "lucide-react";
import {
  ACTION_LABEL, ASSET_STATUS, COND_LABEL, RECURRING, TRIGGER_LABEL, WEEKDAYS, WO_STATUS, minutesText,
  type Action, type AutomationDoc, type Condition,
} from "./types";

const list = (xs: string[], none: string) => (xs.length ? xs.join(" or ") : none);

export function triggerText(d: AutomationDoc): string {
  const t = d.trigger;
  if (t.type === "meter_reading") {
    const v = String(t.value ?? "").trim();
    if (!v) return "A meter reading: pick a value to compare with";
    return `A meter reading ${COND_LABEL[t.condition].toLowerCase()} ${v}${RECURRING.includes(t.condition) && t.first_at !== undefined && t.first_at !== "" ? `, starting at ${t.first_at}` : ""}`;
  }
  if (t.type === "asset_status") return `An asset goes from ${list(t.from.map((s) => ASSET_STATUS[s]), "any status")} to ${list(t.to.map((s) => ASSET_STATUS[s]), "any status")}`;
  const extra = [t.priorities.length ? `priority ${t.priorities.join(" or ")}` : "", t.categories.length ? `${t.categories.length} categor${t.categories.length === 1 ? "y" : "ies"}` : ""].filter(Boolean);
  return `A work order goes from ${list(t.from.map((s) => WO_STATUS[s]), "any status")} to ${list(t.to.map((s) => WO_STATUS[s]), "any status")}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

function sensitivityText(d: AutomationDoc): string {
  const s = d.sensitivity ?? {};
  if (s.mode === "once") return "Only the first time it happens, until it goes back";
  if (s.mode === "n_of_m") return `When it happens ${s.n ?? "?"} times in the last ${s.m ?? "?"} readings`;
  if (s.mode === "duration") return `When it stays that way for ${minutesText(s.minutes) || "a while"}`;
  return "Every time it happens";
}

export function conditionText(c: Condition): string {
  if (c.type === "asset_status") return c.in.length ? `The asset is ${list(c.in.map((s) => ASSET_STATUS[s]), "")}` : "The asset is in… (pick a status)";
  if (c.type === "weekday") return c.days.length ? `It's ${c.days.map((d) => WEEKDAYS[d] ?? d).join(", ")}` : "It's one of… (pick days)";
  return c.from && c.to ? `Between ${c.from} and ${c.to}` : "Between… (pick the times)";
}

export function actionText(a: Action): string {
  if (a.type === "create_work_order") {
    const what = a.title?.trim() ? `“${a.title.trim()}”` : a.template_id ? "from a template" : "(add a title or template)";
    const who = a.assignees?.length ? `, assigned to ${a.assignees.length}` : "";
    const due = a.due_in_days !== undefined && a.due_in_days !== "" ? `, due in ${a.due_in_days} day${a.due_in_days === 1 ? "" : "s"}` : "";
    return `Create a work order ${what}${who}${due}`;
  }
  if (a.type === "change_asset_status") return `Set the asset to ${ASSET_STATUS[a.status]}${a.downtime_type ? ` (${a.downtime_type} downtime)` : ""}${a.reason ? `: ${a.reason}` : ""}`;
  return a.recipients.length ? `Email ${a.recipients.length} recipient${a.recipients.length === 1 ? "" : "s"}${a.subject ? `: “${a.subject}”` : ""}` : "Send an email (add recipients)";
}

function Node({ icon, title, children, empty, open: start = true }: { icon: ReactNode; title: string; children?: ReactNode[]; empty?: string; open?: boolean }) {
  const [open, setOpen] = useState(start);
  const kids = (children ?? []).filter(Boolean);
  return (
    <li className="atree-node">
      <button type="button" className="atree-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{icon}<span>{title}</span>
        <span className="atree-count">{kids.length}</span>
      </button>
      {open && (kids.length ? <ul>{kids}</ul> : <div className={"atree-empty" + (empty?.startsWith("Missing") ? " missing" : "")}>{empty}</div>)}
    </li>
  );
}
const Leaf = ({ text, sub, missing }: { text: string; sub?: string; missing?: boolean }) => (
  <li className={"atree-leaf" + (missing ? " missing" : "")}><span>{text}</span>{sub && <span className="small faint">{sub}</span>}</li>);

export function AutomationTree({ doc, targetNames, defaultOpen = true }: { doc: AutomationDoc; targetNames?: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const kind = doc.trigger.type === "meter_reading" ? "meter" : "asset";
  const targets = targetNames?.length ? targetNames.slice(0, 5).join(", ") + (targetNames.length > 5 ? ` and ${targetNames.length - 5} more` : "")
    : doc.targets.length ? `${doc.targets.length} ${kind}${doc.targets.length === 1 ? "" : "s"}` : "";
  return (
    <section className="card atree" aria-label="How this automation works">
      <button type="button" className="atree-top" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<ListTree size={16} aria-hidden /><span>How it works</span>
        <span className="small faint">{TRIGGER_LABEL[doc.trigger.type]} → {doc.conditions.length} condition{doc.conditions.length === 1 ? "" : "s"} → {doc.actions.length} action{doc.actions.length === 1 ? "" : "s"}</span>
      </button>
      {open && <ul className="atree-root">
        <Node icon={<Zap size={14} aria-hidden />} title="When" empty="">
          {[<Leaf key="t" text={triggerText(doc)} missing={doc.trigger.type === "meter_reading" && !String(doc.trigger.value ?? "").trim()} />,
            doc.trigger.type === "work_order_status"
              ? <Leaf key="g" text={targets ? `Work orders on ${targets}` : "Work orders on any asset"} />
              : <Leaf key="g" text={targets ? `On ${targets}` : `Missing: pick one or more ${kind}s`} missing={!targets} />,
            doc.trigger.type === "meter_reading" ? <Leaf key="s" text={sensitivityText(doc)} /> : null]}
        </Node>
        <Node icon={<Filter size={14} aria-hidden />} title="Only if" empty="No conditions: it runs every time the trigger fires.">
          {doc.conditions.map((c, i) => <Leaf key={i} text={conditionText(c)} missing={conditionText(c).includes("pick")} />)}
        </Node>
        <Node icon={<Play size={14} aria-hidden />} title="Then" empty="Missing: add at least one action.">
          {doc.actions.map((a, i) => <Leaf key={i} text={actionText(a)} sub={ACTION_LABEL[a.type]} missing={/\(add/.test(actionText(a))} />)}
        </Node>
        {doc.rerun_minutes > 0 && <Leaf text={`Then waits ${minutesText(doc.rerun_minutes)} before it can run again`} />}
      </ul>}
    </section>
  );
}
