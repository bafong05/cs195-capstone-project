const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
// const INACTIVITY_THRESHOLD_MS = 10 * 1000;

let lastUserActivity = Date.now();
let videoPlaying = false;
let lastPromptedAutoSessionId = null;
let lastActivityHeartbeatAt = 0;

async function getLastUserActivity() {
  const { lastUserActivityAt } = await chrome.storage.local.get(["lastUserActivityAt"]);
  const stored = Number(lastUserActivityAt);
  return Number.isFinite(stored) && stored > 0 ? stored : lastUserActivity;
}

async function setLastUserActivity(ts) {
  lastUserActivity = ts;
  await chrome.storage.local.set({ lastUserActivityAt: ts });
}

function shouldIgnoreUrl(url) {
  if (!url) return true;

  try {
    new URL(url);
    return false;
  } catch {
    return true;
  }
}

function shouldIgnoreExtensionPage(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "chrome-extension:" &&
      (
        parsed.pathname.endsWith("/dashboard.html") ||
        parsed.pathname.endsWith("/popup.html") ||
        parsed.pathname.endsWith("/intent.html")
      )
    );
  } catch {
    return false;
  }
}

function toDomain(url) {
  try {
    const parsed = new URL(url);

    if (
      (parsed.protocol === "chrome:" && parsed.pathname === "//newtab/") ||
      (parsed.protocol === "chrome-search:" && parsed.pathname.includes("local-ntp"))
    ) {
      return "new-tab-page";
    }

    const host = parsed.hostname.replace(/^www\./, "");
    if (host) return host;

    if (parsed.protocol === "file:") {
      const parts = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
      return parts[parts.length - 1] || "local file";
    }

    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return `${parsed.protocol}//${path || "page"}`;
  } catch {
    return "unknown";
  }
}

function computeSessionMetrics(visits) {
  if (!visits.length) return null;

  const start = visits[0].time;
  const end = visits[visits.length - 1].time;
  const durationMs = Math.max(0, end - start);

  const domains = visits.map((v) => v.domain || toDomain(v.url));
  const uniqueDomains = Array.from(new Set(domains));

  const timePerDomain = {};
  for (let i = 0; i < visits.length; i++) {
    const curr = visits[i];
    const next = visits[i + 1];
    const dtRaw = next ? Math.max(0, next.time - curr.time) : 0;
    const dt = Math.min(dtRaw, INACTIVITY_THRESHOLD_MS);
    const key = curr.domain || toDomain(curr.url);
    timePerDomain[key] = (timePerDomain[key] || 0) + dt;
  }

  return {
    start,
    end,
    durationMs,
    totalVisits: visits.length,
    totalSites: uniqueDomains.length,
    uniqueDomains,
    timePerDomain
  };
}

function groupIntoSessions(visits) {
  if (!visits.length) return [];

  const sorted = [...visits].sort((a, b) => a.time - b.time);
  const hasSessionIds = sorted.some((v) => v.sessionId != null);

  let sessions;

  if (hasSessionIds) {
    const byId = new Map();

    for (const v of sorted) {
      const key = v.sessionId != null ? v.sessionId : "__legacy__";
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(v);
    }

    sessions = Array.from(byId.values()).sort((a, b) => a[0].time - b[0].time);
  } else {
    sessions = [];
    let current = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.time - prev.time;

      if (gap > INACTIVITY_THRESHOLD_MS) {
        sessions.push(current);
        current = [];
      }

      current.push(curr);
    }

    sessions.push(current);
  }

  return sessions.map((sessionVisits, idx) => {
    const metrics = computeSessionMetrics(sessionVisits);

    return {
      id: `${sessionVisits[0].time}-${idx}`,
      visits: sessionVisits,
      metrics
    };
  });
}

async function rebuildSessions() {
  const { visits = [], sessionIntents = [] } = await chrome.storage.local.get([
    "visits",
    "sessionIntents"
  ]);

  const sessionsWithMetrics = groupIntoSessions(visits).map((session) => {
    const metrics = session.metrics;
    if (!metrics) return session;

    const sessionId = session.visits?.[0]?.sessionId;

    let intent = sessionIntents.find((i) => i.sessionId === sessionId);

    if (!intent) {
      intent = sessionIntents.find((i) => i.startTime === metrics.start);
    }

    if (!intent || intent.intendedMinutes == null) return session;

    const intendedMs = intent.intendedMinutes * 60 * 1000;
    const durationMs = metrics.durationMs || 0;
    const overrunMs = Math.max(0, durationMs - intendedMs);
    const overrunRatio = intendedMs > 0 ? overrunMs / intendedMs : null;

    return {
      ...session,
      metrics: {
        ...metrics,
        intendedMinutes: intent.intendedMinutes,
        intendedMs,
        overrunMs,
        overrunRatio
      }
    };
  });

  await chrome.storage.local.set({ sessions: sessionsWithMetrics });
  return sessionsWithMetrics;
}

