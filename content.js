
// AtlasChat content script

// v1.10: Integrated structured PME responses, enforced Guard Mode behavior, and improved response handling

// NOTE: Guard-mode wrapper branding updated in background.js (no 'PME' in user-facing output).

//

// Responsibilities:
// - Only activate on ChatGPT domains
// - Capture Enter (no Shift) at CAPTURE phase to govern sends
// - In Guard mode: wrap user text with the Guard prompt wrapper (handled by background.js)
// - In Direct mode: send exactly what user typed (handled by background.js)

// Safety: If anything fails, we fall back and do not break the page.

const ATLAS_ENABLED_KEY = "atlasChatEnabled";
const ATLAS_MODE_KEY = "atlasChatMode";

let atlasChatEnabled = false;
let atlasChatMode = "guard";

// Runtime state (must be releasable / idempotent)
let promptEl = null;
let isProcessing = false;
let skipNextIntercept = false;
let promptWatchTimer = null;
let promptWatchAttempts = 0;
let keyListenerAttached = false;
let routeWatcherInstalled = false;

// Hard timeout (ms) for background processing; prevents "stuck in Guard/markdown lock"
const REWRITE_TIMEOUT_MS = 2500;

(function bootstrap() {
  const host = window.location.host || "";
  const isChatGPTHost = host.includes("chat.openai.com") || host.includes("chatgpt.com");
  if (!isChatGPTHost) return;

  console.log("[AtlasChat] v1.10 content LOADED on:", window.location.href);

  // SPA route watcher (ChatGPT navigates without full reload)
  installRouteWatcher();

  // Load initial state, then init
  chrome.storage.local.get([ATLAS_ENABLED_KEY, ATLAS_MODE_KEY], (result) => {
    atlasChatEnabled = Boolean(result[ATLAS_ENABLED_KEY]);
    atlasChatMode = result[ATLAS_MODE_KEY] === "direct" ? "direct" : "guard";
    initOrRelease("bootstrap");
  });

  // React to state changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const enabledChanged = Boolean(changes[ATLAS_ENABLED_KEY]);
    const modeChanged = Boolean(changes[ATLAS_MODE_KEY]);

    if (enabledChanged) atlasChatEnabled = Boolean(changes[ATLAS_ENABLED_KEY].newValue);
    if (modeChanged) atlasChatMode = changes[ATLAS_MODE_KEY].newValue === "direct" ? "direct" : "guard";

    // Any meaningful change: hard release then re-init as needed.
    initOrRelease("storage-change");
  });
})();

function initOrRelease(reason) {
  // Always start clean; prevents stacked listeners/observers or hung state across refreshes.
  release(reason);

  if (!atlasChatEnabled) {
    console.log("[AtlasChat] Disabled. Released hooks. Reason:", reason);
    return;
  }

  // Attach capture listener (fires before ChatGPT/ProseMirror handlers)
  if (!keyListenerAttached) {
    document.addEventListener("keydown", onDocumentKeyDownCapture, true);
    keyListenerAttached = true;
  }

  startPromptWatcher();
  console.log("[AC:INIT] Enabled. Mode:", atlasChatMode, "Reason:", reason);
}

function release(reason) {
  // Idempotent: safe to call repeatedly.
  try {
    // Stop prompt watcher interval
    if (promptWatchTimer) {
      window.clearInterval(promptWatchTimer);
      promptWatchTimer = null;
      promptWatchAttempts = 0;
    }

    // Detach key listener
    if (keyListenerAttached) {
      document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
      keyListenerAttached = false;
    }

    // Reset runtime flags
    promptEl = null;
    isProcessing = false;
    skipNextIntercept = false;

    // Optional: you can log with reason for diagnostics
    if (reason) console.log("[AC:RELEASE] complete. Reason:", reason);
  } catch (e) {
    console.warn("[AtlasChat] RELEASE error (non-fatal):", e);
  }
}

function installRouteWatcher() {
  if (routeWatcherInstalled) return;
  routeWatcherInstalled = true;

  const onRouteChange = () => {
    // Route changes can replace the composer DOM node; release + re-init prevents ghost hooks.
    initOrRelease("route-change");
  };

  // Patch history methods (best-effort; do not break page if it fails)
  try {
    const _pushState = history.pushState;
    history.pushState = function (...args) {
      const ret = _pushState.apply(this, args);
      window.setTimeout(onRouteChange, 0);
      return ret;
    };

    const _replaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = _replaceState.apply(this, args);
      window.setTimeout(onRouteChange, 0);
      return ret;
    };
  } catch (e) {
    console.warn("[AtlasChat] Could not patch history (non-fatal):", e);
  }

  window.addEventListener("popstate", () => window.setTimeout(onRouteChange, 0), false);
}

function startPromptWatcher() {
  const intervalMs = 500;
  const maxAttempts = 120; // 60 seconds

  promptWatchAttempts = 0;

  promptWatchTimer = window.setInterval(() => {
    promptWatchAttempts += 1;

    const el = findPromptElement();
    if (el) {
      promptEl = el;
      window.clearInterval(promptWatchTimer);
      promptWatchTimer = null;

      console.log("[AtlasChat] Attached to prompt:", promptEl);
      return;
    }

    if (promptWatchAttempts >= maxAttempts) {
      window.clearInterval(promptWatchTimer);
      promptWatchTimer = null;
      console.warn("[AtlasChat] Could not locate prompt element after 60s.");
    }
  }, intervalMs);
}

