let chooserMode = null;
const launchMode = new URLSearchParams(window.location.search).get("intent");
const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 10;
let inactivityThresholdMs = DEFAULT_INACTIVITY_THRESHOLD_MINUTES * 60 * 1000;
const sessionHelpers = window.ScreenTimeSessionHelpers || null;
const normalizeSessionName =
  sessionHelpers?.normalizeSessionName ||
  ((value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 80));
const saveIntentToActiveSession = sessionHelpers?.saveIntentToActiveSession || null;
const startManualSession = sessionHelpers?.startManualSession || null;
let popupFailed = false;
let refreshTimerId = null;
const RISK_SAMPLE_MIN = 3;

async function safeRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    const text = String(error?.message || error || "");
    if (text.includes("No SW") || text.includes("Receiving end does not exist")) {
      return null;
    }
    throw error;
  }
}

function showPopupError(message) {
  popupFailed = true;
  const heading = document.getElementById("popupHeading");
  const progressChart = document.getElementById("popupProgressChart");
  const chooser = document.getElementById("intentChooser");
  const actionButtons = [
    document.getElementById("openDashboard"),
    document.getElementById("stopSession"),
    document.getElementById("newSession"),
    document.getElementById("otherIntentBtn"),
    document.getElementById("applyOtherIntent")
  ];

  if (heading) heading.textContent = "Extension needs refresh";
  if (progressChart) {
    progressChart.innerHTML = `<div style="padding:16px;text-align:center;color:#6b7280;font-size:13px;">${message}</div>`;
  }
  if (chooser) chooser.hidden = true;
  actionButtons.forEach((button) => {
    if (button) button.disabled = true;
  });
  document.querySelectorAll(".intentOption").forEach((button) => {
    button.disabled = true;
  });

  if (refreshTimerId) {
    window.clearInterval(refreshTimerId);
    refreshTimerId = null;
  }
}

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

function isDisplayDomain(domain) {
  const value = String(domain || "").trim().toLowerCase();
  if (!value || value === "unknown") return false;
  if (
    value === "extensions" ||
    value === "new-tab-page" ||
    value === "chrome" ||
    value.startsWith("chrome:") ||
    value.startsWith("chrome-extension:") ||
    value.startsWith("devtools:") ||
    value.startsWith("about:")
  ) {
    return false;
  }
  return true;
}

function getSessionPrimaryDomain(session) {
  const entries = Object.entries(session?.metrics?.timePerDomain || {})
    .filter(([domain, ms]) => isDisplayDomain(domain) && Number(ms || 0) > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries[0]?.[0]) return entries[0][0];

  for (const visit of session?.visits || []) {
    if (isDisplayDomain(visit?.domain)) return visit.domain;
  }

  return "";
}

function getCurrentPrimaryDomain(activeSession, sessions) {
  const activeId = String(activeSession?.id || "");
  const matchingSession = (sessions || []).find((session) => {
    const visitSessionId = String(session?.visits?.[0]?.sessionId || session?.id || "");
    return activeId && visitSessionId === activeId;
  });

  if (matchingSession) return getSessionPrimaryDomain(matchingSession);
  const uniqueDomains = Array.isArray(activeSession?.uniqueDomains) ? activeSession.uniqueDomains : [];
  return uniqueDomains.find(isDisplayDomain) || "";
}

function bucketGoalMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 10) return "<10";
  if (value <= 15) return "10-15";
  if (value <= 30) return "16-30";
  if (value <= 60) return "31-60";
  return "60+";
}

