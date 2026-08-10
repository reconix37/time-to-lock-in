# DESIGN.md — Time To Lock In (Desktop Activity Tracker)

> Машинный спека для Cursor/Codex. Основа: Rosé Pine Dawn (референс юзера — deploychan.webcam) + Linear (монитор-поверхность: luminance-степпинг, тонкие границы, акцент только на CTA).

## Surface

**Monitor** — дашборды, хитмапы, статусы, таймлайн. Плюс **Command/Inspect** для терминального дайджеста. НЕ маркетинг, НЕ центрированные лендинги.

## Color Tokens — Light Theme (Rosé Pine Dawn)

```css
:root {
  /* Surfaces (warm cream, никогда чистый #e5e5e5/#ffffff) */
  --bg:        #faf4ed;  /* фон окна */
  --surface:   #fffaf3;  /* карточки, панели */
  --overlay:   #f2e9e1;  /* hover, вложенные панели */
  --hl-low:    #f4ede8;  /* бейджи, мягкие заливки */
  --hl-med:    #dfcec4;  /* границы по умолчанию */
  --hl-high:   #f0e0dc;  /* акцентные заливки (редко) */

  /* Text */
  --text:      #575279;  /* основной текст (никогда #000) */
  --muted:     #797593;  /* вторичный */
  --subtle:    #9893a5;  /* метаданные, таймстемпы */

  /* Accents (только CTA/active; категории — своя палитра ниже) */
  --love:      #b4637a;  /* primary CTA */
  --love-hover:#c17f91;
  --iris:      #907aa9;  /* focus, ссылки, active */

  /* Категории (палитра Rosé Pine) */
  --cat-useful:  #286983;  /* pine — Work и «полезно» */
  --cat-neutral: #ea9d34;  /* gold — Chill, перерывы */
  --cat-waste:   #b4637a;  /* love — Brainrot и «вредно» */
  --cat-foam:    #56949f;  /* доп. категория */
  --cat-iris:    #907aa9;  /* доп. категория */
  --cat-muted:   #9893a5;  /* Uncategorized */

  /* Status */
  --ok:   #286983;
  --warn: #ea9d34;
  --bad:  #b4637a;

  --border:    1px solid var(--hl-med);
  --radius-sm: 6px;   /* кнопки, инпуты */
  --radius-md: 10px;  /* карточки */
  --radius-lg: 14px;  /* панели, модалки */
  --radius-pill: 999px;
  --shadow: 0 1px 2px rgba(87, 82, 121, 0.06); /* минимум, светлая тема */
  --font-sans: 'Space Grotesk', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace;
  /* Терминальный лог (Печать дня) — в светлой теме тоже тёмный блок */
  --term-bg:   #2a2534;
  --term-text: #f4ede8;
  --term-muted:#797593;
}
```

## Color Tokens — Dark Theme (Rosé Pine Moon)

```css
[data-theme="dark"] {
  --bg:        #232136;  /* глубокий тёплый фиолетово-серый, НЕ чистый #000 */
  --surface:   #2a273f;
  --overlay:   #393552;
  --hl-low:    #2a283e;
  --hl-med:    #44415a;  /* границы в тёмной теме — чуть светлее фона */
  --hl-high:   #56526e;

  --text:      #e0def4;
  --muted:     #6e6a86;
  --subtle:    #908caa;

  --love:      #eb6f92;
  --love-hover:#f0839f;
  --iris:      #c4a7e7;

  --cat-useful:  #3e8fb0;  /* pine (светлее, для контраста на тёмном) */
  --cat-neutral: #f6c177;
  --cat-waste:   #eb6f92;
  --cat-foam:    #9ccfd8;
  --cat-iris:    #c4a7e7;
  --cat-muted:   #6e6a86;

  --ok:   #9ccfd8;
  --warn: #f6c177;
  --bad:  #eb6f92;

  --border:    1px solid var(--hl-med);
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  /* Терминальный лог в тёмной теме: инверсия — светлый лог на тёмном фоне
     (bg #e0def4 текст тёмный), или тот же тёмный лог, но с границей hl-med.
     Решение: тёмный лог остаётся тёмным (#1f1c2b bg), но выделяется
     границей --hl-med; контраст с фоном достигается тоном, не светом */
  --term-bg:   #1f1c2b;
  --term-text: #e0def4;
  --term-muted:#908caa;
}
```

