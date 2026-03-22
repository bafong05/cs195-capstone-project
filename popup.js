let chooserMode = null;
const launchMode = new URLSearchParams(window.location.search).get("intent");
const INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;

if (launchMode === "manual" || launchMode === "auto") {
  document.body.classList.add("chooserOnly");
  document.getElementById("popupHeading").hidden = true;
}

function fmtElapsed(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildProgressSvg(valueLabel, goalLabel, ratio) {
  const size = 148;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  const isOverGoal = ratio > 1;
  const accent = isOverGoal ? "#dc2626" : "#7d34d8";
  const track = isOverGoal ? "rgba(220, 38, 38, 0.12)" : "rgba(125, 52, 216, 0.12)";

  return `
    <svg class="popupProgressSvg" viewBox="0 0 ${size} ${size}" role="img">
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
      <text class="popupProgressValue" x="${cx}" y="${cy + 4}">${valueLabel}</text>
      <text class="popupProgressGoal" x="${cx}" y="${cy + 24}">/ ${goalLabel}</text>
    </svg>
  `;
}

function showChooser(mode) {
  chooserMode = mode;
  const chooser = document.getElementById("intentChooser");
  const title = document.getElementById("chooserTitle");
  const otherWrap = document.getElementById("otherIntentInputWrap");
  const otherInput = document.getElementById("otherIntentInput");

  title.textContent =
    mode === "manual" ? "Choose intended duration for new session" : "Set intended duration";
  chooser.hidden = false;
  otherWrap.hidden = true;
  otherInput.value = "";
}

function hideChooser() {
  chooserMode = null;
  document.getElementById("intentChooser").hidden = true;
  document.getElementById("otherIntentInputWrap").hidden = true;
  document.getElementById("otherIntentInput").value = "";
}

async function saveIntentToActiveSession(minutes) {
  const { activeSession, sessionIntents = [] } = await chrome.storage.local.get([
    "activeSession",
    "sessionIntents"
  ]);

  if (!activeSession) return;

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
}

async function submitIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;

  if (chooserMode === "manual") {
    await startManualSession(minutes);
  } else {
    await saveIntentToActiveSession(minutes);
  }

  hideChooser();
  await refresh();
  window.close();
}

async function refresh() {
  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  const progressChart = document.getElementById("popupProgressChart");

  if (!activeSession) {
    progressChart.innerHTML = buildProgressSvg("0:00", "free", 0);
    hideChooser();
    return;
  }

  const now = Date.now();
  const idleMs = now - (activeSession.lastEventTime || activeSession.startTime);
  const effectiveEndTime = idleMs > INACTIVITY_THRESHOLD_MS
    ? (activeSession.lastEventTime || activeSession.startTime)
    : now;
  const elapsedMs = Math.max(0, effectiveEndTime - activeSession.startTime);
  const goalMinutes = activeSession.intendedMinutes;
  const ringBasisMinutes = goalMinutes || 30;
  const ratio = elapsedMs / (ringBasisMinutes * 60 * 1000);
  progressChart.innerHTML = buildProgressSvg(
    fmtElapsed(elapsedMs),
    goalMinutes ? `${goalMinutes}m` : "free",
    ratio
  );

  if (activeSession.intendedMinutes != null && chooserMode !== "manual") {
    hideChooser();
  }
}

document.getElementById("openDashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

document.getElementById("newSession").addEventListener("click", () => {
  showChooser("manual");
});

document.querySelectorAll(".intentOption").forEach((button) => {
  button.addEventListener("click", () => {
    submitIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
  });
});

document.getElementById("otherIntentBtn").addEventListener("click", () => {
  document.getElementById("otherIntentInputWrap").hidden = false;
  document.getElementById("otherIntentInput").focus();
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

refresh();
if (launchMode === "manual" || launchMode === "auto") {
  showChooser(launchMode);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.activeSession) refresh();
});
setInterval(refresh, 1000);
