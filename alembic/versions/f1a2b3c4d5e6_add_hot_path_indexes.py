"""Add indexes for hot query paths

Adds the filter-column indexes the polled API endpoints need:

* packet.portnum was unindexed, so the /api/edges neighbor lookup and any
  portnum-filtered /api/packets query scanned the whole packet table.
* packet.channel was unindexed, so channel-filtered stats scanned as well.
* packet_seen had an index on node_id and one on import_time_us, but not the
  composite -- per-node time-window lookups filtered a large row set by hand.

Created with IF NOT EXISTS so the migration is safe on databases where
create_all() already produced the index.

Revision ID: f1a2b3c4d5e6
Revises: e8f2c4b6d9a1
Create Date: 2026-07-22 11:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "e8f2c4b6d9a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


INDEXES = (
    (
        "idx_packet_portnum_time_us",
        "CREATE INDEX IF NOT EXISTS idx_packet_portnum_time_us "
        "ON packet (portnum, import_time_us DESC)",
    ),
    (
        "idx_packet_channel",
        "CREATE INDEX IF NOT EXISTS idx_packet_channel ON packet (channel)",
    ),
    (
        "idx_packet_seen_node_time_us",
        "CREATE INDEX IF NOT EXISTS idx_packet_seen_node_time_us "
        "ON packet_seen (node_id, import_time_us)",
    ),
)


def upgrade() -> None:
    for _, ddl in INDEXES:
        op.execute(ddl)


def downgrade() -> None:
    for name, _ in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
