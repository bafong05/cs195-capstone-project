const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
let browserIdleState = "active";

function normalizeInactivityThresholdMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_INACTIVITY_THRESHOLD_MINUTES;
  return Math.min(120, Math.max(1, Math.round(minutes)));
}

function normalizeSessionName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.slice(0, 80);
}

function getInactivityThresholdMs() {
  return inactivityThresholdMs;
}

function getIdleDetectionSeconds() {
  return Math.max(15, Math.round(getInactivityThresholdMs() / 1000));
}

async function loadInactivityThreshold() {
  const { inactivityThresholdMinutes } = await chrome.storage.local.get(["inactivityThresholdMinutes"]);
  const minutes = normalizeInactivityThresholdMinutes(inactivityThresholdMinutes);
  inactivityThresholdMs = minutes * 60 * 1000;
  return inactivityThresholdMs;
}

async function getNotificationPreferences() {
  const { notificationPreferences } = await chrome.storage.local.get(["notificationPreferences"]);
  return {
    endingSoon: notificationPreferences?.endingSoon !== false,
    overrun: notificationPreferences?.overrun !== false,
    missingGoal: notificationPreferences?.missingGoal !== false,
    sessionEnded: notificationPreferences?.sessionEnded !== false
  };
}

let videoPlaying = false;
let lastPromptedAutoSessionId = null;
let lastOverrunNotificationSessionId = null;
let lastGoalReminderSessionId = null;
let lastEndingSoonNotificationSessionId = null;
let lastSessionEndedNotificationSessionId = null;
const SESSION_MONITOR_ALARM = "session-monitor";
const SESSION_OVERRUN_ALARM = "session-overrun-check";
const SESSION_GOAL_REMINDER_ALARM = "session-goal-reminder";
const SESSION_ENDING_SOON_ALARM = "session-ending-soon";
const NO_GOAL_REMINDER_DELAY_MS = 10 * 1000;

function isIdleStateInactive(state) {
  return state === "idle" || state === "locked";
}

function setIdleDetectionInterval() {
  try {
    chrome.idle.setDetectionInterval(getIdleDetectionSeconds());
  } catch {}
}

function queryIdleState(seconds = getIdleDetectionSeconds()) {
  return new Promise((resolve) => {
    try {
      chrome.idle.queryState(seconds, (state) => {
        if (chrome.runtime.lastError) {
          resolve("active");
          return;
        }
        resolve(state || "active");
      });
    } catch {
      resolve("active");
    }
  });
}

async function refreshIdleState() {
  setIdleDetectionInterval();
  browserIdleState = await queryIdleState();
  return browserIdleState;
}

async function rebuildSessionStore({
  visitsKey,
  sessionsKey,
  intentsKey
}) {
  const data = await chrome.storage.local.get([visitsKey, intentsKey]);
  const visits = data[visitsKey] || [];
  const sessionIntents = data[intentsKey] || [];

  const sessionsWithMetrics = groupIntoSessions(visits).map((session) => {
    const metrics = session.metrics;
    if (!metrics) return session;

    const sessionId = session.visits?.[0]?.sessionId;

    let intent = sessionIntents.find((i) => i.sessionId === sessionId);

    if (!intent) {
      intent = sessionIntents.find((i) => i.startTime === metrics.start);
    }

    if (!intent) return session;

    const sessionName = normalizeSessionName(intent.sessionName);
    if (intent.intendedMinutes == null) {
      return {
        ...session,
        metrics: {
          ...metrics,
          sessionName
        }
      };
    }

    const intendedMs = intent.intendedMinutes * 60 * 1000;
    const durationMs = metrics.durationMs || 0;
    const overrunMs = Math.max(0, durationMs - intendedMs);
    const overrunRatio = intendedMs > 0 ? overrunMs / intendedMs : null;

    return {
      ...session,
      metrics: {
        ...metrics,
        sessionName,
        intendedMinutes: intent.intendedMinutes,
        intendedMs,
        overrunMs,
        overrunRatio
      }
    };
  });

  await chrome.storage.local.set({ [sessionsKey]: sessionsWithMetrics });
  return sessionsWithMetrics;
}

