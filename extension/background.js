const API_URL = "http://127.0.0.1:43110/event";
const TOKEN_KEY = "ttli_token";
const DEBOUNCE_MS = 2_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

const recentEvents = new Map();
let captureQueue = Promise.resolve();

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function truncate(value, maxLength) {
  return Array.from(value).slice(0, maxLength).join("");
}

function tabEvent(tab) {
  if (!tab?.url || !tab.title) {
    return null;
  }

  try {
    const parsedUrl = new URL(tab.url);
    if (!parsedUrl.hostname) {
      return null;
    }

    return {
      ts: Date.now(),
      domain: truncate(parsedUrl.hostname.toLowerCase(), 253),
      title: truncate(tab.title, 500),
    };
  } catch {
    return null;
  }
}

function isDebounced(event) {
  const now = Date.now();
  const key = `${event.domain}\u0000${event.title}`;

  for (const [storedKey, sentAt] of recentEvents) {
    if (now - sentAt >= DEBOUNCE_MS) {
      recentEvents.delete(storedKey);
    }
  }

  if (recentEvents.has(key)) {
    return true;
  }

  recentEvents.set(key, now);
  return false;
}

async function readToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === "string" ? token.trim() : "";
}

async function postEvent(event, token) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TTLI-Token": token,
        },
        body: JSON.stringify(event),
      });

      if (response.ok || response.status < 500) {
        return;
      }
    } catch {
      // Сетевые ошибки обрабатываются тем же ограниченным retry.
    }

    if (attempt < MAX_ATTEMPTS) {
      await wait(RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

async function captureActiveTab() {
  const token = await readToken();
  if (!token) {
    return;
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const event = tabEvent(tab);

  if (!event || isDebounced(event)) {
    return;
  }

  await postEvent(event, token);
}

function queueCapture() {
  captureQueue = captureQueue.then(captureActiveTab, captureActiveTab);
}

chrome.tabs.onActivated.addListener(queueCapture);

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.status === "complete" ||
    Object.hasOwn(changeInfo, "url") ||
    Object.hasOwn(changeInfo, "title")
  ) {
    queueCapture();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    queueCapture();
  }
});

chrome.runtime.onStartup.addListener(queueCapture);
chrome.runtime.onInstalled.addListener(queueCapture);
