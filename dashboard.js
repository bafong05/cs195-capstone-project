const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DISTRIBUTION_COLORS = [
  "#7d34d8",
  "#9150e4",
  "#a76cf0",
  "#ba87f7",
  "#cd9ff9",
  "#8b5cf6",
  "#6d28d9",
  "#ddd6fe"
];
const expandedSessionStarts = new Set();
const expandedHistoryDays = new Set();
const expandedHistorySessions = new Set();
let dashboardState = {
  activeSession: null,
  sessions: [],
  visits: []
};

function faviconUrl(domain, size = 32) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function msToMinutes(ms) {
  return Math.round(Math.max(0, ms) / 60000);
}

function msToPretty(ms) {
  const mins = msToMinutes(ms);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function sessionDurationLabel(metrics = {}) {
  const durationMs = Math.max(0, metrics.durationMs || 0);
  const visitCount = metrics.totalVisits || 0;
  const roundedMinutes = Math.round(durationMs / 60000);
  const displayMinutes = visitCount > 0 ? Math.max(1, roundedMinutes) : roundedMinutes;

  if (displayMinutes < 60) return `${displayMinutes}m`;
  const h = Math.floor(displayMinutes / 60);
  const m = displayMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function minutesToHourLabel(minutes) {
  if (minutes <= 0) return "0h";
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
}

function fmtElapsed(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

function isValidDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  const normalized = domain.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "unknown";
}

function hrefForVisit(visitOrUrl, fallbackLabel = "") {
  const rawUrl = typeof visitOrUrl === "string" ? visitOrUrl : visitOrUrl?.url;

  if (rawUrl) {
    try {
      return new URL(rawUrl).toString();
    } catch {}
  }

  return isValidDomain(fallbackLabel) ? `https://${fallbackLabel}` : "#";
}

function describeGoal(minutes) {
  return minutes ? `${minutes}m goal` : "No goal";
}

function fmtDayLabel(ts) {
  return new Date(ts).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function computeTodayFromSessions(sessions) {
  const todayStart = startOfDay();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;

  const todaySessions = sessions
    .filter((session) => session?.metrics?.start >= todayStart && session.metrics.start < tomorrowStart)
    .sort((a, b) => a.metrics.start - b.metrics.start);

  const totalTimeMs = todaySessions.reduce((sum, session) => sum + (session.metrics?.durationMs || 0), 0);
  const totalVisits = todaySessions.reduce((sum, session) => sum + (session.metrics?.totalVisits || 0), 0);
  const timePerDomain = {};
  const visitsPerDomain = {};
  const latestUrlPerDomain = {};

  for (const session of todaySessions) {
    for (const [domain, ms] of Object.entries(session.metrics?.timePerDomain || {})) {
      if (!isValidDomain(domain)) continue;
      timePerDomain[domain] = (timePerDomain[domain] || 0) + ms;
    }

    for (const visit of session.visits || []) {
      if (!isValidDomain(visit.domain)) continue;
      visitsPerDomain[visit.domain] = (visitsPerDomain[visit.domain] || 0) + 1;
      if (!latestUrlPerDomain[visit.domain] || visit.time > (latestUrlPerDomain[visit.domain].time || 0)) {
        latestUrlPerDomain[visit.domain] = { url: visit.url, time: visit.time };
      }
    }
  }

  const sortedDomains = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1]);
  const topSite = sortedDomains[0]?.[0] || "-";

  return {
    todaySessions,
    totalTimeMs,
    totalVisits,
    timePerDomain,
    visitsPerDomain,
    latestUrlPerDomain,
    uniqueSiteCount: Object.keys(timePerDomain).length,
    avgSessionMs: todaySessions.length ? Math.round(totalTimeMs / todaySessions.length) : 0,
    topSite
  };
}

function buildLiveSessions(sessions, activeSession, visits) {
  if (!activeSession?.id) return sessions;

  const lastVisit = [...visits]
    .reverse()
    .find((visit) => visit?.sessionId === activeSession.id && isValidDomain(visit.domain));

  if (!lastVisit) return sessions;

  const liveTailMs = Math.max(0, Math.min(Date.now() - lastVisit.time, INACTIVITY_THRESHOLD_MS));
  if (!liveTailMs) return sessions;

  return sessions.map((session) => {
    const sessionId = session?.visits?.[0]?.sessionId;
    if (sessionId !== activeSession.id || !session.metrics) return session;

    const timePerDomain = {
      ...(session.metrics.timePerDomain || {})
    };
    timePerDomain[lastVisit.domain] = (timePerDomain[lastVisit.domain] || 0) + liveTailMs;

    return {
      ...session,
      metrics: {
        ...session.metrics,
        end: lastVisit.time + liveTailMs,
        durationMs: (session.metrics.durationMs || 0) + liveTailMs,
        timePerDomain
      }
    };
  });
}

function computeHourlyMinutes(sessions) {
  const todayStart = startOfDay();
  const hourly = new Array(24).fill(0);

  for (const session of sessions) {
    const visits = session.visits || [];
    const sessionEnd = session?.metrics?.end || 0;
    for (let i = 0; i < visits.length; i += 1) {
      const current = visits[i];
      const next = visits[i + 1];
      const start = current?.time;
      const end = next
        ? Math.min(next.time, start + INACTIVITY_THRESHOLD_MS)
        : Math.max(start, sessionEnd);

      if (!start || end <= start) continue;

      let cursor = Math.max(start, todayStart);
      const limit = Math.min(end, todayStart + 24 * 60 * 60 * 1000);

      while (cursor < limit) {
        const hourIndex = new Date(cursor).getHours();
        const hourEnd = Math.min(startOfDay(cursor) + (hourIndex + 1) * 60 * 60 * 1000, limit);
        hourly[hourIndex] += (hourEnd - cursor) / 60000;
        cursor = hourEnd;
      }
    }
  }

  return hourly.map((value) => Math.round(value));
}

function computeWeekBars(sessions) {
  const days = [];
  const todayStart = startOfDay();
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let offset = 6; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const total = sessions.reduce((sum, session) => {
      const start = session?.metrics?.start || 0;
      return start >= dayStart && start < dayEnd ? sum + (session.metrics?.durationMs || 0) : sum;
    }, 0);

    days.push({
      label: weekdayLabels[new Date(dayStart).getDay()],
      minutes: msToMinutes(total)
    });
  }

  return days;
}

