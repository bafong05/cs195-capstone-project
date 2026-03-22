const mode = new URLSearchParams(window.location.search).get("mode") || "manual";

function applyCopy() {
  const eyebrow = document.getElementById("intentEyebrow");
  const title = document.getElementById("intentTitle");
  const hint = document.getElementById("intentHint");

  if (mode === "auto") {
    eyebrow.textContent = "Session resumed";
    title.textContent = "Choose intended duration";
    hint.textContent = "A new session started after inactivity. Select a goal to continue.";
    return;
  }

  eyebrow.textContent = "New session";
  title.textContent = "Choose intended duration";
  hint.textContent = "Select a goal to start this session.";
}

async function saveIntentToActiveSession(minutes) {
  const { activeSession, sessionIntents = [] } = await chrome.storage.local.get([
    "activeSession",
    "sessionIntents"
  ]);

  if (!activeSession) return false;

  const intents = Array.isArray(sessionIntents) ? sessionIntents.slice() : [];
  const filtered = intents.filter((intent) => intent.sessionId !== activeSession.id);

  await chrome.storage.local.set({
    activeSession: {
      ...activeSession,
      intendedMinutes: minutes
    },
    sessionIntents: minutes == null ? filtered : [...filtered, { sessionId: activeSession.id, intendedMinutes: minutes }]
  });

  chrome.runtime.sendMessage({ type: "rebuildSessions" }, () => {});
  return true;
}

async function startManualSession(minutes) {
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
  return true;
}

async function closeSelf() {
  const currentTab = await chrome.tabs.getCurrent();
  if (currentTab?.id) {
    await chrome.tabs.remove(currentTab.id);
    return;
  }

  window.close();
}

async function submitIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;

  if (mode === "auto") {
    await saveIntentToActiveSession(minutes);
  } else {
    await startManualSession(minutes);
  }

  await closeSelf();
}

document.querySelectorAll(".intentOption").forEach((button) => {
  button.addEventListener("click", () => {
    submitIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
  });
});

document.getElementById("applyOtherIntent").addEventListener("click", () => {
  const value = Number(document.getElementById("otherIntentInput").value.trim());
  submitIntent(value);
});

document.getElementById("otherIntentInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const value = Number(event.currentTarget.value.trim());
    submitIntent(value);
  }
});

applyCopy();
