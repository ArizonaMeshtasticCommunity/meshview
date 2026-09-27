import asyncio
import datetime
import gzip
import json
import logging
import shutil
from pathlib import Path

from sqlalchemy import delete, select, text
from sqlalchemy.engine.url import make_url

from meshview import migrations, models, mqtt_database, mqtt_reader, mqtt_store
from meshview.config import CONFIG
from meshview.deps import check_optional_deps

# -------------------------
# Basic logging configuration
# -------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(filename)s:%(lineno)d [pid:%(process)d] %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# -------------------------
# Logging for cleanup
# -------------------------
cleanup_logger = logging.getLogger("dbcleanup")
cleanup_logger.setLevel(logging.INFO)
cleanup_logfile = CONFIG.get("logging", {}).get("db_cleanup_logfile", "dbcleanup.log")
file_handler = logging.FileHandler(cleanup_logfile)
file_handler.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
file_handler.setFormatter(formatter)
cleanup_logger.addHandler(file_handler)
cleanup_status_file = str(Path(cleanup_logfile).with_suffix(".status.json"))
backup_status_file = str(Path(cleanup_logfile).with_name("dbbackup.status.json"))


# -------------------------
# Helper functions
# -------------------------
def get_bool(config, section, key, default=False):
    return str(config.get(section, {}).get(key, default)).lower() in ("1", "true", "yes", "on")


def get_int(config, section, key, default=0):
    try:
        return int(config.get(section, {}).get(key, default))
    except ValueError:
        return default


def _rowcount(value):
    return value if value is not None and value >= 0 else None