function computeHistoryDays(sessions, numDays = 7) {
  const todayStart = startOfDay();
  const days = [];

  for (let offset = 1; offset <= numDays; offset += 1) {
    const dayStart = todayStart - offset * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const daySessions = sessions.filter((session) => {
      const start = session?.metrics?.start || 0;
      return start >= dayStart && start < dayEnd;
    });

    const totalTimeMs = daySessions.reduce((sum, session) => sum + (session.metrics?.durationMs || 0), 0);
    const totalVisits = daySessions.reduce((sum, session) => sum + (session.metrics?.totalVisits || 0), 0);
    const timePerDomain = {};

    daySessions.forEach((session) => {
      Object.entries(session.metrics?.timePerDomain || {}).forEach(([domain, ms]) => {
        if (!isValidDomain(domain)) return;
        timePerDomain[domain] = (timePerDomain[domain] || 0) + ms;
      });
    });

    const sortedDomains = Object.entries(timePerDomain).sort((a, b) => b[1] - a[1]);
    days.push({
      dayStart,
      label: fmtDayLabel(dayStart),
      sessions: daySessions
        .slice()
        .sort((a, b) => (b?.metrics?.start || 0) - (a?.metrics?.start || 0)),
      sessionCount: daySessions.length,
      totalTimeMs,
      totalVisits,
      uniqueSites: Object.keys(timePerDomain).length,
      topSite: sortedDomains[0]?.[0] || "-",
      topSiteTimeMs: sortedDomains[0]?.[1] || 0
    });
  }

  return days;
}

function buildLinePath(points) {
  if (!points.length) return "";
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}

