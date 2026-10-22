// How often something repeats (MaintainX: Daily, Weekly on chosen days, Monthly by date or weekday, Yearly, every N days).
// Used by the plan editor's tasks and the work order form's Repeat control.
import { Input, Select } from "../../components/ui";
import { describe, FREQ_LABEL, WEEKDAYS, type Freq, type Spec } from "./types";

const UNIT: Record<Freq, [string, string]> = {
  daily: ["day", "days"], every_n_days: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"],
};

export function ScheduleInput({ value, onChange, anchor, floating, idPrefix = "rep" }: {
  value: Spec; onChange: (s: Spec) => void; anchor?: string | null; floating?: boolean; idPrefix?: string;
}) {
  const n = value.interval || 1;
  const anchorDay = anchor ? (new Date(anchor).getDay() + 6) % 7 : null;
  const days = value.weekdays?.length ? value.weekdays : anchorDay !== null ? [anchorDay] : [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    onChange({ ...value, weekdays: next.length ? next.sort() : days });
  };
  return (
    <div className="pm-sched">
      <div className="row wrap" style={{ gap: 6 }}>
        <Select id={`${idPrefix}-freq`} aria-label="Repeats" value={value.freq} style={{ width: 150 }}
          onChange={(e) => onChange({ freq: e.target.value as Freq, interval: value.interval })}>
          {(Object.keys(FREQ_LABEL) as Freq[]).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
        </Select>
        <span className="small muted">every</span>
        <Input id={`${idPrefix}-n`} aria-label="Interval" type="number" min={1} max={1000} value={n} style={{ width: 76 }}
          onChange={(e) => onChange({ ...value, interval: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />
        <span className="small muted">{UNIT[value.freq][n === 1 ? 0 : 1]}</span>
        {value.freq === "monthly" && (
          <Select aria-label="Monthly on" value={value.monthly ?? "by_date"} style={{ width: 170 }}
            onChange={(e) => onChange({ ...value, monthly: e.target.value as Spec["monthly"] })}>
            <option value="by_date">On the same date</option><option value="by_weekday">On the same weekday</option>
          </Select>)}
      </div>
      {value.freq === "weekly" && (
        <div className="pm-days" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((w, i) => (
            <button type="button" key={w} className={"pm-day" + (days.includes(i) ? " on" : "")} aria-pressed={days.includes(i)} onClick={() => toggleDay(i)}>{w[0]}<span className="sr-only">{w}</span></button>))}
        </div>)}
      <span className="small muted pm-sched-sum">{describe({ ...value, weekdays: days }, anchor, floating)}</span>
    </div>
  );
}
