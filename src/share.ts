import { invoke } from "@tauri-apps/api/core";
import { toDataURL as qrToDataURL } from "qrcode";

export const INSTALL_URL = "https://github.com/reconix37/time-to-lock-in/releases/latest";

export interface KindLabels {
  useful: string;
  neutral: string;
  waste: string;
}

export interface DayPrintEntry {
  app: string;
  category_name: string;
  category_kind: "useful" | "neutral" | "waste";
  duration_ms: number;
}

export interface DayPrintData {
  local_date: string;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  observed_ms: number;
  useful_goal_min: number;
  waste_limit_min: number;
  observed_min: number;
  useful_passed: boolean;
  waste_passed: boolean;
  observed_passed: boolean;
  passed: boolean;
  public_xp: number;
  lifetime_xp: number;
  rank: string;
  burned_rubles: number | null;
  currency: string;
  top_entries: DayPrintEntry[];
  challenge_code: string | null;
  challenge_passed: boolean | null;
}

export interface WeekSummaryData {
  days: DayPrintData[];
  passed_count: number;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  week_xp: number;
  lifetime_xp: number;
  rank: string;
  strongest_day: string | null;
  waste_days: number;
  burned_rubles: number | null;
  currency: string;
}

interface SharePalette {
  background: string;
  text: string;
  muted: string;
  useful: string;
  neutral: string;
  waste: string;
  iris: string;
  border: string;
}

const WIDTH = 1080;
const HEIGHT = 1350;
const PADDING = 76;

function palette(): SharePalette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--term-bg"),
    text: token("--term-text"),
    muted: token("--term-muted"),
    useful: token("--cat-useful"),
    neutral: token("--cat-neutral"),
    waste: token("--cat-waste"),
    iris: token("--iris"),
    border: token("--hl-med"),
  };
}

function createCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D, SharePalette] {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas недоступен");
  const colors = palette();
  context.fillStyle = colors.background;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.textBaseline = "alphabetic";
  return [canvas, context, colors];
}

function font(context: CanvasRenderingContext2D, size: number, weight = 500): void {
  context.font = `${weight} ${size}px "JetBrains Mono", "Cascadia Mono", monospace`;
}

function minutes(milliseconds: number): number {
  return Math.floor(Math.max(0, milliseconds) / 60_000);
}

function duration(milliseconds: number): string {
  const total = minutes(milliseconds);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0 ? `${rest}м` : `${hours}ч ${rest}м`;
}

