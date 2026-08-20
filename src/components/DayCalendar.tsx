import { useMemo, useState } from "react";
import { useI18n } from "../i18nContext";
import { localeForLang, type Lang } from "../i18n";

const WEEK_START = 1; // Понедельник

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

interface DayCalendarProps {
  selected: string;
  today: string;
  onSelect: (date: string) => void;
  onClose: () => void;
}

export function DayCalendar({ selected, today, onSelect, onClose }: DayCalendarProps) {
  const { lang, t } = useI18n();
  const [anchor] = useState(() => {
    const [year, month] = (selected || today).split("-").map(Number);
    return { year, month: month - 1 };
  });
  const [monthOffset, setMonthOffset] = useState(0);
  const year = anchor.year;
  const month = anchor.month + monthOffset;

  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);

  const locale = localeForLang(lang as Lang);
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month, 1)),
    [locale, year, month],
  );

  const weekdayLabels = useMemo(() => {
    const labels: string[] = [];
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
    for (let d = 0; d < 7; d += 1) {
      labels.push(formatter.format(new Date(2026, 0, 5 + d))); // 2026-01-05 — Пн
    }
    return labels;
  }, [locale]);

  const cells = useMemo(() => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = (new Date(year, month, 1).getDay() - WEEK_START + 7) % 7;
    const result: Array<{ date: string; day: number; disabled: boolean; isToday: boolean; isSelected: boolean }> = [];
    for (let i = 0; i < firstWeekday; i += 1) {
      result.push({ date: "", day: 0, disabled: true, isToday: false, isSelected: false });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = toLocalDate(year, month, day);
      const isFuture =
        year > todayYear || (year === todayYear && month > todayMonth) ||
        (year === todayYear && month === todayMonth && day > todayDay);
      result.push({
        date,
        day,
        disabled: isFuture,
        isToday: year === todayYear && month === todayMonth && day === todayDay,
        isSelected: date === selected,
      });
    }
    return result;
  }, [year, month, todayYear, todayMonth, todayDay, selected]);

  const atFutureMonth = year > todayYear || (year === todayYear && month >= todayMonth);
  // Февраль високосного года через Intl корректно, поэтому day-cap берём из новой даты.

  return (
    <div className="day-calendar" role="dialog" aria-label={t("trends.calendar")}>
      <div className="day-calendar-head">
        <button
          type="button"
          className="day-calendar-nav"
          aria-label={t("trends.prevMonth")}
          onClick={() => setMonthOffset((offset) => offset - 1)}
        >
          ‹
        </button>
        <span className="day-calendar-month">{monthLabel}</span>
        <button
          type="button"
          className="day-calendar-nav"
          aria-label={t("trends.nextMonth")}
          disabled={atFutureMonth}
          onClick={() => setMonthOffset((offset) => offset + 1)}
        >
          ›
        </button>
      </div>
      <div className="day-calendar-weekdays" aria-hidden="true">
        {weekdayLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
      <div className="day-calendar-grid" role="grid">
        {cells.map((cell, index) =>
          cell.date === "" ? (
            <span key={`blank-${index}`} />
          ) : (
            <button
              type="button"
              key={cell.date}
              className={`day-calendar-day${cell.isSelected ? " is-selected" : ""}${cell.isToday ? " is-today" : ""}`}
              disabled={cell.disabled}
              aria-pressed={cell.isSelected}
              onClick={() => {
                onSelect(cell.date);
                onClose();
              }}
            >
              {cell.day}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
