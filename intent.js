const mode = new URLSearchParams(window.location.search).get("mode") || "manual";
const sessionHelpers = window.ScreenTimeSessionHelpers || null;
const normalizeSessionName =
  sessionHelpers?.normalizeSessionName ||
  ((value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 80));
const saveIntentToActiveSession = sessionHelpers?.saveIntentToActiveSession || null;
const startManualSession = sessionHelpers?.startManualSession || null;
let intentSubmitted = false;
let dismissingAutoPrompt = false;
let autoDismissTimer = null;
let autoPromptDismissNotified = false;
let selectedReflection = "";
let selectedOverrunAction = "";
let selectedExtensionMinutes = 0;

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

function safeRuntimeSignal(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
}

if (document.body) {
  document.body.classList.toggle("is-overrun", mode === "overrun");
}

function getReflectionValue() {
  if (selectedReflection !== "Other") return selectedReflection;
  const otherValue = String(document.getElementById("overrunOtherReasonInput")?.value || "").trim();
  return otherValue;
}

function showIntentError(message) {
  const shell = document.querySelector(".intentShell");
  if (!shell) return;

  shell.innerHTML = `
    <section class="intentCard">
      <div class="intentEyebrow">Extension needs refresh</div>
      <h1>Session chooser unavailable</h1>
      <p class="intentHint">${message}</p>
    </section>
  `;
}

function currentSessionName() {
  return normalizeSessionName(document.getElementById("sessionNameInput")?.value || "");
}

function setInlineError(message) {
  const node = document.getElementById("intentInlineError");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
}

function updateOverrunStepState() {
  const reflectionOptions = document.getElementById("reflectionOptions");
  const otherReasonWrap = document.getElementById("overrunOtherReason");
  const submitButton = document.getElementById("applyOverrunDecisionButton");
  const reflectionLabel = document.getElementById("reflectionLabel");
  const hasAction = Boolean(selectedOverrunAction);

  reflectionOptions?.classList.toggle("is-disabled", !hasAction);
  if (otherReasonWrap) {
    otherReasonWrap.classList.toggle("is-disabled", !hasAction);
  }
  if (reflectionLabel) {
    reflectionLabel.textContent = hasAction
      ? "Why are you extending or ending?"
      : "Choose an action first";
  }
  if (submitButton) {
    submitButton.disabled = !hasAction;
  }
}

function toggleOtherReasonVisibility() {
  const otherWrap = document.getElementById("overrunOtherReason");
  const otherInput = document.getElementById("overrunOtherReasonInput");
  if (!otherWrap) return;
  otherWrap.hidden = selectedReflection !== "Other";
  if (selectedReflection !== "Other" && otherInput) {
    otherInput.value = "";
  }
}

function applyCopy(overrunState = null) {
  const eyebrow = document.getElementById("intentEyebrow");
  const title = document.getElementById("intentTitle");
  const hint = document.getElementById("intentHint");
  const sessionNameSection = document.getElementById("sessionNameSection");
  const optionsSection = document.getElementById("intentOptions");
  const otherSection = document.getElementById("otherIntentSection");
  const overrunSection = document.getElementById("overrunSection");

  eyebrow.hidden = false;
  hint.hidden = false;

  if (mode === "overrun") {
    eyebrow.textContent = "Time limit reached";
    title.textContent = "Do you want to keep going intentionally?";
    hint.textContent = "Your session has passed its planned limit. Choose the next step before continuing.";

    sessionNameSection.hidden = true;
    optionsSection.hidden = true;
    otherSection.hidden = true;
    overrunSection.hidden = false;
    return;
  }

  eyebrow.textContent = "New Session";
  hint.textContent = "A new session started after inactivity. Select a goal to continue.";
  title.textContent = "Choose intended duration for new session";
  sessionNameSection.hidden = false;
  optionsSection.hidden = false;
  otherSection.hidden = false;
  overrunSection.hidden = true;
}

async function closeSelf() {
  const currentTab = await chrome.tabs.getCurrent();
  if (currentTab?.id) {
    await chrome.tabs.remove(currentTab.id);
    return;
  }

  window.close();
}

async function closeAllIntentWindows() {
  const intentBaseUrl = chrome.runtime.getURL("intent.html");
  const windows = await chrome.windows.getAll({ populate: true });
  const tabIds = [];

  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab?.id && tab?.url && tab.url.startsWith(intentBaseUrl)) {
        tabIds.push(tab.id);
      }
    }
  }

  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
      return;
    } catch {}
  }

  await closeSelf();
}

async function submitIntent(minutes) {
  if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) return;
  intentSubmitted = true;
  const sessionName = currentSessionName();

  if (mode === "auto") {
    if (!saveIntentToActiveSession) throw new Error("Session helpers are unavailable.");
    await saveIntentToActiveSession(minutes, sessionName);
  } else {
    if (!startManualSession) throw new Error("Session helpers are unavailable.");
    await startManualSession(minutes, sessionName);
  }

  await closeAllIntentWindows();
}

async function submitOverrunDecision(action, extensionMinutes = 0) {
  const reflection = getReflectionValue();
  if (!selectedReflection) {
    setInlineError("Choose a quick reflection first.");
    return;
  }
  if (selectedReflection === "Other" && !reflection) {
    setInlineError("Add a short reason for \"Other.\"");
    return;
  }

  intentSubmitted = true;
  setInlineError("");

  const response = await safeRuntimeMessage({
    type: "applyOverrunDecision",
    action,
    extensionMinutes,
    reflection
  });

  if (!response?.ok) {
    intentSubmitted = false;
    setInlineError(response?.error || "Could not update the session. Reload the extension and try again.");
    return;
  }

  await closeAllIntentWindows();
}

