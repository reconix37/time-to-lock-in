const TOKEN_KEY = "ttli_token";

const form = document.querySelector("#token-form");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");

function setStatus(message) {
  status.textContent = message;
}

// Проверка через /register: 200 = подключён И привязан (токен валиден),
// 401 = токен не подходит, сетевая ошибка = приложение не запущено.
async function checkConnection() {
  setStatus("Проверка подключения…");

  try {
    const response = await chrome.runtime.sendMessage({ type: "ttli-register" });
    if (response?.ok === true) {
      setStatus("TTLI подключён");
    } else if (response?.status === 401) {
      setStatus("Токен не подходит. Скопируй его из настроек приложения.");
    } else if (response?.status === 0) {
      setStatus("TTLI не подключён. Запусти приложение и попробуй ещё раз.");
    } else {
      setStatus("TTLI отклонил привязку. Проверь расширение и попробуй ещё раз.");
    }
  } catch {
    setStatus("TTLI не подключён. Запусти приложение и попробуй ещё раз.");
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
  setStatus("Токен сохранён, привязываю…");
  await checkConnection();
});

void loadToken();
void checkConnection();
