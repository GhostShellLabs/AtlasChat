// background.js
// AtlasChat — background service worker
// Single source of truth for extension-wide state (enabled + mode)
// Modes: "guard" (default) and "direct"

const ATLAS_ENABLED_KEY = "atlasChatEnabled";
const ATLAS_MODE_KEY = "atlasChatMode";
const DEFAULT_MODE = "guard";

// Initialize default state on install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(
    {
      [ATLAS_ENABLED_KEY]: false,   // extension starts disengaged
      [ATLAS_MODE_KEY]: DEFAULT_MODE
    },
    () => {
      updateIcon(false);
      chrome.action.setTitle({ title: "AtlasChat: disengaged" });
    }
  );
});

// Central message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return; // ignore noise
  }

  switch (message.type) {
    case "ATLASCHAT_TOGGLE":
      handleToggle(sendResponse);
      return true; // async

    case "ATLASCHAT_GET_STATE":
      getExtensionState((state) => {
        sendResponse(state);
      });
      return true; // async

    case "ATLASCHAT_SET_MODE":
      handleSetMode(message.mode, sendResponse);
      return true; // async

    case "ATLASCHAT_PROCESS_PROMPT":
      handleProcessPrompt(message.text, message.mode, sendResponse);
      return true; // async

    default:
      // Unknown message type - ignore for now
      return;
  }
});

// --- State helpers --------------------------------------------------------

function getExtensionState(callback) {
  chrome.storage.local.get([ATLAS_ENABLED_KEY, ATLAS_MODE_KEY], (result) => {
    const enabled = Boolean(result[ATLAS_ENABLED_KEY]);
    const storedMode = result[ATLAS_MODE_KEY];
    const mode = storedMode === "direct" ? "direct" : DEFAULT_MODE;
    callback({ enabled, mode });
  });
}

function setEnabled(nextEnabled, callback) {
  chrome.storage.local.set({ [ATLAS_ENABLED_KEY]: nextEnabled }, () => {
    updateIcon(nextEnabled);
    chrome.action.setTitle({
      title: nextEnabled ? "AtlasChat: ENGAGED" : "AtlasChat: disengaged"
    });
    getExtensionState(callback);
  });
}

function setMode(nextMode, callback) {
  const mode = nextMode === "direct" ? "direct" : DEFAULT_MODE;
  chrome.storage.local.set({ [ATLAS_MODE_KEY]: mode }, () => {
    getExtensionState(callback);
  });
}

// --- Message handlers -----------------------------------------------------

function handleToggle(sendResponse) {
  chrome.storage.local.get([ATLAS_ENABLED_KEY], (result) => {
    const current = Boolean(result[ATLAS_ENABLED_KEY]);
    const next = !current;

    setEnabled(next, (state) => {
      sendResponse(state);
    });
  });
}

function handleSetMode(requestedMode, sendResponse) {
  setMode(requestedMode, (state) => {
    sendResponse(state);
  });
}

function handleProcessPrompt(rawText, modeOverride, sendResponse) {
  // Canonical error enum (v1.0):
  // EMPTY_PROMPT | ATLASCHAT_DISABLED | INVALID_STATE | TIMEOUT | RUNTIME_ERROR

  const text = typeof rawText === "string" ? rawText : "";

  if (!text.trim()) {
    sendResponse({ ok: false, error: "EMPTY_PROMPT" });
    return;
  }

  getExtensionState(({ enabled, mode }) => {
    if (!enabled) {
      sendResponse({ ok: false, error: "ATLASCHAT_DISABLED" });
      return;
    }

    const requested = (modeOverride === "direct" || modeOverride === "guard") ? modeOverride : null;
// Invalid or unknown mode defaults to DIRECT (safe fallback)

    const effectiveMode = requested ?? mode;

    if (effectiveMode === "guard") {
      console.log("[AC:MODE] Guard");

      const processed = applyGuardV1(text);
      sendResponse({
        ok: true,
        mode: "guard",
        text: processed
      });
    } else {
      console.log("[AC:MODE] Direct");

      const processed = applyDirectV1(text);
      sendResponse({
        ok: true,
        mode: "direct",
        text: processed
      });
    }
  });
}

// --- Mode implementations (v1 rules) -------------------------------------

// Guard Mode v1
// ALWAYS: clarify structure safely, preserve meaning, keep deterministic.
// NEVER: add new meaning, change tone substantially, expand intent.
function applyGuardV1(input) {
  const userText = String(input ?? "");

  // v1.6 Guard Mode (PME-style): rewrite-only wrapper
  // - We do NOT "auto-optimize" content inside the extension (minimizes meaning risk).
  // - Instead, we ask ChatGPT to produce a single execution-ready prompt inside ONE markdown code block.
  // - User can then Copy / Download / Execute (Direct Mode) via the content-script UI bar.

  // NOTE: We intentionally do not persist any prompt content in extension storage.

  const wrapper =
`[AtlasChat Guard Mode]

AtlasChat is optimizing your request for clarity, consistency, and safe execution.

Next steps:
1) Review the optimized prompt in the code block (in the assistant's response).
2) Click “Copy code”.
3) Paste it into the chat input.
4) Press Enter to execute.

Task:
Rewrite the user's request into an execution-ready prompt.

Rules:
- Preserve intent and tone.
- Resolve contradictions by making the prompt internally consistent.
- Do NOT add new meaning or expand scope.
- If questions are required, include them as TODO items INSIDE the prompt (do not ask outside the prompt).

Output requirements:
- Output ONLY ONE markdown code block containing the final optimized prompt.
- No commentary outside the code block.

User request:
<<<
${userText}
>>>`;

  return wrapper;
}

// Direct Mode v1
// ALWAYS: return prompt as-is (with basic string coercion).
// NEVER: rewrite, clarify, or change meaning.
function applyDirectV1(input) {
  return String(input ?? "");
}

// --- Icon / UI helpers ----------------------------------------------------

function updateIcon(enabled) {
  const iconBase = enabled ? "icon-green" : "icon-grey";

  chrome.action.setIcon({
    path: {
      16: `assets/${iconBase}-16.png`,
      32: `assets/${iconBase}-32.png`,
      48: `assets/${iconBase}-48.png`,
      128: `assets/${iconBase}-128.png`
    }
  });
}