function attachChartTooltips(container, selector) {
  const tooltip = container.querySelector(".chartTooltip");
  if (!tooltip) return;

  const showTooltip = (event) => {
    const target = event.currentTarget;
    tooltip.textContent = target.dataset.tooltip || "";
    tooltip.hidden = false;

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${Math.max(12, y - 14)}px`;
  };

  const hideTooltip = () => {
    tooltip.hidden = true;
  };

  container.querySelectorAll(selector).forEach((node) => {
    node.addEventListener("mouseenter", showTooltip);
    node.addEventListener("mousemove", showTooltip);
    node.addEventListener("mouseleave", hideTooltip);
  });
}

function renderActivityChart(values) {
  const container = document.getElementById("activityChart");
  const totalMinutes = values.reduce((sum, value) => sum + value, 0);
  document.getElementById("activityTotal").textContent = msToPretty(totalMinutes * 60000);
  const width = 640;
  const height = 220;
  const padding = { top: 18, right: 10, bottom: 36, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(10, Math.ceil(Math.max(...values, 0) / 10) * 10);
  const tickValues = Array.from({ length: maxValue / 10 + 1 }, (_, index) => index * 10);
  const points = values.map((value, index) => {
    const x = padding.left + (index / 23) * innerWidth;
    const y = padding.top + innerHeight - (value / maxValue) * innerHeight;
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  });
  const linePath = buildLinePath(points);
  const areaPath = `${linePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`;

  const gridLines = tickValues
    .map((tick) => {
      const y = padding.top + innerHeight - (tick / maxValue) * innerHeight;
      return `
        <line class="gridLine" x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}"></line>
        <text class="tickLabel" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${tick}m</text>
      `;
    })
    .join("");

  const xLabels = values
    .map((_, index) => {
      if (index % 3 !== 0) return "";
      const x = padding.left + (index / 23) * innerWidth;
      const d = new Date();
      d.setHours(index, 0, 0, 0);
      const label = d.toLocaleTimeString([], { hour: "numeric" }).toLowerCase();
      return `<text class="axisLabel" x="${x}" y="${height - 10}" text-anchor="middle">${label}</text>`;
    })
    .join("");

  const pointMarkers = points
    .map((point, index) => {
      const d = new Date();
      d.setHours(index, 0, 0, 0);
      const label = d.toLocaleTimeString([], { hour: "numeric" }).toLowerCase();
      return `
        <circle
          class="linePoint"
          cx="${point.x}"
          cy="${point.y}"
          r="5"
          data-tooltip="${label}: ${msToPretty(values[index] * 60000)}"
        ></circle>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img">
      <defs>
        <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a76cf0" stop-opacity="0.28"></stop>
          <stop offset="100%" stop-color="#a76cf0" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      ${xLabels}
      <path class="lineArea" d="${areaPath}"></path>
      <path class="linePath" d="${linePath}"></path>
      ${pointMarkers}
    </svg>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".linePoint");
}

