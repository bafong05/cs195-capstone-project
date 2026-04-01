const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
const LEGITIMATE_TAB_DWELL_MS = 3000;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;

function isValidDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  const normalized = domain.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "unknown";
}

function isDisplayDomain(domain) {
  if (!isValidDomain(domain)) return false;
  const normalized = domain.trim().toLowerCase();
  return !["extensions", "newtab", "new-tab-page"].includes(normalized);
}

function hourLabel(hour) {
  const suffix = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${suffix}`;
}

function hourWindowLabel(startHour, span = 3) {
  const endHour = (startHour + span) % 24;
  return `${hourLabel(startHour)}-${hourLabel(endHour)}`;
}

function computeTopSiteSequences(sessions, limit = 3, sequenceLength = 3) {
  const counts = new Map();

  const getSequenceSignature = (sequence) => {
    if (
      sequence.length === 3 &&
      sequence[0] === sequence[2] &&
      sequence[0] !== sequence[1]
    ) {
      const pair = [sequence[0], sequence[1]].sort((a, b) => a.localeCompare(b));
      return {
        key: `loop:${pair.join("<->")}`,
        type: "loop",
        pair
      };
    }

    return {
      key: sequence.join(" -> "),
      type: "sequence",
      pair: null
    };
  };

  (sessions || []).forEach((session) => {
    const sessionVisits = Array.isArray(session?.visits) ? session.visits : [];
    const legitimateDomains = [];

    sessionVisits.forEach((visit, index) => {
      if (!isDisplayDomain(visit?.domain)) return;

      const nextVisit = sessionVisits[index + 1];
      const rawEnd = nextVisit?.time ?? session?.metrics?.end ?? visit.time;
      const dwellMs = Math.max(0, Math.min(rawEnd - visit.time, inactivityThresholdMs));
      const isLegitimate = Boolean(visit?.hadInteraction) || dwellMs >= LEGITIMATE_TAB_DWELL_MS;

      if (!isLegitimate) return;
      if (legitimateDomains[legitimateDomains.length - 1] === visit.domain) return;
      legitimateDomains.push(visit.domain);
    });

    if (legitimateDomains.length < sequenceLength) return;

    for (let index = 0; index <= legitimateDomains.length - sequenceLength; index += 1) {
      const sequence = legitimateDomains.slice(index, index + sequenceLength);
      const signature = getSequenceSignature(sequence);
      const existing = counts.get(signature.key) || {
        sequence,
        type: signature.type,
        pair: signature.pair,
        label:
          signature.type === "loop"
            ? `${signature.pair[0]} ↔ ${signature.pair[1]} loop`
            : sequence.join(" -> "),
        count: 0,
        sessionStarts: new Set()
      };

      existing.count += 1;
      existing.sessionStarts.add(Number(session?.metrics?.start) || 0);
      counts.set(signature.key, existing);
    }
  });

  return Array.from(counts.values())
    .map((entry) => ({
      sequence: entry.sequence,
      type: entry.type,
      pair: entry.pair,
      label: entry.label,
      count: entry.count,
      sessions: entry.sessionStarts.size
    }))
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.count - a.count ||
      a.label.localeCompare(b.label)
    ))
    .slice(0, limit);
}

function computeExtendedSessionSites(sessions, limit = 3) {
  const counts = new Map();

  (sessions || []).forEach((session) => {
    const intendedMs = Number(session?.metrics?.intendedMs) || 0;
    const overrunMs = Number(session?.metrics?.overrunMs) || 0;
    const durationMs = Number(session?.metrics?.durationMs) || 0;
    if (intendedMs <= 0 || overrunMs <= 0) return;

    const uniqueDomains = new Set(
      (session?.visits || [])
        .map((visit) => visit?.domain)
        .filter(isDisplayDomain)
    );

    uniqueDomains.forEach((domain) => {
      const existing = counts.get(domain) || {
        domain,
        sessions: 0,
        totalTimeMs: 0
      };

      existing.sessions += 1;
      existing.totalTimeMs += durationMs;
      counts.set(domain, existing);
    });
  });

  return Array.from(counts.values())
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.domain.localeCompare(b.domain)
    ))
    .slice(0, limit);
}

function computeTimeOfDayTrends(sessions) {
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    sessions: 0,
    totalTimeMs: 0,
    totalVisits: 0,
    avgDurationMs: 0,
    avgVisits: 0,
    goalSessions: 0,
    overrunSessions: 0,
    overrunRate: 0
  }));

  (sessions || []).forEach((session) => {
    const start = Number(session?.metrics?.start) || 0;
    const durationMs = Number(session?.metrics?.durationMs) || 0;
    const totalVisits = Number(session?.metrics?.totalVisits) || 0;
    const intendedMs = Number(session?.metrics?.intendedMs) || 0;
    const overrunMs = Number(session?.metrics?.overrunMs) || 0;
    if (!start) return;

    const bucket = hourly[new Date(start).getHours()];
    bucket.sessions += 1;
    bucket.totalTimeMs += durationMs;
    bucket.totalVisits += totalVisits;

    if (intendedMs > 0) {
      bucket.goalSessions += 1;
      if (overrunMs > 0) bucket.overrunSessions += 1;
    }
  });

  hourly.forEach((bucket) => {
    bucket.avgDurationMs = bucket.sessions ? Math.round(bucket.totalTimeMs / bucket.sessions) : 0;
    bucket.avgVisits = bucket.sessions ? Math.round((bucket.totalVisits / bucket.sessions) * 10) / 10 : 0;
    bucket.overrunRate = bucket.goalSessions ? bucket.overrunSessions / bucket.goalSessions : 0;
  });

  const topHours = [...hourly]
    .filter((bucket) => bucket.sessions > 0)
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.hour - b.hour
    ))
    .slice(0, 3);

  const longestSessionHour = [...hourly]
    .filter((bucket) => bucket.sessions > 0)
    .sort((a, b) => (
      b.avgDurationMs - a.avgDurationMs ||
      b.sessions - a.sessions ||
      a.hour - b.hour
    ))[0] || null;

  const overrunProneHour = [...hourly]
    .filter((bucket) => bucket.goalSessions > 0)
    .sort((a, b) => (
      b.overrunRate - a.overrunRate ||
      b.overrunSessions - a.overrunSessions ||
      b.goalSessions - a.goalSessions ||
      a.hour - b.hour
    ))[0] || null;

  const activeWindows = hourly.map((bucket, startHour) => {
    let sessionsInWindow = 0;
    let totalTimeMs = 0;

    for (let offset = 0; offset < 3; offset += 1) {
      const windowBucket = hourly[(startHour + offset) % 24];
      sessionsInWindow += windowBucket.sessions;
      totalTimeMs += windowBucket.totalTimeMs;
    }

    return {
      startHour,
      label: hourWindowLabel(startHour, 3),
      sessions: sessionsInWindow,
      totalTimeMs
    };
  });

  const mostCommonActiveWindow = activeWindows
    .filter((window) => window.sessions > 0)
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.totalTimeMs - a.totalTimeMs ||
      a.startHour - b.startHour
    ))[0] || null;

  return { hourly, topHours, longestSessionHour, overrunProneHour, mostCommonActiveWindow };
}

function makeSession({ startHour, durationMin, visits, intendedMin = null, overrunMin = 0 }) {
  const start = new Date(`2026-03-31T${String(startHour).padStart(2, "0")}:00:00`).getTime();
  return {
    visits: visits.map((visit, index) => ({
      domain: visit.domain,
      time: start + index * 5 * 60 * 1000,
      hadInteraction: visit.hadInteraction ?? true
    })),
    metrics: {
      start,
      end: start + durationMin * 60 * 1000,
      durationMs: durationMin * 60 * 1000,
      totalVisits: visits.length,
      intendedMs: intendedMin == null ? 0 : intendedMin * 60 * 1000,
      overrunMs: overrunMin * 60 * 1000
    }
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function printResults(title, results) {
  console.log(`\n${title}`);
  console.table(results);
}

const results = [];

function runKR1Test(name, sessions, expectedLabels) {
  const actual = computeTopSiteSequences(sessions).map((row) => row.label);
  results.push({
    kr: "KR1",
    test: name,
    expected: JSON.stringify(expectedLabels),
    actual: JSON.stringify(actual),
    result: deepEqual(actual, expectedLabels) ? "PASS" : "FAIL"
  });
}

function runKR2Test(name, sessions, expectedDomains) {
  const actual = computeExtendedSessionSites(sessions).map((row) => row.domain);
  results.push({
    kr: "KR2",
    test: name,
    expected: JSON.stringify(expectedDomains),
    actual: JSON.stringify(actual),
    result: deepEqual(actual, expectedDomains) ? "PASS" : "FAIL"
  });
}

function runKR3Test(name, sessions, expected) {
  const actual = computeTimeOfDayTrends(sessions);

  const summary = {
    topHours: actual.topHours.map((h) => h.hour),
    longestSessionHour: actual.longestSessionHour?.hour ?? null,
    overrunProneHour: actual.overrunProneHour?.hour ?? null,
    mostCommonActiveWindow: actual.mostCommonActiveWindow?.startHour ?? null
  };

  results.push({
    kr: "KR3",
    test: name,
    expected: JSON.stringify(expected),
    actual: JSON.stringify(summary),
    result: deepEqual(summary, expected) ? "PASS" : "FAIL"
  });
}

const kr1Sessions = [
  makeSession({
    startHour: 9,
    durationMin: 20,
    visits: [{ domain: "google.com" }, { domain: "gmail.com" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 20,
    visits: [{ domain: "google.com" }, { domain: "gmail.com" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 20,
    visits: [{ domain: "canvas.instructure.com" }, { domain: "google.com" }, { domain: "quizlet.com" }]
  }),
  makeSession({
    startHour: 12,
    durationMin: 20,
    visits: [{ domain: "google.com" }, { domain: "gmail.com" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 13,
    durationMin: 20,
    visits: [{ domain: "slack.com" }, { domain: "github.com" }, { domain: "slack.com" }]
  })
];

runKR1Test("Top 3 common site sequences", kr1Sessions, [
  "google.com -> gmail.com -> docs.google.com",
  "canvas.instructure.com -> google.com -> quizlet.com",
  "github.com ↔ slack.com loop"
]);

const kr2Sessions = [
  makeSession({
    startHour: 9,
    durationMin: 40,
    intendedMin: 20,
    overrunMin: 20,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 35,
    intendedMin: 15,
    overrunMin: 20,
    visits: [{ domain: "youtube.com" }, { domain: "x.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 50,
    intendedMin: 30,
    overrunMin: 20,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 12,
    durationMin: 20,
    intendedMin: 25,
    overrunMin: 0,
    visits: [{ domain: "docs.google.com" }, { domain: "gmail.com" }]
  })
];

runKR2Test("Top 3 sites involved in extended sessions", kr2Sessions, [
  "youtube.com",
  "reddit.com",
  "x.com"
]);

const kr3Sessions = [
  makeSession({
    startHour: 9,
    durationMin: 20,
    intendedMin: 25,
    overrunMin: 0,
    visits: [{ domain: "gmail.com" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 9,
    durationMin: 25,
    intendedMin: 20,
    overrunMin: 5,
    visits: [{ domain: "gmail.com" }, { domain: "canvas.instructure.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 60,
    intendedMin: 30,
    overrunMin: 30,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }, { domain: "x.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 15,
    intendedMin: 20,
    overrunMin: 0,
    visits: [{ domain: "google.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 45,
    intendedMin: 20,
    overrunMin: 25,
    visits: [{ domain: "slack.com" }, { domain: "github.com" }]
  })
];

runKR3Test("Time-of-day trend summary", kr3Sessions, {
  topHours: [10, 9, 11],
  longestSessionHour: 10,
  overrunProneHour: 10,
  mostCommonActiveWindow: 9
});

printResults("Beta KR Test Results", results);

const passCount = results.filter((result) => result.result === "PASS").length;
console.log(`\nPassed ${passCount}/${results.length} tests.`);