async function markVisitInteraction(tabId, url, ts = Date.now()) {
  if (!tabId) return;

  const {
    visits = [],
    analyticsVisits = []
  } = await chrome.storage.local.get(["visits", "analyticsVisits"]);
  const nextVisits = Array.isArray(visits) ? visits.slice() : [];
  const nextAnalyticsVisits = Array.isArray(analyticsVisits) ? analyticsVisits.slice() : [];
  let changed = false;

  const markLatestMatchingVisit = (list) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const visit = list[i];
      if (visit?.tabId !== tabId) continue;
      if (url && visit?.url && visit.url !== url) continue;
      const nextVisit = {
        ...visit,
        hadInteraction: true,
        lastActiveTime: Math.max(Number(visit?.lastActiveTime || 0), ts)
      };

      if (!visit?.firstInteractionTime) {
        nextVisit.firstInteractionTime = ts;
      }

      const visitChanged =
        nextVisit.hadInteraction !== visit?.hadInteraction ||
        nextVisit.firstInteractionTime !== visit?.firstInteractionTime ||
        nextVisit.lastActiveTime !== visit?.lastActiveTime;

      if (!visitChanged) return false;

      list[i] = nextVisit;
      return true;
    }
    return false;
  };

  const dashboardChanged = markLatestMatchingVisit(nextVisits);
  const analyticsChanged = markLatestMatchingVisit(nextAnalyticsVisits);
  changed = dashboardChanged || analyticsChanged;
  if (!changed) return;

  await chrome.storage.local.set({
    visits: nextVisits,
    analyticsVisits: nextAnalyticsVisits
  });
  await rebuildSessions();
  await rebuildAnalyticsSessions();
}

async function setLastUserActivity(ts) {
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
  const lastVisit = visits[visits.length - 1];
  const end = Math.max(
    lastVisit.time,
    Number(lastVisit.lastActiveTime || lastVisit.firstInteractionTime || lastVisit.time)
  );
  const durationMs = Math.max(0, end - start);

  const domains = visits.map((v) => v.domain || toDomain(v.url));
  const uniqueDomains = Array.from(new Set(domains));

  const timePerDomain = {};
  for (let i = 0; i < visits.length; i++) {
    const curr = visits[i];
    const next = visits[i + 1];
    const currRecordedEnd = Math.max(
      curr.time,
      Number(curr.lastActiveTime || curr.firstInteractionTime || curr.time)
    );
    const dt = next
      ? Math.max(0, next.time - curr.time)
      : Math.max(0, currRecordedEnd - curr.time);
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

function createBasicNotification(id, title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("notification-icon.png"),
      title,
      message,
      priority: 1
    }, (notificationId) => {
      const error = chrome.runtime.lastError?.message || "";
      resolve({
        ok: !error,
        notificationId: notificationId || null,
        error
      });
    });
  });
}

async function markSessionNotificationSent(sessionId, key) {
  if (!sessionId || !key) return;

  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);
  const updates = {};

  if (activeSession?.id === sessionId) {
    updates.activeSession = {
      ...activeSession,
      [key]: true
    };
  }

  if (analyticsActiveSession?.id === sessionId) {
    updates.analyticsActiveSession = {
      ...analyticsActiveSession,
      [key]: true
    };
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

async function maybeNotifySessionOverrun(activeSession) {
  if (!activeSession?.id || activeSession?.intendedMinutes == null) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.overrun) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.overrunNotificationSent) {
    lastOverrunNotificationSessionId = sessionId;
    return;
  }
  if (lastOverrunNotificationSessionId === sessionId) return;

  const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
  if (intendedMs <= 0) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);

  if (elapsedMs <= intendedMs) return;

  try {
    await createBasicNotification(
      `session-overrun-${sessionId}`,
      "Over intended time",
      "You have now exceeded your intended browsing duration."
    );
    lastOverrunNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "overrunNotificationSent");
  } catch {}
}

