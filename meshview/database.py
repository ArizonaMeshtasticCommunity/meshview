from sqlalchemy import event
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from meshview import models

engine = None
async_session = None

# Read-side SQLite tuning.
#
# The web process is read-only but heavily polled: the map and firehose pages
# refresh every few seconds, so the same queries run once per viewer per
# interval. SQLite's defaults (2MB page cache, no mmap) mean every one of those
# reads goes back to the filesystem. These pragmas are applied per connection.
#
# busy_timeout matters most for reliability: without it, any read that lands
# while the ingest process holds a write lock fails immediately with
# "database is locked" and surfaces as a 500.
# NOTE ON SIZING: cache_size is per connection, so the worst case is
# cache_size * (pool_size + max_overflow). This host has ~3.4GB available with
# swap already in use, so the budget here is deliberately ~224MB rather than
# the 512MB a 64MiB cache would allow. mmap_size is file-backed and shared via
# the OS page cache, so it does not multiply the same way.
SQLITE_READ_PRAGMAS = (
    "PRAGMA busy_timeout=5000;",  # ms; wait out writer locks instead of erroring
    "PRAGMA cache_size=-32768;",  # 32 MiB page cache per connection (default is 2)
    "PRAGMA mmap_size=268435456;",  # 256 MiB memory-mapped read window
    "PRAGMA temp_store=MEMORY;",  # sorts/temp b-trees stay off disk
    "PRAGMA query_only=1;",  # belt-and-braces with the mode=ro URL below
)


def init_database(database_connection_string):
    global engine, async_session
    kwargs = {"echo": False}
    url = make_url(database_connection_string)
    connect_args = {}

    is_sqlite = url.drivername.startswith("sqlite")

    if is_sqlite:
        query = dict(url.query)
        query.setdefault("mode", "ro")
        url = url.set(query=query)
        connect_args["uri"] = True
        # Each aiosqlite connection is backed by a thread, so keep the pool
        # bounded rather than relying on the dialect default.
        kwargs["pool_size"] = 5
        kwargs["max_overflow"] = 2
        kwargs["pool_recycle"] = 3600

    if connect_args:
        kwargs["connect_args"] = connect_args

    engine = create_async_engine(url, **kwargs)

    if is_sqlite:

        @event.listens_for(engine.sync_engine, "connect")
        def _set_sqlite_read_pragmas(dbapi_conn, _):
            cursor = dbapi_conn.cursor()
            for pragma in SQLITE_READ_PRAGMAS:
                cursor.execute(pragma)
            cursor.close()

    async_session = async_sessionmaker(
        bind=engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )


async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.create_all)
