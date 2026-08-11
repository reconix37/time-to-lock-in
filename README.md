# 🐹 TTLI — Time To Lock In

**A time tracker that won't let you fool yourself.**

TTLI automatically tracks how much time you actually spend at your computer, splits it into useful / neutral / wasted, and turns it into a game: ranks from **Hamster** to **Master of Time**, daily pass/fail verdicts, and duels with your friends.

---

## 🚀 Install (Windows)

**[⬇️ Download installer](https://github.com/reconix37/time-to-lock-in/releases/latest/download/Time.To.Lock.In_0.2.0_x64-setup.exe)**

1. Download and run the installer — two clicks, no setup required
2. TTLI appears in the tray and starts tracking immediately
3. For precise browser-tab tracking (optional) — add the [TTLI Tracker](extension/) extension

> Updating: **Settings → "Check for updates"** — the app downloads the fresh installer, your data is preserved.

---

## 🎮 Features

| | |
|---|---|
| 🏆 **Ranks** | Hamster → Intern → Coder → Focus Maniac → Time Ninja → Cyber Samurai → Time Architect → Master of Time. Earn XP from passed days |
| ✅ **Daily verdict** | Three conditions: useful-time goal, waste limit, observation minimum. Meet them all — "Day passed" |
| 📊 **Charts** | Cumulative day lines, stacked 7/30-day trends, activity heatmap, MA7 |
| 🪟 **Mini window** | Compact always-on-top window with your live day progress |
| 🖨️ **Day print** | Terminal-style verdict + 3 shareable PNG cards (day / week / challenge) |
| ⚔️ **Duels** | "Beat my day" code — import a friend's challenge and compete on the same goals |
| 🏷️ **Categories & rules** | Custom labels, retro-classification — create a rule, the whole history re-colors |
| 💤 **AFK** | Auto-detection of idle time, media exemption (YouTube doesn't count as AFK) |
| 💰 **Hourly rate** | Optional: how much "burned" money per day |
| 🌍 **Languages** | Русский / Українська / English — toggle in the header |

## 🔒 Privacy

**Everything stays local.** No cloud, no telemetry, no external servers. Data lives in SQLite on your machine. The extension sends only the active tab's hostname and title to the app — full URLs are never stored or transmitted.

## 🛠 For developers

- **Stack:** Tauri v2 (Rust + React/TypeScript), SQLite (rusqlite), Chrome/Edge MV3 extension
- **Build:** `npm run tauri build` (Windows), CI — GitHub Actions on `v*` tags (strict `x.y.z`)
- **DB schema:** `src-tauri/migrations/`
- **PRD:** `docs/prds/v1-activity-tracker.md`

Made with 🐹 and love for focus.