function buildRiskCardCopy(activeSession, sessions) {
  if (!activeSession || activeSession?.intendedMinutes == null) {
    return null;
  }

  const meaningfulSessions = (sessions || []).filter((session) => {
    const metrics = session?.metrics || {};
    return Number(metrics?.intendedMinutes) > 0 && Number(metrics?.durationMs) > 0;
  });

  if (!meaningfulSessions.length) return null;

  const currentStart = Number(activeSession.startTime || Date.now());
  const currentHour = new Date(currentStart).getHours();
  const currentGoalMinutes = Number(activeSession.intendedMinutes || 0);
  const currentGoalBucket = bucketGoalMinutes(currentGoalMinutes);
  const currentPrimaryDomain = getCurrentPrimaryDomain(activeSession, meaningfulSessions);

  const computeRate = (list) => {
    const sample = list.length;
    if (!sample) return null;
    const overruns = list.filter((session) => Number(session?.metrics?.overrunMs || 0) > 0).length;
    return {
      sample,
      rate: overruns / sample
    };
  };

  const overall = computeRate(meaningfulSessions);
  if (!overall) return null;

  const eveningSessions = meaningfulSessions.filter((session) => {
    const start = Number(session?.metrics?.start || 0);
    return new Date(start).getHours() >= 21;
  });
  const hourWindowSessions = meaningfulSessions.filter((session) => {
    const start = Number(session?.metrics?.start || 0);
    const hour = new Date(start).getHours();
    return Math.abs(hour - currentHour) <= 1;
  });
  const goalBucketSessions = meaningfulSessions.filter((session) => {
    return bucketGoalMinutes(session?.metrics?.intendedMinutes) === currentGoalBucket;
  });
  const domainSessions = currentPrimaryDomain
    ? meaningfulSessions.filter((session) => getSessionPrimaryDomain(session) === currentPrimaryDomain)
    : [];

  const candidates = [];

  const addCandidate = (key, stats, reasonBuilder, weight = 1) => {
    if (!stats || stats.sample < RISK_SAMPLE_MIN) return;
    const lift = stats.rate - overall.rate;
    candidates.push({
      key,
      sample: stats.sample,
      rate: stats.rate,
      lift,
      score: stats.rate + Math.max(0, lift) + weight * 0.02,
      reasonBuilder
    });
  };

  addCandidate(
    "late",
    currentHour >= 21 ? computeRate(eveningSessions) : null,
    (stats) => `Your sessions after 9pm exceed your intended time ${Math.round(stats.rate * 100)}% of the time.`
  );
  addCandidate(
    "hour-window",
    computeRate(hourWindowSessions),
    (stats) => `Sessions that start around ${formatHourWindow(currentHour)} run over ${Math.round(stats.rate * 100)}% of the time for you.`
  );
  addCandidate(
    "goal-bucket",
    currentGoalBucket ? computeRate(goalBucketSessions) : null,
    (stats) => {
      if (currentGoalBucket === "<10") {
        return `Short intended sessions under 10 minutes run over ${Math.round(stats.rate * 100)}% of the time.`;
      }
      return `${formatGoalBucket(currentGoalBucket)} sessions run over ${Math.round(stats.rate * 100)}% of the time for you.`;
    },
    1.5
  );
  addCandidate(
    "domain",
    currentPrimaryDomain ? computeRate(domainSessions) : null,
    (stats) => `${formatDomainLabel(currentPrimaryDomain)} sessions run over ${Math.round(stats.rate * 100)}% of the time for you.`,
    1.25
  );

  const best = candidates.sort((a, b) => b.score - a.score || b.sample - a.sample)[0];
  const activeElapsedMs = Math.max(0, Date.now() - currentStart);
  const progressRatio = currentGoalMinutes > 0 ? activeElapsedMs / (currentGoalMinutes * 60 * 1000) : 0;

  let level = "low";
  let title = "Low overrun risk right now";
  let reason = `Sessions like this usually stay close to plan for you.`;

  if (best) {
    const highRisk = best.rate >= 0.65 || (best.lift >= 0.2 && best.sample >= 4);
    const mediumRisk = best.rate >= 0.45 || best.lift >= 0.1;

    if (highRisk) {
      level = "high";
      title = progressRatio >= 0.5 ? "This session is likely to run over" : "High overrun risk";
    } else if (mediumRisk) {
      level = "medium";
      title = progressRatio >= 0.5 ? "This session could drift long" : "Moderate overrun risk";
    }

    reason = best.reasonBuilder(best);
  } else if (overall.rate >= 0.55) {
    level = "medium";
    title = "This session could drift long";
    reason = `About ${Math.round(overall.rate * 100)}% of your goal-based sessions run over.`;
  }

  return { level, title, reason };
}

function formatGoalBucket(bucket) {
  switch (bucket) {
    case "<10":
      return "Short";
    case "10-15":
      return "10–15 minute";
    case "16-30":
      return "16–30 minute";
    case "31-60":
      return "31–60 minute";
    case "60+":
      return "Long";
    default:
      return "Similar";
  }
}

function formatHourWindow(hour) {
  const start = ((hour % 24) + 24) % 24;
  const end = (start + 1) % 24;
  return `${formatHourLabel(start)}–${formatHourLabel(end)}`;
}

function formatHourLabel(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? "pm" : "am";
  const twelveHour = normalized % 12 || 12;
  return `${twelveHour}${suffix}`;
}

function formatDomainLabel(domain) {
  const normalized = String(domain || "").replace(/^www\./, "");
  if (normalized === "docs.google.com") return "Google Docs";
  if (normalized === "chatgpt.com") return "ChatGPT";
  return normalized;
}

