import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isLang, translate, type Lang, type Translate, type TranslateVars } from "./i18n";

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => Promise<void>;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("ru");

  useEffect(() => {
    void invoke<Record<string, string>>("get_settings").then((settings) => {
      if (isLang(settings.language)) setLangState(settings.language);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "ua" ? "uk" : lang;
  }, [lang]);

  const setLang = useCallback(async (nextLang: Lang) => {
    setLangState(nextLang);
    try {
      await invoke("set_setting", { key: "language", value: nextLang });
    } catch (reason: unknown) {
      setLangState(lang);
      throw reason;
    }
  }, [lang]);

  const t = useCallback((key: string, vars?: TranslateVars) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