function dateLabel(localDate: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${localDate}T12:00:00`));
}

function divider(context: CanvasRenderingContext2D, colors: SharePalette, y: number): void {
  context.strokeStyle = colors.border;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(PADDING, y);
  context.lineTo(WIDTH - PADDING, y);
  context.stroke();
}

function fittedText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  const characters = Array.from(value);
  while (characters.length > 0 && context.measureText(`${characters.join("")}…`).width > maxWidth) {
    characters.pop();
  }
  return `${characters.join("")}…`;
}

function kindInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase("ru-RU") ?? "?";
}

function condition(
  context: CanvasRenderingContext2D,
  colors: SharePalette,
  y: number,
  label: string,
  value: number,
  threshold: number,
  passed: boolean,
  limit = false,
): void {
  context.fillStyle = passed ? colors.useful : colors.waste;
  font(context, 34, 700);
  context.fillText(passed ? "✓" : "×", PADDING, y);
  context.fillStyle = colors.text;
  font(context, 29);
  context.fillText(fittedText(context, label, 500), PADDING + 58, y);
  context.textAlign = "right";
  context.fillStyle = colors.muted;
  context.fillText(`${value}м ${limit ? "≤" : "≥"} ${threshold}м`, WIDTH - PADDING, y);
  context.textAlign = "left";
}

function categoryBars(
  context: CanvasRenderingContext2D,
  colors: SharePalette,
  values: Array<{ label: string; value: number; color: string }>,
  y: number,
): void {
  const max = Math.max(...values.map((item) => item.value), 1);
  values.forEach((item, index) => {
    const rowY = y + index * 72;
    context.fillStyle = colors.muted;
    font(context, 24);
    context.fillText(fittedText(context, item.label, 650), PADDING, rowY);
    context.textAlign = "right";
    context.fillStyle = colors.text;
    context.fillText(duration(item.value), WIDTH - PADDING, rowY);
    context.textAlign = "left";
    context.fillStyle = colors.border;
    context.fillRect(PADDING, rowY + 18, WIDTH - PADDING * 2, 13);
    context.fillStyle = item.color;
    context.fillRect(PADDING, rowY + 18, (WIDTH - PADDING * 2) * item.value / max, 13);
  });
}

async function qrImage(colors: SharePalette): Promise<HTMLImageElement> {
  const source = await qrToDataURL(INSTALL_URL, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: colors.text, light: colors.background },
  });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось создать QR-код"));
    image.src = source;
  });
}

async function footer(context: CanvasRenderingContext2D, colors: SharePalette): Promise<void> {
  const qr = await qrImage(colors);
  context.drawImage(qr, WIDTH - PADDING - 180, HEIGHT - PADDING - 180, 180, 180);
  context.fillStyle = colors.text;
  font(context, 25, 700);
  context.fillText("Tracked locally. No screenshots.", PADDING, HEIGHT - PADDING - 104);
  context.fillStyle = colors.muted;
  font(context, 18);
  context.fillText("github.com/reconix37/time-to-lock-in", PADDING, HEIGHT - PADDING - 62);
  context.fillText("TTLI // TIME TO LOCK IN", PADDING, HEIGHT - PADDING - 20);
}

export function challengeCode(day: DayPrintData): string {
  return `TF-${minutes(day.useful_ms)}-${minutes(day.waste_ms)}-${minutes(day.observed_ms)}`;
}

export async function renderDayPrintPng(day: DayPrintData, kindLabels: KindLabels): Promise<string> {
  const [canvas, context, colors] = createCanvas();
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText(`TIMEFORGE // DAILY LOG — ${day.local_date}`, PADDING, 90);
  context.fillStyle = day.passed ? colors.useful : colors.waste;
  font(context, 62, 700);
  context.fillText(day.passed ? "ДЕНЬ СИЛЫ" : "ДЕНЬ ЗОМБИ", PADDING, 176);
  context.fillStyle = colors.text;
  font(context, 27);
  context.fillText(`${day.rank} · +${day.public_xp.toLocaleString("ru-RU")} XP`, PADDING, 226);
  divider(context, colors, 266);

  condition(context, colors, 326, kindLabels.useful.toLocaleUpperCase("ru-RU"), minutes(day.useful_ms), day.useful_goal_min, day.useful_passed);
  condition(context, colors, 382, kindLabels.waste.toLocaleUpperCase("ru-RU"), minutes(day.waste_ms), day.waste_limit_min, day.waste_passed, true);
  condition(context, colors, 438, "НАБЛЮДЕНИЕ", minutes(day.observed_ms), day.observed_min, day.observed_passed);
  if (day.challenge_passed !== null) {
    context.fillStyle = day.challenge_passed ? colors.useful : colors.waste;
    font(context, 24, 700);
    context.fillText(`CHALLENGE ${day.challenge_passed ? "PASSED" : "FAILED"}`, PADDING, 492);
  }
  divider(context, colors, 528);
  categoryBars(context, colors, [
    { label: kindLabels.useful, value: day.useful_ms, color: colors.useful },
    { label: kindLabels.neutral, value: day.neutral_ms, color: colors.neutral },
    { label: kindLabels.waste, value: day.waste_ms, color: colors.waste },
  ], 582);

  let y = 828;
  if (day.top_entries.length > 0) {
    context.fillStyle = colors.muted;
    font(context, 19);
    context.fillText("TOP // ПРИЛОЖЕНИЕ · КАТЕГОРИЯ · ВРЕМЯ", PADDING, y);
    y += 42;
    for (const entry of day.top_entries.slice(0, 5)) {
      context.fillStyle = colors.text;
      font(context, 21);
      context.fillText(entry.app.replace(/\.exe$/i, "").slice(0, 25), PADDING, y);
      context.fillStyle = entry.category_kind === "useful" ? colors.useful : entry.category_kind === "waste" ? colors.waste : colors.neutral;
      context.fillText(entry.category_name.slice(0, 18), 410, y);
      context.textAlign = "right";
      context.fillStyle = colors.muted;
      context.fillText(duration(entry.duration_ms), WIDTH - PADDING, y);
      context.textAlign = "left";
      y += 38;
    }
  }
  if (day.burned_rubles !== null) {
    context.fillStyle = colors.waste;
    font(context, 25, 700);
    context.fillText(`СОЖЖЕНО ${day.currency} ${day.burned_rubles.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`, PADDING, 1090);
  }
  await footer(context, colors);
  return canvas.toDataURL("image/png");
}