Правила тем:
- Переключение: `data-theme` на корне + сохранение в настройках; трей-подсказка не участвует
- В тёмной теме категории использует светлые варианты палитры (pine #3e8fb0 вместо #286983) — контраст на тёмном фоне
- Тени в тёмной — темнее и больше (0 1px 3px rgba(0,0,0,0.35)), но НЕ blur-heavy
- Хитмап-интенсивности в тёмной: базовые клетки --hl-low, уровни — alpha от светлого pine
- Границы в тёмной НЕ белые rgba(255,255,255,0.08) как у Linear — у нас тёплые #44415a (hl-med)

## Typography

- **UI**: Space Grotesk — 400 (тело), 500 (навигация/лейблы), 700 (hero-цифры: EXP, уровень, «сожжено ₽» — и только они)
- **Цифры/метаданные/терминальный лог/хитмап**: JetBrains Mono 400/500
- **Scale**: 12 / 13 / 14 / 16 / 20 / 24 / 32 / 48
- Заголовки: 20px 500, letter-spacing -0.2px. Hero-цифры: 48px 700 mono (или Space Grotesk 700)
- Таймстемпы, лог: mono 13px

## Spacing

4px grid: 4, 8, 12, 16, 20, 24, 32, 48. Контентная ширина дашборда ≤ 1200px, паддинги страниц 24px.

## Radius

6 / 10 / 14 / 999. **НЕ 8.**

## Components

- **Primary button**: bg `--love`, text `#faf4ed`, radius 6, padding 8px 16px, hover `--love-hover`. Только один на экран
- **Ghost button**: bg transparent, border `--border`, text `--text`, radius 6. Secondary actions
- **Pill/chip**: bg `--hl-low`, border `--border`, radius 999, text 13px 500, padding 4px 10px. Категории в фильтрах
- **Card**: bg `--surface`, border `--border`, radius 10, shadow `--shadow`. Без hover-подъёмов, без blur
- **Input**: bg `--surface`, border `--border`, radius 6, padding 8px 12px; focus: border `--iris` + `outline: 2px solid color-mix(in srgb, var(--iris) 20%, transparent)`
- **Хитмап**: grid клеток, фон `--hl-low`, интенсивность — прозрачность цвета категории (useful → pine). Подпись: mono 11px `--subtle`
- **Таймлайн дня**: горизонтальная полоса 24ч на `--hl-low`; сегменты — цвет категории, radius 3px между сегментами 1px gap; клик по сегменту → модалка «сменить категорию» (переклассификация)
- **Терминальный дайджест**: блок mono 13px на `--surface`; формат `[09:14] figma — Work 45m`; время — `--subtle`, приложение — `--text`, категория — цветом категории
- **Трей-иконка**: не цветная мозаика — монохром `--text` + точка цвета текущей категории

## States

1. Loading — skeleton shimmer (bg `--hl-low` → `--hl-med` pulse)
2. Empty — centered block с CTA («Создай первую категорию»)
3. Error — toast снизу, `--bad` border
4. Success — instant, без toast

## Anti-patterns (ЗАПРЕЩЕНО)

- ❌ Серые `#e5e5e5` фоны/границы — только тёплый крем (`--hl-med`, `--hl-low`)
- ❌ Чистый белый `#ffffff` фон и чистый чёрный `#000` текст
- ❌ outline-кнопки (border 2px без фона)
- ❌ border-radius 8px
- ❌ Градиенты, стекломорфизм, blur-подложки
- ❌ Тяжёлые тени (только `--shadow`)
- ❌ Центрированные лейауты (кроме empty state)
- ❌ Inter как основной шрифт; акценты-радуга; неоновые цвета
- ❌ AI-слоп-паттерны: feature-tile grid, icon topper, accent rail, «монументальная» статистика без смысла
- ❌ Хардкод-цвета в компонентах — только через токены

## Charts (графики)

```css
/* Хитмап — 5 дискретных уровней, не градиент */
--heat-0: var(--hl-low);
--heat-1: color-mix(in srgb, var(--cat-useful) 22%, var(--hl-low));
--heat-2: color-mix(in srgb, var(--cat-useful) 42%, var(--hl-low));
--heat-3: color-mix(in srgb, var(--cat-useful) 65%, var(--hl-low));
--heat-4: color-mix(in srgb, var(--cat-useful) 90%, var(--hl-low));
/* waste-хитмап: та же шкала от --cat-waste */
```

- Хитмап: нулевая клетка видна, но не спорит с границей; «сегодня» — контур `--subtle`; зачтённый день — маленькая точка `--ok` (НЕ рамка — цвет кодирует величину, статус нельзя кодировать тем же цветом)
- Bullet-бары зачёта дня: риска порога (tick), waste заполняется в обратной логике — приближение к лимиту
- Накопительные линии: useful/waste по часам, dashed-линии цели и лимита
- Стековые столбцы: useful/neutral/waste по дням, линии цели/лимита проходят через все дни
- Терминальный лог (Печать дня): **канон = агрегат, не журнал переключений**. В ОБЕИХ темах темнее основного окна (`--term-bg`), остаётся отдельным Command/Inspect-объектом; время — term-muted, приложение — term-text, категория — своим цветом; `love` не использовать как универсальный синтаксический акцент
- Печать дня — порядок строк (канон): заголовок `TIMEFORGE // DAILY LOG — <дата>` → по одному агрегированному пункту на категорию/приложение (топ-5, с длительностью) → три условия зачёта (✓/✕) → `STATUS: <вердикт> · +<XP>` → burned ₽ (opt-in). Токены: `--term-bg` (#2a2534 Dawn / #1f1c2b Moon), `--term-text`, `--term-muted` — уже определены в темах
- Skeleton: дискретный pulse `--hl-low ↔ --hl-med`, без градиентного shimmer
- Тень: только модалки/popover/верхние карточки; на плотных таблицах и внутренних графиках — без тени

## Notes

- Обе темы — в v1: светлая Rosé Pine Dawn (дефолт), тёмная Rosé Pine Moon (переключатель, `data-theme`)
- Категории: юзер выбирает цвет из палитры Rosé Pine (6 вариантов), кастомные hex разрешены
- Шрифты: Space Grotesk + JetBrains Mono с Google Fonts (fontsource для офлайна в Tauri)