function groupIntoSessions(visits) {
  if (!visits.length) return [];
  const thresholdMs = getInactivityThresholdMs();

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

      if (gap > thresholdMs) {
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
  return rebuildSessionStore({
    visitsKey: "visits",
    sessionsKey: "sessions",
    intentsKey: "sessionIntents"
  });
}

async function rebuildAnalyticsSessions() {
  return rebuildSessionStore({
    visitsKey: "analyticsVisits",
    sessionsKey: "analyticsSessions",
    intentsKey: "analyticsSessionIntents"
  });
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
  const {
    activeSession,
    analyticsActiveSession
  } = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);
  const updates = {};

  if (activeSession && (activeSession.lastEventTime || 0) < ts) {
    updates.activeSession = {
      ...activeSession,
      lastEventTime: ts
    };
  }

  if (analyticsActiveSession && (analyticsActiveSession.lastEventTime || 0) < ts) {
    updates.analyticsActiveSession = {
      ...analyticsActiveSession,
      lastEventTime: ts
    };
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  await maybeNotifySessionOverrun(updates.activeSession || activeSession);
  await maybeNotifyMissingGoal(updates.activeSession || activeSession);
}

async function resumeSessionFromForegroundActivity(tab, ts = Date.now()) {
  const url = tab?.url || "";
  if (!url || shouldIgnoreUrl(url) || shouldIgnoreExtensionPage(url)) return false;

  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  const shouldResume = !activeSession;

  if (!shouldResume) return false;

  await logVisit(url, "activity-resume", tab.id ?? null, tab.favIconUrl || "");
  return true;
}

async function logVisit(url, source, tabId = null, favIconUrl = "") {
  if (shouldIgnoreUrl(url)) return;
  if (shouldIgnoreExtensionPage(url)) return;

  const now = Date.now();
  const visit = {
    url,
    domain: toDomain(url),
    time: now,
    lastActiveTime: now,
    source,
    tabId,
    favIconUrl,
    hadInteraction: false
  };

  const data = await chrome.storage.local.get([
    "visits",
    "activeSession",
    "analyticsVisits",
    "analyticsActiveSession"
  ]);
  const visits = data.visits || [];
  const analyticsVisits = data.analyticsVisits || [];
  let active = data.activeSession || null;
  let analyticsActive = data.analyticsActiveSession || null;
  let startedAutoSession = false;

  if (!active) {
    active = {
      id: `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0,
      goalSelectionMade: false
    };
    startedAutoSession = true;
  }

  if (!analyticsActive) {
    analyticsActive = {
      id: active?.id || `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0,
      goalSelectionMade: active?.goalSelectionMade ?? false
    };
  }

  // The first tracked event after inactivity should resume activity state so
  // subsequent tab switches do not keep spawning new auto sessions.
  if (startedAutoSession) {
    await setLastUserActivity(now);
  }

  active.lastEventTime = now;
  active.visitCount += 1;

  if (!active.uniqueDomains.includes(visit.domain)) {
    active.uniqueDomains.push(visit.domain);
  }

  visit.sessionId = active.id;
  const analyticsVisit = {
    ...visit,
    sessionId: analyticsActive.id
  };

  visits.push(visit);
  analyticsVisits.push(analyticsVisit);

  await chrome.storage.local.set({
    visits,
    activeSession: active,
    analyticsVisits,
    analyticsActiveSession: {
      ...analyticsActive,
      lastEventTime: now,
      visitCount: (analyticsActive.visitCount || 0) + 1,
      uniqueDomains: analyticsActive.uniqueDomains?.includes(analyticsVisit.domain)
        ? analyticsActive.uniqueDomains
        : [...(analyticsActive.uniqueDomains || []), analyticsVisit.domain]
    }
  });

  await rebuildSessions();
  await rebuildAnalyticsSessions();
  await maybeNotifySessionOverrun(active);
  await maybeNotifyMissingGoal(active);

  if (startedAutoSession) {
    await promptForAutoSessionIntent(active.id);
  }
}

async function maybeNotifyMissingGoal(activeSession) {
  if (!activeSession?.id) return;
  if (activeSession.goalSelectionMade === true) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.missingGoal) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.missingGoalNotificationSent) {
    lastGoalReminderSessionId = sessionId;
    return;
  }
  if (lastGoalReminderSessionId === sessionId) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  if (elapsedMs < NO_GOAL_REMINDER_DELAY_MS) return;

  try {
    const result = await createBasicNotification(
      `session-goal-reminder-${sessionId}`,
      "No goal selected",
      "This current session has no goal. Start a new session to set a goal or choose No goal."
    );
    if (!result?.ok) return;
    lastGoalReminderSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "missingGoalNotificationSent");
  } catch {}
}

