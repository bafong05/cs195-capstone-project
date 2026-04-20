(function () {
  function safeBackgroundSignal(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
  }

  function normalizeSessionName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  function buildIntentRecord(sessionId, minutes, sessionName, extras = {}) {
    if (minutes == null && !sessionName) return null;
    return {
      sessionId,
      intendedMinutes: minutes,
      sessionName,
      initialIntendedMinutes:
        extras.initialIntendedMinutes != null
          ? Number(extras.initialIntendedMinutes)
          : (minutes == null ? null : Number(minutes)),
      totalExtendedMinutes: Math.max(0, Number(extras.totalExtendedMinutes || 0)),
      startTime: extras.startTime != null ? Number(extras.startTime) : undefined
    };
  }

  function toDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || "unknown";
    } catch {
      return "unknown";
    }
  }

  async function saveIntentToActiveSession(minutes, sessionName = "") {
    const {
      activeSession,
      analyticsActiveSession,
      pendingAutoResume,
      sessionIntents = [],
      analyticsSessionIntents = []
    } = await chrome.storage.local.get([
      "activeSession",
      "analyticsActiveSession",
      "pendingAutoResume",
      "sessionIntents",
      "analyticsSessionIntents"
    ]);

    const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
    const analyticsIntents = Array.isArray(analyticsSessionIntents) ? analyticsSessionIntents.slice() : [];
    const normalizedName = normalizeSessionName(sessionName);

    if (!activeSession && pendingAutoResume?.url) {
      const now = Date.now();
      const sessionId = `${now}`;
      const domain = toDomain(pendingAutoResume.url);
      const newSession = {
        id: sessionId,
        startTime: now,
        lastEventTime: now,
        uniqueDomains: domain && domain !== "unknown" ? [domain] : [],
        visitCount: 1,
        intendedMinutes: minutes,
        initialIntendedMinutes: minutes == null ? null : Number(minutes),
        totalExtendedMinutes: 0,
        sessionName: normalizedName,
        goalSelectionMade: true,
        autoIntentPrompted: false
      };
      const newVisit = {
        url: pendingAutoResume.url,
        domain,
        time: now,
        lastActiveTime: now,
        source: pendingAutoResume.source || "activity-resume",
        tabId: pendingAutoResume.tabId ?? null,
        favIconUrl: pendingAutoResume.favIconUrl || "",
        hadInteraction: true,
        firstInteractionTime: now,
        sessionId
      };

      const { visits = [], analyticsVisits = [] } = await chrome.storage.local.get(["visits", "analyticsVisits"]);
      const nextIntent = buildIntentRecord(sessionId, minutes, normalizedName, {
        initialIntendedMinutes: minutes,
        totalExtendedMinutes: 0,
        startTime: now
      });
      const filtered = intents.filter((intent) => intent.sessionId !== sessionId);
      const filteredAnalytics = analyticsIntents.filter((intent) => intent.sessionId !== sessionId);

      await chrome.storage.local.set({
        visits: [...visits, newVisit],
        analyticsVisits: [...analyticsVisits, { ...newVisit }],
        activeSession: newSession,
        analyticsActiveSession: { ...newSession },
        pendingAutoResume: null,
        awaitingResumeIntent: false,
        sessionIntents: nextIntent ? [...filtered, nextIntent] : filtered,
        analyticsSessionIntents: nextIntent ? [...filteredAnalytics, nextIntent] : filteredAnalytics,
        lastUserActivityAt: now
      });

      safeBackgroundSignal({ type: "rebuildSessions" });
      return true;
    }

    if (!activeSession) return false;

    const filtered = intents.filter((intent) => intent.sessionId !== activeSession.id);
    const filteredAnalytics = analyticsIntents.filter((intent) => intent.sessionId !== activeSession.id);
    const nextIntent = buildIntentRecord(activeSession.id, minutes, normalizedName, {
      initialIntendedMinutes:
        activeSession.initialIntendedMinutes != null
          ? Number(activeSession.initialIntendedMinutes)
          : (minutes == null ? null : Number(minutes)),
      totalExtendedMinutes: Math.max(0, Number(activeSession.totalExtendedMinutes || 0)),
      startTime: activeSession.startTime
    });

    await chrome.storage.local.set({
      activeSession: {
        ...activeSession,
        intendedMinutes: minutes,
        initialIntendedMinutes:
          activeSession.initialIntendedMinutes != null
            ? Number(activeSession.initialIntendedMinutes)
            : (minutes == null ? null : Number(minutes)),
        totalExtendedMinutes: Math.max(0, Number(activeSession.totalExtendedMinutes || 0)),
        sessionName: normalizedName,
        goalSelectionMade: true,
        autoIntentPrompted: false
      },
      analyticsActiveSession:
        analyticsActiveSession?.id === activeSession.id
          ? {
              ...analyticsActiveSession,
              intendedMinutes: minutes,
              initialIntendedMinutes:
                analyticsActiveSession.initialIntendedMinutes != null
                  ? Number(analyticsActiveSession.initialIntendedMinutes)
                  : (
                      activeSession.initialIntendedMinutes != null
                        ? Number(activeSession.initialIntendedMinutes)
                        : (minutes == null ? null : Number(minutes))
                    ),
              totalExtendedMinutes: Math.max(
                0,
                Number(
                  analyticsActiveSession.totalExtendedMinutes ??
                  activeSession.totalExtendedMinutes ??
                  0
                )
              ),
              sessionName: normalizedName,
              goalSelectionMade: true,
              autoIntentPrompted: false
            }
          : analyticsActiveSession,
      pendingAutoResume: null,
      awaitingResumeIntent: false,
      sessionIntents: nextIntent ? [...filtered, nextIntent] : filtered,
      analyticsSessionIntents: nextIntent ? [...filteredAnalytics, nextIntent] : filteredAnalytics
    });

    safeBackgroundSignal({ type: "rebuildSessions" });
    return true;
  }

  async function startManualSession(minutes, sessionName = "") {
    const now = Date.now();
    const normalizedName = normalizeSessionName(sessionName);
    const pendingManualSession = {
      id: `${now}`,
      createdAt: now,
      intendedMinutes: minutes,
      initialIntendedMinutes: minutes == null ? null : Number(minutes),
      totalExtendedMinutes: 0,
      sessionName: normalizedName,
      goalSelectionMade: true
    };

    const {
      sessionIntents = [],
      analyticsSessionIntents = []
    } = await chrome.storage.local.get([
      "sessionIntents",
      "analyticsSessionIntents"
    ]);

    const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
    const analyticsIntents = Array.isArray(analyticsSessionIntents) ? analyticsSessionIntents.slice() : [];
    const filtered = intents.filter((intent) => intent.sessionId !== pendingManualSession.id);
    const filteredAnalytics = analyticsIntents.filter((intent) => intent.sessionId !== pendingManualSession.id);
    const nextIntent = buildIntentRecord(pendingManualSession.id, minutes, normalizedName, {
      initialIntendedMinutes: minutes,
      totalExtendedMinutes: 0,
      startTime: now
    });

    await chrome.storage.local.set({
      activeSession: null,
      analyticsActiveSession: null,
      pendingManualSession,
      pendingAutoResume: null,
      awaitingResumeIntent: false,
      sessionIntents: nextIntent ? [...filtered, nextIntent] : filtered,
      analyticsSessionIntents: nextIntent ? [...filteredAnalytics, nextIntent] : filteredAnalytics
    });

    safeBackgroundSignal({ type: "rebuildSessions" });
    return pendingManualSession;
  }

  window.ScreenTimeSessionHelpers = {
    normalizeSessionName,
    buildIntentRecord,
    saveIntentToActiveSession,
    startManualSession
  };
})();
