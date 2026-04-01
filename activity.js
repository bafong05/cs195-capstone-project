const ACTIVITY_REPORT_INTERVAL_MS = 250;
let lastReportedActivityAt = 0;
let lastPointerX = null;
let lastPointerY = null;

function persistActivity(now, source) {
  try {
    chrome.storage.local.set({ lastUserActivityAt: now }, () => {});
  } catch {}

  try {
    chrome.runtime.sendMessage({
      type: "userActivity",
      ts: now,
      source
    }, () => {});
  } catch {}
}

function reportActivity(source) {
  const now = Date.now();
  if (now - lastReportedActivityAt < ACTIVITY_REPORT_INTERVAL_MS) return;
  lastReportedActivityAt = now;
  persistActivity(now, source);
}

function handlePointerMove(event) {
  const nextX = Number(event.clientX);
  const nextY = Number(event.clientY);
  const moved = nextX !== lastPointerX || nextY !== lastPointerY;
  lastPointerX = nextX;
  lastPointerY = nextY;
  if (moved) {
    reportActivity("cursor");
  }
}

[
  "pointermove",
  "mousemove"
].forEach((eventName) => {
  window.addEventListener(eventName, handlePointerMove, { capture: true, passive: true });
  document.addEventListener(eventName, handlePointerMove, { capture: true, passive: true });
});

[
  "pointerdown",
  "click",
  "keydown",
  "input",
  "scroll",
  "wheel"
].forEach((eventName) => {
  window.addEventListener(eventName, () => reportActivity(eventName), { capture: true, passive: true });
  document.addEventListener(eventName, () => reportActivity(eventName), { capture: true, passive: true });
});

window.addEventListener("focus", () => reportActivity("focus"), { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reportActivity("visibilitychange");
  }
});
