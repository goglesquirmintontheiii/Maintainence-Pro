// Header row for date-based views (Calendar, Workload; MP-113): Today, previous/next and the period label grouped
// on the left with the range switch next to them; filters on the right. Wraps cleanly on phones.
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui";

export function PeriodBar<T extends string | number>({ label, onToday, onMove, range, ranges, onRange, rangeLabel = "Range", children }: {
  label: ReactNode; onToday: () => void; onMove: (d: -1 | 1) => void;
  range: T; ranges: { id: T; label: string }[]; onRange: (r: T) => void; rangeLabel?: string; children?: ReactNode;
}) {
  return (
    <div className="period-bar">
      <div className="period-nav">
        <Button size="sm" onClick={onToday}>Today</Button>
        <span className="period-arrows">
          <Button size="sm" variant="ghost" icon aria-label="Previous" onClick={() => onMove(-1)}><ChevronLeft size={16} /></Button>
          <Button size="sm" variant="ghost" icon aria-label="Next" onClick={() => onMove(1)}><ChevronRight size={16} /></Button>
        </span>
        <h2 className="period-label" aria-live="polite">{label}</h2>
      </div>
      <div className="seg period-seg" role="group" aria-label={rangeLabel}>
        {ranges.map((r) => (
          <button key={String(r.id)} type="button" aria-pressed={r.id === range} className={"seg-btn" + (r.id === range ? " on" : "")} onClick={() => onRange(r.id)}>{r.label}</button>
        ))}
      </div>
      {children && <div className="period-side">{children}</div>}
    </div>
  );
}
