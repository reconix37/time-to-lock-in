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

impl RuleSet {
    pub fn load(connection: &Connection) -> Result<Self, String> {
        let mut statement = connection
            .prepare(
                "SELECT id, match_type, pattern, category_id, priority,
                        match_mode, case_insensitive
                 FROM rules
                 ORDER BY priority DESC,
                          CASE match_type WHEN 'domain' THEN 3 WHEN 'title' THEN 2 ELSE 1 END DESC,
                          id ASC",
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
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| target_rank(right).cmp(&target_rank(left)))
                .then_with(|| left.id.cmp(&right.id))
        });
        let rules = definitions
            .into_iter()
            .map(|definition| {
                validate_definition(&definition)?;
                let matcher = if definition.match_mode == "regex" {
                    Matcher::Regex(compile_regex(
                        &definition.pattern,
                        definition.case_insensitive,
                    )?)
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
            let value = field_value(&definition.match_type, &activity).to_string();
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

fn validate_definition(definition: &RuleDefinition) -> Result<(), String> {
    if !matches!(definition.match_type.as_str(), "exe" | "title" | "domain") {
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
    use super::{Activity, RuleDefinition, RuleSet};
    use rusqlite::Connection;

    fn rule(id: i64, target: &str, pattern: &str, category: i64) -> RuleDefinition {
        RuleDefinition {
            id,
            match_type: target.to_string(),
            pattern: pattern.to_string(),
            category_id: category,
            priority: 0,
            match_mode: "legacy".to_string(),
            case_insensitive: true,
        }
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