def write_cleanup_status(status: dict) -> None:
    status_path = Path(cleanup_status_file)
    tmp_path = status_path.with_suffix(f"{status_path.suffix}.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
        tmp_path.replace(status_path)
    except Exception as e:
        cleanup_logger.warning(f"Failed to write cleanup status file: {e}")


def write_backup_status(status: dict) -> None:
    status_path = Path(backup_status_file)
    tmp_path = status_path.with_suffix(f"{status_path.suffix}.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
        tmp_path.replace(status_path)
    except Exception as e:
        cleanup_logger.warning(f"Failed to write backup status file: {e}")


# -------------------------
# Shared DB lock
# -------------------------
db_lock = asyncio.Lock()


# -------------------------
# WAL checkpointing
# -------------------------
async def periodic_wal_checkpoint(interval_seconds: int = 300):
    """Force a TRUNCATE checkpoint on a fixed interval.

    SQLite's automatic checkpointing is passive: it is skipped whenever any
    reader holds a read mark. The web process polls on a few-second interval,
    so in practice a read mark is almost always held and the WAL grows without
    bound -- it was observed at 704MB against a 631MB database, which puts a
    ~170k-frame wal-index in front of every single read.

    An explicit checkpoint still yields to readers (busy=1 below), but running
    it on a schedule means it eventually lands in a quiet moment. Taking the
    ingest lock keeps this from competing with a write transaction.
    """
    consecutive_busy = 0

    while True:
        await asyncio.sleep(interval_seconds)

        try:
            async with db_lock:
                result = await mqtt_database.checkpoint_wal("TRUNCATE")

            if result is None:
                return  # not SQLite; nothing to do

            busy, wal_pages, reclaimed = result

            if busy:
                consecutive_busy += 1
                # Only start complaining once it is clearly not transient.
                if consecutive_busy in (3, 12) or consecutive_busy % 48 == 0:
                    cleanup_logger.warning(
                        f"WAL checkpoint blocked by a reader {consecutive_busy} times in a row "
                        f"(wal={wal_pages} pages, reclaimed={reclaimed}). "
                        "The WAL cannot be truncated while a read mark is held."
                    )
            else:
                if consecutive_busy:
                    cleanup_logger.info(
                        f"WAL checkpoint succeeded after {consecutive_busy} blocked attempts"
                    )
                consecutive_busy = 0

        except Exception as e:
            cleanup_logger.error(f"Error during WAL checkpoint: {e}")


# -------------------------
# Database backup function
# -------------------------
async def backup_database(database_url: str, backup_dir: str = ".", keep: int = 7) -> None:
    """
    Create a consistent, compressed backup of the database.

    Uses SQLite's ``VACUUM INTO``, which takes a transactionally consistent
    snapshot of a live database and writes an already-compacted copy. The
    previous implementation copied the raw file with shutil while writes were
    in flight and ignored the -wal file entirely, which produces a torn backup
    that is missing all un-checkpointed data. Do not reintroduce that.

    Args:
        database_url: SQLAlchemy connection string
        backup_dir: Directory to store backups (default: current directory)
    """
    snapshot_file = None
    backup_status = {
        "status": "running",
        "started_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "completed_at": None,
        "backup_dir": backup_dir,
        "database_path": None,
        "backup_file": None,
        "original_size_bytes": None,
        "compressed_size_bytes": None,
        "compression_percent": None,
        "error": None,
    }
    write_backup_status(backup_status)

    try:
        url = make_url(database_url)
        if not url.drivername.startswith("sqlite"):
            cleanup_logger.warning("Backup only supported for SQLite databases")
            backup_status["status"] = "unsupported"
            backup_status["error"] = "Backup only supported for SQLite databases"
            return

        if not url.database or url.database == ":memory:":
            cleanup_logger.error("Could not extract database path from connection string")
            backup_status["status"] = "error"
            backup_status["error"] = "Could not extract database path from connection string"
            return

        db_file = Path(url.database)
        backup_status["database_path"] = str(db_file)
        if not db_file.exists():
            cleanup_logger.error(f"Database file not found: {db_file}")
            backup_status["status"] = "error"
            backup_status["error"] = f"Database file not found: {db_file}"
            return

        # Create backup directory if it doesn't exist
        backup_path = Path(backup_dir)
        backup_path.mkdir(parents=True, exist_ok=True)

        # Generate backup filename with timestamp
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = f"{db_file.stem}_backup_{timestamp}"
        snapshot_file = backup_path / f"{stem}.db"
        backup_file = backup_path / f"{stem}.db.gz"
        backup_status["backup_file"] = str(backup_file)

        cleanup_logger.info(f"Creating backup: {backup_file}")

        # Prune before writing, so retention frees space for the run about to
        # happen rather than only for the next one.
        prune_old_backups(str(backup_path), keep)

        # Need room for the uncompressed snapshot plus its gzip, with headroom.
        if not check_disk_space(str(backup_path), int(db_file.stat().st_size * 1.6)):
            backup_status["status"] = "error"
            backup_status["error"] = "insufficient disk space"
            return

        # VACUUM INTO refuses to overwrite an existing file.
        if snapshot_file.exists():
            snapshot_file.unlink()

        # Consistent snapshot of the live database (read-only wrt the source).
        # VACUUM cannot run inside a transaction, hence AUTOCOMMIT.
        async with mqtt_database.engine.connect() as conn:
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text("VACUUM INTO :target"), {"target": str(snapshot_file)})

        snapshot_size = snapshot_file.stat().st_size

        # Compress the snapshot, then drop the intermediate.
        with open(snapshot_file, 'rb') as f_in:
            with gzip.open(backup_file, 'wb', compresslevel=6) as f_out:
                shutil.copyfileobj(f_in, f_out)

        snapshot_file.unlink()
        snapshot_file = None

        # Get file sizes for logging
        original_size_bytes = snapshot_size
        compressed_size_bytes = backup_file.stat().st_size
        original_size = original_size_bytes / (1024 * 1024)  # MB
        compressed_size = compressed_size_bytes / (1024 * 1024)  # MB
        compression_ratio = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0
        backup_status["original_size_bytes"] = original_size_bytes
        backup_status["compressed_size_bytes"] = compressed_size_bytes
        backup_status["compression_percent"] = round(compression_ratio, 1)
        backup_status["status"] = "ok"

        cleanup_logger.info(
            f"Backup created successfully: {backup_file.name} "
            f"({original_size:.2f} MB -> {compressed_size:.2f} MB, "
            f"{compression_ratio:.1f}% compression)"
        )

    except Exception as e:
        cleanup_logger.error(f"Error creating database backup: {e}")
        backup_status["status"] = "error"
        backup_status["error"] = str(e)
    finally:
        # Never leave a half-written snapshot behind to fill the disk.
        if snapshot_file is not None and snapshot_file.exists():
            try:
                snapshot_file.unlink()
            except OSError as e:
                cleanup_logger.warning(f"Could not remove partial snapshot {snapshot_file}: {e}")
        backup_status["completed_at"] = datetime.datetime.now(datetime.UTC).isoformat()
        write_backup_status(backup_status)


def prune_old_backups(backup_dir: str, keep: int) -> None:
    """Delete all but the newest ``keep`` backups.

    Without this the daily job accumulates indefinitely. At ~200MB compressed
    per run that fills the remaining disk in a matter of weeks, and a full
    disk breaks ingestion, checkpointing and the backup itself at once.

    keep <= 0 disables pruning.
    """
    if keep <= 0:
        return

    try:
        backups = sorted(
            Path(backup_dir).glob("*_backup_*.db.gz"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError as e:
        cleanup_logger.warning(f"Could not list backups in {backup_dir}: {e}")
        return

    for stale in backups[keep:]:
        try:
            size_mb = stale.stat().st_size / (1024 * 1024)
            stale.unlink()
            cleanup_logger.info(f"Pruned old backup: {stale.name} ({size_mb:.2f} MB)")
        except OSError as e:
            cleanup_logger.warning(f"Could not remove old backup {stale}: {e}")


def check_disk_space(path: str, need_bytes: int) -> bool:
    """Return True if ``path`` has room for ``need_bytes``, logging if not."""
    try:
        free = shutil.disk_usage(path).free
    except OSError as e:
        cleanup_logger.warning(f"Could not check free space on {path}: {e}")
        return True  # don't block the backup on a stat failure

    if free < need_bytes:
        cleanup_logger.error(
            f"Insufficient disk space for backup: {free / 1024**3:.2f} GB free, "
            f"need ~{need_bytes / 1024**3:.2f} GB. Skipping backup."
        )
        return False
    return True


# -------------------------
# Database backup scheduler
# -------------------------
async def daily_backup_at(hour: int = 2, minute: int = 0, backup_dir: str = ".", keep: int = 7):
    while True:
        now = datetime.datetime.now()
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            next_run += datetime.timedelta(days=1)
        delay = (next_run - now).total_seconds()
        cleanup_logger.info(f"Next backup scheduled at {next_run}")
        await asyncio.sleep(delay)

        database_url = CONFIG["database"]["connection_string"]
        await backup_database(database_url, backup_dir, keep)


# -------------------------
# Daily snapshot scheduler
# -------------------------
async def daily_snapshot_at(hour: int = 1, minute: int = 0):
    while True:
        now = datetime.datetime.now()
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            next_run += datetime.timedelta(days=1)
        delay = (next_run - now).total_seconds()
        cleanup_logger.info(f"Next daily snapshot scheduled at {next_run}")
        await asyncio.sleep(delay)

        try:
            async with db_lock:
                await mqtt_store.capture_daily_snapshot()
            cleanup_logger.info("Daily snapshot captured successfully.")
        except Exception as e:
            cleanup_logger.error(f"Error capturing daily snapshot: {e}")


# -------------------------
# Database cleanup using ORM
# -------------------------
async def daily_cleanup_at(
    hour: int = 2,
    minute: int = 0,
    days_to_keep: int = 14,
    vacuum_db: bool = True,
    wait_for_backup: bool = False,
):
    while True:
        now = datetime.datetime.now()
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            next_run += datetime.timedelta(days=1)
        delay = (next_run - now).total_seconds()
        cleanup_logger.info(f"Next cleanup scheduled at {next_run}")
        await asyncio.sleep(delay)

        # If backup is enabled, wait a bit to let backup complete first
        if wait_for_backup:
            cleanup_logger.info("Waiting 60 seconds for backup to complete...")
            await asyncio.sleep(60)

        cutoff_dt = (
            datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=days_to_keep)
        ).replace(tzinfo=None)
        cutoff_us = int(cutoff_dt.timestamp() * 1_000_000)
        cleanup_logger.info(f"Running cleanup for records older than {cutoff_dt.isoformat()}...")
        rows_deleted = {
            "packet": None,
            "packet_seen": None,
            "traceroute": None,
            "node": None,
        }
        cleanup_status = {
            "status": "running",
            "started_at": datetime.datetime.now(datetime.UTC).isoformat(),
            "completed_at": None,
            "cutoff_at": cutoff_dt.replace(tzinfo=datetime.UTC).isoformat(),
            "days_to_keep": days_to_keep,
            "vacuum_requested": vacuum_db,
            "vacuum_completed": False,
            "rows_deleted": rows_deleted,
            "error": None,
        }
        write_cleanup_status(cleanup_status)

        try:
            async with db_lock:  # Pause ingestion
                cleanup_logger.info("Ingestion paused for cleanup.")

                async with mqtt_database.async_session() as session:
                    # -------------------------
                    # Packet
                    # -------------------------
                    result = await session.execute(
                        delete(models.Packet).where(models.Packet.import_time_us < cutoff_us)
                    )
                    rows_deleted["packet"] = _rowcount(result.rowcount)
                    cleanup_logger.info(f"Deleted {result.rowcount} rows from Packet")

                    # -------------------------
                    # PacketSeen
                    # -------------------------
                    result = await session.execute(
                        delete(models.PacketSeen).where(
                            models.PacketSeen.import_time_us < cutoff_us
                        )
                    )
                    rows_deleted["packet_seen"] = _rowcount(result.rowcount)
                    cleanup_logger.info(f"Deleted {result.rowcount} rows from PacketSeen")

                    # -------------------------
                    # Traceroute
                    # -------------------------
                    result = await session.execute(
                        delete(models.Traceroute).where(
                            models.Traceroute.import_time_us < cutoff_us
                        )
                    )
                    rows_deleted["traceroute"] = _rowcount(result.rowcount)
                    cleanup_logger.info(f"Deleted {result.rowcount} rows from Traceroute")

                    # Traceroute and Packet are deleted on their own
                    # independent import_time_us cutoffs, so a traceroute
                    # imported just after its packet can outlive it and be
                    # left pointing at a row that no longer exists. Sweep
                    # those up rather than letting them accumulate.
                    orphan_packets = select(models.Packet.id).where(
                        models.Packet.id == models.Traceroute.packet_id
                    )
                    result = await session.execute(
                        delete(models.Traceroute).where(~orphan_packets.exists())
                    )
                    cleanup_logger.info(f"Deleted {result.rowcount} orphaned Traceroute rows")

                    # -------------------------
                    # Node
                    # -------------------------
                    result = await session.execute(
                        delete(models.Node).where(models.Node.last_seen_us < cutoff_us)
                    )
                    rows_deleted["node"] = _rowcount(result.rowcount)
                    cleanup_logger.info(f"Deleted {result.rowcount} rows from Node")

                    await session.commit()

                is_sqlite = mqtt_database.engine.dialect.name == "sqlite"

                # Always checkpoint after a bulk delete, whether or not VACUUM
                # is enabled -- the deletes just wrote a large amount of WAL.
                if is_sqlite:
                    result = await mqtt_database.checkpoint_wal("TRUNCATE")
                    if result:
                        busy, wal_pages, reclaimed = result
                        cleanup_logger.info(
                            f"Post-cleanup WAL checkpoint: busy={busy}, "
                            f"wal={wal_pages} pages, reclaimed={reclaimed} pages"
                        )
                        if busy:
                            cleanup_logger.warning(
                                "WAL checkpoint could not truncate (reader active). "
                                "VACUUM will likely fail for the same reason."
                            )

                if vacuum_db and is_sqlite:
                    # VACUUM needs an exclusive lock and rewrites the whole
                    # file. It is expected to fail while the web process holds
                    # connections open -- log that plainly instead of letting
                    # the outer handler swallow it, because a silently failing
                    # VACUUM is why the database never reclaims space.
                    cleanup_logger.info("Running VACUUM...")
                    try:
                        # engine.begin() opens a transaction; VACUUM cannot run
                        # inside one. This is a second reason the previous
                        # implementation never reclaimed space.
                        async with mqtt_database.engine.connect() as conn:
                            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
                            await conn.exec_driver_sql("VACUUM;")
                        cleanup_logger.info("VACUUM completed.")
                        cleanup_status["vacuum_completed"] = True
                    except Exception as e:
                        cleanup_logger.error(
                            f"VACUUM FAILED: {e}. Free pages were not reclaimed and the "
                            "database file will not shrink. This usually means another "
                            "process holds an open connection. Run VACUUM offline, or use "
                            "'VACUUM INTO' to produce a compacted copy."
                        )
                elif vacuum_db:
                    cleanup_logger.info("VACUUM skipped (not supported for this database).")

                cleanup_logger.info("Cleanup completed successfully.")
                cleanup_logger.info("Ingestion resumed after cleanup.")
                cleanup_status["status"] = "ok"

        except Exception as e:
            cleanup_logger.error(f"Error during cleanup: {e}")
            cleanup_status["status"] = "error"
            cleanup_status["error"] = str(e)
        finally:
            cleanup_status["completed_at"] = datetime.datetime.now(datetime.UTC).isoformat()
            write_cleanup_status(cleanup_status)


# -------------------------
# MQTT loading
# -------------------------
async def load_database_from_mqtt(
    mqtt_server: str,
    mqtt_port: int,
    topics: list,
    mqtt_user: str | None = None,
    mqtt_passwd: str | None = None,
):
    async for topic, env in mqtt_reader.get_topic_envelopes(
        mqtt_server, mqtt_port, topics, mqtt_user, mqtt_passwd
    ):
        async with db_lock:  # Block if cleanup is running
            await mqtt_store.process_envelope(topic, env)


# -------------------------
# Main function
# -------------------------
async def main():
    check_optional_deps()
    logger = logging.getLogger(__name__)

    # Initialize database
    database_url = CONFIG["database"]["connection_string"]
    mqtt_database.init_database(database_url)

    # Create migration status table
    await migrations.create_migration_status_table(mqtt_database.engine)

    # Set migration in progress flag
    await migrations.set_migration_in_progress(mqtt_database.engine, True)
    logger.info("Migration status set to 'in progress'")

    try:
        # Check if migrations are needed before running them
        logger.info("Checking for pending database migrations...")
        if await migrations.is_database_up_to_date(mqtt_database.engine, database_url):
            logger.info("Database schema is already up to date, skipping migrations")
        else:
            logger.info("Database schema needs updating, running migrations...")
            migrations.run_migrations(database_url)
            logger.info("Database migrations completed")

        # Create tables if needed (for backwards compatibility)
        logger.info("Creating database tables...")
        await mqtt_database.create_tables()
        logger.info("Database tables created")

        # Load MQTT gateway cache after DB init/migrations
        await mqtt_store.load_gateway_cache()

    finally:
        # Clear migration in progress flag
        logger.info("Clearing migration status...")
        await migrations.set_migration_in_progress(mqtt_database.engine, False)
        logger.info("Migration status cleared - database ready")

    mqtt_user = CONFIG["mqtt"].get("username") or None
    mqtt_passwd = CONFIG["mqtt"].get("password") or None
    mqtt_topics = json.loads(CONFIG["mqtt"]["topics"])

    cleanup_enabled = get_bool(CONFIG, "cleanup", "enabled", False)
    cleanup_days = get_int(CONFIG, "cleanup", "days_to_keep", 14)
    vacuum_db = get_bool(CONFIG, "cleanup", "vacuum", False)
    cleanup_hour = get_int(CONFIG, "cleanup", "hour", 2)
    cleanup_minute = get_int(CONFIG, "cleanup", "minute", 0)

    backup_enabled = get_bool(CONFIG, "cleanup", "backup_enabled", False)
    backup_dir = CONFIG.get("cleanup", {}).get("backup_dir", "./backups")
    backup_hour = get_int(CONFIG, "cleanup", "backup_hour", cleanup_hour)
    backup_minute = get_int(CONFIG, "cleanup", "backup_minute", cleanup_minute)
    backup_keep = get_int(CONFIG, "cleanup", "backup_keep", 7)
    snapshot_hour = get_int(CONFIG, "snapshot", "hour", 1)
    snapshot_minute = get_int(CONFIG, "snapshot", "minute", 0)

    checkpoint_seconds = get_int(CONFIG, "database", "wal_checkpoint_seconds", 300)

    logger.info(f"Starting MQTT ingestion from {CONFIG['mqtt']['server']}:{CONFIG['mqtt']['port']}")
    if cleanup_enabled:
        logger.info(
            f"Daily cleanup enabled: keeping {cleanup_days} days of data at {cleanup_hour:02d}:{cleanup_minute:02d}"
        )
    if backup_enabled:
        logger.info(
            f"Daily backups enabled: storing in {backup_dir} at "
            f"{backup_hour:02d}:{backup_minute:02d} (keeping {backup_keep})"
        )
    logger.info(f"Daily snapshots enabled: capturing at {snapshot_hour:02d}:{snapshot_minute:02d}")
    if checkpoint_seconds > 0:
        logger.info(f"WAL checkpoint interval: {checkpoint_seconds}s")
    else:
        logger.warning("WAL checkpointing is DISABLED; the -wal file will grow without bound")

    async with asyncio.TaskGroup() as tg:
        tg.create_task(
            load_database_from_mqtt(
                CONFIG["mqtt"]["server"],
                int(CONFIG["mqtt"]["port"]),
                mqtt_topics,
                mqtt_user,
                mqtt_passwd,
            )
        )

        # Keep the WAL bounded. Not optional for SQLite -- see the docstring.
        if checkpoint_seconds > 0:
            tg.create_task(periodic_wal_checkpoint(checkpoint_seconds))

        # Start backup task if enabled
        if backup_enabled:
            tg.create_task(daily_backup_at(backup_hour, backup_minute, backup_dir, backup_keep))

        # Start cleanup task if enabled (waits for backup if both run at same time)
        if cleanup_enabled:
            wait_for_backup = (
                backup_enabled
                and (backup_hour == cleanup_hour)
                and (backup_minute == cleanup_minute)
            )
            tg.create_task(
                daily_cleanup_at(
                    cleanup_hour, cleanup_minute, cleanup_days, vacuum_db, wait_for_backup
                )
            )

        tg.create_task(daily_snapshot_at(snapshot_hour, snapshot_minute))

        if not cleanup_enabled and not backup_enabled:
            cleanup_logger.info("Daily cleanup and backups are both disabled by configuration.")
            cleanup_logger.info("Daily snapshots remain enabled by schedule configuration.")


# -------------------------
# Entry point
# -------------------------
if __name__ == '__main__':
    asyncio.run(main())
