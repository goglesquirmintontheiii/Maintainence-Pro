import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// How often something repeats (MaintainX: Daily, Weekly on chosen days, Monthly by date or weekday, Yearly, every N days).
// Used by the plan editor's tasks and the work order form's Repeat control.
import { Select } from "../../components/ui";
import { describe, FREQ_LABEL, WEEKDAYS } from "./types";
import { NumberInput } from "../../components/NumberInput";
const UNIT = {
    daily: ["day", "days"], every_n_days: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"],
};
export function ScheduleInput({ value, onChange, anchor, floating, idPrefix = "rep" }) {
    const n = value.interval || 1;
    const anchorDay = anchor ? (new Date(anchor).getDay() + 6) % 7 : null;
    const days = value.weekdays?.length ? value.weekdays : anchorDay !== null ? [anchorDay] : [];
    const toggleDay = (d) => {
        const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
        onChange({ ...value, weekdays: next.length ? next.sort() : days });
    };
    return (_jsxs("div", { className: "pm-sched", children: [_jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Select, { id: `${idPrefix}-freq`, "aria-label": "Repeats", value: value.freq, style: { width: 150 }, onChange: (e) => onChange({ freq: e.target.value, interval: value.interval }), children: Object.keys(FREQ_LABEL).map((f) => _jsx("option", { value: f, children: FREQ_LABEL[f] }, f)) }), _jsx("span", { className: "small muted", children: "every" }), _jsx(NumberInput, { id: `${idPrefix}-n`, "aria-label": "Interval", min: 1, max: 1000, integer: true, empty: 1, value: n, style: { width: 76 }, onValue: (v) => onChange({ ...value, interval: v ?? 1 }) }), _jsx("span", { className: "small muted", children: UNIT[value.freq][n === 1 ? 0 : 1] }), value.freq === "monthly" && (_jsxs(Select, { "aria-label": "Monthly on", value: value.monthly ?? "by_date", style: { width: 170 }, onChange: (e) => onChange({ ...value, monthly: e.target.value }), children: [_jsx("option", { value: "by_date", children: "On the same date" }), _jsx("option", { value: "by_weekday", children: "On the same weekday" })] }))] }), value.freq === "weekly" && (_jsx("div", { className: "pm-days", role: "group", "aria-label": "Weekdays", children: WEEKDAYS.map((w, i) => (_jsxs("button", { type: "button", className: "pm-day" + (days.includes(i) ? " on" : ""), "aria-pressed": days.includes(i), onClick: () => toggleDay(i), children: [w[0], _jsx("span", { className: "sr-only", children: w })] }, w))) })), _jsx("span", { className: "small muted pm-sched-sum", children: describe({ ...value, weekdays: days }, anchor, floating) })] }));
}
