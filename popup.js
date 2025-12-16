// popup.js
// AtlasChat popup — controls engagement toggle, status display, and mode selection.

const toggleBtn = document.getElementById("toggle-btn");
const statusPill = document.getElementById("status-pill");
const modeGuardBtn = document.getElementById("mode-guard");
const modeDirectBtn = document.getElementById("mode-direct");
const modeValueLabel = document.getElementById("mode-value");

function setEnabledUI(enabled) {
  if (enabled) {
    statusPill.textContent = "Engaged";
    statusPill.classList.remove("status-off");
    statusPill.classList.add("status-on");

    toggleBtn.textContent = "Disengage AtlasChat";
    toggleBtn.classList.remove("btn-off");
    toggleBtn.classList.add("btn-on");
  } else {
    statusPill.textContent = "Disengaged";
    statusPill.classList.remove("status-on");
    statusPill.classList.add("status-off");

    toggleBtn.textContent = "Engage AtlasChat";
    toggleBtn.classList.remove("btn-on");
    toggleBtn.classList.add("btn-off");
  }
}

function setModeUI(mode) {
  const effective = mode === "direct" ? "direct" : "guard";

  if (!modeGuardBtn || !modeDirectBtn || !modeValueLabel) return;

  if (effective === "direct") {
    modeGuardBtn.classList.remove("mode-active");
    modeDirectBtn.classList.add("mode-active");
    modeValueLabel.textContent = "Direct";
    modeValueLabel.style.color = "#7ab0ff";
  } else {
    modeGuardBtn.classList.add("mode-active");
    modeDirectBtn.classList.remove("mode-active");
    modeValueLabel.textContent = "Guard";
    modeValueLabel.style.color = "#7af07a";
  }
}

// Ask background for current state on load
chrome.runtime.sendMessage({ type: "ATLASCHAT_GET_STATE" }, (response) => {
  const enabled = Boolean(response && response.enabled);
  const mode = response && response.mode === "direct" ? "direct" : "guard";

  setEnabledUI(enabled);
  setModeUI(mode);
});

// Wire click handler to toggle
toggleBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ATLASCHAT_TOGGLE" }, (response) => {
    const enabled = Boolean(response && response.enabled);
    setEnabledUI(enabled);
  });
});

// Mode button handlers
if (modeGuardBtn) {
  modeGuardBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage(
      { type: "ATLASCHAT_SET_MODE", mode: "guard" },
      (response) => {
        const mode = response && response.mode === "direct" ? "direct" : "guard";
        setModeUI(mode);
      }
    );
  });
}

if (modeDirectBtn) {
  modeDirectBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage(
      { type: "ATLASCHAT_SET_MODE", mode: "direct" },
      (response) => {
        const mode = response && response.mode === "direct" ? "direct" : "guard";
        setModeUI(mode);
      }
    );
  });
}
