import json
import math
import os
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field


LOCAL_TZ = ZoneInfo("America/Los_Angeles")
RESERVED_TIME_TERMS = {
    "today",
    "yesterday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "week",
    "month",
}

MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

INTERNAL_DOMAIN_TERMS = {
    "unknown",
    "extensions",
    "newtab",
    "new-tab-page",
}

AI_RESPONSE_CACHE_TTL_SECONDS = 45
AI_RESPONSE_CACHE: dict[str, tuple[float, str]] = {}
NON_USER_REFLECTION_TEXTS = {
    "ended due to inactivity",
    "ended manually",
    "ended when browser closed or restarted",
}


def json_safe(obj: Any) -> Any:
    if obj is None:
        return None

    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj

    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}

    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]

    return obj


def ms_to_pretty(ms: Any) -> str:
    value = int(max(0, float(ms or 0)))
    total_seconds = value // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60

    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes or hours:
        parts.append(f"{minutes}m")
    if not hours:
        parts.append(f"{seconds}s")
    return " ".join(parts)


def format_active_window(window: Any) -> str:
    if isinstance(window, dict):
        label = str(window.get("label") or "").strip()
        session_count = int(to_float(window.get("sessions"), 0))
        if label and session_count > 0:
            return f"You’re most active between {label}, with {session_count} sessions."
        if label:
            return f"You’re most active between {label}."
    if isinstance(window, str) and window.strip():
        return f"You’re most active between {window.strip()}."
    return ""


def format_answer(summary: str, bullets: list[str] | None = None, follow_up: str | None = None) -> str:
    lines = [summary.strip()]
    for bullet in bullets or []:
        clean = str(bullet or "").strip()
        if clean:
            lines.append(f"- {clean}")
    if follow_up:
        lines.append(follow_up.strip())
    return "\n".join(line for line in lines if line)


def format_sectioned_answer(summary: str, bullets: list[str] | None = None, next_step: str | None = None) -> str:
    lines = ["Summary:", summary.strip()]
    clean_bullets = [str(item or "").strip() for item in (bullets or []) if str(item or "").strip()]
    if clean_bullets:
        lines.extend(["", "Key points:"])
        lines.extend(f"- {item}" for item in clean_bullets)
    if next_step:
        lines.extend(["", "Next:", next_step.strip()])
    return "\n".join(lines)


def to_local_datetime(value: Any) -> datetime | None:
    try:
        ts = float(value or 0)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return datetime.fromtimestamp(ts / 1000, tz=LOCAL_TZ)


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


def is_display_domain(domain: Any) -> bool:
    normalized = str(domain or "").strip().lower()
    if not normalized or normalized in INTERNAL_DOMAIN_TERMS:
        return False
    return not (
        normalized.startswith("data:") or
        normalized.startswith("blob:") or
        normalized.startswith("javascript:") or
        normalized.startswith("about:") or
        normalized.startswith("devtools:") or
        normalized.startswith("chrome:") or
        normalized.startswith("chrome-search:")
    )


def start_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def end_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=23, minute=59, second=59, microsecond=999000)


def build_domain_aliases(domain: str) -> set[str]:
    clean = (domain or "").strip().lower()
    if not clean:
        return set()

    aliases = {clean}
    without_www = clean.removeprefix("www.")
    aliases.add(without_www)
    labels = without_www.split(".")
    if labels:
        if len(labels[0]) >= 3:
            aliases.add(labels[0])
            aliases.add(labels[0].replace("-", " "))
    if len(labels) >= 2:
        if len(labels[0]) >= 3 and len(labels[1]) >= 3:
            aliases.add(f"{labels[0]} {labels[1]}")
            aliases.add(f"{labels[1]} {labels[0]}")
            aliases.add(f"{labels[0]}.{labels[1]}")
    if len(labels) >= 3 and labels[-2:] == ["google", "com"]:
        aliases.add(f"google {labels[0]}")
        aliases.add(f"{labels[0]} google")
    return {alias.strip() for alias in aliases if alias.strip()}


def contains_alias(question: str, alias: str) -> bool:
    candidate = str(alias or "").strip().lower()
    if not candidate:
        return False
    if "." in candidate:
        return candidate in question
    escaped = re.escape(candidate)
    pattern = rf"(?<![a-z0-9]){escaped}(?![a-z0-9])"
    return re.search(pattern, question) is not None


def canonical_phrase_for_domain(domain: str) -> str | None:
    clean = (domain or "").strip().lower().removeprefix("www.")
    special = {
        "docs.google.com": "google docs",
        "mail.google.com": "gmail",
        "calendar.google.com": "google calendar",
        "drive.google.com": "google drive",
        "chat.openai.com": "chatgpt",
        "chatgpt.com": "chatgpt",
    }
    return special.get(clean)


def collect_known_domains(context: dict[str, Any]) -> list[str]:
    domains: set[str] = set()
    for row in context.get("todaySummary", {}).get("topSites", []) or []:
        if isinstance(row, dict):
            domain = row.get("domain")
        else:
            domain = row
        if is_display_domain(domain):
            domains.add(str(domain))
    for row in context.get("fullVisitHistory", []) or []:
        if not isinstance(row, dict):
            continue
        domain = row.get("domain")
        if is_display_domain(domain):
            domains.add(str(domain))
    for session in context.get("fullSessionHistory", []) or []:
        if not isinstance(session, dict):
            continue
        for row in session.get("topSites", []) or []:
            if isinstance(row, dict):
                domain = row.get("domain")
            else:
                domain = row
            if is_display_domain(domain):
                domains.add(str(domain))
        for domain in (session.get("timePerDomain") or {}).keys():
            if is_display_domain(domain):
                domains.add(str(domain))
    return sorted(domains)


def detect_question_domains(question: str, context: dict[str, Any]) -> list[str]:
    q = question.lower()
    scored_matches: list[tuple[int, str]] = []
    for domain in collect_known_domains(context):
        normalized_domain = domain.lower().removeprefix("www.")
        root_label = normalized_domain.split(".")[0]
        if root_label in RESERVED_TIME_TERMS:
            continue
        aliases = build_domain_aliases(domain)
        canonical = canonical_phrase_for_domain(domain)
        best_score = -1

        if canonical and canonical in q:
            best_score = max(best_score, 1000 + len(canonical))

        if normalized_domain in q:
            best_score = max(best_score, 900 + len(normalized_domain))

        for alias in aliases:
            if not alias:
                continue
            if len(alias) < 3:
                continue
            if not contains_alias(q, alias):
                continue
            score = len(alias)
            if " " in alias:
                score += 200
            elif "." in alias:
                score += 150
            elif alias == normalized_domain.split(".")[0]:
                score += 25
            best_score = max(best_score, score)

        if best_score >= 0:
            scored_matches.append((best_score, domain))

    scored_matches.sort(key=lambda item: (-item[0], item[1]))
    ordered: list[str] = []
    for _, domain in scored_matches:
        if domain not in ordered:
            ordered.append(domain)
    return ordered[:3]


