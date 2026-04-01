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
        label: `${pair[0]} ↔ ${pair[1]} loop`
      };
    }

    return {
      key: sequence.join(" -> "),
      label: sequence.join(" -> ")
    };
  };

  (sessions || []).forEach((session) => {
    const collapsedDomains = [];

    (session?.visits || []).forEach((visit) => {
      if (!visit?.domain || visit.domain === "unknown") return;
      if (["extensions", "newtab", "new-tab-page"].includes(visit.domain)) return;
      if (collapsedDomains[collapsedDomains.length - 1] === visit.domain) return;
      collapsedDomains.push(visit.domain);
    });

    if (collapsedDomains.length < sequenceLength) return;

    for (let index = 0; index <= collapsedDomains.length - sequenceLength; index += 1) {
      const sequence = collapsedDomains.slice(index, index + sequenceLength);
      const signature = getSequenceSignature(sequence);
      const existing = counts.get(signature.key) || {
        label: signature.label,
        count: 0,
        sessions: new Set()
      };

      existing.count += 1;
      existing.sessions.add(session.id);
      counts.set(signature.key, existing);
    }
  });

  return Array.from(counts.values())
    .map((entry) => ({
      label: entry.label,
      count: entry.count,
      sessions: entry.sessions.size
    }))
    .sort((a, b) => (
      b.sessions - a.sessions ||
      b.count - a.count ||
      a.label.localeCompare(b.label)
    ))
    .slice(0, limit);
}

const results = [];

function runSequenceTest(name, sessions, expectedLabels) {
  const actualRows = computeTopSiteSequences(sessions);
  const actualLabels = actualRows.map((row) => row.label);

  results.push({
    test: name,
    expectedTop3: JSON.stringify(expectedLabels),
    actualTop3: JSON.stringify(actualLabels),
    result: JSON.stringify(actualLabels) === JSON.stringify(expectedLabels) ? "PASS" : "FAIL"
  });
}

runSequenceTest("Repeated school workflow plus one loop", [
  {
    id: "s1",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "s2",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "s3",
    visits: [
      { domain: "canvas.instructure.com" },
      { domain: "google.com" },
      { domain: "quizlet.com" }
    ]
  },
  {
    id: "s4",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "s5",
    visits: [
      { domain: "slack.com" },
      { domain: "github.com" },
      { domain: "slack.com" }
    ]
  }
], [
  "google.com -> gmail.com -> docs.google.com",
  "canvas.instructure.com -> google.com -> quizlet.com",
  "github.com ↔ slack.com loop"
]);

runSequenceTest("Ignores utility tabs and collapses repeat visits", [
  {
    id: "s1",
    visits: [
      { domain: "newtab" },
      { domain: "docs.google.com" },
      { domain: "docs.google.com" },
      { domain: "chatgpt.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "s2",
    visits: [
      { domain: "extensions" },
      { domain: "docs.google.com" },
      { domain: "chatgpt.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "s3",
    visits: [
      { domain: "unknown" },
      { domain: "canvas.instructure.com" },
      { domain: "google.com" },
      { domain: "quizlet.com" }
    ]
  }
], [
  "chatgpt.com ↔ docs.google.com loop",
  "canvas.instructure.com -> google.com -> quizlet.com"
]);

runSequenceTest("Ranks by session coverage before raw repeat count", [
  {
    id: "s1",
    visits: [
      { domain: "figma.com" },
      { domain: "github.com" },
      { domain: "linear.app" }
    ]
  },
  {
    id: "s2",
    visits: [
      { domain: "figma.com" },
      { domain: "github.com" },
      { domain: "linear.app" }
    ]
  },
  {
    id: "s3",
    visits: [
      { domain: "notion.so" },
      { domain: "docs.google.com" },
      { domain: "chatgpt.com" }
    ]
  },
  {
    id: "s4",
    visits: [
      { domain: "slack.com" },
      { domain: "gmail.com" },
      { domain: "calendar.google.com" }
    ]
  }
], [
  "figma.com -> github.com -> linear.app",
  "notion.so -> docs.google.com -> chatgpt.com",
  "slack.com -> gmail.com -> calendar.google.com"
]);

console.table(results);
const sampleSessions = [
  {
    id: "sample-1",
    visits: [
      { domain: "docs.google.com" },
      { domain: "chatgpt.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "sample-2",
    visits: [
      { domain: "docs.google.com" },
      { domain: "chatgpt.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "sample-3",
    visits: [
      { domain: "canvas.instructure.com" },
      { domain: "google.com" },
      { domain: "quizlet.com" }
    ]
  },
  {
    id: "sample-4",
    visits: [
      { domain: "canvas.instructure.com" },
      { domain: "google.com" },
      { domain: "quizlet.com" }
    ]
  },
  {
    id: "sample-5",
    visits: [
      { domain: "slack.com" },
      { domain: "github.com" },
      { domain: "slack.com" }
    ]
  },
  {
    id: "sample-6",
    visits: [
      { domain: "slack.com" },
      { domain: "github.com" },
      { domain: "slack.com" }
    ]
  },
  {
    id: "sample-7",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "sample-8",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  },
  {
    id: "sample-9",
    visits: [
      { domain: "google.com" },
      { domain: "gmail.com" },
      { domain: "docs.google.com" }
    ]
  }
];

console.log("\nScenario: multiple real sessions producing multiple repeated workflows");
console.table([
  { session: "sample-1", path: "docs.google.com -> chatgpt.com -> docs.google.com" },
  { session: "sample-2", path: "docs.google.com -> chatgpt.com -> docs.google.com" },
  { session: "sample-3", path: "canvas.instructure.com -> google.com -> quizlet.com" },
  { session: "sample-4", path: "canvas.instructure.com -> google.com -> quizlet.com" },
  { session: "sample-5", path: "slack.com -> github.com -> slack.com" },
  { session: "sample-6", path: "slack.com -> github.com -> slack.com" },
  { session: "sample-7", path: "google.com -> gmail.com -> docs.google.com" },
  { session: "sample-8", path: "google.com -> gmail.com -> docs.google.com" },
  { session: "sample-9", path: "google.com -> gmail.com -> docs.google.com" }
]);

console.log("\nComputed top 3 sequences from sample dataset:");
console.table(computeTopSiteSequences(sampleSessions));

const allPassed = results.every((row) => row.result === "PASS");

if (allPassed) {
  console.log("All KR1 sequence tests passed.");
} else {
  console.log("Some KR1 sequence tests failed.");
  process.exitCode = 1;
}
