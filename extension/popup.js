const HEALTH_URL = "http://127.0.0.1:43110/health";
const TOKEN_KEY = "ttli_token";

const form = document.querySelector("#token-form");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");

function setStatus(message) {
  status.textContent = message;
}

async function checkConnection() {
  setStatus("Проверка подключения…");

  try {
    const response = await fetch(HEALTH_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const health = await response.json();
    if (health.status !== "ok") {
      throw new Error("Unexpected health response");
    }

    setStatus("TTLI подключён");
  } catch {
    setStatus("TTLI не подключён. Запусти приложение и проверь привязку.");
  }
}

async function loadToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  if (typeof token === "string") {
    tokenInput.value = token;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  tokenInput.value = token;
  setStatus("Токен сохранён");
  await checkConnection();
});

void loadToken();
void checkConnection();