function renderWeekChart(days) {
  const container = document.getElementById("weekChart");
  const width = 640;
  const height = 220;
  const padding = { top: 18, right: 12, bottom: 36, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(180, ...days.map((day) => day.minutes), 1);
  const barWidth = innerWidth / days.length - 12;
  const tickValues = [60, 120, 180];

  const gridLines = tickValues
    .map((tick) => {
      const y = padding.top + innerHeight - (tick / maxValue) * innerHeight;
      return `
        <line class="gridLine" x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}"></line>
        <text class="tickLabel" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${minutesToHourLabel(tick)}</text>
      `;
    })
    .join("");

  const bars = days
    .map((day, index) => {
      const x = padding.left + index * (innerWidth / days.length) + 6;
      const barHeight = (day.minutes / maxValue) * innerHeight;
      const y = padding.top + innerHeight - barHeight;
      return `
        <rect
          class="barRect"
          x="${x}"
          y="${y}"
          width="${barWidth}"
          height="${barHeight}"
          rx="8"
          data-tooltip="${day.label}: ${msToPretty(day.minutes * 60000)}"
        ></rect>
        <text class="axisLabel" x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle">${day.label}</text>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${width} ${height}" role="img">
      <defs>
        <linearGradient id="weekBarFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#9b5cf2"></stop>
          <stop offset="100%" stop-color="#7d34d8"></stop>
        </linearGradient>
      </defs>
      ${gridLines}
      ${bars}
    </svg>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".barRect");
}

function polarPoint(cx, cy, radius, angle) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
}

function ringSlicePath(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
  const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
  const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z"
  ].join(" ");
}

function renderDistributionChart(timePerDomain) {
  const container = document.getElementById("distributionChart");
  const rows = Object.entries(timePerDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  const total = rows.reduce((sum, [, ms]) => sum + ms, 0);
  const cx = 110;
  const cy = 110;
  const outer = 70;
  const inner = 38;
  let angle = -Math.PI / 2;

  const slices = rows
    .map(([domain, ms], index) => {
      const sliceAngle = (ms / total) * Math.PI * 2;
      const start = angle;
      const end = angle + sliceAngle;
      angle = end;
      return `
        <path
          class="distributionSlice"
          d="${ringSlicePath(cx, cy, inner, outer, start, end)}"
          fill="${DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]}"
          data-tooltip="${domain}: ${msToPretty(ms)} (${Math.round((ms / total) * 100)}%)"
        ></path>
      `;
    })
    .join("");

  const legend = rows
    .map(
      ([domain, ms], index) => `
        <span class="legendRow">
          <span class="legendSwatch" style="background:${DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]}"></span>
          <span class="legendLabel">${escapeHtml(domain)}</span>
          <span class="legendValue">${Math.round((ms / total) * 100)}%</span>
        </span>
      `
    )
    .join("");

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 220 220" role="img" style="max-width:220px;">
      ${slices}
      <circle cx="${cx}" cy="${cy}" r="${inner - 2}" fill="white" fill-opacity="0.95"></circle>
    </svg>
    <div class="legendList">${legend}</div>
    <div class="chartTooltip" hidden></div>
  `;

  attachChartTooltips(container, ".distributionSlice");
}

function renderCurrentSession(activeSession, visits = []) {
  const progressContainer = document.getElementById("sessionProgressChart");
  const sitesList = document.getElementById("sitesList");
  const sessionSites = document.getElementById("sessionSites");
  const sessionVisits = document.getElementById("sessionVisits");
  const sessionGoal = document.getElementById("sessionGoal");

  if (!activeSession) {
    progressContainer.innerHTML = buildProgressSvg("0:00", "No goal", 0);
    sitesList.textContent = "No session yet.";
    sessionSites.textContent = "0 sites";
    sessionVisits.textContent = "0 visits";
    sessionGoal.textContent = "Goal: -";
    return;
  }

  const now = Date.now();
  const domains = activeSession.uniqueDomains || [];
  const validDomains = domains.filter(isValidDomain);
  const visitUrls = new Map();
  visits
    .filter((visit) => visit?.sessionId === activeSession.id && isValidDomain(visit.domain))
    .forEach((visit) => {
      if (!visitUrls.has(visit.domain)) {
        visitUrls.set(visit.domain, visit.url);
      }
    });
  const siteChips = validDomains.length
    ? domains
        .filter(isValidDomain)
        .slice(0, 6)
        .map(
          (domain) => `
            <a
              class="siteChip"
              href="${hrefForVisit(visitUrls.get(domain), domain)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src="${faviconUrl(domain, 32)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
              ${escapeHtml(domain)}
            </a>
          `
        )
        .join("")
    : "No sites yet.";

  const idleMs = now - (activeSession.lastEventTime || activeSession.startTime);
  const isIdle = idleMs > INACTIVITY_THRESHOLD_MS;
  const effectiveEndTime = isIdle
    ? (activeSession.lastEventTime || activeSession.startTime)
    : now;
  const elapsedMs = Math.max(0, effectiveEndTime - activeSession.startTime);
  const goalMinutes = activeSession.intendedMinutes;
  const ringBasisMinutes = goalMinutes || 30;
  const ratio = elapsedMs / (ringBasisMinutes * 60 * 1000);

  progressContainer.innerHTML = buildProgressSvg(
    fmtElapsed(elapsedMs),
    goalMinutes ? `${goalMinutes}m` : "free",
    ratio
  );
  sitesList.innerHTML = siteChips;
  sessionSites.textContent = `${validDomains.length} ${validDomains.length === 1 ? "site" : "sites"}`;
  sessionVisits.textContent = `${activeSession.visitCount || 0} visits`;
  sessionGoal.textContent = `Goal: ${describeGoal(goalMinutes)}`;
}

function renderCurrentSessionData(activeSession, visits) {
  const container = document.getElementById("currentSessionData");

  if (!activeSession) {
    container.innerHTML = `<div class="muted">No session yet.</div>`;
    return;
  }

  const sessionVisits = (visits || [])
    .filter((visit) => visit?.sessionId === activeSession.id && isValidDomain(visit.domain))
    .sort((a, b) => b.time - a.time);

  if (!sessionVisits.length) {
    container.innerHTML = `<div class="muted">No sites recorded in the current session yet.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="sessionDetailsList">
      ${sessionVisits
        .map(
          (visit) => `
            <div class="sessionVisitRow">
              <div class="sessionVisitMain">
                <img src="${faviconUrl(visit.domain, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
                <a
                  class="sessionVisitDomain"
                  href="${hrefForVisit(visit, visit.domain)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >${escapeHtml(visit.domain)}</a>
              </div>
              <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function buildProgressSvg(valueLabel, goalLabel, ratio) {
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  const isOverGoal = ratio > 1;
  const accent = isOverGoal ? "#dc2626" : "#7d34d8";
  const track = isOverGoal ? "rgba(220, 38, 38, 0.12)" : "rgba(125, 52, 216, 0.12)";

  return `
    <svg class="chartSvg" viewBox="0 0 ${size} ${size}" role="img">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${track}" stroke-width="10"></circle>
      <circle
        cx="${cx}"
        cy="${cy}"
        r="${radius}"
        fill="none"
        stroke="${accent}"
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray="${circumference}"
        stroke-dashoffset="${dashOffset}"
        transform="rotate(-90 ${cx} ${cy})"
      ></circle>
      <text class="progressValue" x="${cx}" y="${cy + 4}">${valueLabel}</text>
      <text class="progressGoal" x="${cx}" y="${cy + 24}">/ ${goalLabel}</text>
    </svg>
  `;
}

function buildSessionVisitsHtml(visits = []) {
  return visits
    .filter((visit) => isValidDomain(visit.domain))
    .slice()
    .sort((a, b) => b.time - a.time)
    .map(
      (visit) => `
        <div class="sessionVisitRow">
          <div class="sessionVisitMain">
            <img src="${faviconUrl(visit.domain, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
            <a
              class="sessionVisitDomain"
              href="${hrefForVisit(visit, visit.domain)}"
              target="_blank"
              rel="noopener noreferrer"
            >${escapeHtml(visit.domain)}</a>
          </div>
          <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
        </div>
      `
    )
    .join("");
}

function buildGoalBadgeHtml(metrics = {}) {
  const goal = metrics.intendedMinutes;
  const overrunMs = metrics.overrunMs || 0;
  const overrunMinutes = msToMinutes(overrunMs);

  if (!goal) return "";

  if (overrunMinutes > 0) {
    return `
      <div class="badgeStack">
        <div class="goalBadge">${goal}m goal</div>
        <div class="overrunBadge">${overrunMinutes}m over</div>
      </div>
    `;
  }

  return `<div class="goalBadge">${goal}m goal</div>`;
}

function renderSessionsList(sessions) {
  const container = document.getElementById("sessionsList");
  const todayStart = startOfDay();
  const todaySessions = [...sessions]
    .filter((session) => session?.metrics)
    .filter((session) => (session.metrics?.start || 0) >= todayStart)
    .sort((a, b) => b.metrics.start - a.metrics.start)
    .slice(0, 6);

  document.getElementById("recentSessionsCount").textContent = `${todaySessions.length} sessions today`;

  if (!todaySessions.length) {
    container.innerHTML = `<div class="muted">No sessions yet today. Browse a bit and come back.</div>`;
    return;
  }

  const sessionKeys = todaySessions.map((session) => String(session.metrics.start));
  const existingRows = Array.from(container.querySelectorAll(".sessionRow"));
  const canPatch =
    existingRows.length === todaySessions.length &&
    existingRows.every((row, index) => row.dataset.sessionStart === sessionKeys[index]);

  if (canPatch) {
    todaySessions.forEach((session, index) => {
      const row = existingRows[index];
      const validUniqueDomains = (session.metrics.uniqueDomains || []).filter(isValidDomain);
      const badgeSlot = row.querySelector(".sessionBadgeSlot");
      const detailsList = row.querySelector(".sessionDetailsList");
      const visitsHtml = buildSessionVisitsHtml(session.visits || []);
      row.querySelector(".sessionTime").textContent =
        `${fmtTime(session.metrics.start)} - ${fmtTime(session.metrics.end)}`;

      const meta = row.querySelectorAll(".sessionMeta span");
      if (meta[0]) meta[0].textContent = sessionDurationLabel(session.metrics);
      if (meta[1]) meta[1].textContent = `${validUniqueDomains.length} sites`;
      if (meta[2]) meta[2].textContent = `${session.metrics.totalVisits || 0} visits`;
      if (badgeSlot) {
        badgeSlot.innerHTML = buildGoalBadgeHtml(session.metrics);
      }
      if (detailsList) {
        detailsList.innerHTML = visitsHtml || '<div class="muted">No visits recorded.</div>';
      }
    });
    return;
  }

  container.innerHTML = todaySessions
    .map((session) => {
      const startStr = fmtTime(session.metrics.start);
      const endStr = fmtTime(session.metrics.end);
      const sessionKey = session.metrics.start;
      const goal = session.metrics.intendedMinutes;
      const isExpanded = expandedSessionStarts.has(sessionKey);
      const validUniqueDomains = (session.metrics.uniqueDomains || []).filter(isValidDomain);
      const visitsHtml = buildSessionVisitsHtml(session.visits || []);

      return `
        <div class="sessionRow" data-session-start="${sessionKey}">
          <button type="button" class="sessionToggle" aria-expanded="${isExpanded}">
            <div class="sessionHeader">
              <div>
                <div class="sessionTime">${startStr} - ${endStr}</div>
              </div>
              <div class="sessionHeaderRight">
                <div class="sessionBadgeSlot">${buildGoalBadgeHtml(session.metrics)}</div>
                <span class="sessionChevron">${isExpanded ? "−" : "+"}</span>
              </div>
            </div>
          </button>
          <div class="sessionMeta">
            <span>${sessionDurationLabel(session.metrics)}</span>
            <span>${validUniqueDomains.length} sites</span>
            <span>${session.metrics.totalVisits || 0} visits</span>
          </div>
          <div class="sessionDetails" ${isExpanded ? "" : "hidden"}>
            <div class="sessionDetailsList">
              ${visitsHtml || '<div class="muted">No visits recorded.</div>'}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".sessionToggle").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest(".sessionRow");
      const sessionKey = Number(row.dataset.sessionStart);
      const details = row.querySelector(".sessionDetails");
      const chevron = row.querySelector(".sessionChevron");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedSessionStarts.add(sessionKey);
      } else {
        expandedSessionStarts.delete(sessionKey);
      }
    });
  });
}

function renderTopSitesToday(timePerDomain, visitsPerDomain, latestUrlPerDomain = {}) {
  const container = document.getElementById("topSitesList");
  const rows = Object.entries(timePerDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No site time yet today.</div>`;
    return;
  }

  const domains = rows.map(([domain]) => domain);
  const existingRows = Array.from(container.querySelectorAll(".siteRow"));
  const canPatch =
    existingRows.length === rows.length &&
    existingRows.every((row, index) => row.dataset.domain === domains[index]);

  if (canPatch) {
    rows.forEach(([domain, ms], index) => {
      const row = existingRows[index];
      const meta = row.querySelector(".siteMeta");
      const time = row.querySelector(".siteTime");
      if (meta) meta.textContent = `${visitsPerDomain[domain] || 0} visits`;
      if (time) time.textContent = msToPretty(ms);
    });
    return;
  }

  container.innerHTML = rows
    .map(([domain, ms], index) => `
      <div class="siteRow" data-domain="${domain}">
        <div class="siteRank">${index + 1}</div>
        <div class="siteMain">
          <img src="${faviconUrl(domain, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
          <div>
            <a class="siteName" href="${hrefForVisit(latestUrlPerDomain[domain]?.url, domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a>
            <div class="siteMeta">${visitsPerDomain[domain] || 0} visits</div>
          </div>
        </div>
        <div class="siteTime">${msToPretty(ms)}</div>
      </div>
    `)
    .join("");
}

function renderHistoryList(sessions) {
  const container = document.getElementById("historyList");
  const rows = computeHistoryDays(sessions).filter((day) => day.totalTimeMs > 0 || day.sessionCount > 0);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No previous-day history yet.</div>`;
    return;
  }

  container.innerHTML = rows
    .map(
      (day) => `
        <div class="historyRow">
          <button type="button" class="historyToggle" aria-expanded="${expandedHistoryDays.has(day.dayStart)}">
            <div class="historyRowMain">
              <div class="historyDay">
                <div class="historyDate">${day.label}</div>
                <div class="historyTopSite">Top site: ${escapeHtml(day.topSite)}</div>
              </div>
              <div class="historyStats">
                <div class="historyStat">
                  <strong>${msToPretty(day.totalTimeMs)}</strong>
                  <span>Tracked time</span>
                </div>
                <div class="historyStat">
                  <strong>${day.sessionCount}</strong>
                  <span>Sessions</span>
                </div>
                <div class="historyStat">
                  <strong>${day.totalVisits}</strong>
                  <span>Visits</span>
                </div>
                <div class="historyStat">
                  <strong>${day.uniqueSites}</strong>
                  <span>Sites</span>
                </div>
                <span class="sessionChevron">${expandedHistoryDays.has(day.dayStart) ? "−" : "+"}</span>
              </div>
            </div>
          </button>
          <div class="historyDetails" ${expandedHistoryDays.has(day.dayStart) ? "" : "hidden"}>
            <div class="historyDetailsList">
              ${day.sessions
                .map((session) => {
                  const historySessionKey = `${day.dayStart}-${session.metrics.start}`;
                  const isHistorySessionExpanded = expandedHistorySessions.has(historySessionKey);
                  const validUniqueDomains = (session.metrics?.uniqueDomains || []).filter(isValidDomain);
                  const visitsHtml = (session.visits || [])
                    .filter((visit) => isValidDomain(visit.domain))
                    .slice()
                    .sort((a, b) => b.time - a.time)
                    .map(
                      (visit) => `
                        <div class="sessionVisitRow">
                          <div class="sessionVisitMain">
                            <img src="${faviconUrl(visit.domain, 32)}" alt="" class="siteFavicon" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden';" />
                            <a
                              class="sessionVisitDomain"
                              href="${hrefForVisit(visit, visit.domain)}"
                              target="_blank"
                              rel="noopener noreferrer"
                            >${escapeHtml(visit.domain)}</a>
                          </div>
                          <div class="sessionVisitTime">${fmtTime(visit.time)}</div>
                        </div>
                      `
                    )
                    .join("");

                  return `
                    <div class="historySessionCard">
                      <button
                        type="button"
                        class="historySessionToggle"
                        data-history-session-key="${historySessionKey}"
                        aria-expanded="${isHistorySessionExpanded}"
                      >
                        <div class="historySessionHeader">
                          <div class="sessionTime">${fmtTime(session.metrics.start)} - ${fmtTime(session.metrics.end)}</div>
                          <div class="historySessionHeaderRight">
                            <div class="sessionBadgeSlot">${buildGoalBadgeHtml(session.metrics)}</div>
                            <span class="sessionChevron">${isHistorySessionExpanded ? "−" : "+"}</span>
                          </div>
                        </div>
                        <div class="sessionMeta">
                          <span>${sessionDurationLabel(session.metrics)}</span>
                          <span>${validUniqueDomains.length} sites</span>
                          <span>${session.metrics.totalVisits || 0} visits</span>
                        </div>
                      </button>
                      <div class="historySessionDetails" ${isHistorySessionExpanded ? "" : "hidden"}>
                        <div class="sessionDetailsList">
                          ${visitsHtml || '<div class="muted">No visits recorded.</div>'}
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        </div>
      `
    )
    .join("");

  container.querySelectorAll(".historyToggle").forEach((button, index) => {
    button.addEventListener("click", () => {
      const day = rows[index];
      const row = button.closest(".historyRow");
      const details = row.querySelector(".historyDetails");
      const chevron = row.querySelector(".sessionChevron");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedHistoryDays.add(day.dayStart);
      } else {
        expandedHistoryDays.delete(day.dayStart);
      }
    });
  });

  container.querySelectorAll(".historySessionToggle").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionKey = button.dataset.historySessionKey;
      const card = button.closest(".historySessionCard");
      const details = card.querySelector(".historySessionDetails");
      const chevron = card.querySelector(".sessionChevron");
      const nextExpanded = details.hidden;

      details.hidden = !nextExpanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      chevron.textContent = nextExpanded ? "−" : "+";

      if (nextExpanded) {
        expandedHistorySessions.add(sessionKey);
      } else {
        expandedHistorySessions.delete(sessionKey);
      }
    });
  });
}

function renderDashboard(data) {
  dashboardState = {
    activeSession: data.activeSession || null,
    sessions: data.sessions || [],
    visits: data.visits || []
  };

  const liveSessions = buildLiveSessions(
    dashboardState.sessions,
    dashboardState.activeSession,
    dashboardState.visits
  );
  const today = computeTodayFromSessions(liveSessions);

  document.getElementById("todayTime").textContent = msToPretty(today.totalTimeMs);

  renderCurrentSession(dashboardState.activeSession, dashboardState.visits);
  renderCurrentSessionData(dashboardState.activeSession, dashboardState.visits);
  renderActivityChart(computeHourlyMinutes(today.todaySessions));
  renderWeekChart(computeWeekBars(liveSessions));
  renderDistributionChart(today.timePerDomain);
  renderSessionsList(liveSessions);
  renderTopSitesToday(today.timePerDomain, today.visitsPerDomain, today.latestUrlPerDomain);
  renderHistoryList(liveSessions);
}

function tickCurrentSession() {
  renderCurrentSession(dashboardState.activeSession, dashboardState.visits);
  renderCurrentSessionData(dashboardState.activeSession, dashboardState.visits);
}

async function refresh() {
  const data = await chrome.storage.local.get(["activeSession", "sessions", "visits"]);
  renderDashboard(data);
}

async function startNewSession(minutes) {
  const now = Date.now();
  const newSession = {
    id: `${now}`,
    startTime: now,
    lastEventTime: now,
    uniqueDomains: [],
    visitCount: 0,
    intendedMinutes: minutes
  };

  const { manualSessionStarts = [], sessionIntents = [] } = await chrome.storage.local.get([
    "manualSessionStarts",
    "sessionIntents"
  ]);

  const updatedStarts = Array.isArray(manualSessionStarts) ? manualSessionStarts.slice() : [];
  updatedStarts.push(now);
  const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
  const filtered = intents.filter((intent) => intent.sessionId !== newSession.id);

  await chrome.storage.local.set({
    activeSession: newSession,
    manualSessionStarts: updatedStarts,
    sessionIntents: minutes == null ? filtered : [...filtered, { sessionId: newSession.id, intendedMinutes: minutes }]
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  await refresh();
}

async function openIntentChooser(mode) {
  if (mode === "manual") {
    document.getElementById("intentModal").hidden = false;
    document.getElementById("intentModalOtherInput").value = "";
    document.getElementById("intentModalOtherInput").focus();
    return;
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`intent.html?mode=${encodeURIComponent(mode)}`),
    active: true
  });
}

function closeIntentModal() {
  document.getElementById("intentModal").hidden = true;
}

async function submitManualIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  await startNewSession(minutes);
  closeIntentModal();
}

const navItems = Array.from(document.querySelectorAll(".navItem"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));

function setActiveTab(tabName) {
  navItems.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("isActive", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tabPanel === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle("isActive", isActive);
  });
}

navItems.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await refresh();
});

