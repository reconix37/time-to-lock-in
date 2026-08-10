const API_BASE = "http://127.0.0.1:43110";
const API_URL = `${API_BASE}/event`;
const REGISTER_URL = `${API_BASE}/register`;
const TOKEN_KEY = "ttli_token";
const PAIRED_KEY = "ttli_paired_id";
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

function browserName() {
  return navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
}

async function isPaired() {
  const stored = await chrome.storage.local.get(PAIRED_KEY);
  return stored[PAIRED_KEY] === chrome.runtime.id;
}

// Автоподключение: расширение само присылает свой ID; апка запоминает его.
// Токен обязателен — без него апка отвечает 401. Origin браузер подделать не даёт.
async function registerSelf() {
  const token = await readToken();
  if (!token) {
    return { ok: false, status: 401 };
  }

  try {
    const response = await fetch(REGISTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TTLI-Token": token,
        "X-TTLI-Extension-Id": chrome.runtime.id,
        "X-TTLI-Browser": browserName(),
      },
      body: "{}",
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    await chrome.storage.local.set({ [PAIRED_KEY]: chrome.runtime.id });
    return { ok: true, status: response.status };
  } catch {
    // Апка не запущена — ретраим при следующем событии.
    return { ok: false, status: 0 };
  }
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

      if (response.status === 401 || response.status === 403) {
        // Отвязали/сменили токен — следующий контакт перепривяжет.
        await chrome.storage.local.remove(PAIRED_KEY);
        return;
      }
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

  if (!(await isPaired())) {
    await registerSelf();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ttli-register") {
    registerSelf().then((result) => {
      sendResponse(result);
      if (result.ok) {
        queueCapture();
      }
    });
    return true; // асинхронный ответ
  }
  return undefined;
});

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