async function maybeNotifySessionEndingSoon(activeSession) {
  if (!activeSession?.id || activeSession?.intendedMinutes == null) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.endingSoon) return;
  if (isIdleStateInactive(await refreshIdleState()) && !videoPlaying) return;

  const sessionId = String(activeSession.id);
  if (activeSession.endingSoonNotificationSent) {
    lastEndingSoonNotificationSessionId = sessionId;
    return;
  }
  if (lastEndingSoonNotificationSessionId === sessionId) return;
  if (lastOverrunNotificationSessionId === sessionId) return;

  const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
  if (intendedMs <= 2 * 60 * 1000) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  const remainingMs = intendedMs - elapsedMs;

  if (remainingMs <= 0 || remainingMs > 2 * 60 * 1000) return;

  try {
    const result = await createBasicNotification(
      `session-ending-soon-${sessionId}`,
      "Your session is ending soon",
      "You have about 2 minutes left before reaching your intended browsing duration."
    );
    if (!result?.ok) return;
    lastEndingSoonNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "endingSoonNotificationSent");
  } catch {}
}

async function maybeNotifySessionEnded(activeSession) {
  if (!activeSession?.id) return;
  const preferences = await getNotificationPreferences();
  if (!preferences.sessionEnded) return;

  const sessionId = String(activeSession.id);
  if (activeSession.sessionEndedNotificationSent) {
    lastSessionEndedNotificationSessionId = sessionId;
    return;
  }
  if (lastSessionEndedNotificationSessionId === sessionId) return;

  try {
    const result = await createBasicNotification(
      `session-ended-${sessionId}`,
      "Your session has ended",
      "This session ended because no activity was detected before your inactivity threshold."
    );
    if (!result?.ok) return;
    lastSessionEndedNotificationSessionId = sessionId;
    await markSessionNotificationSent(sessionId, "sessionEndedNotificationSent");
  } catch {}
}

