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

const results = [];

function runExtendedSessionTest(name, sessions, expectedDomains) {
  const actualRows = computeExtendedSessionSites(sessions);
  const actualDomains = actualRows.map((row) => row.domain);

  results.push({
    test: name,
    expectedTop3: JSON.stringify(expectedDomains),
    actualTop3: JSON.stringify(actualDomains),
    result: JSON.stringify(actualDomains) === JSON.stringify(expectedDomains) ? "PASS" : "FAIL"
  });
}

runExtendedSessionTest("Basic extended-session ranking", [
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
], [
  "youtube.com",
  "reddit.com",
  "x.com"
]);

runExtendedSessionTest("Ignores no-goal sessions, on-time sessions, and utility tabs", [
  makeSession({
    startHour: 9,
    durationMin: 45,
    intendedMin: null,
    overrunMin: 0,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 30,
    intendedMin: 30,
    overrunMin: 0,
    visits: [{ domain: "gmail.com" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 50,
    intendedMin: 20,
    overrunMin: 30,
    visits: [{ domain: "newtab" }, { domain: "youtube.com" }, { domain: "extensions" }]
  }),
  makeSession({
    startHour: 12,
    durationMin: 55,
    intendedMin: 25,
    overrunMin: 30,
    visits: [{ domain: "youtube.com" }, { domain: "slack.com" }]
  })
], [
  "youtube.com",
  "slack.com"
]);

runExtendedSessionTest("Counts each site once per extended session and breaks ties by total time", [
  makeSession({
    startHour: 9,
    durationMin: 60,
    intendedMin: 20,
    overrunMin: 40,
    visits: [{ domain: "netflix.com" }, { domain: "netflix.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 50,
    intendedMin: 25,
    overrunMin: 25,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 40,
    intendedMin: 15,
    overrunMin: 25,
    visits: [{ domain: "netflix.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 12,
    durationMin: 55,
    intendedMin: 20,
    overrunMin: 35,
    visits: [{ domain: "netflix.com" }, { domain: "spotify.com" }]
  })
], [
  "netflix.com",
  "youtube.com",
  "reddit.com"
]);

runExtendedSessionTest("Mixed real-world cases: ignores non-extended and no-goal sessions", [
  makeSession({
    startHour: 8,
    durationMin: 25,
    intendedMin: 25,
    overrunMin: 0,
    visits: [{ domain: "docs.google.com" }, { domain: "gmail.com" }]
  }),
  makeSession({
    startHour: 9,
    durationMin: 18,
    intendedMin: 20,
    overrunMin: 0,
    visits: [{ domain: "canvas.instructure.com" }, { domain: "quizlet.com" }]
  }),
  makeSession({
    startHour: 10,
    durationMin: 45,
    intendedMin: null,
    overrunMin: 0,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 11,
    durationMin: 55,
    intendedMin: 20,
    overrunMin: 35,
    visits: [{ domain: "newtab" }, { domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 12,
    durationMin: 50,
    intendedMin: 25,
    overrunMin: 25,
    visits: [{ domain: "youtube.com" }, { domain: "x.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 13,
    durationMin: 48,
    intendedMin: 20,
    overrunMin: 28,
    visits: [{ domain: "spotify.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 14,
    durationMin: 40,
    intendedMin: 15,
    overrunMin: 25,
    visits: [{ domain: "reddit.com" }, { domain: "spotify.com" }]
  }),
  makeSession({
    startHour: 15,
    durationMin: 42,
    intendedMin: 20,
    overrunMin: 22,
    visits: [{ domain: "extensions" }, { domain: "youtube.com" }, { domain: "spotify.com" }]
  })
], [
  "youtube.com",
  "spotify.com",
  "reddit.com"
]);

console.table(results);
const sampleSessions = [
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
    durationMin: 55,
    intendedMin: 20,
    overrunMin: 35,
    visits: [{ domain: "netflix.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 13,
    durationMin: 45,
    intendedMin: 20,
    overrunMin: 25,
    visits: [{ domain: "reddit.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 14,
    durationMin: 42,
    intendedMin: 15,
    overrunMin: 27,
    visits: [{ domain: "x.com" }, { domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 15,
    durationMin: 25,
    intendedMin: 25,
    overrunMin: 0,
    visits: [{ domain: "docs.google.com" }, { domain: "gmail.com" }]
  }),
  makeSession({
    startHour: 16,
    durationMin: 45,
    intendedMin: null,
    overrunMin: 0,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 17,
    durationMin: 48,
    intendedMin: 20,
    overrunMin: 28,
    visits: [{ domain: "spotify.com" }, { domain: "youtube.com" }]
  })
];

console.log("\nScenario: mixed sessions with extended, on-time, and no-goal cases");
console.table([
  { session: "sample-1", intended: "20m", actual: "40m", sites: "youtube.com, reddit.com" },
  { session: "sample-2", intended: "15m", actual: "35m", sites: "youtube.com, x.com" },
  { session: "sample-3", intended: "30m", actual: "50m", sites: "youtube.com, reddit.com" },
  { session: "sample-4", intended: "20m", actual: "55m", sites: "netflix.com, youtube.com" },
  { session: "sample-5", intended: "20m", actual: "45m", sites: "reddit.com, youtube.com" },
  { session: "sample-6", intended: "15m", actual: "42m", sites: "x.com, youtube.com" },
  { session: "sample-7", intended: "25m", actual: "25m", sites: "docs.google.com, gmail.com" },
  { session: "sample-8", intended: "No goal", actual: "45m", sites: "youtube.com, reddit.com" },
  { session: "sample-9", intended: "20m", actual: "48m", sites: "spotify.com, youtube.com" }
]);

console.log("\nComputed extended-session site ranking from sample dataset:");
console.table(computeExtendedSessionSites(sampleSessions));

const allPassed = results.every((row) => row.result === "PASS");

if (allPassed) {
  console.log("All KR2 extended-session site tests passed.");
} else {
  console.log("Some KR2 extended-session site tests failed.");
  process.exitCode = 1;
}