document.getElementById("newSessionBtn").addEventListener("click", async () => {
  await openIntentChooser("manual");
});

document.getElementById("closeIntentModalBtn").addEventListener("click", () => {
  closeIntentModal();
});

document.querySelectorAll(".intentModalOption").forEach((button) => {
  button.addEventListener("click", () => {
    submitManualIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
  });
});

document.getElementById("intentModalOtherSubmit").addEventListener("click", () => {
  const value = Number(document.getElementById("intentModalOtherInput").value.trim());
  submitManualIntent(value);
});

document.getElementById("intentModalOtherInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const value = Number(event.currentTarget.value.trim());
    submitManualIntent(value);
  } else if (event.key === "Escape") {
    closeIntentModal();
  }
});

document.getElementById("confirmClearBtn").addEventListener("click", async () => {
  const confirmed = window.confirm("Clear all tracked visits, sessions, and current progress?");
  if (!confirmed) return;

  await chrome.storage.local.set({
    visits: [],
    sessions: [],
    activeSession: null,
    sessionIntents: [],
    manualSessionStarts: []
  });
  await refresh();
});

setActiveTab("overview");
refresh();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("intentModal").hidden) {
    closeIntentModal();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.activeSession) {
    dashboardState.activeSession = changes.activeSession.newValue || null;
  }
  if (changes.sessions) {
    dashboardState.sessions = changes.sessions.newValue || [];
  }
  if (changes.visits) {
    dashboardState.visits = changes.visits.newValue || [];
  }

  if (changes.sessions || changes.activeSession || changes.visits) {
    renderDashboard(dashboardState);
  }
});

setInterval(tickCurrentSession, 1000);