async function runSessionMonitorTick() {
  const now = Date.now();
  const idleState = await refreshIdleState();
  const browserInactive = isIdleStateInactive(idleState);
  const data = await chrome.storage.local.get(["activeSession", "analyticsActiveSession"]);
  const active = data.activeSession;
  const analyticsActive = data.analyticsActiveSession;
  const updates = {};

  if (active) {
    if (browserInactive && !videoPlaying) {
      await maybeNotifySessionEnded(active);
      updates.activeSession = null;
      lastOverrunNotificationSessionId = null;
      lastGoalReminderSessionId = null;
      lastEndingSoonNotificationSessionId = null;
    } else {
      await maybeNotifySessionEndingSoon(active);
      await maybeNotifySessionOverrun(active);
      await maybeNotifyMissingGoal(active);
    }
  }

  if (analyticsActive) {
    if (browserInactive && !videoPlaying) {
      updates.analyticsActiveSession = null;
    }
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

function ensureSessionMonitorAlarm() {
  chrome.alarms.create(SESSION_MONITOR_ALARM, {
    periodInMinutes: 1
  });
}

async function resumeFromActiveTab(source = "activity-resume") {
  try {
    const { activeSession } = await chrome.storage.local.get(["activeSession"]);
    if (activeSession?.id) return false;

    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    const activeTab = tabs?.[0];
    if (!activeTab?.url) return false;

    await logVisit(activeTab.url, source, activeTab.id ?? null, activeTab.favIconUrl || "");
    return true;
  } catch {
    return false;
  }
}

function scheduleActiveSessionAlarms(activeSession) {
  chrome.alarms.clear(SESSION_OVERRUN_ALARM);
  chrome.alarms.clear(SESSION_GOAL_REMINDER_ALARM);
  chrome.alarms.clear(SESSION_ENDING_SOON_ALARM);

  if (!activeSession?.id) return;

  const now = Date.now();
  const sessionStart = Number(activeSession.startTime || now);

  if (activeSession.goalSelectionMade !== true) {
    chrome.alarms.create(SESSION_GOAL_REMINDER_ALARM, {
      when: sessionStart + NO_GOAL_REMINDER_DELAY_MS
    });
  }

  if (activeSession.intendedMinutes != null) {
    const intendedMs = Number(activeSession.intendedMinutes || 0) * 60 * 1000;
    if (intendedMs > 0) {
      if (intendedMs > 2 * 60 * 1000) {
        chrome.alarms.create(SESSION_ENDING_SOON_ALARM, {
          when: sessionStart + intendedMs - 2 * 60 * 1000
        });
      }
      chrome.alarms.create(SESSION_OVERRUN_ALARM, {
        when: sessionStart + intendedMs
      });
    }
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      await logVisit(tab.url, "tab-switch", tabId, tab.favIconUrl || "");
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

  let favIconUrl = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    favIconUrl = tab?.favIconUrl || "";
  } catch {}

  await logVisit(details.url, source, details.tabId, favIconUrl);
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    ensureSessionMonitorAlarm();
    await loadInactivityThreshold();
    await refreshIdleState();
    await rebuildSessions();
    await rebuildAnalyticsSessions();
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    const activeTab = tabs?.[0];
    if (activeTab?.url) {
      await logVisit(activeTab.url, "browser-startup", activeTab.id, activeTab.favIconUrl || "");
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    ensureSessionMonitorAlarm();
    const {
      visits,
      sessions,
      activeSession,
      sessionIntents,
      lastUserActivityAt,
      inactivityThresholdMinutes,
      analyticsVisits,
      analyticsSessions,
      analyticsActiveSession,
      analyticsSessionIntents
    } =
      await chrome.storage.local.get([
        "visits",
        "sessions",
        "activeSession",
        "sessionIntents",
        "lastUserActivityAt",
        "inactivityThresholdMinutes",
        "analyticsVisits",
        "analyticsSessions",
        "analyticsActiveSession",
        "analyticsSessionIntents"
      ]);

    if (!visits) await chrome.storage.local.set({ visits: [] });
    if (!sessions) await chrome.storage.local.set({ sessions: [] });
    if (!activeSession) await chrome.storage.local.set({ activeSession: null });
    if (!sessionIntents) await chrome.storage.local.set({ sessionIntents: [] });
    if (!lastUserActivityAt) await chrome.storage.local.set({ lastUserActivityAt: Date.now() });
    if (!analyticsVisits) await chrome.storage.local.set({ analyticsVisits: visits || [] });
    if (!analyticsSessions) await chrome.storage.local.set({ analyticsSessions: sessions || [] });
    if (!analyticsActiveSession) await chrome.storage.local.set({ analyticsActiveSession: activeSession || null });
    if (!analyticsSessionIntents) {
      await chrome.storage.local.set({ analyticsSessionIntents: sessionIntents || [] });
    }
    if (inactivityThresholdMinutes == null) {
      await chrome.storage.local.set({ inactivityThresholdMinutes: DEFAULT_INACTIVITY_THRESHOLD_MINUTES });
    }
    await loadInactivityThreshold();
    await refreshIdleState();
    await rebuildSessions();
    await rebuildAnalyticsSessions();

    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    const activeTab = tabs?.[0];
    if (activeTab?.url) {
      await logVisit(activeTab.url, "extension-update", activeTab.id, activeTab.favIconUrl || "");
    }
  } catch {}
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === SESSION_MONITOR_ALARM) {
    runSessionMonitorTick().catch(() => {});
    return;
  }

  if (
    alarm?.name === SESSION_OVERRUN_ALARM ||
    alarm?.name === SESSION_GOAL_REMINDER_ALARM ||
    alarm?.name === SESSION_ENDING_SOON_ALARM
  ) {
    chrome.storage.local.get(["activeSession"]).then(({ activeSession }) => {
      if (alarm.name === SESSION_ENDING_SOON_ALARM) {
        return maybeNotifySessionEndingSoon(activeSession);
      }

      if (alarm.name === SESSION_OVERRUN_ALARM) {
        return maybeNotifySessionOverrun(activeSession);
      }

      return maybeNotifyMissingGoal(activeSession);
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "userActivity") {
    const ts = Number(msg.ts) || Date.now();
    browserIdleState = "active";
    (async () => {
      try {
        const resumed = await resumeSessionFromForegroundActivity(sender?.tab, ts);
        await setLastUserActivity(ts);
        if (!resumed) {
          await heartbeatActiveSession(ts);
          await markVisitInteraction(sender?.tab?.id, sender?.tab?.url, ts);
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "videoStatus") {
    (async () => {
      try {
        videoPlaying = msg.playing;
        if (msg.playing) {
          browserIdleState = "active";
          const ts = Number(msg.ts) || Date.now();
          await setLastUserActivity(ts);
          await heartbeatActiveSession(ts);
          await markVisitInteraction(sender?.tab?.id, sender?.tab?.url, ts);
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "rebuildSessions") {
    Promise.all([rebuildSessions(), rebuildAnalyticsSessions()])
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));

    return true;
  }

  if (msg.type === "testNotificationPreview") {
    const kind = msg.kind;
    let title = "Screen Time Momentum";
    let message = "Test notification.";

    if (kind === "endingSoon") {
      title = "Your session is ending soon";
      message = "You have about 2 minutes left before reaching your intended browsing duration.";
    } else if (kind === "overrun") {
      title = "Over intended time";
      message = "You have now exceeded your intended browsing duration.";
    } else if (kind === "missingGoal") {
      title = "No goal selected";
      message = "This current session has no goal. Start a new session to set a goal or choose No goal.";
    } else if (kind === "sessionEnded") {
      title = "Your session has ended";
      message = "This session ended because no activity was detected before your inactivity threshold.";
    }

    createBasicNotification(`test-preview-${kind}-${Date.now()}`, title, message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }

});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.inactivityThresholdMinutes) {
    const minutes = normalizeInactivityThresholdMinutes(changes.inactivityThresholdMinutes.newValue);
    inactivityThresholdMs = minutes * 60 * 1000;
    setIdleDetectionInterval();
    rebuildSessions().catch(() => {});
    rebuildAnalyticsSessions().catch(() => {});
  }

  if (changes.activeSession) {
    scheduleActiveSessionAlarms(changes.activeSession.newValue || null);
  }
});

ensureSessionMonitorAlarm();
chrome.storage.local.get(["activeSession"]).then(({ activeSession }) => {
  scheduleActiveSessionAlarms(activeSession || null);
}).catch(() => {});
loadInactivityThreshold().catch(() => {});
refreshIdleState().catch(() => {});

chrome.idle.onStateChanged.addListener((state) => {
  browserIdleState = state || "active";
  if (state === "active") {
    (async () => {
      await setLastUserActivity(Date.now());
      await resumeFromActiveTab("idle-resume");
    })().catch(() => {});
    return;
  }
  runSessionMonitorTick().catch(() => {});
});
