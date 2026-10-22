"""Recurrence maths for preventive maintenance (roadmap r153): RFC 5545 RRULEs in the plan's time zone.

Due dates are computed on the wall clock of the plan's time zone and converted to UTC afterwards, so a PM due
"every Monday 08:00" stays at 08:00 across daylight-saving changes. Pure functions only; no database access.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import rrulestr

from mpro.orgs.services import RuleError

FREQS = ("daily", "weekly", "monthly", "yearly", "every_n_days")
WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
ORDINALS = {1: "first", 2: "second", 3: "third", 4: "fourth", -1: "last"}


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def build_rrule(spec: dict[str, Any], anchor_local: datetime) -> str:
    """A friendly repeat spec (what the form sends) as an RRULE string.

    spec: {freq: daily|weekly|monthly|yearly|every_n_days, interval: n, weekdays: [0-6] (weekly),
           monthly: "by_date"|"by_weekday" (monthly)}
    MaintainX offers Daily, Weekly (every N weeks on chosen weekdays), Monthly by date, Monthly by weekday
    (1st–4th or last), Yearly and periodic every N days (r156).
    """
    if not isinstance(spec, dict):
        raise RuleError("Pick how often it repeats.", 422)
    freq = spec.get("freq")
    if freq not in FREQS:
        raise RuleError("Repeat daily, weekly, monthly, yearly or every N days.", 422)
    try:
        interval = int(spec.get("interval") or 1)
    except (TypeError, ValueError) as e:
        raise RuleError("The interval must be a whole number.", 422) from e
    if not 1 <= interval <= 1000:
        raise RuleError("The interval must be between 1 and 1,000.", 422)
    if freq == "every_n_days":
        return f"FREQ=DAILY;INTERVAL={interval}"
    if freq == "daily":
        return f"FREQ=DAILY;INTERVAL={interval}"
    if freq == "weekly":
        days = spec.get("weekdays") or [anchor_local.weekday()]
        if not isinstance(days, list) or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
            raise RuleError("Pick the weekdays it repeats on.", 422)
        byday = ",".join(WEEKDAYS[d] for d in sorted(set(days)))
        return f"FREQ=WEEKLY;INTERVAL={interval};BYDAY={byday}"
    if freq == "monthly":
        if spec.get("monthly") == "by_weekday":
            nth = (anchor_local.day - 1) // 7 + 1
            pos = -1 if spec.get("last") or nth == 5 else nth
            return f"FREQ=MONTHLY;INTERVAL={interval};BYDAY={pos}{WEEKDAYS[anchor_local.weekday()]}"
        return f"FREQ=MONTHLY;INTERVAL={interval};BYMONTHDAY={anchor_local.day}"
    return f"FREQ=YEARLY;INTERVAL={interval}"


def describe(spec: dict[str, Any] | None, anchor_local: datetime | None = None, floating: bool = False) -> str:
    """Plain-language summary, e.g. "Every 2 weeks on Mon, Thu"."""
    if not spec:
        return ""
    freq, n = spec.get("freq"), int(spec.get("interval") or 1)
    tail = " after completion" if floating else ""
    if freq in ("daily", "every_n_days"):
        return ("Every day" if n == 1 else f"Every {n} days") + tail
    if freq == "weekly":
        days = spec.get("weekdays") or ([anchor_local.weekday()] if anchor_local else [])
        on = f" on {', '.join(WEEKDAY_NAMES[d] for d in sorted(set(days)))}" if days else ""
        return ("Every week" if n == 1 else f"Every {n} weeks") + on + tail
    if freq == "monthly":
        base = "Every month" if n == 1 else f"Every {n} months"
        if anchor_local is not None:
            if spec.get("monthly") == "by_weekday":
                nth = (anchor_local.day - 1) // 7 + 1
                word = "last" if spec.get("last") or nth == 5 else ORDINALS.get(nth, f"{nth}th")
                base += f" on the {word} {WEEKDAY_NAMES[anchor_local.weekday()]}"
            else:
                base += f" on day {anchor_local.day}"
        return base + tail
    if freq == "yearly":
        base = "Every year" if n == 1 else f"Every {n} years"
        if anchor_local is not None:
            base += f" on {anchor_local:%b} {anchor_local.day}"
        return base + tail
    return ""


def describe_rrule(rule: str) -> str:
    """Fallback description for a raw RRULE (API clients)."""
    parts = dict(p.split("=", 1) for p in rule.split(";") if "=" in p)
    n = int(parts.get("INTERVAL", "1"))
    unit = {"DAILY": "day", "WEEKLY": "week", "MONTHLY": "month", "YEARLY": "year"}.get(parts.get("FREQ", ""), "")
    if not unit:
        return rule
    return f"Every {unit}" if n == 1 else f"Every {n} {unit}s"


def validate_rrule(rule: str) -> str:
    rule = (rule or "").strip().removeprefix("RRULE:")
    if not rule:
        raise RuleError("A time-based schedule needs a repeat rule.", 422)
    if len(rule) > 500 or "DTSTART" in rule.upper():
        raise RuleError("That repeat rule isn't valid.", 422)
    try:
        rrulestr(rule, dtstart=datetime(2026, 1, 1, 8, 0))
    except (ValueError, TypeError) as e:
        raise RuleError("That repeat rule isn't valid.", 422) from e
    if "COUNT" not in rule.upper() and "UNTIL" not in rule.upper() and "FREQ=SECONDLY" in rule.upper():
        raise RuleError("Schedules can repeat at most daily.", 422)
    if any(f in rule.upper() for f in ("FREQ=SECONDLY", "FREQ=MINUTELY", "FREQ=HOURLY")):
        raise RuleError("Schedules can repeat at most daily.", 422)
    return rule


def to_local(dt: datetime, tz: ZoneInfo) -> datetime:
    return dt.astimezone(tz).replace(tzinfo=None)


def to_utc(local_naive: datetime, tz: ZoneInfo) -> datetime:
    """Wall-clock time in tz -> UTC. Nonexistent times (spring forward) move forward an hour."""
    aware = local_naive.replace(tzinfo=tz)
    back = aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None)
    if back != local_naive:  # inside a DST gap
        aware = (local_naive + timedelta(hours=1)).replace(tzinfo=tz)
    return aware.astimezone(UTC)


def expand(rule: str, anchor: datetime, tz: ZoneInfo, start: datetime, end: datetime) -> list[datetime]:
    """Due dates (UTC) of `rule` anchored at `anchor` (UTC) that fall in [start, end)."""
    dtstart = to_local(anchor, tz)
    r = rrulestr(rule, dtstart=dtstart)
    lo, hi = to_local(start, tz), to_local(end, tz)
    out = []
    for local in r.between(lo - timedelta(days=1), hi + timedelta(days=1), inc=True):
        u = to_utc(local, tz)
        if start <= u < end:
            out.append(u)
        if len(out) > 2000:
            break
    return out


def next_after(rule: str, base: datetime, anchor: datetime, tz: ZoneInfo) -> datetime | None:
    """Floating intervals: the first due date after `base` (a completion), keeping the anchor's time of day."""
    a = to_local(anchor, tz)
    b = to_local(base, tz)
    dtstart = b.replace(hour=a.hour, minute=a.minute, second=0, microsecond=0)
    r = rrulestr(rule, dtstart=dtstart)
    nxt = r.after(dtstart, inc=False)
    return to_utc(nxt, tz) if nxt else None


def is_workday(d: date, holidays: set[date], skip_weekends: bool, skip_holidays: bool) -> bool:
    if skip_weekends and d.weekday() >= 5:
        return False
    return not (skip_holidays and d in holidays)


def apply_calendar(due: datetime, cal: dict[str, Any], tz: ZoneInfo, holidays: Iterable[date]) -> datetime | None:
    """Seasonal months and weekend/holiday rules (MP-038). Returns the shifted due date, or None to drop it."""
    local = to_local(due, tz)
    months = cal.get("months") or []
    if months and local.month not in months:
        return None
    sw, sh = bool(cal.get("skip_weekends")), bool(cal.get("skip_holidays"))
    hol = set(holidays)
    if is_workday(local.date(), hol, sw, sh):
        return due
    shift = cal.get("shift") or "previous"
    if shift == "skip":
        return None
    step = -1 if shift == "previous" else 1
    d = local
    for _ in range(14):
        d = d + timedelta(days=step)
        if is_workday(d.date(), hol, sw, sh):
            return to_utc(d, tz)
    return None