export async function renderWeekPng(week: WeekSummaryData, kindLabels: KindLabels): Promise<string> {
  const [canvas, context, colors] = createCanvas();
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText("TIMEFORGE // WEEKLY RANK", PADDING, 90);
  context.fillStyle = colors.text;
  font(context, 58, 700);
  context.fillText(`ЗАЧТЕНО ${week.passed_count}/7`, PADDING, 174);
  context.fillStyle = colors.iris;
  font(context, 27);
  context.fillText(`${week.rank} · +${week.week_xp.toLocaleString("ru-RU")} XP за неделю`, PADDING, 224);
  divider(context, colors, 266);

  week.days.forEach((day, index) => {
    const y = 322 + index * 78;
    context.fillStyle = day.passed ? colors.useful : colors.waste;
    font(context, 27, 700);
    context.fillText(day.passed ? "✓" : "×", PADDING, y);
    context.fillStyle = colors.text;
    font(context, 25);
    context.fillText(dateLabel(day.local_date, { weekday: "short", day: "2-digit", month: "2-digit" }), PADDING + 52, y);
    context.fillStyle = colors.useful;
    context.fillText(`${kindInitial(kindLabels.useful)} ${duration(day.useful_ms)}`, 350, y);
    context.fillStyle = colors.waste;
    context.fillText(`${kindInitial(kindLabels.waste)} ${duration(day.waste_ms)}`, 510, y);
    context.fillStyle = colors.neutral;
    context.fillText(`Н ${duration(day.observed_ms)}`, 670, y);
    context.textAlign = "right";
    context.fillStyle = colors.muted;
    context.fillText(day.passed ? "ДЕНЬ СИЛЫ" : "ДЕНЬ ЗОМБИ", WIDTH - PADDING, y);
    context.textAlign = "left";
  });
  divider(context, colors, 894);
  context.fillStyle = colors.text;
  font(context, 29, 700);
  context.fillText(fittedText(context, `${kindLabels.useful.toLocaleUpperCase("ru-RU")} ${duration(week.useful_ms)}`, WIDTH - PADDING * 2), PADDING, 954);
  context.fillStyle = colors.waste;
  context.fillText(fittedText(context, `${kindLabels.waste.toLocaleUpperCase("ru-RU")} ${duration(week.waste_ms)}`, WIDTH - PADDING * 2), PADDING, 1002);
  context.fillStyle = colors.muted;
  font(context, 23);
  const strongest = week.strongest_day
    ? dateLabel(week.strongest_day, { weekday: "long", day: "numeric", month: "long" })
    : "—";
  context.fillText(`Самый сильный день: ${strongest}`, PADDING, 1052);
  context.fillText(`Слито рабочих дней: ${week.waste_days}`, PADDING, 1092);
  if (week.burned_rubles !== null) {
    context.fillStyle = colors.waste;
    context.fillText(`Сожжено ${week.currency} ${week.burned_rubles.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`, PADDING, 1132);
  }
  await footer(context, colors);
  return canvas.toDataURL("image/png");
}

export async function renderChallengePng(day: DayPrintData, kindLabels: KindLabels): Promise<string> {
  const [canvas, context, colors] = createCanvas();
  const code = challengeCode(day);
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText("TIMEFORGE // LOCAL CHALLENGE", PADDING, 90);
  context.fillStyle = colors.text;
  font(context, 65, 700);
  context.fillText("ПОБЕЙ МОЙ ДЕНЬ", PADDING, 190);
  context.fillStyle = colors.iris;
  font(context, 38, 700);
  context.fillText(code, PADDING, 264);
  divider(context, colors, 314);
  context.fillStyle = colors.muted;
  font(context, 23);
  context.fillText("ТРИ УСЛОВИЯ", PADDING, 374);
  condition(context, colors, 448, kindLabels.useful.toLocaleUpperCase("ru-RU"), minutes(day.useful_ms), minutes(day.useful_ms), true);
  condition(context, colors, 516, kindLabels.waste.toLocaleUpperCase("ru-RU"), minutes(day.waste_ms), minutes(day.waste_ms), true, true);
  condition(context, colors, 584, "НАБЛЮДЕНИЕ", minutes(day.observed_ms), minutes(day.observed_ms), true);
  divider(context, colors, 636);
  context.fillStyle = colors.text;
  font(context, 31, 700);
  context.fillText(`РЕЗУЛЬТАТ: ${day.passed ? "ДЕНЬ СИЛЫ" : "ДЕНЬ ЗОМБИ"}`, PADDING, 708);
  context.fillStyle = colors.muted;
  font(context, 25);
  context.fillText(`${day.rank} · ${day.public_xp} Public XP`, PADDING, 756);
  context.fillText("Вставь код в настройках TTLI.", PADDING, 850);
  context.fillText("Три числа. Никаких аккаунтов и личности.", PADDING, 892);
  await footer(context, colors);
  return canvas.toDataURL("image/png");
}

export async function savePng(dataUrl: string, fileName: string): Promise<boolean> {
  const response = await fetch(dataUrl);
  const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
  return invoke<boolean>("save_png", { fileName, pngBytes: bytes });
}