function ensurePromptElement() {
  // ChatGPT can replace the composer DOM node between sends.
  // If our cached promptEl is disconnected, re-acquire it.
  try {
    if (!promptEl || !(promptEl.isConnected || document.contains(promptEl))) {
      promptEl = findPromptElement();
    }
  } catch (_) {
    promptEl = findPromptElement();
  }
  return promptEl;
}

function findPromptElement() {
  // ChatGPT ProseMirror prompt
  let el = document.querySelector("div#prompt-textarea[contenteditable='true']");
  if (el) return el;

  // Generic id fallback
  el = document.querySelector("[id='prompt-textarea'][contenteditable='true']");
  if (el) return el;

  // Legacy textarea path
  el = document.querySelector("textarea[data-testid='prompt-textarea']");
  if (el) return el;

  const allTextareas = document.querySelectorAll("textarea");
  if (allTextareas.length > 0) return allTextareas[allTextareas.length - 1];

  return null;
}

function isEventFromPrompt(event) {
  if (!promptEl) return false;

  const t = event.target;
  if (!t) return false;

  // Direct match
  if (t === promptEl) return true;

  // If the target is inside the prompt
  if (promptEl.contains(t)) return true;

  // If active element is the prompt (or inside it)
  const ae = document.activeElement;
  if (ae && (ae === promptEl || promptEl.contains(ae))) return true;

  // If the target has a closest prompt ancestor
  if (typeof t.closest === "function") {
    const closest = t.closest("#prompt-textarea");
    if (closest && closest === promptEl) return true;
  }

  return false;
}

async function onDocumentKeyDownCapture(event) {
  // Only intercept Enter submit (no Shift)
  if (event.key !== "Enter" || event.shiftKey) return;

  // Ignore IME composition
  if (event.isComposing) return;

  if (skipNextIntercept) {
    skipNextIntercept = false;
    return;
  }

  if (!atlasChatEnabled) return;

  try {
    ensurePromptElement();
    if (!promptEl) return;

    if (!isEventFromPrompt(event)) return;

    // Prevent ChatGPT from handling this Enter.
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    if (isProcessing) return;

    const originalText = getPromptText(promptEl);
    if (!originalText.trim()) return;

    isProcessing = true;

    console.log("[AtlasChat] Intercepted Enter. Mode:", atlasChatMode, "Text:", originalText);

    // Hard timeout protection: never hang the UI in guarded mode.
    const response = await withTimeout(
      processWithAtlasChat(originalText, atlasChatMode),
      REWRITE_TIMEOUT_MS
    );

    isProcessing = false;

    if (!response || !response.ok) {
      console.warn("[AC:PIPELINE_FAIL]", response && response.error);
// Non-blocking user signal (best-effort)
chrome.runtime.sendMessage({ type: "ATLASCHAT_PIPELINE_ERROR", error: response && response.error });


      // Fail-safe: send original text (un-governed) instead of trapping the user.
      setPromptText(promptEl, originalText);

      window.setTimeout(() => {
        skipNextIntercept = true;
        triggerSend();
      }, 25);

      return;
    }

    const finalText = response.text || originalText;
    console.log("[AtlasChat] Process OK. Final:", finalText);

    setPromptText(promptEl, finalText);

    // Let React/ProseMirror digest input before clicking send.
    window.setTimeout(() => {
      skipNextIntercept = true;
      triggerSend();
    }, 25);
  } catch (err) {
    isProcessing = false;
    console.error("[AtlasChat] Intercept error:", err);

    // Absolute fail-safe: release hooks so we never trap the page.
    // (User can re-enable from popup if needed.)
    initOrRelease("intercept-error");
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;

    const t = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "TIMEOUT" });
    }, ms);

    Promise.resolve(promise)
      .then((v) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        resolve({ ok: false, error: "EXCEPTION", detail: String(e && e.message ? e.message : e) });
      });
  });
}

function getPromptText(el) {
  if (!el) return "";
  if (el instanceof HTMLTextAreaElement) return el.value || "";
  if (el.isContentEditable) return (el.innerText || el.textContent || "");
  return el.value || el.textContent || "";
}

function setPromptText(el, text) {
  if (!el) return;

  // Textarea: set value + input event
  if (el instanceof HTMLTextAreaElement) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // ProseMirror / contenteditable: use execCommand insertText to update editor state.
  if (el.isContentEditable) {
    el.focus();

    // Select all existing content inside the editor.
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();

    const range = document.createRange();
    range.selectNodeContents(el);
    if (sel) sel.addRange(range);

    // Replace with governed text.
    document.execCommand("insertText", false, text);

    // Fire input event (some builds still rely on it)
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // Fallback
  if ("value" in el) el.value = text;
  else el.textContent = text;

  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function processWithAtlasChat(text, modeOverride) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "ATLASCHAT_PROCESS_PROMPT", text, mode: modeOverride },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("[AtlasChat] runtime error:", chrome.runtime.lastError);
          resolve({ ok: false, error: "RUNTIME_ERROR" });
          return;
        }
        resolve(response);
      }
    );
  });
}

function triggerSend() {
  // ChatGPT can re-render the composer and buttons. Refresh references.
  ensurePromptElement();

  const sendButton =
    document.querySelector("button[data-testid='send-button']") ||
    document.querySelector("button[aria-label='Send message']") ||
    document.querySelector("button[aria-label='Send']");

  if (sendButton && !sendButton.disabled) {
    sendButton.click();
    return;
  }

  // Fallback: synthesize Enter on the prompt element
  if (promptEl) {
    const evtInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
    promptEl.dispatchEvent(new KeyboardEvent("keydown", evtInit));
    promptEl.dispatchEvent(new KeyboardEvent("keypress", evtInit));
    promptEl.dispatchEvent(new KeyboardEvent("keyup", evtInit));
  }
}
