use rusqlite::{backup::Backup, Connection};
use std::path::Path;
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

pub fn backup_daily() -> Result<(), String> {
    let path = crate::db::database_path()?;
    let folder = path.parent().ok_or("Database folder is unavailable")?
        .join("time-to-lock-in-backups");
    let source = crate::db::open()?;
    let day: String = source.query_row("SELECT date('now','localtime')", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let destination = folder.join(format!("ttli-{day}.db"));
    if destination.exists() { return Ok(()); }
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let temporary = folder.join(format!("ttli-{day}-{}.partial", uuid::Uuid::new_v4()));
    let result = checked_snapshot(&source, &temporary)
        .and_then(|_| std::fs::rename(&temporary, &destination).map_err(|error| error.to_string()));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result?;
    // Удаляем только наши старые снимки и только после успешного нового снимка.
    let mut snapshots: Vec<_> = std::fs::read_dir(&folder).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("ttli-") && name.ends_with(".db") && name.len() == 18
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        }).collect();
    snapshots.sort_by_key(|entry| entry.file_name());
    let excess = snapshots.len().saturating_sub(14);
    for entry in snapshots.into_iter().take(excess) { let _ = std::fs::remove_file(entry.path()); }
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
