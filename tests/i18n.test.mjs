import assert from "node:assert/strict";
import test from "node:test";

import { localeForLang, messages, translate } from "../src/i18n.ts";

test("translates every supported language and replaces placeholders", () => {
  assert.equal(translate("ru", "rank.next", { name: "Стажёр" }), "До ранга «Стажёр»");
  assert.equal(translate("ua", "rank.next", { name: "Стажёр" }), "До рангу «Стажёр»");
  assert.equal(translate("en", "rank.next", { name: "Стажёр" }), "Until rank “Стажёр”");
  assert.equal(
    translate("ru", "classification.historyWarning", { app: "Chrome", count: 48 }),
    "Будет переклассифицирована вся история Chrome — 48 сегментов",
  );
  assert.equal(
    translate("en", "classification.titleMatchCount", { count: 3 }),
    "Matches 3 segments",
  );
});

test("all dictionaries expose the same message keys", () => {
  const russianKeys = Object.keys(messages.ru).sort();
  assert.deepEqual(Object.keys(messages.ua).sort(), russianKeys);
  assert.deepEqual(Object.keys(messages.en).sort(), russianKeys);
});

test("maps application languages to Intl locales", () => {
  assert.equal(localeForLang("ru"), "ru-RU");
  assert.equal(localeForLang("ua"), "uk-UA");
  assert.equal(localeForLang("en"), "en-US");
});
