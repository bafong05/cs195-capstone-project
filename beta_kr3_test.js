function hourLabel(hour) {
  const suffix = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${suffix}`;
}

function hourWindowLabel(startHour, span = 3) {
  const endHour = (startHour + span) % 24;
  return `${hourLabel(startHour)}-${hourLabel(endHour)}`;
}

function formatHourList(hours) {
  return (hours || []).map((hour) => hourLabel(hour)).join(", ");
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

const results = [];

function runTimeOfDayTest(name, sessions, expected) {
  const actual = computeTimeOfDayTrends(sessions);
  const summary = {
    topHours: actual.topHours.map((hour) => hour.hour),
    longestSessionHour: actual.longestSessionHour?.hour ?? null,
    overrunProneHour: actual.overrunProneHour?.hour ?? null,
    mostCommonActiveWindow: actual.mostCommonActiveWindow?.startHour ?? null
  };

  const peakPass = JSON.stringify(summary.topHours) === JSON.stringify(expected.topHours);
  const longestPass = summary.longestSessionHour === expected.longestSessionHour;
  const overrunPass = summary.overrunProneHour === expected.overrunProneHour;
  const windowPass = summary.mostCommonActiveWindow === expected.mostCommonActiveWindow;

  results.push({
    scenario: name,
    peak: `${formatHourList(summary.topHours)} (${peakPass ? "P" : "F"})`,
    longest: `${hourLabel(summary.longestSessionHour)} (${longestPass ? "P" : "F"})`,
    overrun: `${hourLabel(summary.overrunProneHour)} (${overrunPass ? "P" : "F"})`,
    window: `${hourWindowLabel(summary.mostCommonActiveWindow)} (${windowPass ? "P" : "F"})`,
    pass: peakPass && longestPass && overrunPass && windowPass ? "PASS" : "FAIL"
  });
}

runTimeOfDayTest("School/work day", [
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
], {
  topHours: [10, 9, 11],
  longestSessionHour: 10,
  overrunProneHour: 10,
  mostCommonActiveWindow: 9
});

runTimeOfDayTest("No-goal excluded", [
  makeSession({
    startHour: 8,
    durationMin: 50,
    intendedMin: null,
    overrunMin: 0,
    visits: [{ domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 8,
    durationMin: 55,
    intendedMin: null,
    overrunMin: 0,
    visits: [{ domain: "chatgpt.com" }]
  }),
  makeSession({
    startHour: 14,
    durationMin: 45,
    intendedMin: 20,
    overrunMin: 25,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 15,
    durationMin: 30,
    intendedMin: 30,
    overrunMin: 0,
    visits: [{ domain: "gmail.com" }]
  })
], {
  topHours: [8, 14, 15],
  longestSessionHour: 8,
  overrunProneHour: 14,
  mostCommonActiveWindow: 6
});

runTimeOfDayTest("Late-night wrap", [
  makeSession({
    startHour: 22,
    durationMin: 20,
    intendedMin: 15,
    overrunMin: 5,
    visits: [{ domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 23,
    durationMin: 25,
    intendedMin: 20,
    overrunMin: 5,
    visits: [{ domain: "chatgpt.com" }]
  }),
  makeSession({
    startHour: 0,
    durationMin: 30,
    intendedMin: 20,
    overrunMin: 10,
    visits: [{ domain: "youtube.com" }]
  }),
  makeSession({
    startHour: 14,
    durationMin: 15,
    intendedMin: 15,
    overrunMin: 0,
    visits: [{ domain: "gmail.com" }]
  })
], {
  topHours: [0, 23, 22],
  longestSessionHour: 0,
  overrunProneHour: 0,
  mostCommonActiveWindow: 22
});

console.log("\nKR3 scenario summary:");
console.table(results);

const sampleSessions = [
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
  }),
  makeSession({
    startHour: 14,
    durationMin: 35,
    intendedMin: 20,
    overrunMin: 15,
    visits: [{ domain: "notion.so" }, { domain: "docs.google.com" }]
  }),
  makeSession({
    startHour: 14,
    durationMin: 25,
    intendedMin: 25,
    overrunMin: 0,
    visits: [{ domain: "gmail.com" }]
  }),
  makeSession({
    startHour: 19,
    durationMin: 50,
    intendedMin: 30,
    overrunMin: 20,
    visits: [{ domain: "youtube.com" }, { domain: "reddit.com" }]
  }),
  makeSession({
    startHour: 21,
    durationMin: 40,
    intendedMin: 20,
    overrunMin: 20,
    visits: [{ domain: "slack.com" }, { domain: "github.com" }]
  })
];

const summary = computeTimeOfDayTrends(sampleSessions);
console.log("\nSample dataset summary:");
console.table([
  {
    peak: formatHourList(summary.topHours.map((hour) => hour.hour)),
    longest: hourLabel(summary.longestSessionHour?.hour ?? 0),
    overrun: hourLabel(summary.overrunProneHour?.hour ?? 0),
    window: hourWindowLabel(summary.mostCommonActiveWindow?.startHour ?? 0)
  }
]);

const allPassed = results.every((row) => row.pass === "PASS");

if (allPassed) {
  console.log("All KR3 time-of-day trend tests passed.");
} else {
  console.log("Some KR3 time-of-day trend tests failed.");
  process.exitCode = 1;
}
