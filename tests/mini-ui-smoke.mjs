import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const baseUrl = process.env.TTLI_TEST_URL ?? "http://127.0.0.1:4173";
const chromePath = process.env.TTLI_CHROMIUM ?? "/snap/bin/chromium";
const languages = ["ru", "ua", "en"];
const textSizes = ["normal", "large"];
const viewports = [[300, 228], [340, 252], [390, 280], [480, 340]];

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address) server.close(() => resolve(address.port));
  });
});

const chrome = spawn(chromePath, [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  `--remote-debugging-port=${port}`,
  "about:blank",
], { stdio: "ignore" });

async function waitForChrome() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chromium may need a moment to expose its debugging endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chromium debugging endpoint did not start");
}

async function openSession(url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  assert.equal(response.ok, true, `Could not open ${url}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error" && !message.params.entry.url?.endsWith("/favicon.ico")) {
      errors.push(message.params.entry.text);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    sequence += 1;
    pending.set(sequence, { resolve, reject });
    socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  return { socket, send, errors, targetId: target.id };
}

function layoutExpression() {
  const visible = (element) => element && getComputedStyle(element).display !== "none";
  const rect = (element) => element.getBoundingClientRect();
  const inside = (child, parent) => {
    const a = rect(child);
    const b = rect(parent);
    return a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
  };
  const overlaps = (first, second) => {
    const a = rect(first);
    const b = rect(second);
    return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  };
  const shell = document.querySelector(".mini-shell");
  const body = document.querySelector(".mini-body");
  const headerStatus = document.querySelector(".mini-header-status");
  const headerControls = document.querySelector(".mini-header-controls");
  const footerStats = document.querySelector(".mini-footer-stats");
  const footerButtons = document.querySelector(".mini-footer-buttons");
  const bodyRows = [...document.querySelectorAll(".mini-score-hero, .mini-top-categories, .mini-metrics, .mini-current")].filter(visible);
  const failures = [];
  if (!shell || !body) failures.push(`mini shell did not render (${document.readyState}): ${performance.getEntriesByType("resource").map((entry) => entry.name).join(", ")}`);
  if (document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight) failures.push("viewport scrollbar");
  if (shell && (shell.scrollWidth > shell.clientWidth || shell.scrollHeight > shell.clientHeight)) failures.push("shell clipping");
  if (body && (body.scrollWidth > body.clientWidth || body.scrollHeight > body.clientHeight)) failures.push("body clipping");
  for (const element of [...document.querySelectorAll(".mini-icon-button")]) {
    if (shell && !inside(element, shell)) failures.push("header button outside shell");
  }
  if (headerStatus && headerControls && overlaps(headerStatus, headerControls)) failures.push("header controls overlap brand");
  if (footerStats && footerButtons && overlaps(footerStats, footerButtons)) failures.push("footer controls overlap stats");
  for (const row of bodyRows) {
    if (body && !inside(row, body)) failures.push(`${row.className} outside body`);
  }
  for (let left = 0; left < bodyRows.length; left += 1) {
    for (let right = left + 1; right < bodyRows.length; right += 1) {
      if (overlaps(bodyRows[left], bodyRows[right])) failures.push(`${bodyRows[left].className} overlaps ${bodyRows[right].className}`);
    }
  }
  return failures;
}

try {
  await waitForChrome();
  let scenarios = 0;
  for (const language of languages) {
    for (const textSize of textSizes) {
      for (const [width, height] of viewports) {
        const url = `${baseUrl}/mini-test.html?lang=${language}&large=${textSize === "large" ? "1" : "0"}`;
        const session = await openSession(url);
        try {
          await session.send("Page.enable");
          await session.send("Runtime.enable");
          await session.send("Log.enable");
          const effectiveWidth = textSize === "large" ? Math.max(width, 340) : width;
          const effectiveHeight = textSize === "large" ? Math.max(height, 252) : height;
          await session.send("Emulation.setDeviceMetricsOverride", { width: effectiveWidth, height: effectiveHeight, deviceScaleFactor: 1, mobile: false });
          await session.send("Page.navigate", { url });
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const ready = await session.send("Runtime.evaluate", { expression: "Boolean(document.querySelector('.mini-shell') && document.querySelector('.mini-current.tone-useful') && !document.querySelector('.mini-loading'))", returnByValue: true });
            if (ready.result.value) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const evaluation = await session.send("Runtime.evaluate", {
            expression: `(${layoutExpression.toString()})()`,
            returnByValue: true,
          });
          const failures = [...session.errors, ...(evaluation.result.value ?? [])];
          assert.deepEqual(failures, [], `${language}/${textSize}/${width}x${height}: ${failures.join(", ")}`);
          scenarios += 1;
          console.log(`ok ${scenarios} - ${language}/${textSize}/${width}x${height}`);
        } finally {
          session.socket.close();
          await fetch(`http://127.0.0.1:${port}/json/close/${session.targetId}`);
        }
      }
    }
  }
  console.log(`mini-ui smoke: ${scenarios} scenarios passed`);
} finally {
  chrome.kill("SIGTERM");
}