def parse_date_anchor_phrase(phrase: str, now: datetime, reference_start: datetime | None = None) -> datetime | None:
    text = str(phrase or "").strip().lower()
    if not text:
        return None

    if text == "today":
        return start_of_day(now)
    if text == "yesterday":
        return start_of_day(now - timedelta(days=1))

    weekday_names = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
    weekday_index = {name: index for index, name in enumerate(weekday_names)}

    last_weekday_match = re.fullmatch(
        r"(?:since\s+)?last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
        text,
    )
    if last_weekday_match:
        weekday = last_weekday_match.group(1)
        index = weekday_index[weekday]
        days_back = (now.weekday() - index) % 7
        if days_back == 0:
            days_back = 7
        return start_of_day(now - timedelta(days=days_back))

    this_weekday_match = re.fullmatch(
        r"(?:since\s+)?(?:this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
        text,
    )
    if this_weekday_match:
        weekday = this_weekday_match.group(1)
        index = weekday_index[weekday]
        if reference_start:
            base = start_of_day(reference_start)
            delta = (index - base.weekday()) % 7
            return start_of_day(base + timedelta(days=delta))
        days_back = (now.weekday() - index) % 7
        return start_of_day(now - timedelta(days=days_back))

    month_day_match = re.fullmatch(
        r"(?:since\s+)?("
        + "|".join(MONTH_NAMES.keys())
        + r")\s+(\d{1,2})",
        text,
    )
    if month_day_match:
        month = MONTH_NAMES[month_day_match.group(1)]
        day = int(month_day_match.group(2))
        year = now.year
        try:
            candidate = datetime(year, month, day, tzinfo=LOCAL_TZ)
        except ValueError:
            return None
        if candidate > now and not reference_start:
            candidate = datetime(year - 1, month, day, tzinfo=LOCAL_TZ)
        return start_of_day(candidate)

    return None


def extract_time_window(question: str) -> tuple[int | None, int | None, str]:
    q = question.lower()
    now = datetime.now(LOCAL_TZ)

    between_match = re.search(
        r"\bbetween\s+(.+?)\s+and\s+(.+?)(?:$|[?.!,])",
        q,
    )
    if between_match:
        start_phrase = between_match.group(1).strip()
        end_phrase = between_match.group(2).strip()
        end_phrase = re.split(
            r"\s+(?:on|for|with|in)\s+(?:www\.)?[a-z0-9.-]+(?:\.[a-z]{2,})?(?:\s|$)",
            end_phrase,
            maxsplit=1,
        )[0].strip()
        start_dt = parse_date_anchor_phrase(start_phrase, now)
        end_dt = parse_date_anchor_phrase(end_phrase, now, reference_start=start_dt)
        if start_dt and end_dt:
            if end_dt < start_dt:
                end_dt = start_of_day(end_dt + timedelta(days=7))
            return (
                int(start_of_day(start_dt).timestamp() * 1000),
                int(end_of_day(end_dt).timestamp() * 1000),
                f"between {start_phrase.title()} and {end_phrase.title()}",
            )

    start_ms, label = extract_time_filter(question)
    return start_ms, None, label


def extract_time_filter(question: str) -> tuple[int | None, str]:
    q = question.lower()
    now = datetime.now(LOCAL_TZ)
    weekday_names = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
    weekday_index = {name: index for index, name in enumerate(weekday_names)}

    def ms_and_label(dt: datetime, label: str) -> tuple[int, str]:
        return int(start_of_day(dt).timestamp() * 1000), label

    if "today" in q:
        return ms_and_label(now, "today")
    if "yesterday" in q:
        return ms_and_label(now - timedelta(days=1), "yesterday onward")

    last_weekday_match = re.search(r"\bsince\s+last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", q)
    if last_weekday_match:
        weekday = last_weekday_match.group(1)
        index = weekday_index[weekday]
        days_back = (now.weekday() - index) % 7
        if days_back == 0:
            days_back = 7
        return ms_and_label(now - timedelta(days=days_back), f"since last {weekday.capitalize()}")

    this_weekday_match = re.search(r"\bsince\s+(?:this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", q)
    if this_weekday_match:
        weekday = this_weekday_match.group(1)
        index = weekday_index[weekday]
        days_back = (now.weekday() - index) % 7
        return ms_and_label(now - timedelta(days=days_back), f"since {weekday.capitalize()}")

    if "since last week" in q or "last week onward" in q:
        this_week_start = start_of_day(now - timedelta(days=now.weekday()))
        return ms_and_label(this_week_start - timedelta(days=7), "since last week")

    if "this week" in q or "week so far" in q:
        week_start = start_of_day(now - timedelta(days=now.weekday()))
        return int(week_start.timestamp() * 1000), "this week"

    if "since last month" in q or "last month onward" in q:
        this_month_start = start_of_day(now.replace(day=1))
        previous_month_end = this_month_start - timedelta(days=1)
        previous_month_start = previous_month_end.replace(day=1)
        return ms_and_label(previous_month_start, "since last month")

    rolling_match = re.search(r"\b(?:over|during|for|in)\s+the\s+last\s+(\d+)\s+(day|days|week|weeks|month|months)\b", q)
    if not rolling_match:
        rolling_match = re.search(r"\b(?:past|last)\s+(\d+)\s+(day|days|week|weeks|month|months)\b", q)
    if rolling_match:
        amount = max(1, int(rolling_match.group(1)))
        unit = rolling_match.group(2)
        if unit.startswith("day"):
            return ms_and_label(now - timedelta(days=amount), f"over the last {amount} days")
        if unit.startswith("week"):
            return ms_and_label(now - timedelta(days=amount * 7), f"over the last {amount} weeks")
        if unit.startswith("month"):
            return ms_and_label(now - timedelta(days=amount * 30), f"over the last {amount} months")

    month_day_match = re.search(
        r"\bsince\s+("
        + "|".join(MONTH_NAMES.keys())
        + r")\s+(\d{1,2})\b",
        q,
    )
    if month_day_match:
        month = MONTH_NAMES[month_day_match.group(1)]
        day = int(month_day_match.group(2))
        year = now.year
        try:
            candidate = datetime(year, month, day, tzinfo=LOCAL_TZ)
        except ValueError:
            candidate = None
        if candidate:
            if candidate > now:
                candidate = datetime(year - 1, month, day, tzinfo=LOCAL_TZ)
            return ms_and_label(candidate, f"since {month_day_match.group(1).capitalize()} {day}")

    if "this month" in q:
        month_start = start_of_day(now.replace(day=1))
        return int(month_start.timestamp() * 1000), "this month"
    return None, "all time"


def question_requests_specific_range(question: str) -> bool:
    q = question.lower()
    if any(
        phrase in q
        for phrase in [
            "since ",
            "last week",
            "last month",
            "this week",
            "this month",
            "yesterday",
            "today",
            "past ",
            "over the last ",
            "during the last ",
        ]
    ):
        return True
    if re.search(r"\b(?:last|past)\s+\d+\s+(?:day|days|week|weeks|month|months)\b", q):
        return True
    if re.search(r"\bsince\s+(?:" + "|".join(MONTH_NAMES.keys()) + r")\s+\d{1,2}\b", q):
        return True
    return False


def unresolved_range_response() -> str:
    return (
        "I can answer that exactly, but I couldn’t parse the date range yet. "
        "Try phrasing it like 'since last Wednesday', 'since this Monday', or 'over the last 7 days'."
    )


def is_generic_total_time_question(question: str) -> bool:
    q = question.lower()
    if not any(phrase in q for phrase in ["how much time", "total time", "time have i spent", "time did i spend"]):
        return False
    if any(phrase in q for phrase in [" on ", "spent on", "time on", "for ", "after ", "before ", "lead into", "leading to"]):
        return False
    return True


def filter_visits(
    visits: list[dict[str, Any]],
    *,
    start_ms: int | None,
    end_ms: int | None = None,
    domains: list[str],
) -> list[dict[str, Any]]:
    domain_set = {domain.lower() for domain in domains}
    rows: list[dict[str, Any]] = []
    for visit in visits:
        time_value = to_float(visit.get("time"), 0)
        if start_ms and time_value < start_ms:
            continue
        if end_ms and time_value > end_ms:
            continue
        domain = str(visit.get("domain") or "").lower()
        if not is_display_domain(domain):
            continue
        if domain_set and domain not in domain_set:
            continue
        rows.append(visit)
    return rows


