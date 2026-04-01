(function () {
  function normalizeSessionName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  function buildIntentRecord(sessionId, minutes, sessionName) {
    if (minutes == null && !sessionName) return null;
    return {
      sessionId,
      intendedMinutes: minutes,
      sessionName
    };
  }

  async function saveIntentToActiveSession(minutes, sessionName = "") {
    const {
      activeSession,
      analyticsActiveSession,
      sessionIntents = [],
      analyticsSessionIntents = []
    } = await chrome.storage.local.get([
      "activeSession",
      "analyticsActiveSession",
      "sessionIntents",
      "analyticsSessionIntents"
    ]);

    if (!activeSession) return false;

    const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
    const analyticsIntents = Array.isArray(analyticsSessionIntents) ? analyticsSessionIntents.slice() : [];
    const filtered = intents.filter((intent) => intent.sessionId !== activeSession.id);
    const filteredAnalytics = analyticsIntents.filter((intent) => intent.sessionId !== activeSession.id);
    const normalizedName = normalizeSessionName(sessionName);
    const nextIntent = buildIntentRecord(activeSession.id, minutes, normalizedName);

    await chrome.storage.local.set({
      activeSession: {
        ...activeSession,
        intendedMinutes: minutes,
        sessionName: normalizedName,
        goalSelectionMade: true
      },
      analyticsActiveSession:
        analyticsActiveSession?.id === activeSession.id
          ? { ...analyticsActiveSession, intendedMinutes: minutes, sessionName: normalizedName, goalSelectionMade: true }
          : analyticsActiveSession,
      sessionIntents: nextIntent ? [...filtered, nextIntent] : filtered,
      analyticsSessionIntents: nextIntent ? [...filteredAnalytics, nextIntent] : filteredAnalytics
    });

    chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
    return true;
  }

  async function startManualSession(minutes, sessionName = "") {
    const now = Date.now();
    const normalizedName = normalizeSessionName(sessionName);
    const newSession = {
      id: `${now}`,
      startTime: now,
      lastEventTime: now,
      uniqueDomains: [],
      visitCount: 0,
      intendedMinutes: minutes,
      sessionName: normalizedName,
      goalSelectionMade: true
    };

    const {
      manualSessionStarts = [],
      sessionIntents = [],
      analyticsSessionIntents = []
    } = await chrome.storage.local.get([
      "manualSessionStarts",
      "sessionIntents",
      "analyticsSessionIntents"
    ]);

    const updatedStarts = Array.isArray(manualSessionStarts) ? manualSessionStarts.slice() : [];
    updatedStarts.push(now);

    const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
    const analyticsIntents = Array.isArray(analyticsSessionIntents) ? analyticsSessionIntents.slice() : [];
    const filtered = intents.filter((intent) => intent.sessionId !== newSession.id);
    const filteredAnalytics = analyticsIntents.filter((intent) => intent.sessionId !== newSession.id);
    const nextIntent = buildIntentRecord(newSession.id, minutes, normalizedName);

    await chrome.storage.local.set({
      activeSession: newSession,
      analyticsActiveSession: newSession,
      manualSessionStarts: updatedStarts,
      sessionIntents: nextIntent ? [...filtered, nextIntent] : filtered,
      analyticsSessionIntents: nextIntent ? [...filteredAnalytics, nextIntent] : filteredAnalytics
    });

    chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
    return newSession;
  }

  window.ScreenTimeSessionHelpers = {
    normalizeSessionName,
    buildIntentRecord,
    saveIntentToActiveSession,
    startManualSession
  };
})();
