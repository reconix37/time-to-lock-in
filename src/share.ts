import { invoke } from "@tauri-apps/api/core";
import { toDataURL as qrToDataURL } from "qrcode";
import { localeForLang, translate, type Lang, type Translate, type TranslateVars } from "./i18n";

export const INSTALL_URL = "https://github.com/reconix37/time-to-lock-in/releases/latest";

export interface KindLabels {
  useful: string;
  neutral: string;
  waste: string;
  observed: string;
}

export interface DayPrintEntry {
  app: string;
  category_name: string;
  category_kind: "useful" | "neutral" | "waste";
  is_uncategorized: boolean;
  duration_ms: number;
}

export interface DayPrintData {
  local_date: string;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  afk_ms: number;
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
  afk_ms: number;
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

function createCanvas(t: Translate): [HTMLCanvasElement, CanvasRenderingContext2D, SharePalette] {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("error.canvas"));
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

function duration(milliseconds: number, t: Translate): string {
  const total = minutes(milliseconds);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0
    ? t("duration.minutes", { minutes: rest })
    : t("duration.hoursMinutes", { hours, minutes: rest });
}

function dateLabel(localDate: string, options: Intl.DateTimeFormatOptions, lang: Lang): string {
  return new Intl.DateTimeFormat(localeForLang(lang), options).format(new Date(`${localDate}T12:00:00`));
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

function kindInitial(label: string, lang: Lang): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase(localeForLang(lang)) ?? "?";
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
  t?: Translate,
): void {
  context.fillStyle = passed ? colors.useful : colors.waste;
  font(context, 34, 700);
  context.fillText(passed ? "✓" : "×", PADDING, y);
  context.fillStyle = colors.text;
  font(context, 29);
  context.fillText(fittedText(context, label, 500), PADDING + 58, y);
  context.textAlign = "right";
  context.fillStyle = colors.muted;
  const unit = t?.("common.minutesShort") ?? "m";
  context.fillText(`${value}${unit} ${limit ? "≤" : "≥"} ${threshold}${unit}`, WIDTH - PADDING, y);
  context.textAlign = "left";
}

function categoryBars(
  context: CanvasRenderingContext2D,
  colors: SharePalette,
  values: Array<{ label: string; value: number; color: string }>,
  y: number,
  t: Translate,
): void {
  const max = Math.max(...values.map((item) => item.value), 1);
  values.forEach((item, index) => {
    const rowY = y + index * 72;
    context.fillStyle = colors.muted;
    font(context, 24);
    context.fillText(fittedText(context, item.label, 650), PADDING, rowY);
    context.textAlign = "right";
    context.fillStyle = colors.text;
    context.fillText(duration(item.value, t), WIDTH - PADDING, rowY);
    context.textAlign = "left";
    context.fillStyle = colors.border;
    context.fillRect(PADDING, rowY + 18, WIDTH - PADDING * 2, 13);
    context.fillStyle = item.color;
    context.fillRect(PADDING, rowY + 18, (WIDTH - PADDING * 2) * item.value / max, 13);
  });
}

async function qrImage(colors: SharePalette, t: Translate): Promise<HTMLImageElement> {
  const source = await qrToDataURL(INSTALL_URL, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: colors.text, light: colors.background },
  });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("error.qr")));
    image.src = source;
  });
}

async function footer(context: CanvasRenderingContext2D, colors: SharePalette, t: Translate): Promise<void> {
  const qr = await qrImage(colors, t);
  context.drawImage(qr, WIDTH - PADDING - 180, HEIGHT - PADDING - 180, 180, 180);
  context.fillStyle = colors.text;
  font(context, 25, 700);
  context.fillText(t("print.privacy"), PADDING, HEIGHT - PADDING - 104);
  context.fillStyle = colors.muted;
  font(context, 18);
  context.fillText("github.com/reconix37/time-to-lock-in", PADDING, HEIGHT - PADDING - 62);
  context.fillText("TTLI // TIME TO LOCK IN", PADDING, HEIGHT - PADDING - 20);
}

export function challengeCode(day: DayPrintData): string {
  return `TF-${minutes(day.useful_ms)}-${minutes(day.waste_ms)}-${minutes(day.observed_ms)}`;
}

function translator(lang: Lang): Translate {
  return (key: string, vars?: TranslateVars) => translate(lang, key, vars);
}