def filter_sessions(
    sessions: list[dict[str, Any]],
    *,
    start_ms: int | None,
    end_ms: int | None = None,
    domains: list[str],
) -> list[dict[str, Any]]:
    domain_set = {domain.lower() for domain in domains}
    rows: list[dict[str, Any]] = []
    for session in sessions:
        session_end = to_float(session.get("end"), 0)
        session_start = to_float(session.get("start"), 0)
        if start_ms and max(session_end, session_start) < start_ms:
            continue
        if end_ms and session_start > end_ms:
            continue
        if domain_set:
            session_domains = {
                str(row.get("domain") or "").lower()
                for row in session.get("visits", []) or []
                if is_display_domain(row.get("domain"))
            }
            session_domains.update(
                str(domain).lower()
                for domain in (session.get("timePerDomain") or {}).keys()
                if is_display_domain(domain)
            )
            if not session_domains.intersection(domain_set):
                continue
        rows.append(session)
    return rows


def aggregate_time_for_domains(sessions: list[dict[str, Any]], domains: list[str]) -> int:
    domain_set = {domain.lower() for domain in domains}
    total = 0
    for session in sessions:
        time_per_domain = session.get("timePerDomain") or {}
        for domain, ms in time_per_domain.items():
            if not is_display_domain(domain):
                continue
            if str(domain).lower() in domain_set:
                try:
                    total += int(float(ms or 0))
                except (TypeError, ValueError):
                    continue
    return total


def count_active_days_for_domains(sessions: list[dict[str, Any]], domains: list[str]) -> int:
    domain_set = {domain.lower() for domain in domains}
    active_days: set[datetime] = set()
    for session in sessions:
        session_start = to_local_datetime(session.get("start"))
        if not session_start:
            continue
        matched = False
        for domain, ms in (session.get("timePerDomain") or {}).items():
            if not is_display_domain(domain):
                continue
            if domain_set and str(domain).lower() not in domain_set:
                continue
            if to_float(ms, 0) > 0:
                matched = True
                break
        if matched:
            active_days.add(start_of_day(session_start))
    return len(active_days)


def sorted_domain_times_for_sessions(sessions: list[dict[str, Any]], domains: list[str] | None = None) -> list[tuple[str, int]]:
    domain_filter = {domain.lower() for domain in (domains or [])}
    totals: defaultdict[str, int] = defaultdict(int)
    for session in sessions:
        for domain, ms in (session.get("timePerDomain") or {}).items():
            normalized = str(domain or "").strip()
            if not is_display_domain(normalized):
                continue
            if domain_filter and normalized.lower() not in domain_filter:
                continue
            try:
                totals[normalized] += int(float(ms or 0))
            except (TypeError, ValueError):
                continue
    return sorted(totals.items(), key=lambda item: item[1], reverse=True)


def iter_session_domain_paths(sessions: list[dict[str, Any]]) -> list[list[str]]:
    paths: list[list[str]] = []
    for session in sessions:
        ordered_visits = sorted(
            [visit for visit in (session.get("visits") or []) if isinstance(visit, dict)],
            key=lambda row: to_float(row.get("time"), 0),
        )
        path: list[str] = []
        for visit in ordered_visits:
            domain = str(visit.get("domain") or "").strip().lower()
            if not is_display_domain(domain):
                continue
            if not path or path[-1] != domain:
                path.append(domain)
        if path:
            paths.append(path)
    return paths


def compute_transition_counts(sessions: list[dict[str, Any]]) -> tuple[Counter[tuple[str, str]], Counter[str], Counter[str]]:
    pair_counts: Counter[tuple[str, str]] = Counter()
    after_counts: Counter[str] = Counter()
    before_counts: Counter[str] = Counter()
    for path in iter_session_domain_paths(sessions):
        for current, nxt in zip(path, path[1:]):
            pair_counts[(current, nxt)] += 1
    return pair_counts, after_counts, before_counts


def compute_anchor_transitions(sessions: list[dict[str, Any]], anchor: str) -> tuple[Counter[str], Counter[str]]:
    target = str(anchor or "").strip().lower()
    after_counts: Counter[str] = Counter()
    before_counts: Counter[str] = Counter()
    if not target:
        return after_counts, before_counts
    for path in iter_session_domain_paths(sessions):
        for index, domain in enumerate(path):
            if domain != target:
                continue
            if index + 1 < len(path):
                after_counts[path[index + 1]] += 1
            if index - 1 >= 0:
                before_counts[path[index - 1]] += 1
    return after_counts, before_counts


def build_retrieved_context(question: str, context: dict[str, Any]) -> dict[str, Any]:
    domains = detect_question_domains(question, context)
    start_ms, end_ms, range_label = extract_time_window(question)
    full_visits = context.get("fullVisitHistory") or []
    full_sessions = context.get("fullSessionHistory") or []
    relevant_visits = filter_visits(full_visits, start_ms=start_ms, end_ms=end_ms, domains=domains)
    relevant_sessions = filter_sessions(full_sessions, start_ms=start_ms, end_ms=end_ms, domains=domains)

    domain_counts = Counter(
        str(visit.get("domain") or "")
        for visit in relevant_visits
        if visit.get("domain")
    )
    recent_visits = sorted(
        relevant_visits,
        key=lambda row: to_float(row.get("time"), 0),
        reverse=True
    )[:15]

    session_samples = sorted(
        relevant_sessions,
        key=lambda row: max(to_float(row.get("end"), 0), to_float(row.get("start"), 0)),
        reverse=True
    )[:8]

    time_by_domain = defaultdict(int)
    for session in relevant_sessions:
        for domain, ms in (session.get("timePerDomain") or {}).items():
            if domains and str(domain).lower() not in {item.lower() for item in domains}:
                continue
            try:
                time_by_domain[str(domain)] += int(float(ms or 0))
            except (TypeError, ValueError):
                continue

    return {
        "questionScope": {
            "rangeLabel": range_label,
            "startMs": start_ms,
            "endMs": end_ms,
            "matchedDomains": domains,
        },
        "highLevelSummary": {
            "currentSession": context.get("currentSession"),
            "todaySummary": context.get("todaySummary"),
            "recentTodaySessions": context.get("recentTodaySessions"),
            "selectedAnchorSite": context.get("selectedAnchorSite"),
            "analytics": context.get("analytics"),
        },
        "retrievedHistory": {
            "visitCount": len(relevant_visits),
            "sessionCount": len(relevant_sessions),
            "topDomains": [
                {"domain": domain, "visits": count}
                for domain, count in domain_counts.most_common(8)
            ],
            "timeByDomain": [
                {"domain": domain, "timeMs": ms, "timePretty": ms_to_pretty(ms)}
                for domain, ms in sorted(time_by_domain.items(), key=lambda item: item[1], reverse=True)[:8]
            ],
            "recentVisits": recent_visits,
            "sampleSessions": session_samples,
        },
    }