function selectOverrunAction(action, extensionMinutes = 0) {
  selectedOverrunAction = String(action || "").trim();
  selectedExtensionMinutes = Number(extensionMinutes || 0);
  setInlineError("");
  document.querySelectorAll(".overrunAction").forEach((button) => {
    const buttonAction = String(button.dataset.overrunAction || "");
    const buttonMinutes = Number(button.dataset.extensionMinutes || 0);
    const isSelected =
      buttonAction === selectedOverrunAction &&
      (selectedOverrunAction !== "extend" || buttonMinutes === selectedExtensionMinutes);
    button.classList.toggle("is-selected", isSelected);
  });
  updateOverrunStepState();
}

async function submitOtherExtensionMinutes() {
  const input = document.getElementById("overrunOtherMinutesInput");
  const value = Number(String(input?.value || "").trim());
  if (!Number.isFinite(value) || value <= 0) {
    setInlineError("Enter how many minutes you want to add.");
    return;
  }
  selectOverrunAction("extend", value);
}

async function dismissAutoPromptWithoutSelection() {
  if (mode !== "auto" || intentSubmitted || dismissingAutoPrompt) return;
  dismissingAutoPrompt = true;

  try {
    await safeRuntimeMessage({ type: "dismissPendingAutoResumePrompt" });
    autoPromptDismissNotified = true;
  } catch {}

  await closeAllIntentWindows();
}

function scheduleAutoDismissIfIgnored() {
  if (mode !== "auto" || intentSubmitted || dismissingAutoPrompt) return;
  window.clearTimeout(autoDismissTimer);
  autoDismissTimer = window.setTimeout(() => {
    if (!document.hasFocus()) {
      dismissAutoPromptWithoutSelection().catch(() => {});
    }
  }, 2000);
}

function cancelAutoDismiss() {
  if (autoDismissTimer) {
    window.clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

function notifyAutoPromptDismissed() {
  if (mode !== "auto" || intentSubmitted || autoPromptDismissNotified) return;
  autoPromptDismissNotified = true;
  safeRuntimeSignal({ type: "dismissPendingAutoResumePrompt" });
}

function notifyOverrunPromptDismissed() {
  if (mode !== "overrun" || intentSubmitted) return;
  safeRuntimeSignal({ type: "dismissOverrunPrompt" });
}

function bindIntentEvents() {
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

  document.querySelectorAll(".reflectionOption").forEach((button) => {
    button.addEventListener("click", () => {
      if (!selectedOverrunAction) {
        setInlineError("Choose how you want to continue first.");
        return;
      }
      selectedReflection = String(button.dataset.reflection || "");
      setInlineError("");
      const otherInput = document.getElementById("overrunOtherReasonInput");
      toggleOtherReasonVisibility();
      if (selectedReflection === "Other" && otherInput) {
        window.setTimeout(() => otherInput.focus(), 0);
      }
      document.querySelectorAll(".reflectionOption").forEach((node) => {
        node.classList.toggle("is-selected", node === button);
      });
    });
  });

  document.getElementById("overrunOtherReasonInput")?.addEventListener("input", () => {
    if (selectedReflection === "Other") {
      setInlineError("");
    }
  });

  document.getElementById("applyOverrunOtherMinutes")?.addEventListener("click", () => {
    submitOtherExtensionMinutes();
  });

  document.getElementById("overrunOtherMinutesInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitOtherExtensionMinutes();
    }
  });

  document.querySelectorAll(".overrunAction").forEach((button) => {
    button.addEventListener("click", () => {
      const action = String(button.dataset.overrunAction || "");
      const extensionMinutes = Number(button.dataset.extensionMinutes || 0);
      selectOverrunAction(action, extensionMinutes);
    });
  });

  document.getElementById("applyOverrunDecisionButton")?.addEventListener("click", () => {
    if (!selectedOverrunAction) {
      setInlineError("Choose how you want to continue first.");
      return;
    }
    submitOverrunDecision(selectedOverrunAction, selectedExtensionMinutes);
  });
}

async function initIntentPage() {
  if (!sessionHelpers) {
    showIntentError("Reload the extension in chrome://extensions and reopen this window.");
    return;
  }

  let overrunState = null;
  if (mode === "overrun") {
    try {
      overrunState = await safeRuntimeMessage({ type: "getOverrunPromptState" });
    } catch {}
    if (!overrunState?.ok) {
      showIntentError(overrunState?.error || "There is no active overrun session to review.");
      return;
    }
  }

  applyCopy(overrunState);
  toggleOtherReasonVisibility();
  updateOverrunStepState();
  bindIntentEvents();

  if (mode === "auto") {
    window.addEventListener("blur", scheduleAutoDismissIfIgnored);
    window.addEventListener("focus", cancelAutoDismiss);
    window.addEventListener("pagehide", notifyAutoPromptDismissed);
    window.addEventListener("beforeunload", notifyAutoPromptDismissed);
  } else if (mode === "overrun") {
    window.addEventListener("pagehide", notifyOverrunPromptDismissed);
    window.addEventListener("beforeunload", notifyOverrunPromptDismissed);
  }
}

initIntentPage().catch((error) => {
  console.error("Intent popup failed to initialize", error);
  showIntentError("Something went wrong while loading the session chooser. Try refreshing the extension.");
});
