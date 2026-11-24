use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn checked_snapshot(source: &Connection, destination: &Path) -> Result<(), String> {
    let integrity: String = source.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err("Database integrity check failed; existing backups were preserved".into());
    }
    let mut target = Connection::open(destination).map_err(|error| error.to_string())?;
    {
        let backup = Backup::new(source, &mut target).map_err(|error| error.to_string())?;
        backup.run_to_completion(100, Duration::from_millis(5), None)
            .map_err(|error| error.to_string())?;
    }
    let integrity: String = target.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" { return Err("Backup integrity check failed".into()); }
    Ok(())
}

fn backup_folder(path: &Path) -> Result<PathBuf, String> {
    Ok(path.parent().ok_or("Database folder is unavailable")?.join("time-to-lock-in-backups"))
}

fn snapshots(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("ttli-") && name.ends_with(".db") && name.len() == 18
            && entry.file_type().map_err(|error| error.to_string())?.is_file()
        {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn data_profile(connection: &Connection) -> Result<(i64, Option<i64>, i64, i64), String> {
    connection.query_row(
        "SELECT (SELECT count(*) FROM segments), (SELECT min(ts_start) FROM segments),
                (SELECT count(*) FROM rules), (SELECT count(*) FROM categories)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| error.to_string())
}

fn check_against_snapshot(source: &Connection, snapshot: &Path) -> Result<(), String> {
    let snapshot = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let (segments, oldest, rules, categories) = data_profile(source)?;
    let (prior_segments, prior_oldest, prior_rules, prior_categories) = data_profile(&snapshot)?;
    let history_missing = prior_segments > 0 && (segments == 0
        || oldest.zip(prior_oldest).is_some_and(|(current, prior)| current.saturating_sub(prior) >= 86_400_000));
    let rules_and_categories_missing = prior_rules > 0 && rules == 0 && categories < prior_categories;
    if history_missing || rules_and_categories_missing {
        return Err("TTL found history or rules in a backup that are missing from the working database. The backup was preserved.".into());
    }
    Ok(())
}

pub fn check_startup() -> Result<(), String> {
    let path = crate::db::database_path()?;
    let backups = snapshots(&backup_folder(&path)?)?;
    let Some(latest) = backups.last() else { return Ok(()); };
    if !path.is_file() || std::fs::metadata(&path).map_err(|error| error.to_string())?.len() == 0 {
        return Err("The TTL database is missing or empty. Existing backups were preserved.".into());
    }
    let database = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    check_against_snapshot(&database, latest)
}

pub fn backup_daily() -> Result<(), String> {
    let path = crate::db::database_path()?;
    let folder = backup_folder(&path)?;
    let previous = snapshots(&folder)?;
    let source = crate::db::open()?;
    let day: String = source.query_row("SELECT date('now','localtime')", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let destination = folder.join(format!("ttli-{day}.db"));
    if let Some(latest) = previous.last() {
        check_against_snapshot(&source, latest)?;
    }
    if destination.exists() { return Ok(()); }
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let temporary = folder.join(format!("ttli-{day}-{}.partial", uuid::Uuid::new_v4()));
    let result = checked_snapshot(&source, &temporary)
        .and_then(|_| std::fs::rename(&temporary, &destination).map_err(|error| error.to_string()));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result?;
    // Удаляем только наши старые снимки и только после успешного нового снимка.
    let current = snapshots(&folder)?;
    let excess = current.len().saturating_sub(14);
    for path in current.into_iter().take(excess) { let _ = std::fs::remove_file(path); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_includes_committed_wal_and_survives_source_changes() {
        let root = std::env::temp_dir().join(format!("ttli-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = Connection::open(root.join("source.db")).unwrap();
        source.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);").unwrap();
        checked_snapshot(&source, &root.join("snapshot.db")).unwrap();
        source.execute("INSERT INTO items VALUES(2)", []).unwrap();
        let target = Connection::open(root.join("snapshot.db")).unwrap();
        assert_eq!(target.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(target.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
        drop(target);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}
