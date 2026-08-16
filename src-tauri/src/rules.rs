use regex::{Regex, RegexBuilder};
use rusqlite::Connection;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity<'a> {
    pub app: &'a str,
    pub title: &'a str,
    pub domain: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleDefinition {
    pub id: i64,
    pub match_type: String,
    pub pattern: String,
    pub category_id: i64,
    pub priority: i64,
    pub category_priority: i64,
    pub match_mode: String,
    pub case_insensitive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchStats {
    pub match_count: i64,
    pub manual_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RulePreview {
    pub matched_values: i64,
    pub total_values: i64,
    pub matched_duration_ms: i64,
    pub broad_warning: bool,
}

pub fn normalize_pattern(pattern: &str) -> String {
    pattern
        .trim()
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ")
}

#[derive(Clone)]
enum Matcher {
    Legacy,
    Regex(Regex),
}

#[derive(Clone)]
struct CompiledRule {
    definition: RuleDefinition,
    matcher: Matcher,
}

#[derive(Clone, Default)]
pub struct RuleSet {
    rules: Vec<CompiledRule>,
}

pub(crate) struct RuleCache {
    revision: i64,
    rules: RuleSet,
}

impl RuleCache {
    pub(crate) fn load(connection: &Connection) -> Result<Self, String> {
        Ok(Self {
            revision: crate::db::rules_revision(connection)?,
            rules: RuleSet::load(connection)?,
        })
    }

    pub(crate) fn refresh(&mut self, connection: &Connection) -> Result<bool, String> {
        let revision = crate::db::rules_revision(connection)?;
        if revision == self.revision {
            return Ok(false);
        }
        self.rules = RuleSet::load(connection)?;
        self.revision = revision;
        Ok(true)
    }

    pub(crate) fn classify(
        &mut self,
        connection: &Connection,
        activity: &Activity<'_>,
    ) -> Result<i64, String> {
        self.refresh(connection)?;
        Ok(self.classify_cached(activity))
    }

    pub(crate) fn classify_cached(&self, activity: &Activity<'_>) -> i64 {
        self.rules.classify(activity)
    }
}

impl RuleSet {
    pub fn load(connection: &Connection) -> Result<Self, String> {
        let mut statement = connection
            .prepare(
                "SELECT r.id, r.match_type, r.pattern, r.category_id, r.priority,
                        r.match_mode, r.case_insensitive, c.priority
                 FROM rules r
                 JOIN categories c ON c.id = r.category_id
                 ORDER BY c.priority ASC,
                          r.priority DESC,
                          CASE r.match_type WHEN 'domain' THEN 3 WHEN 'title' THEN 2 ELSE 1 END DESC,
                          r.id ASC",
            )
            .map_err(|error| error.to_string())?;
        let definitions = statement
            .query_map([], |row| {
                Ok(RuleDefinition {
                    id: row.get(0)?,
                    match_type: row.get(1)?,
                    pattern: row.get(2)?,
                    category_id: row.get(3)?,
                    priority: row.get(4)?,
                    category_priority: row.get(7)?,
                    match_mode: row.get(5)?,
                    case_insensitive: row.get::<_, i64>(6)? == 1,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Self::compile(definitions)
    }

    pub fn compile(mut definitions: Vec<RuleDefinition>) -> Result<Self, String> {
        definitions.sort_by(|left, right| {
            let target_rank = |rule: &RuleDefinition| match rule.match_type.as_str() {
                "domain" => 3,
                "title" => 2,
                _ => 1,
            };
            // Приоритет категории (1 = перехватывает первой) — первичный ключ сортировки.
            left.category_priority
                .cmp(&right.category_priority)
                .then_with(|| right.priority.cmp(&left.priority))
                .then_with(|| target_rank(right).cmp(&target_rank(left)))
                .then_with(|| left.id.cmp(&right.id))
        });
        let rules = definitions
            .into_iter()
            .map(|definition| {
                validate_definition(&definition)?;
                let matcher = if definition.match_mode == "regex" {
                    let pattern = if definition.match_type == "any" {
                        validate_list_separator(&definition.pattern)?;
                        normalize_any_pattern(&definition.pattern)
                    } else {
                        definition.pattern.clone()
                    };
                    Matcher::Regex(compile_regex(&pattern, definition.case_insensitive)?)
                } else {
                    Matcher::Legacy
                };
                Ok(CompiledRule {
                    definition,
                    matcher,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self { rules })
    }

    pub fn classify(&self, activity: &Activity<'_>) -> i64 {
        self.rules
            .iter()
            .find(|rule| rule.matches(activity))
            .map_or(0, |rule| rule.definition.category_id)
    }

    pub fn matches_definition(
        definition: RuleDefinition,
        activity: &Activity<'_>,
    ) -> Result<bool, String> {
        let rule_set = Self::compile(vec![definition])?;
        Ok(rule_set.rules[0].matches(activity))
    }

    pub fn match_stats(&self, connection: &Connection) -> Result<MatchStats, String> {
        let mut statement = connection
            .prepare("SELECT app, window_title, domain, manual_category FROM segments")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut stats = MatchStats {
            match_count: 0,
            manual_count: 0,
        };
        for row in rows {
            let (app, title, domain, manual) = row.map_err(|error| error.to_string())?;
            if self.classify(&Activity {
                app: &app,
                title: &title,
                domain: &domain,
            }) != 0
            {
                stats.match_count += 1;
                stats.manual_count += i64::from(manual == 1);
            }
        }
        Ok(stats)
    }

    pub fn preview(
        connection: &Connection,
        definition: RuleDefinition,
        now_ms: i64,
    ) -> Result<RulePreview, String> {
        let rule_set = Self::compile(vec![definition.clone()])?;
        let rule = &rule_set.rules[0];
        let mut statement = connection
            .prepare(
                "SELECT app, window_title, domain, MAX(0, ts_end - ts_start)
                 FROM segments WHERE ts_end >= ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([now_ms - 30 * 24 * 60 * 60 * 1000], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut values: HashMap<String, (bool, i64)> = HashMap::new();
        let mut matched_duration_ms = 0;
        for row in rows {
            let (app, title, domain, duration) = row.map_err(|error| error.to_string())?;
            let activity = Activity {
                app: &app,
                title: &title,
                domain: &domain,
            };
            let value = if definition.match_type == "any" {
                format!("{app}|{title}|{domain}")
            } else {
                field_value(&definition.match_type, &activity).to_string()
            };
            let matched = rule.matches(&activity);
            let entry = values.entry(value).or_insert((matched, 0));
            entry.0 |= matched;
            entry.1 += duration;
            if matched {
                matched_duration_ms += duration;
            }
        }
        let total_values = values.len() as i64;
        let matched_values = values.values().filter(|(matched, _)| *matched).count() as i64;
        let sample_is_broad = total_values >= 20 && matched_values * 4 >= total_values;
        Ok(RulePreview {
            matched_values,
            total_values,
            matched_duration_ms,
            broad_warning: universal_pattern(&definition.pattern) || sample_is_broad,
        })
    }
}

impl CompiledRule {
    fn matches(&self, activity: &Activity<'_>) -> bool {
        if self.definition.match_type == "any" {
            return self.matches_any(activity);
        }
        let value = field_value(&self.definition.match_type, activity);
        match &self.matcher {
            Matcher::Regex(regex) => regex.is_match(value),
            Matcher::Legacy => legacy_matches(
                &self.definition.match_type,
                &self.definition.pattern,
                value,
                self.definition.case_insensitive,
            ),
        }
    }

    fn matches_any(&self, activity: &Activity<'_>) -> bool {
        match &self.matcher {
            Matcher::Regex(regex) => {
                regex.is_match(activity.app)
                    || regex.is_match(activity.title)
                    || regex.is_match(activity.domain)
            }
            Matcher::Legacy => {
                let tokens = list_tokens(&self.definition.pattern);
                if self.definition.case_insensitive {
                    let values = [
                        activity.app.to_lowercase(),
                        activity.title.to_lowercase(),
                        activity.domain.to_lowercase(),
                    ];
                    tokens.iter().any(|token| {
                        let token = token.to_lowercase();
                        values.iter().any(|value| value.contains(&token))
                    })
                } else {
                    let values = [activity.app, activity.title, activity.domain];
                    tokens
                        .iter()
                        .any(|token| values.iter().any(|value| value.contains(token)))
                }
            }
        }
    }
}

fn list_tokens(pattern: &str) -> Vec<&str> {
    pattern
        .split(['|', ','])
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect()
}

fn field_value<'a>(match_type: &str, activity: &'a Activity<'_>) -> &'a str {
    match match_type {
        "exe" => activity.app,
        "domain" => activity.domain,
        _ => activity.title,
    }
}

fn legacy_matches(match_type: &str, pattern: &str, value: &str, case_insensitive: bool) -> bool {
    if match_type == "title" {
        return crate::db::title_matches_with_case(pattern, value, case_insensitive);
    }
    let (pattern, value) = if case_insensitive {
        (pattern.to_lowercase(), value.to_lowercase())
    } else {
        (pattern.to_string(), value.to_string())
    };
    match match_type {
        "exe" => value.starts_with(&pattern),
        "domain" => value.contains(&pattern),
        _ => false,
    }
}

fn compile_regex(pattern: &str, case_insensitive: bool) -> Result<Regex, String> {
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|error| format!("invalid regex: {error}"))?;
    if regex.is_match("") {
        return Err("regex must not match an empty string".to_string());
    }
    Ok(regex)
}

fn validate_list_separator(pattern: &str) -> Result<(), String> {
    if matches!(pattern.trim().chars().last(), Some('|' | ',')) {
        return Err("rule pattern must not end with a list separator".to_string());
    }
    Ok(())
}

fn normalize_any_pattern(pattern: &str) -> String {
    let mut normalized = String::with_capacity(pattern.len());
    let mut characters = pattern.chars().peekable();
    let mut in_braces = false;
    while let Some(character) = characters.next() {
        match character {
            '{' => {
                in_braces = true;
                normalized.push(character);
            }
            '}' => {
                in_braces = false;
                normalized.push(character);
            }
            ',' if !in_braces => {
                while normalized.chars().last().is_some_and(char::is_whitespace) {
                    normalized.pop();
                }
                normalized.push('|');
                while characters.next_if(|next| next.is_whitespace()).is_some() {}
            }
            _ => normalized.push(character),
        }
    }
    normalized
}

fn validate_definition(definition: &RuleDefinition) -> Result<(), String> {
    if !matches!(
        definition.match_type.as_str(),
        "exe" | "title" | "domain" | "any"
    ) {
        return Err("invalid rule match type".to_string());
    }
    if !matches!(definition.match_mode.as_str(), "legacy" | "regex") {
        return Err("invalid rule match mode".to_string());
    }
    let length = definition.pattern.chars().count();
    if length == 0 || length > 500 {
        return Err("rule pattern must contain 1-500 characters".to_string());
    }
    Ok(())
}

fn universal_pattern(pattern: &str) -> bool {
    matches!(pattern.trim(), ".*" | ".+" | "^.*$")
}

#[cfg(test)]
mod tests {
    use super::{normalize_pattern, Activity, RuleCache, RuleDefinition, RuleSet};
    use rusqlite::Connection;

    fn rule(id: i64, target: &str, pattern: &str, category: i64) -> RuleDefinition {
        RuleDefinition {
            id,
            match_type: target.to_string(),
            pattern: pattern.to_string(),
            category_id: category,
            priority: 0,
            category_priority: 0,
            match_mode: "legacy".to_string(),
            case_insensitive: true,
        }
    }

    #[test]
    fn legacy_blender_title_matches_case_insensitively() {
        let rules = RuleSet::compile(vec![rule(1, "title", "Blender", 7)]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "Blender Course Animation",
                domain: "courses.example",
            }),
            7
        );
    }

    #[test]
    fn real_newlines_normalize_to_spaces_but_literal_escape_keeps_regex_meaning() {
        assert_eq!(normalize_pattern("Blender\r\ntutorial"), "Blender tutorial");

        let mut definition = rule(1, "title", &normalize_pattern(r"first\nsecond"), 7);
        definition.match_mode = "regex".to_string();
        let rules = RuleSet::compile(vec![definition]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "first\nsecond",
                domain: "",
            }),
            7
        );
    }

    #[test]
    fn regex_matches_only_the_selected_activity_field() {
        for (target, activity) in [
            (
                "title",
                Activity {
                    app: "browser.exe",
                    title: "Practical 3D modeling",
                    domain: "courses.example",
                },
            ),
            (
                "exe",
                Activity {
                    app: "blender.exe",
                    title: "Untitled",
                    domain: "",
                },
            ),
            (
                "domain",
                Activity {
                    app: "browser.exe",
                    title: "Home",
                    domain: "blender.org",
                },
            ),
        ] {
            let mut definition = rule(1, target, r"\b3d\b|blender", 8);
            definition.match_mode = "regex".to_string();
            assert_eq!(
                RuleSet::compile(vec![definition])
                    .expect("rules")
                    .classify(&activity),
                8
            );
        }
    }

    #[test]
    fn regex_does_not_match_the_wrong_field() {
        let mut exe_rule = rule(2, "exe", "3d", 9);
        exe_rule.match_mode = "regex".to_string();
        assert_eq!(
            RuleSet::compile(vec![exe_rule])
                .expect("rules")
                .classify(&Activity {
                    app: "browser.exe",
                    title: "3D course",
                    domain: "courses.example",
                }),
            0
        );
    }

    #[test]
    fn higher_priority_rule_wins() {
        let low = rule(1, "title", "Blender", 1);
        let mut high = rule(2, "exe", "blender.exe", 2);
        high.priority = 10;
        let rules = RuleSet::compile(vec![low, high]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "Blender.exe",
                title: "Blender Course Animation",
                domain: "",
            }),
            2
        );
    }

    #[test]
    fn lower_category_priority_claims_name_first() {
        // Категория с приоритетом 1 перехватывает названия раньше категории с
        // приоритетом 2 — даже если у той правило приоритетнее и специфичнее
        // (кейс Эдуарда: «AI Studio» = AI 3D, а не Google).
        let mut first_category = rule(1, "title", "AI Studio", 1);
        first_category.category_priority = 1;
        let mut second_category = rule(2, "exe", "google.exe", 2);
        second_category.category_priority = 2;
        second_category.priority = 10;
        let rules = RuleSet::compile(vec![second_category, first_category]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "google.exe",
                title: "AI Studio — Blender Course",
                domain: "",
            }),
            1
        );
    }

    #[test]
    fn revision_change_reclassifies_unchanged_activity() {
        let connection = Connection::open_in_memory().expect("database");
        connection
            .execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE categories (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#286983',
                    icon TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'neutral',
                    goal_multiplier REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 999
                 );
                 INSERT INTO categories (id, name) VALUES (4, 'Cat4'), (9, 'Cat9');
                 CREATE TABLE rules (
                    id INTEGER PRIMARY KEY, match_type TEXT NOT NULL, pattern TEXT NOT NULL,
                    category_id INTEGER NOT NULL, priority INTEGER NOT NULL,
                    match_mode TEXT NOT NULL, case_insensitive INTEGER NOT NULL
                 );
                 INSERT INTO settings VALUES ('rules_revision', '1');
                 INSERT INTO rules VALUES (1, 'title', 'Blender', 4, 0, 'legacy', 1);",
            )
            .expect("schema");
        let activity = Activity {
            app: "blender.exe",
            title: "Blender Course Animation",
            domain: "",
        };
        let mut cache = RuleCache::load(&connection).expect("cache");
        assert_eq!(cache.classify(&connection, &activity).expect("category"), 4);

        connection
            .execute("UPDATE rules SET category_id = 9 WHERE id = 1", [])
            .expect("updated rule");
        crate::db::bump_rules_revision(&connection).expect("revision");

        assert_eq!(cache.classify(&connection, &activity).expect("category"), 9);
    }

    #[test]
    fn legacy_matching_keeps_existing_semantics() {
        let rules = RuleSet::compile(vec![
            rule(1, "exe", "code.exe", 1),
            rule(2, "title", "Game of Thrones season 4", 2),
        ])
        .expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "Code.exe-insiders",
                title: "",
                domain: ""
            }),
            1
        );
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "Thrones: Game — Season 4, episode 2",
                domain: ""
            }),
            2
        );
    }

    #[test]
    fn regex_respects_case_flag_and_priority() {
        let mut low = rule(1, "title", "blender", 1);
        low.match_mode = "regex".to_string();
        low.case_insensitive = false;
        let mut high = rule(2, "domain", "BLENDER\\.org", 2);
        high.match_mode = "regex".to_string();
        high.priority = 10;
        let rules = RuleSet::compile(vec![low, high]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "BLENDER",
                domain: "blender.org"
            }),
            2
        );
    }

    #[test]
    fn invalid_and_empty_matching_regexes_are_rejected() {
        let mut invalid = rule(1, "title", "(", 1);
        invalid.match_mode = "regex".to_string();
        assert!(RuleSet::compile(vec![invalid]).is_err());
        let mut empty = rule(2, "title", ".*", 1);
        empty.match_mode = "regex".to_string();
        assert!(RuleSet::compile(vec![empty]).is_err());
    }

    #[test]
    fn any_regex_matches_either_field() {
        let mut definition = rule(1, "any", "tiktok|reddit", 4);
        definition.match_mode = "regex".to_string();
        let rules = RuleSet::compile(vec![definition]).expect("rules");

        assert_eq!(
            rules.classify(&Activity {
                app: "discord.exe",
                title: "TikTok",
                domain: "",
            }),
            4
        );
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "Home",
                domain: "reddit.com",
            }),
            4
        );
        assert_eq!(
            rules.classify(&Activity {
                app: "Code.exe",
                title: "Untitled",
                domain: "",
            }),
            0
        );
    }

    #[test]
    fn any_regex_treats_comma_as_separator_and_keeps_braces() {
        let mut list = rule(1, "any", "tiktok, reddit, facebook", 4);
        list.match_mode = "regex".to_string();
        assert_eq!(
            RuleSet::compile(vec![list])
                .expect("list rule")
                .classify(&Activity {
                    app: "browser.exe",
                    title: "Facebook",
                    domain: "social.example",
                }),
            4
        );

        let mut quantified = rule(2, "any", "a{2,3}|blender", 5);
        quantified.match_mode = "regex".to_string();
        assert_eq!(
            RuleSet::compile(vec![quantified])
                .expect("quantified rule")
                .classify(&Activity {
                    app: "browser.exe",
                    title: "aaa course",
                    domain: "courses.example",
                }),
            5
        );
    }

    #[test]
    fn any_legacy_matches_list_or_single_token_in_any_field() {
        let rules = RuleSet::compile(vec![rule(1, "any", "tiktok|reddit", 4)]).expect("rules");
        assert_eq!(
            rules.classify(&Activity {
                app: "tiktok.exe",
                title: "Home",
                domain: "",
            }),
            4
        );
        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "Reddit",
                domain: "social.example",
            }),
            4
        );

        let single = RuleSet::compile(vec![rule(2, "any", "blender", 5)]).expect("single rule");
        assert_eq!(
            single.classify(&Activity {
                app: "blender.exe",
                title: "Untitled",
                domain: "",
            }),
            5
        );
    }

    #[test]
    fn specific_domain_rule_beats_any_rule_at_equal_priority() {
        let mut domain = rule(1, "domain", r"reddit\.com", 5);
        domain.match_mode = "regex".to_string();
        let mut any = rule(2, "any", "reddit", 6);
        any.match_mode = "regex".to_string();
        let rules = RuleSet::compile(vec![any, domain]).expect("rules");

        assert_eq!(
            rules.classify(&Activity {
                app: "browser.exe",
                title: "Reddit",
                domain: "reddit.com",
            }),
            5
        );
    }

    #[test]
    fn any_regex_rejects_trailing_separator() {
        for pattern in ["tiktok|reddit|", "tiktok, reddit,"] {
            let mut definition = rule(1, "any", pattern, 4);
            definition.match_mode = "regex".to_string();
            assert!(RuleSet::compile(vec![definition]).is_err());
        }
    }

    #[test]
    fn case_sensitive_legacy_and_regex_rules_preserve_case() {
        let mut legacy = rule(1, "title", "Blender", 1);
        legacy.case_insensitive = false;
        let rules = RuleSet::compile(vec![legacy]).expect("legacy rule");
        assert_eq!(
            rules.classify(&Activity {
                app: "",
                title: "blender course",
                domain: ""
            }),
            0
        );

        let mut regex = rule(2, "domain", "Example\\.com", 2);
        regex.match_mode = "regex".to_string();
        regex.case_insensitive = false;
        let rules = RuleSet::compile(vec![regex]).expect("regex rule");
        assert_eq!(
            rules.classify(&Activity {
                app: "",
                title: "",
                domain: "example.com"
            }),
            0
        );
    }

    #[test]
    fn preview_warns_when_regex_matches_at_least_a_quarter_of_unique_values() {
        let connection = Connection::open_in_memory().expect("database");
        connection
            .execute_batch(
                "CREATE TABLE segments (
                    app TEXT NOT NULL, window_title TEXT NOT NULL, domain TEXT NOT NULL,
                    ts_start INTEGER NOT NULL, ts_end INTEGER NOT NULL
                 );",
            )
            .expect("schema");
        for index in 0..20 {
            connection
                .execute(
                    "INSERT INTO segments VALUES (?1, '', '', 0, 1000)",
                    [if index < 5 {
                        format!("code-{index}")
                    } else {
                        format!("other-{index}")
                    }],
                )
                .expect("segment");
        }
        let mut definition = rule(1, "exe", "^code-", 1);
        definition.match_mode = "regex".to_string();
        let preview = RuleSet::preview(&connection, definition, 1_000).expect("preview");
        assert_eq!(preview.matched_values, 5);
        assert_eq!(preview.total_values, 20);
        assert!(preview.broad_warning);
    }

    #[test]
    fn the_same_ruleset_result_can_drive_live_and_replay() {
        let rules = RuleSet::compile(vec![rule(1, "domain", "example.com", 7)]).expect("rules");
        let activity = Activity {
            app: "browser.exe",
            title: "Example",
            domain: "docs.example.com",
        };
        let live_category = rules.classify(&activity);
        let replay_category = rules.classify(&activity);
        assert_eq!(live_category, replay_category);
    }
}