def answer_range_visit_count(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not (("how many" in q or "count" in q) and any(term in q for term in ["visit", "visited", "times"])):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        return None
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    visits = filter_visits(context.get("fullVisitHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=domains)
    count = len(visits)
    primary = domains[0]
    if count == 0:
        return f"I don’t see any visits to {primary} {range_label.lower()}."
    ordered = sorted(
        [dt for dt in (to_local_datetime(visit.get("time")) for visit in visits) if dt],
        key=lambda dt: dt.timestamp()
    )
    bullets: list[str] = []
    if ordered:
        bullets.append(f"First visit in that range: {ordered[0].strftime('%b %-d at %-I:%M %p')}")
        bullets.append(f"Most recent visit: {ordered[-1].strftime('%b %-d at %-I:%M %p')}")
    return format_answer(
        f"You visited {primary} {count} times {range_label.lower()}.",
        bullets,
    )


def answer_range_time(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(phrase in q for phrase in ["how much time", "how long", "time on", "spent on"]):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        return None
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=domains)
    total_ms = aggregate_time_for_domains(sessions, domains)
    primary = domains[0]
    if total_ms <= 0:
        return f"I don’t see tracked time for {primary} {range_label.lower()}."
    matching = sorted(
        (
            session for session in sessions
            if str(primary).lower() in {str(domain).lower() for domain in (session.get("timePerDomain") or {}).keys()}
        ),
        key=lambda row: to_float(row.get("durationMs"), 0),
        reverse=True,
    )
    bullets: list[str] = []
    if matching:
        longest = matching[0]
        longest_ms = to_float((longest.get("timePerDomain") or {}).get(primary), 0)
        bullets.append(
            f"Longest matching session: {ms_to_pretty(longest_ms)} in {longest.get('name') or 'Unnamed session'}"
        )
        bullets.append(f"Matching sessions: {len(matching)}")
    return format_answer(
        f"You spent about {ms_to_pretty(total_ms)} on {primary} {range_label.lower()}.",
        bullets,
    )


def answer_average_time(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if "average" not in q and "avg" not in q:
        return None
    if not any(phrase in q for phrase in ["per day", "a day", "each day", "daily"]):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        return None
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=domains)
    total_ms = aggregate_time_for_domains(sessions, domains)
    primary = domains[0]
    if total_ms <= 0:
        return f"I don’t see tracked time for {primary} {range_label.lower()}."
    active_days = count_active_days_for_domains(sessions, domains)
    if active_days <= 0:
        return f"I don’t have enough matched days to calculate a daily average for {primary}."
    average_ms = round(total_ms / active_days)
    bullets = [f"Across {active_days} active {('day' if active_days == 1 else 'days')}"]
    return format_answer(
        f"You average about {ms_to_pretty(average_ms)} per day on {primary} {range_label.lower()}.",
        bullets,
    )


def answer_total_time(question: str, context: dict[str, Any]) -> str | None:
    if not is_generic_total_time_question(question):
        return None
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=[])
    if not sessions:
        return f"I don’t see any tracked browsing {range_label.lower()}."
    total_ms = sum(int(to_float(session.get("durationMs"), 0)) for session in sessions)
    ranked = sorted_domain_times_for_sessions(sessions)[:3]
    bullets = []
    if ranked:
        bullets.append(f"Top site: {ranked[0][0]} ({ms_to_pretty(ranked[0][1])})")
    bullets.append(f"Sessions: {len(sessions)}")
    return format_answer(
        f"You’ve spent {ms_to_pretty(total_ms)} {range_label.lower()}.",
        bullets,
        "Want that broken down by site or by session?",
    )


def answer_top_sites(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(
        phrase in q
        for phrase in [
            "top site",
            "top sites",
            "most used",
            "most time on",
            "most visited",
            "most common site",
            "site visited",
        ]
    ):
        return None
    limit_match = re.search(r"\btop\s+(\d+)\s+sites?\b", q)
    limit = max(1, min(int(limit_match.group(1)), 10)) if limit_match else 3
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    wants_visits = any(
        phrase in q
        for phrase in [
            "most visited",
            "visited the most",
            "most common site",
            "site visited",
            "by visits",
        ]
    )

    if wants_visits:
        visits = filter_visits(context.get("fullVisitHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=[])
        visit_counts = Counter(
            str(visit.get("domain") or "").strip()
            for visit in visits
            if is_display_domain(visit.get("domain"))
        )
        if not visit_counts:
            return "I don’t have enough tracked browsing to identify the most visited site yet."
        top_sites = visit_counts.most_common(limit)
        bullets = [f"{domain}: {count} visits" for domain, count in top_sites]
        if limit == 1:
            return format_answer(
                f"Your most visited site {range_label.lower()} is {top_sites[0][0]} with {top_sites[0][1]} visits.",
                bullets,
                "Want the same ranking by time spent instead of visits?",
            )
        return format_answer(
            f"Here are your most visited sites {range_label.lower()}.",
            bullets,
            "Want the same ranking by time spent instead of visits?",
        )

    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=[])
    domain_times = sorted_domain_times_for_sessions(sessions)
    if not domain_times:
        return "I don’t have enough tracked browsing to identify top sites yet."
    top_sites = domain_times[:limit]
    bullets = [f"{domain}: {ms_to_pretty(ms)}" for domain, ms in top_sites]
    if limit == 1:
        return format_answer(
            f"Your top site {range_label.lower()} is {top_sites[0][0]} at {ms_to_pretty(top_sites[0][1])}.",
            bullets,
            "Want the same ranking by visits instead of time?",
        )
    return format_answer(
        f"Here are your top {len(top_sites)} sites {range_label.lower()}.",
        bullets,
        "Want the same ranking by visits instead of time?",
    )


def answer_compare_domains(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if "compare" not in q and "vs" not in q and "versus" not in q:
        return None
    domains = detect_question_domains(question, context)
    if len(domains) < 2:
        return None
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    compared = domains[:2]
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=compared)
    totals = [(domain, aggregate_time_for_domains(sessions, [domain])) for domain in compared]
    totals = [(domain, ms) for domain, ms in totals if ms > 0]
    if not totals:
        return f"I don’t see tracked time for those sites {range_label.lower()}."
    totals.sort(key=lambda item: item[1], reverse=True)
    bullets = [f"{domain}: {ms_to_pretty(ms)}" for domain, ms in totals]
    if len(totals) == 1:
        return format_answer(f"I only see tracked time for {totals[0][0]} {range_label.lower()}.", bullets)
    leader, runner_up = totals[0], totals[1]
    delta = leader[1] - runner_up[1]
    return format_answer(
        f"{leader[0]} is higher than {runner_up[0]} {range_label.lower()} by {ms_to_pretty(delta)}.",
        bullets,
    )


def answer_switching_pattern_exact(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(phrase in q for phrase in ["switch", "bounce", "between the most", "workflow"]):
        return None
    sessions = context.get("fullSessionHistory") or []
    pair_counts, _, _ = compute_transition_counts(sessions)
    if not pair_counts:
        return "I don’t have enough multi-site history yet to identify a strong switching pattern."
    top_pair, top_count = pair_counts.most_common(1)[0]
    bullets = [
        f"{src} -> {dst}: {count} transitions"
        for (src, dst), count in pair_counts.most_common(3)
    ]
    return format_answer(
        f"Your strongest switch is {top_pair[0]} to {top_pair[1]}, with {top_count} transitions.",
        bullets,
        "Want me to break that down by session or time of day?",
    )


def answer_anchor_flow(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(phrase in q for phrase in ["after", "next", "lead into", "leading to", "before"]):
        return None
    domains = detect_question_domains(question, context)
    if not domains:
        anchor = str(context.get("selectedAnchorSite") or "").strip()
        domains = [anchor] if anchor else []
    if not domains:
        return None

    anchor = domains[0]
    after_counts, before_counts = compute_anchor_transitions(context.get("fullSessionHistory") or [], anchor)

    if any(phrase in q for phrase in ["after", "next"]):
        if not after_counts:
            return f"I don’t see a consistent next stop after {anchor} yet."
        target, count = after_counts.most_common(1)[0]
        bullets = [f"{domain}: {hits} next-stop transitions" for domain, hits in after_counts.most_common(3)]
        return format_answer(
            f"After {anchor}, you most often go to {target}.",
            bullets,
            "Want the matching incoming pattern too?",
        )

    if not before_counts:
        return f"I don’t see a consistent incoming source leading into {anchor} yet."
    source, count = before_counts.most_common(1)[0]
    bullets = [f"{domain}: {hits} incoming transitions" for domain, hits in before_counts.most_common(3)]
    return format_answer(
        f"The strongest incoming source for {anchor} is {source}.",
        bullets,
        "Want to see what usually happens after it too?",
    )


def answer_time_of_day(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if "start" in q and "session" in q:
        return None
    if not any(phrase in q for phrase in ["time of day", "most active hour", "peak hour", "active hour"]):
        return None
    hourly = (context.get("todaySummary") or {}).get("hourlyMinutes") or []
    if not hourly:
        return "I don’t have enough time-of-day activity yet."
    indexed = [(index, to_float(value, 0)) for index, value in enumerate(hourly)]
    indexed.sort(key=lambda item: item[1], reverse=True)
    top_hour, top_minutes = indexed[0]
    if top_minutes <= 0:
        return "I don’t have enough time-of-day activity yet."
    bullets = [
        f"{hour % 12 or 12}{'AM' if hour < 12 else 'PM'}: {round(minutes)} minutes"
        for hour, minutes in indexed[:3]
        if minutes > 0
    ]
    return format_answer(
        f"Your most active hour today is {top_hour % 12 or 12}{'AM' if top_hour < 12 else 'PM'}.",
        bullets,
    )


def answer_session_start_time(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not (
        ("start" in q and "session" in q)
        or "when do i usually start" in q
        or "what time do i usually start" in q
        or "what time of day do i usually start" in q
        or "when do i start browsing" in q
    ):
        return None

    sessions = get_meaningful_history_sessions(context)
    if len(sessions) < 2:
        return "I don’t have enough session history yet to identify when you usually start."

    counts: Counter[int] = Counter()
    for session in sessions:
        started = session_started_at(session)
        if started is None:
            continue
        counts[started.hour] += 1

    if not counts:
        return "I don’t have enough session history yet to identify when you usually start."

    best_start = 0
    best_count = -1
    for hour in range(24):
        total = counts[hour] + counts[(hour + 1) % 24]
        if total > best_count:
            best_start = hour
            best_count = total

    label = hour_window_label(best_start, best_start + 2)
    ranked_windows: list[tuple[str, int]] = []
    for hour in range(24):
        total = counts[hour] + counts[(hour + 1) % 24]
        if total > 0:
            ranked_windows.append((hour_window_label(hour, hour + 2), total))
    ranked_windows.sort(key=lambda item: item[1], reverse=True)

    bullets = [f"{window}: {count} session starts" for window, count in ranked_windows[:3]]
    return format_answer(
        f"You usually start your sessions around {label}.",
        bullets,
    )


def answer_session_breakdown(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if "break" not in q or "session" not in q:
        return None
    domains = detect_question_domains(question, context)
    start_ms, end_ms, range_label = extract_time_window(question)
    if start_ms is None and question_requests_specific_range(question):
        return unresolved_range_response()
    sessions = filter_sessions(context.get("fullSessionHistory") or [], start_ms=start_ms, end_ms=end_ms, domains=domains)
    if not sessions:
        return "I don’t have matching sessions to break down."
    ranked = sorted(sessions, key=lambda row: to_float(row.get("durationMs"), 0), reverse=True)[:5]
    bullets = []
    for session in ranked:
        start_dt = to_local_datetime(session.get("start"))
        label = start_dt.strftime("%b %-d %-I:%M %p") if start_dt else "Unknown time"
        bullets.append(f"{label}: {ms_to_pretty(session.get('durationMs'))} in {session.get('name') or 'Unnamed session'}")
    return format_answer(
        f"Here are the main matching sessions {range_label.lower()}.",
        bullets,
    )


def answer_productivity(question: str, context: dict[str, Any]) -> str | None:
    q = question.lower()
    if not any(phrase in q for phrase in ["productive", "productivity", "focus", "focused"]):
        return None

    today_summary = context.get("todaySummary") or {}
    analytics = context.get("analytics") or {}
    top_sites = today_summary.get("topSites") or []
    workflow_patterns = analytics.get("workflowPatterns") or []
    active_window = analytics.get("commonActiveWindow") or ""
    overrun_extensions = analytics.get("overrunExtensions") or {}

    bullets: list[str] = []
    if len(top_sites) >= 2:
        bullets.append(
            f"Most of your tracked time is on {top_sites[0]['domain']} and {top_sites[1]['domain']}."
        )
    elif top_sites:
        bullets.append(f"Most of your tracked time is on {top_sites[0]['domain']}.")

    if workflow_patterns:
        top = workflow_patterns[0]
        sites = top.get("sites") or []
        if len(sites) >= 2:
            bullets.append(
                f"Your strongest repeat loop is {sites[0]} and {sites[1]} ({top.get('occurrences', 0)} switches)."
            )

    if active_window:
        formatted_window = format_active_window(active_window)
        if formatted_window:
            bullets.append(formatted_window)

    top_reflection = overrun_extensions.get("topReflection") or {}
    if top_reflection.get("reason"):
        bullets.append(
            f"When sessions run over, your most common reflection is '{top_reflection['reason']}'."
        )

    average_added_minutes = to_float(overrun_extensions.get("averageAddedMinutes"), 0)
    if average_added_minutes > 0:
        bullets.append(
            f"Sessions you extend usually add about {round(average_added_minutes)} extra minutes."
        )

    if not bullets:
        return "I need a little more browsing history before I can give useful productivity insights."

    return format_sectioned_answer(
        "Here are the clearest productivity patterns from your sessions.",
        bullets[:3],
        "Ask for a 2-step plan or a session-by-session breakdown if you want the next step.",
    )


def get_meaningful_history_sessions(context: dict[str, Any]) -> list[dict[str, Any]]:
    sessions = []
    for session in context.get("fullSessionHistory") or []:
        if not isinstance(session, dict):
            continue
        if to_float(session.get("durationMs"), 0) <= 0:
            continue
        sessions.append(session)
    return sessions


def session_domains(session: dict[str, Any]) -> set[str]:
    domains: set[str] = set()
    for domain in (session.get("timePerDomain") or {}).keys():
        if is_display_domain(domain):
            domains.add(str(domain).strip().lower())
    for visit in session.get("visits", []) or []:
        if not isinstance(visit, dict):
            continue
        domain = str(visit.get("domain") or "").strip().lower()
        if is_display_domain(domain):
            domains.add(domain)
    return domains


def session_started_at(session: dict[str, Any]) -> datetime | None:
    return to_local_datetime(session.get("start"))


def session_intended_ms(session: dict[str, Any]) -> int:
    minutes = to_float(session.get("intendedMinutes"), 0)
    if minutes <= 0:
        return 0
    return int(minutes * 60 * 1000)


def session_initial_intended_minutes(session: dict[str, Any]) -> float:
    minutes = to_float(session.get("initialIntendedMinutes"), 0)
    if minutes > 0:
        return minutes
    return to_float(session.get("intendedMinutes"), 0)


def session_added_minutes(session: dict[str, Any]) -> float:
    return max(0.0, to_float(session.get("totalExtendedMinutes"), 0))


def session_was_extended(session: dict[str, Any]) -> bool:
    return session_added_minutes(session) > 0


def session_latest_reflection(session: dict[str, Any]) -> dict[str, Any] | None:
    reflection = session.get("latestReflection")
    if isinstance(reflection, dict) and str(reflection.get("reflection") or "").strip():
        return reflection
    return None


def is_meaningful_overrun_reflection(reflection: dict[str, Any] | None) -> bool:
    if not isinstance(reflection, dict):
        return False

    action = str(reflection.get("action") or "").strip().lower()
    if action not in {"extend", "no-goal", "end"}:
        return False

    text = str(reflection.get("reflection") or "").strip()
    if not text:
        return False

    return text.lower() not in NON_USER_REFLECTION_TEXTS


def is_overrun_session(session: dict[str, Any]) -> bool:
    intended_ms = session_intended_ms(session)
    if intended_ms <= 0:
        return False
    return to_float(session.get("durationMs"), 0) > intended_ms


def percent_label(value: float) -> str:
    return f"{round(max(0, value) * 100)}%"


def hour_window_label(start_hour: int, end_hour: int) -> str:
    def fmt(hour: int) -> str:
        hour = hour % 24
        suffix = "am" if hour < 12 else "pm"
        display = hour % 12 or 12
        return f"{display}{suffix}"

    if end_hour - start_hour == 1:
        return fmt(start_hour)
    return f"{fmt(start_hour)}–{fmt(end_hour - 1)}"


def build_overview_overrun_window_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = [session for session in get_meaningful_history_sessions(context) if session_intended_ms(session) > 0]
    if len(sessions) < 4:
        return None

    overall_rate = sum(1 for session in sessions if is_overrun_session(session)) / len(sessions)
    windows = [
        ("after 9pm", lambda hour: hour >= 21),
        ("later in the evening", lambda hour: 18 <= hour < 24),
        ("midday", lambda hour: 11 <= hour < 15),
        ("afternoon", lambda hour: 12 <= hour < 18),
        ("morning", lambda hour: 6 <= hour < 12),
    ]

    best: tuple[str, float, int] | None = None
    for label, matcher in windows:
        matching = [
            session
            for session in sessions
            if (started := session_started_at(session)) is not None and matcher(started.hour)
        ]
        if len(matching) < 2:
            continue
        rate = sum(1 for session in matching if is_overrun_session(session)) / len(matching)
        if rate <= overall_rate + 0.08:
            continue
        if not best or rate > best[1]:
            best = (label, rate, len(matching))

    if not best:
        return None

    label, rate, count = best
    title = f"Sessions {label} run over more often"
    if label == "after 9pm":
        summary = f"Your sessions after 9pm exceed your intended time {percent_label(rate)} of the time."
    else:
        summary = f"{label.capitalize()} sessions are most likely to exceed your intended time."
    return {
        "eyebrow": "Overrun pattern",
        "tone": "bad",
        "title": title,
        "summary": summary,
        "metricLabel": "Run over rate",
        "metricValue": percent_label(rate),
        "actionLabel": "Explore",
        "prompt": f"Show me which sessions {label} ran over the most.",
    }


def build_overview_short_session_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = [session for session in get_meaningful_history_sessions(context) if session_initial_intended_minutes(session) > 0]
    short_sessions = [session for session in sessions if session_initial_intended_minutes(session) < 10]
    if len(short_sessions) < 2 or len(sessions) < 4:
        return None

    overall_rate = sum(1 for session in sessions if (is_overrun_session(session) or session_was_extended(session))) / len(sessions)
    short_rate = sum(1 for session in short_sessions if (is_overrun_session(session) or session_was_extended(session))) / len(short_sessions)
    if short_rate <= overall_rate + 0.06:
        return None

    return {
        "eyebrow": "Planning pattern",
        "tone": "bad",
        "title": "Short intended sessions are most likely to run over",
        "summary": "Short intended sessions under 10 minutes are the ones you most often extend or let run past the original plan.",
        "prompt": "Show me the short intended sessions that I extended or that ran over.",
    }


def build_overview_start_window_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = get_meaningful_history_sessions(context)
    if len(sessions) < 3:
        return None

    counts: Counter[int] = Counter()
    for session in sessions:
        started = session_started_at(session)
        if started is None:
            continue
        counts[started.hour] += 1

    if not counts:
        return None

    best_start = 0
    best_count = -1
    for hour in range(24):
        total = counts[hour] + counts[(hour + 1) % 24]
        if total > best_count:
            best_start = hour
            best_count = total

    label = hour_window_label(best_start, best_start + 2)
    return {
        "eyebrow": "Start pattern",
        "tone": "neutral",
        "title": f"Most of your browsing begins around {label}",
        "summary": f"You tend to start browsing in the {label} window more than any other part of the day.",
        "metricLabel": "Starts in window",
        "metricValue": str(best_count),
        "actionLabel": "Explore",
        "prompt": f"Show me the sessions I usually start around {label}.",
    }


def build_overview_late_long_sessions_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = get_meaningful_history_sessions(context)
    if len(sessions) < 4:
        return None

    ranked = sorted(sessions, key=lambda session: to_float(session.get("durationMs"), 0), reverse=True)
    longest = ranked[: max(3, min(6, len(ranked) // 3 or 1))]
    late = [
        session
        for session in longest
        if (started := session_started_at(session)) is not None and started.hour >= 21
    ]
    if len(late) < max(1, math.ceil(len(longest) * 0.4)):
        return None

    median_length = ms_to_pretty(sum(int(to_float(session.get("durationMs"), 0)) for session in longest) / len(longest))
    return {
        "eyebrow": "Late-night pattern",
        "tone": "bad",
        "title": "Your longest sessions tend to start late at night",
        "summary": "The sessions that run longest for you often start later in the evening.",
        "metricLabel": "Typical long-session length",
        "metricValue": median_length,
        "actionLabel": "Explore",
        "prompt": "Show me the longest sessions that started late at night.",
    }


def build_overview_switching_overrun_insight(context: dict[str, Any]) -> dict[str, str] | None:
    analytics = context.get("analytics") or {}
    patterns = analytics.get("workflowPatterns") or []
    sessions = [session for session in get_meaningful_history_sessions(context) if session_intended_ms(session) > 0]
    if not patterns or len(sessions) < 4:
        return None

    top = next((pattern for pattern in patterns if (pattern.get("sites") or []) and len(pattern.get("sites") or []) >= 2), None)
    if not top:
        return None

    site_a, site_b = [str(site).strip().lower() for site in (top.get("sites") or [])[:2]]
    pair_sessions = [
        session
        for session in sessions
        if {site_a, site_b}.issubset(session_domains(session))
    ]
    if len(pair_sessions) < 2:
        return None

    overall_rate = sum(1 for session in sessions if (is_overrun_session(session) or session_was_extended(session))) / len(sessions)
    pair_rate = sum(1 for session in pair_sessions if (is_overrun_session(session) or session_was_extended(session))) / len(pair_sessions)
    if pair_rate <= overall_rate + 0.06:
        return None

    display_a = canonical_phrase_for_domain(site_a) or site_a
    display_b = canonical_phrase_for_domain(site_b) or site_b
    display_a = display_a.title() if " " in display_a else display_a
    display_b = display_b.title() if " " in display_b else display_b
    return {
        "eyebrow": "Switching pattern",
        "tone": "bad",
        "title": f"{display_a} and {display_b} often stretch sessions",
        "summary": f"Sessions involving {display_a} and {display_b} often include repeated switching and are more likely to extend beyond your intended duration.",
        "prompt": f"Show me the sessions where {site_a} and {site_b} kept switching and ran over.",
    }


def build_overview_on_track_window_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = [session for session in get_meaningful_history_sessions(context) if session_intended_ms(session) > 0]
    if len(sessions) < 4:
        return None

    overall_within_goal_rate = sum(1 for session in sessions if not is_overrun_session(session) and not session_was_extended(session)) / len(sessions)
    windows = [
        ("morning", lambda hour: 6 <= hour < 12),
        ("afternoon", lambda hour: 12 <= hour < 18),
        ("early evening", lambda hour: 18 <= hour < 21),
        ("before 9pm", lambda hour: hour < 21),
    ]

    best: tuple[str, float, int] | None = None
    for label, matcher in windows:
        matching = [
            session
            for session in sessions
            if (started := session_started_at(session)) is not None and matcher(started.hour)
        ]
        if len(matching) < 2:
            continue
        within_goal_rate = sum(1 for session in matching if not is_overrun_session(session) and not session_was_extended(session)) / len(matching)
        if within_goal_rate < max(0.6, overall_within_goal_rate + 0.08):
            continue
        if not best or within_goal_rate > best[1]:
            best = (label, within_goal_rate, len(matching))

    if not best:
        return None

    label, rate, _count = best
    if label == "before 9pm":
        title = "Sessions before 9pm usually stay on track"
        summary = f"Your sessions that begin before 9pm stay within your intended time {percent_label(rate)} of the time."
    else:
        title = f"{label.capitalize()} sessions usually stay on track"
        summary = f"Your {label} sessions stay within your intended time {percent_label(rate)} of the time."

    return {
        "eyebrow": "On-track pattern",
        "tone": "good",
        "title": title,
        "summary": summary,
        "prompt": f"Show me the {label} sessions that stayed within my intended time.",
    }


def build_overview_focused_sessions_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = [session for session in get_meaningful_history_sessions(context) if session_intended_ms(session) > 0]
    if len(sessions) < 4:
        return None

    focused_sessions = [
        session
        for session in sessions
        if len(session_domains(session)) <= 2
    ]
    if len(focused_sessions) < 2:
        return None

    overall_within_goal_rate = sum(1 for session in sessions if not is_overrun_session(session) and not session_was_extended(session)) / len(sessions)
    focused_within_goal_rate = sum(1 for session in focused_sessions if not is_overrun_session(session) and not session_was_extended(session)) / len(focused_sessions)
    if focused_within_goal_rate < max(0.6, overall_within_goal_rate + 0.08):
        return None

    return {
        "eyebrow": "Focus pattern",
        "tone": "good",
        "title": "Lower-switch sessions usually stay within plan",
        "summary": f"Sessions with one or two sites stay within your intended time {percent_label(focused_within_goal_rate)} of the time.",
        "prompt": "Show me the sessions with fewer site switches that stayed within my intended time.",
    }


def build_overview_extension_pattern_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = [session for session in get_meaningful_history_sessions(context) if session_initial_intended_minutes(session) > 0]
    extended_sessions = [session for session in sessions if session_was_extended(session)]
    if len(extended_sessions) < 2 or len(sessions) < 4:
        return None

    average_added = round(sum(session_added_minutes(session) for session in extended_sessions) / len(extended_sessions))
    short_extended = [session for session in extended_sessions if session_initial_intended_minutes(session) < 15]
    short_rate = len(short_extended) / len(extended_sessions) if extended_sessions else 0

    if short_rate >= 0.55:
        title = "Short goals often need extra time"
        summary = f"When you extend a session, it usually started as a short goal first. You add about {average_added} extra minutes on average."
    else:
        title = "You often add extra time instead of ending"
        summary = f"Once a session goes over, you usually choose to keep going. Your extensions add about {average_added} minutes on average."

    return {
        "eyebrow": "Extension pattern",
        "tone": "neutral",
        "title": title,
        "summary": summary,
        "prompt": "Show me the sessions where I added extra time after going over.",
    }


def build_overview_reflection_pattern_insight(context: dict[str, Any]) -> dict[str, str] | None:
    sessions = get_meaningful_history_sessions(context)
    reflections: list[str] = []
    for session in sessions:
        reflection = session_latest_reflection(session)
        if not is_meaningful_overrun_reflection(reflection):
            continue
        text = str(reflection.get("reflection") or "").strip()
        if text:
            reflections.append(text)
    if len(reflections) < 2:
        return None

    top_reason, top_count = Counter(reflections).most_common(1)[0]
    if top_count < 2:
        return None

    reason_lower = top_reason.lower()
    tone = "neutral"
    if any(term in reason_lower for term in ["distract", "lost track", "procrast"]):
        tone = "bad"

    return {
        "eyebrow": "Reflection pattern",
        "tone": tone,
        "title": f"You most often say '{top_reason}' when you go over",
        "summary": "Your overrun reflections are starting to show a repeated pattern in why sessions continue past the original plan.",
        "prompt": "Show me the sessions where I gave that overrun reason.",
    }


def build_overview_insights(context: dict[str, Any]) -> list[dict[str, str]]:
    candidates = [
        build_overview_overrun_window_insight(context),
        build_overview_short_session_insight(context),
        build_overview_switching_overrun_insight(context),
        build_overview_extension_pattern_insight(context),
        build_overview_reflection_pattern_insight(context),
        build_overview_on_track_window_insight(context),
        build_overview_focused_sessions_insight(context),
        build_overview_late_long_sessions_insight(context),
        build_overview_start_window_insight(context),
    ]
    bad_candidates = [candidate for candidate in candidates if candidate and candidate.get("tone") == "bad"]
    good_candidates = [candidate for candidate in candidates if candidate and candidate.get("tone") == "good"]
    neutral_candidates = [candidate for candidate in candidates if candidate and candidate.get("tone") == "neutral"]

    ordered_candidates = bad_candidates + good_candidates + neutral_candidates
    insights: list[dict[str, str]] = []
    seen_titles: set[str] = set()
    for candidate in ordered_candidates:
        if not candidate:
            continue
        title = candidate.get("title") or ""
        if title in seen_titles:
            continue
        seen_titles.add(title)
        insights.append(candidate)
        if len(insights) == 3:
            break
    return insights


def classify_question(question: str) -> str:
    q = question.lower()
    if any(phrase in q for phrase in ["time today", "spent today", "today total"]):
        return "time_today"
    if any(phrase in q for phrase in ["top site", "most used site", "used today the most", "most time on"]):
        return "top_site_today"
    if any(phrase in q for phrase in ["how many sessions", "session count", "sessions today"]):
        return "sessions_today"
    if any(phrase in q for phrase in ["switch", "bounce", "between the most", "workflow"]):
        return "switching_pattern"
    if any(phrase in q for phrase in ["productive", "productivity", "focus", "focused"]):
        return "productivity"
    return "general"


def direct_answer(question: str, context: dict[str, Any]) -> str | None:
    kind = classify_question(question)
    today_summary = context.get("todaySummary") or {}
    recent_sessions = context.get("recentTodaySessions") or []
    analytics = context.get("analytics") or {}

    direct_history_answer = (
        answer_compare_domains(question, context)
        or
        answer_total_time(question, context)
        or
        answer_average_time(question, context)
        or
        answer_range_visit_count(question, context)
        or answer_range_time(question, context)
        or answer_top_sites(question, context)
        or answer_anchor_flow(question, context)
        or answer_switching_pattern_exact(question, context)
        or answer_session_start_time(question, context)
        or answer_time_of_day(question, context)
        or answer_session_breakdown(question, context)
        or answer_productivity(question, context)
    )
    if direct_history_answer:
        return direct_history_answer

    if kind == "time_today":
        total_ms = today_summary.get("totalTimeMs") or 0
        return f"You've spent {ms_to_pretty(total_ms)} today."

    if kind == "top_site_today":
        top_sites = today_summary.get("topSites") or []
        if not top_sites:
            return "I don't have enough tracked browsing yet today to identify a top site."
        top = top_sites[0]
        return f"Your top site today is {top['domain']} with about {top.get('minutes', 0)} minutes."

    if kind == "sessions_today":
        session_count = today_summary.get("sessionCount") or 0
        if not session_count:
            return "I don't see any tracked sessions for today yet."
        longest = max(recent_sessions, key=lambda row: row.get("durationMs", 0), default=None)
        if longest:
            return f"You've had {session_count} sessions today."
        return f"You've had {session_count} sessions today."

    if kind == "switching_pattern":
        patterns = analytics.get("workflowPatterns") or []
        if not patterns:
            return "I don't have enough multi-site session history yet to identify a strong switching pattern."
        top = patterns[0]
        sites = top.get("sites") or []
        if not sites:
            return "I can see a switching pattern, but I don't have the site names cleanly enough to summarize it."
        if len(sites) == 2 and top.get("type") == "loop":
            return format_answer(
                f"Your strongest switching loop is between {sites[0]} and {sites[1]}.",
                [f"{top.get('occurrences', 0)} back-and-forth transitions", f"{top.get('sessions', 0)} sessions"],
                "Want to know what usually starts that loop?",
            )
        return format_answer(
            f"One of your strongest browsing paths is {' -> '.join(sites)}.",
            [f"{top.get('occurrences', 0)} occurrences", f"{top.get('sessions', 0)} sessions"],
        )

    return None


def build_llm_prompt(question: str, compact_history: list[dict[str, str]], retrieved_context: dict[str, Any]) -> str:
    transcript_lines = []
    for message in compact_history:
        speaker = "User" if message["role"] == "user" else "Assistant"
        transcript_lines.append(f"{speaker}: {message['content']}")

    return "\n".join(
        [
            "You are the Screen Time Momentum analytics assistant.",
            "Answer like a conversational assistant, not a report generator.",
            "Keep answers visually scannable.",
            "For anything longer than one sentence, use this exact structure:",
            "Summary:",
            "One short sentence.",
            "",
            "Key points:",
            "- short bullet",
            "- short bullet",
            "- short bullet",
            "",
            "Next:",
            "One short optional next step.",
            "Use line breaks generously.",
            "Use only the browsing and session data provided.",
            "Do not invent metrics, habits, or explanations that are not supported by the data.",
            "Convert milliseconds into readable time like '3h 50m' instead of exposing raw ms.",
            "If the context is insufficient, say that clearly.",
            "Prefer short lines over dense paragraphs.",
            "Be concise, practical, and specific.",
            "",
            "Conversation so far:",
            "\n".join(transcript_lines) if transcript_lines else "No prior conversation.",
            "",
            f"User: {question.strip()}",
            "",
            "The JSON below includes the relevant retrieved slice of browsing history for this question plus high-level summaries.",
            f"Context JSON:\n{json.dumps(retrieved_context, indent=2)}",
        ]
    )


def build_context_fingerprint(context: dict[str, Any]) -> str:
    visits = context.get("fullVisitHistory") or []
    sessions = context.get("fullSessionHistory") or []
    latest_visit_time = max((to_float(visit.get("time"), 0) for visit in visits if isinstance(visit, dict)), default=0)
    latest_session_time = max(
        (
            max(to_float(session.get("start"), 0), to_float(session.get("end"), 0))
            for session in sessions
            if isinstance(session, dict)
        ),
        default=0,
    )
    current_session = context.get("currentSession") or {}
    return json.dumps(
        {
            "visitCount": len(visits),
            "sessionCount": len(sessions),
            "latestVisitTime": latest_visit_time,
            "latestSessionTime": latest_session_time,
            "todayTotalTimeMs": to_float((context.get("todaySummary") or {}).get("totalTimeMs"), 0),
            "currentSessionStart": to_float(current_session.get("start"), 0),
            "currentSessionEnd": to_float(current_session.get("lastActiveTime"), 0),
            "anchor": str(context.get("selectedAnchorSite") or ""),
        },
        sort_keys=True,
    )


def build_ai_cache_key(question: str, compact_history: list[dict[str, str]], context: dict[str, Any]) -> str:
    return json.dumps(
        {
            "question": str(question or "").strip().lower(),
            "history": compact_history[-4:],
            "context": build_context_fingerprint(context),
        },
        sort_keys=True,
    )


def get_cached_ai_response(cache_key: str) -> str | None:
    cached = AI_RESPONSE_CACHE.get(cache_key)
    if not cached:
        return None
    expires_at, answer = cached
    if expires_at <= time.time():
        AI_RESPONSE_CACHE.pop(cache_key, None)
        return None
    return answer


def set_cached_ai_response(cache_key: str, answer: str) -> None:
    AI_RESPONSE_CACHE[cache_key] = (time.time() + AI_RESPONSE_CACHE_TTL_SECONDS, answer)


class AssistantMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class AssistantRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[AssistantMessage] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)


class OverviewInsightsRequest(BaseModel):
    context: dict[str, Any] = Field(default_factory=dict)


def is_affirmation(question: str) -> bool:
    normalized = " ".join(str(question or "").strip().lower().split())
    return normalized in {
        "yes",
        "yeah",
        "yep",
        "sure",
        "ok",
        "okay",
        "please",
        "go ahead",
        "do that",
        "sounds good",
    }


def resolve_affirmation_follow_up(history: list[dict[str, str]], context: dict[str, Any]) -> str | None:
    last_assistant = next(
        (message["content"] for message in reversed(history) if message.get("role") == "assistant" and message.get("content")),
        "",
    ).lower()
    anchor = str(context.get("selectedAnchorSite") or "").strip()

    if "by session or time of day" in last_assistant:
        return "Sure — would you like the breakdown by session or by time of day?"

    if "matching incoming pattern" in last_assistant and anchor:
        return answer_anchor_flow(f"What usually leads into {anchor}?", context)

    if "what usually happens after" in last_assistant and anchor:
        return answer_anchor_flow(f"What usually happens after {anchor}?", context)

    if "what usually leads into" in last_assistant and anchor:
        return answer_anchor_flow(f"What usually leads into {anchor}?", context)

    if "breakdown by site or by session" in last_assistant:
        return "Sure — would you like the breakdown by site or by session?"

    return None


app = FastAPI(title="Screen Time Momentum AI Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/analytics/insights")
def analytics_insights(payload: OverviewInsightsRequest) -> dict[str, Any]:
    safe_context = json_safe(payload.context)
    return {"insights": build_overview_insights(safe_context)}


@app.post("/analytics/ai")
def analytics_ai(payload: AssistantRequest) -> dict[str, str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
      raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    safe_context = json_safe(payload.context)
    compact_history = [
        {"role": message.role, "content": message.content.strip()}
        for message in payload.history[-4:]
        if message.content.strip()
    ]

    if is_affirmation(payload.question):
        follow_up_answer = resolve_affirmation_follow_up(compact_history, safe_context)
        if follow_up_answer:
            return {"answer": follow_up_answer}

    shortcut = direct_answer(payload.question, safe_context)
    if shortcut:
        return {"answer": shortcut}

    cache_key = build_ai_cache_key(payload.question, compact_history, safe_context)
    cached_answer = get_cached_ai_response(cache_key)
    if cached_answer:
        return {"answer": cached_answer}

    retrieved_context = build_retrieved_context(payload.question, safe_context)
    prompt = build_llm_prompt(payload.question, compact_history, retrieved_context)

    try:
        response = client.responses.create(
            model="gpt-5-mini",
            instructions="Answer as a browsing analytics coach. Prefer a natural back-and-forth tone. Use short paragraphs or bullets when useful.",
            input=prompt,
        )
    except Exception as exc:  # pragma: no cover - surfaces upstream issue cleanly
        raise HTTPException(status_code=502, detail=f"OpenAI request failed: {exc}") from exc

    answer = getattr(response, "output_text", "") or ""
    answer = answer.strip()
    if not answer:
        raise HTTPException(status_code=502, detail="OpenAI returned an empty response")

    set_cached_ai_response(cache_key, answer)
    return {"answer": answer}
