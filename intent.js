const mode = new URLSearchParams(window.location.search).get("mode") || "manual";
const { normalizeSessionName, saveIntentToActiveSession, startManualSession } = window.ScreenTimeSessionHelpers;

function currentSessionName() {
  return normalizeSessionName(document.getElementById("sessionNameInput")?.value || "");
}

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
  const sessionName = currentSessionName();

  if (mode === "auto") {
    await saveIntentToActiveSession(minutes, sessionName);
  } else {
    await startManualSession(minutes, sessionName);
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