async function promptForAutoSessionIntent(sessionId) {
  if (!sessionId || lastPromptedAutoSessionId === sessionId) return;

  lastPromptedAutoSessionId = sessionId;

  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html?intent=auto"),
      type: "popup",
      width: 360,
      height: 520,
      focused: true
    });
  } catch {}
}

async function heartbeatActiveSession(ts) {
  if (ts - lastActivityHeartbeatAt < 15000) return;
  lastActivityHeartbeatAt = ts;

  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  if (!activeSession) return;

  if ((activeSession.lastEventTime || 0) >= ts) return;

  await chrome.storage.local.set({
    activeSession: {
      ...activeSession,
      lastEventTime: ts
    }
  });
}

async function logVisit(url, source) {
  if (shouldIgnoreUrl(url)) return;
  if (shouldIgnoreExtensionPage(url)) return;

  const now = Date.now();
  const persistedLastUserActivity = await getLastUserActivity();
  const wasInactive = now - persistedLastUserActivity > INACTIVITY_THRESHOLD_MS;
  const visit = {
    url,
    domain: toDomain(url),
    time: now,
    source
  };

  const data = await chrome.storage.local.get(["visits", "activeSession"]);
  const visits = data.visits || [];
  let active = data.activeSession || null;
  let startedAutoSession = false;
  const effectiveLastActivity = Math.max(persistedLastUserActivity, active?.lastEventTime || 0);

  if (!active || (effectiveLastActivity && now - effectiveLastActivity > INACTIVITY_THRESHOLD_MS)) {
    active = {
      id: `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0
    };
    startedAutoSession = true;
  }

  // The first tracked event after inactivity should resume activity state so
  // subsequent tab switches do not keep spawning new auto sessions.
  if (wasInactive || startedAutoSession) {
    await setLastUserActivity(now);
  }

  active.lastEventTime = now;
  active.visitCount += 1;

  if (!active.uniqueDomains.includes(visit.domain)) {
    active.uniqueDomains.push(visit.domain);
  }

  visit.sessionId = active.id;

  visits.push(visit);

  await chrome.storage.local.set({
    visits,
    activeSession: active
  });

  await rebuildSessions();

  if (startedAutoSession) {
    await promptForAutoSessionIntent(active.id);
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      await logVisit(tab.url, "tab-switch");
    }
  } catch {}
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.url) return;

  let source = "navigation";

  if (details.transitionType === "typed") source = "direct-url-entry";
  else if (details.transitionType === "link") source = "link-navigation";
  else if (details.transitionType === "reload") source = "page-reload";
  else if (details.transitionType === "auto_bookmark") source = "bookmark-navigation";
  else if (details.transitionType === "generated") source = "address-bar-search";

  await logVisit(details.url, source);
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    const activeTab = tabs?.[0];
    if (activeTab?.url) {
      await logVisit(activeTab.url, "browser-startup");
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(async () => {
  const { visits, sessions, activeSession, sessionIntents, lastUserActivityAt } =
    await chrome.storage.local.get([
      "visits",
      "sessions",
      "activeSession",
      "sessionIntents",
      "lastUserActivityAt"
    ]);

  if (!visits) await chrome.storage.local.set({ visits: [] });
  if (!sessions) await chrome.storage.local.set({ sessions: [] });
  if (!activeSession) await chrome.storage.local.set({ activeSession: null });
  if (!sessionIntents) await chrome.storage.local.set({ sessionIntents: [] });
  if (!lastUserActivityAt) await chrome.storage.local.set({ lastUserActivityAt: Date.now() });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "userActivity") {
    const ts = Date.now();
    setLastUserActivity(ts).catch(() => {});
    heartbeatActiveSession(ts).catch(() => {});
  }

  if (msg.type === "videoStatus") {
    videoPlaying = msg.playing;
  }

  if (msg.type === "rebuildSessions") {
    rebuildSessions()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));

    return true;
  }

});

setInterval(async () => {

  const now = Date.now();
  const data = await chrome.storage.local.get(["activeSession"]);
  const active = data.activeSession;

  if (!active) return;

  const persistedLastUserActivity = await getLastUserActivity();
  const effectiveLastActivity = Math.max(persistedLastUserActivity, active.lastEventTime || 0);
  const inactive = now - effectiveLastActivity > INACTIVITY_THRESHOLD_MS;

  if (inactive && !videoPlaying) {
    await chrome.storage.local.set({
      activeSession: null
    });
  }

}, 10000);