export async function renderDayPrintPng(day: DayPrintData, kindLabels: KindLabels, lang: Lang): Promise<string> {
  const t = translator(lang);
  const locale = localeForLang(lang);
  const [canvas, context, colors] = createCanvas(t);
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText(t("print.dailyLog", { date: dateLabel(day.local_date, { day: "2-digit", month: "2-digit", year: "numeric" }, lang) }), PADDING, 90);
  context.fillStyle = day.passed ? colors.useful : colors.waste;
  font(context, 62, 700);
  context.fillText(day.passed ? t("print.statusPassed") : t("print.statusFailed"), PADDING, 176);
  context.fillStyle = colors.text;
  font(context, 27);
  context.fillText(`${day.rank} · +${day.public_xp.toLocaleString(locale)} XP`, PADDING, 226);
  divider(context, colors, 266);

  condition(context, colors, 326, kindLabels.useful.toLocaleUpperCase(locale), minutes(day.useful_ms), day.useful_goal_min, day.useful_passed, false, t);
  condition(context, colors, 382, kindLabels.waste.toLocaleUpperCase(locale), minutes(day.waste_ms), day.waste_limit_min, day.waste_passed, true, t);
  condition(context, colors, 438, kindLabels.observed.toLocaleUpperCase(locale), minutes(day.observed_ms), day.observed_min, day.observed_passed, false, t);
  if (day.challenge_passed !== null) {
    context.fillStyle = day.challenge_passed ? colors.useful : colors.waste;
    font(context, 24, 700);
    context.fillText(day.challenge_passed ? t("print.challengePassed") : t("print.challengeFailed"), PADDING, 492);
  }
  divider(context, colors, 528);
  categoryBars(context, colors, [
    { label: kindLabels.useful, value: day.useful_ms, color: colors.useful },
    { label: kindLabels.neutral, value: day.neutral_ms, color: colors.neutral },
    { label: kindLabels.waste, value: day.waste_ms, color: colors.waste },
  ], 582, t);

  let y = 828;
  if (day.afk_ms > 0) {
    context.fillStyle = colors.muted;
    font(context, 22);
    context.fillText(`AFK ${duration(day.afk_ms, t)}`, PADDING, 810);
    y = 848;
  }
  if (day.top_entries.length > 0) {
    context.fillStyle = colors.muted;
    font(context, 19);
    context.fillText(t("share.topHeader"), PADDING, y);
    y += 42;
    for (const entry of day.top_entries.slice(0, 5)) {
      context.fillStyle = colors.text;
      font(context, 21);
      context.fillText(entry.app.replace(/\.exe$/i, "").slice(0, 25), PADDING, y);
      context.fillStyle = entry.category_kind === "useful" ? colors.useful : entry.category_kind === "waste" ? colors.waste : colors.neutral;
      context.fillText((entry.is_uncategorized ? t("common.uncategorized") : entry.category_name).slice(0, 18), 410, y);
      context.textAlign = "right";
      context.fillStyle = colors.muted;
      context.fillText(duration(entry.duration_ms, t), WIDTH - PADDING, y);
      context.textAlign = "left";
      y += 38;
    }
  }
  if (day.burned_rubles !== null) {
    context.fillStyle = colors.waste;
    font(context, 25, 700);
    context.fillText(t("share.burnedUpper", { currency: day.currency, amount: day.burned_rubles.toLocaleString(locale, { maximumFractionDigits: 2 }) }), PADDING, 1090);
  }
  await footer(context, colors, t);
  return canvas.toDataURL("image/png");
}

