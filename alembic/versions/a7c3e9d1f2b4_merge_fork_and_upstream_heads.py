"""merge fork hot path indexes with upstream 4.0.0 migrations

Revision ID: a7c3e9d1f2b4
Revises: f1a2b3c4d5e6, 44612e74a798
Create Date: 2026-11-11 12:00:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "a7c3e9d1f2b4"
down_revision: str | tuple[str, ...] | None = ("f1a2b3c4d5e6", "44612e74a798")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Joins the two migration branches; no schema changes of its own.
    pass


def downgrade() -> None:
    pass