function renderPopupRisk(activeSession, sessions) {
  const card = document.getElementById("popupRiskCard");
  const levelNode = document.getElementById("popupRiskLevel");
  const titleNode = document.getElementById("popupRiskTitle");
  const reasonNode = document.getElementById("popupRiskReason");
  if (!card || !levelNode || !titleNode || !reasonNode) return;

  const risk = buildRiskCardCopy(activeSession, sessions);
  if (!risk) {
    card.hidden = true;
    return;
  }

  levelNode.textContent = risk.level.charAt(0).toUpperCase() + risk.level.slice(1);
  levelNode.className = `popupRiskLevel level-${risk.level}`;
  titleNode.textContent = risk.title;
  reasonNode.textContent = risk.reason;
  card.hidden = false;
}

function buildProgressSvg(valueLabel, goalLabel, ratio, hasGoal = true) {
  const size = 148;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, ratio)));
  const isOverGoal = hasGoal && ratio > 1;
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
  if (popupFailed) return;
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  const sessionName = currentSessionName();

  if (chooserMode === "manual") {
    if (!startManualSession) throw new Error("Session helpers are unavailable.");
    await startManualSession(minutes, sessionName);
  } else {
    if (!saveIntentToActiveSession) throw new Error("Session helpers are unavailable.");
    await saveIntentToActiveSession(minutes, sessionName);
  }

  hideChooser();
  await refresh();
  window.close();
}

async function stopSession() {
  if (popupFailed) return;
  const response = await safeRuntimeMessage({ type: "stopCurrentSession" });
  if (!response?.ok && !response?.stopped) {
    throw new Error("The extension lost connection.");
  }
  hideChooser();
  await refresh();
}

async function refresh() {
  if (popupFailed) return;
  await loadInactivityThreshold();
  const { activeSession, sessions = [] } = await chrome.storage.local.get(["activeSession", "sessions"]);
  const progressChart = document.getElementById("popupProgressChart");

  if (!activeSession) {
    progressChart.innerHTML = buildProgressSvg("0:00", "free", 0);
    renderPopupRisk(null, []);
    if (chooserMode !== "manual") {
      hideChooser();
    }
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
    ratio,
    goalMinutes != null
  );
  renderPopupRisk(activeSession, Array.isArray(sessions) ? sessions : []);

  if (activeSession.intendedMinutes != null && chooserMode !== "manual") {
    hideChooser();
  }
}

async function safeRefresh() {
  if (popupFailed) return;
  try {
    await refresh();
  } catch (error) {
    console.error("Popup refresh failed", error);
    showPopupError("The extension lost connection. Reload it in chrome://extensions and reopen the popup.");
  }
}

function bindPopupEvents() {
  document.getElementById("openDashboard").addEventListener("click", () => {
    if (popupFailed) return;
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  document.getElementById("newSession").addEventListener("click", () => {
    if (popupFailed) return;
    showChooser("manual");
  });

  document.getElementById("stopSession").addEventListener("click", async () => {
    await stopSession();
  });

  document.querySelectorAll(".intentOption").forEach((button) => {
    button.addEventListener("click", () => {
      if (popupFailed) return;
      submitIntent(button.dataset.noGoal ? null : Number(button.dataset.minutes));
    });
  });

  document.getElementById("otherIntentBtn").addEventListener("click", () => {
    if (popupFailed) return;
    document.getElementById("otherIntentInputWrap").hidden = false;
    document.getElementById("otherIntentInput").focus();
  });

  document.getElementById("applyOtherIntent").addEventListener("click", () => {
    if (popupFailed) return;
    const value = Number(document.getElementById("otherIntentInput").value.trim());
    submitIntent(value);
  });

  document.getElementById("otherIntentInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const value = Number(event.currentTarget.value.trim());
      submitIntent(value);
    }
  });
}

async function initPopup() {
  if (!sessionHelpers) {
    showPopupError("Reload the extension in chrome://extensions and reopen the popup.");
    return;
  }

  bindPopupEvents();
  await safeRefresh();

  if (launchMode === "manual" || launchMode === "auto") {
    showChooser(launchMode);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeSession || changes.inactivityThresholdMinutes) {
      safeRefresh();
    }
  });

  refreshTimerId = window.setInterval(safeRefresh, 1000);
}

initPopup().catch((error) => {
  console.error("Popup failed to initialize", error);
  showPopupError("Something went wrong while loading the popup. Try refreshing the extension.");
});