export async function renderWeekPng(week: WeekSummaryData, kindLabels: KindLabels, lang: Lang): Promise<string> {
  const t = translator(lang);
  const locale = localeForLang(lang);
  const [canvas, context, colors] = createCanvas(t);
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText(t("share.weeklyRank"), PADDING, 90);
  context.fillStyle = colors.text;
  font(context, 58, 700);
  context.fillText(t("share.passedCount", { count: week.passed_count }), PADDING, 174);
  context.fillStyle = colors.iris;
  font(context, 27);
  context.fillText(t("share.weekXp", { rank: week.rank, xp: week.week_xp.toLocaleString(locale) }), PADDING, 224);
  divider(context, colors, 266);

  week.days.forEach((day, index) => {
    const y = 322 + index * 78;
    context.fillStyle = day.passed ? colors.useful : colors.waste;
    font(context, 27, 700);
    context.fillText(day.passed ? "✓" : "×", PADDING, y);
    context.fillStyle = colors.text;
    font(context, 25);
    context.fillText(dateLabel(day.local_date, { weekday: "short", day: "2-digit", month: "2-digit" }, lang), PADDING + 52, y);
    context.fillStyle = colors.useful;
    context.fillText(`${kindInitial(kindLabels.useful, lang)} ${duration(day.useful_ms, t)}`, 350, y);
    context.fillStyle = colors.waste;
    context.fillText(`${kindInitial(kindLabels.waste, lang)} ${duration(day.waste_ms, t)}`, 510, y);
    context.fillStyle = colors.neutral;
    context.fillText(`${kindInitial(kindLabels.observed, lang)} ${duration(day.observed_ms, t)}`, 670, y);
    context.textAlign = "right";
    context.fillStyle = colors.muted;
    context.fillText(day.passed ? t("print.statusPassed") : t("print.statusFailed"), WIDTH - PADDING, y);
    context.textAlign = "left";
  });
  divider(context, colors, 894);
  context.fillStyle = colors.text;
  font(context, 29, 700);
  context.fillText(fittedText(context, `${kindLabels.useful.toLocaleUpperCase(locale)} ${duration(week.useful_ms, t)}`, WIDTH - PADDING * 2), PADDING, 954);
  context.fillStyle = colors.waste;
  context.fillText(fittedText(context, `${kindLabels.waste.toLocaleUpperCase(locale)} ${duration(week.waste_ms, t)}`, WIDTH - PADDING * 2), PADDING, 1002);
  context.fillStyle = colors.muted;
  font(context, 23);
  const strongest = week.strongest_day
    ? dateLabel(week.strongest_day, { weekday: "long", day: "numeric", month: "long" }, lang)
    : "—";
  context.fillText(t("share.strongestDay", { date: strongest }), PADDING, 1052);
  context.fillText(t("share.wasteDays", { count: week.waste_days }), PADDING, 1092);
  if (week.burned_rubles !== null) {
    context.fillStyle = colors.waste;
    context.fillText(t("print.burned", { currency: week.currency, amount: week.burned_rubles.toLocaleString(locale, { maximumFractionDigits: 2 }) }), PADDING, 1132);
  }
  await footer(context, colors, t);
  return canvas.toDataURL("image/png");
}

export async function renderChallengePng(day: DayPrintData, kindLabels: KindLabels, lang: Lang): Promise<string> {
  const t = translator(lang);
  const locale = localeForLang(lang);
  const [canvas, context, colors] = createCanvas(t);
  const code = challengeCode(day);
  context.fillStyle = colors.muted;
  font(context, 22);
  context.fillText(t("share.localChallenge"), PADDING, 90);
  context.fillStyle = colors.text;
  font(context, 65, 700);
  context.fillText(t("share.beatMyDay"), PADDING, 190);
  context.fillStyle = colors.iris;
  font(context, 38, 700);
  context.fillText(code, PADDING, 264);
  divider(context, colors, 314);
  context.fillStyle = colors.muted;
  font(context, 23);
  context.fillText(t("share.threeConditions"), PADDING, 374);
  condition(context, colors, 448, kindLabels.useful.toLocaleUpperCase(locale), minutes(day.useful_ms), minutes(day.useful_ms), true, false, t);
  condition(context, colors, 516, kindLabels.waste.toLocaleUpperCase(locale), minutes(day.waste_ms), minutes(day.waste_ms), true, true, t);
  condition(context, colors, 584, kindLabels.observed.toLocaleUpperCase(locale), minutes(day.observed_ms), minutes(day.observed_ms), true, false, t);
  divider(context, colors, 636);
  context.fillStyle = colors.text;
  font(context, 31, 700);
  context.fillText(t("share.result", { status: day.passed ? t("print.statusPassed") : t("print.statusFailed") }), PADDING, 708);
  context.fillStyle = colors.muted;
  font(context, 25);
  context.fillText(`${day.rank} · ${day.public_xp} ${t("common.publicXp")}`, PADDING, 756);
  context.fillText(t("share.codeHint"), PADDING, 850);
  context.fillText(t("share.privacyHint"), PADDING, 892);
  await footer(context, colors, t);
  return canvas.toDataURL("image/png");
}

export async function savePng(dataUrl: string, fileName: string): Promise<boolean> {
  const response = await fetch(dataUrl);
  const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
  return invoke<boolean>("save_png", { fileName, pngBytes: bytes });
}
