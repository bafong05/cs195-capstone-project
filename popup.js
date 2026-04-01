let chooserMode = null;
const launchMode = new URLSearchParams(window.location.search).get("intent");
const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
const { normalizeSessionName, saveIntentToActiveSession, startManualSession } = window.ScreenTimeSessionHelpers;

function currentSessionName() {
  return normalizeSessionName(document.getElementById("sessionNameInput")?.value || "");
}

function normalizeInactivityThresholdMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_INACTIVITY_THRESHOLD_MINUTES;
  return Math.min(120, Math.max(1, Math.round(minutes)));
}

async function loadInactivityThreshold() {
  const { inactivityThresholdMinutes } = await chrome.storage.local.get(["inactivityThresholdMinutes"]);
  inactivityThresholdMs =
    normalizeInactivityThresholdMinutes(inactivityThresholdMinutes) * 60 * 1000;
}

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
  const sessionNameInput = document.getElementById("sessionNameInput");

  title.textContent =
    mode === "manual"
      ? "Choose intended duration for new session"
      : "Your session has expired. A new one is now starting.";
  chooser.hidden = false;
  otherWrap.hidden = true;
  otherInput.value = "";
  if (sessionNameInput) sessionNameInput.value = "";
}

function hideChooser() {
  chooserMode = null;
  document.getElementById("intentChooser").hidden = true;
  document.getElementById("otherIntentInputWrap").hidden = true;
  document.getElementById("otherIntentInput").value = "";
  const sessionNameInput = document.getElementById("sessionNameInput");
  if (sessionNameInput) sessionNameInput.value = "";
}

async function submitIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  const sessionName = currentSessionName();

  if (chooserMode === "manual") {
    await startManualSession(minutes, sessionName);
  } else {
    await saveIntentToActiveSession(minutes, sessionName);
  }

  hideChooser();
  await refresh();
  window.close();
}

async function refresh() {
  await loadInactivityThreshold();
  const { activeSession } = await chrome.storage.local.get(["activeSession"]);
  const progressChart = document.getElementById("popupProgressChart");

  if (!activeSession) {
    progressChart.innerHTML = buildProgressSvg("0:00", "free", 0);
    hideChooser();
    return;
  }

  const now = Date.now();
  const effectiveEndTime = now;
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
  if (changes.activeSession || changes.inactivityThresholdMinutes) refresh();
});
setInterval(refresh, 1000);
