from sqlalchemy import event, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from meshview import models

engine = None
async_session = None

# Write-side SQLite tuning.
#
# busy_timeout was previously 900_000ms (15 minutes). A stall that long is
# indistinguishable from a hang: ingestion silently stops and nothing reports
# it. 30s is long enough to ride out a checkpoint or cleanup and short enough
# that a real deadlock surfaces as an error.
#
# wal_autocheckpoint is left at the SQLite default (1000 pages) but is NOT
# relied upon: passive autocheckpoints are skipped whenever a reader holds a
# read mark, which with a polled web UI is essentially always. startdb.py runs
# an explicit periodic TRUNCATE checkpoint instead -- see checkpoint_wal().
SQLITE_WRITE_PRAGMAS = (
    "PRAGMA journal_mode=WAL;",
    "PRAGMA busy_timeout=30000;",  # ms
    "PRAGMA synchronous=NORMAL;",
    "PRAGMA cache_size=-32768;",  # 32 MiB page cache (default is 2)
    "PRAGMA temp_store=MEMORY;",
)


def init_database(database_connection_string):
    global engine, async_session

    url = make_url(database_connection_string)
    kwargs = {"echo": False}

    is_sqlite = url.drivername.startswith("sqlite")

    if is_sqlite:
        kwargs["connect_args"] = {"timeout": 30}  # seconds

    engine = create_async_engine(url, **kwargs)

    # Enforce SQLite pragmas on every new DB connection
    if is_sqlite:

        @event.listens_for(engine.sync_engine, "connect")
        def _set_sqlite_pragmas(dbapi_conn, _):
            cursor = dbapi_conn.cursor()
            for pragma in SQLITE_WRITE_PRAGMAS:
                cursor.execute(pragma)
            cursor.close()

    async_session = async_sessionmaker(engine, expire_on_commit=False)


async def checkpoint_wal(mode: str = "TRUNCATE") -> tuple[int, int, int] | None:
    """Force a WAL checkpoint and return (busy, wal_pages, reclaimed_pages).

    Returns None for non-SQLite backends. A ``busy`` value of 1 means the
    checkpoint could not fully complete because a reader held a read mark --
    the WAL was flushed but not truncated, and the caller should expect the
    file to still be large.
    """
    if engine is None or engine.dialect.name != "sqlite":
        return None

    # AUTOCOMMIT: a checkpoint must not run inside an open transaction.
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        result = await conn.execute(text(f"PRAGMA wal_checkpoint({mode});"))
        row = result.fetchone()

    if row is None:
        return None
    return (int(row[0]), int(row[1]), int(row[2]))


async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
