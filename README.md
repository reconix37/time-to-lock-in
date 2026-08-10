# Time To Lock In (TTLI)

> Local-first Windows time tracker with custom categories, XP and meme ranks — share weekly cards and challenge friends. No cloud, no accounts.

## Что это

Десктоп-трекер активности под Windows: живёт в трее, автозапуск, каждые 5 сек пишет активное окно в SQLite + расширение Chrome/Edge шлёт домен вкладки. Кастомные категории и правила (exe/домен/тайтл → категория), переклассификация задним числом, EXP за полезное время, 8 мемных рангов (Хомяк → Повелитель времени), хитмапы, «сколько бы я успел» (в часах и деньгах), мини-окно, share-карточки PNG и челлендж-коды для кентов. Всё локально, приватность — фича.

## Стек

Tauri v2 (Rust + React/TS) · SQLite (WAL) · Chrome/Edge extension (MV3) · GitHub Actions (Windows-сборка)

## Документация

- `docs/prds/v1-activity-tracker.md` — PRD v2 (готов к разработке, прошёл 7 раундов Codex-аудита)
- `DESIGN.md` — дизайн-система (Rosé Pine Dawn/Moon, графики, антипаттерны)

## Разработка

```bash
npm install
npm run tauri dev      # dev (требует Rust + пререквизиты Tauri)
npm run build          # только фронт
```

Сборка Windows-installer — по тегу `v*` через GitHub Actions (см. `.github/workflows/release.yml`).

## Плагины

`tauri-plugin-sql` (sqlite, миграции в `src-tauri/migrations/`) · `tauri-plugin-autostart` · `tauri-plugin-single-instance` · `tauri-plugin-dialog`
