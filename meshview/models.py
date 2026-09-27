from datetime import date

from sqlalchemy import BigInteger, Date, ForeignKey, Index, desc
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(AsyncAttrs, DeclarativeBase):
    pass


# Node
class Node(Base):
    __tablename__ = "node"
    id: Mapped[str] = mapped_column(primary_key=True)
    node_id: Mapped[int] = mapped_column(BigInteger, nullable=True, unique=True)
    long_name: Mapped[str] = mapped_column(nullable=True)
    short_name: Mapped[str] = mapped_column(nullable=True)
    hw_model: Mapped[str] = mapped_column(nullable=True)
    firmware: Mapped[str] = mapped_column(nullable=True)
    role: Mapped[str] = mapped_column(nullable=True)
    last_lat: Mapped[int] = mapped_column(BigInteger, nullable=True)
    last_long: Mapped[int] = mapped_column(BigInteger, nullable=True)
    channel: Mapped[str] = mapped_column(nullable=True)
    is_mqtt_gateway: Mapped[bool] = mapped_column(nullable=True)
    first_seen_us: Mapped[int] = mapped_column(BigInteger, nullable=True)
    last_seen_us: Mapped[int] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_node_node_id", "node_id"),
        Index("idx_node_first_seen_us", "first_seen_us"),
        Index("idx_node_last_seen_us", "last_seen_us"),
    )

    def to_dict(self):
        return {column.name: getattr(self, column.name) for column in self.__table__.columns}


class Packet(Base):
    __tablename__ = "packet"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    portnum: Mapped[int] = mapped_column(nullable=True)
    from_node_id: Mapped[int] = mapped_column(BigInteger, nullable=True)
    from_node: Mapped["Node"] = relationship(
        primaryjoin="Packet.from_node_id == foreign(Node.node_id)", lazy="joined"
    )
    to_node_id: Mapped[int] = mapped_column(BigInteger, nullable=True)
    to_node: Mapped["Node"] = relationship(
        primaryjoin="Packet.to_node_id == foreign(Node.node_id)",
        lazy="joined",
        overlaps="from_node",
    )
    payload: Mapped[bytes] = mapped_column(nullable=True)
    import_time_us: Mapped[int] = mapped_column(BigInteger, nullable=True)
    channel: Mapped[str] = mapped_column(nullable=True)

    __table_args__ = (
        Index("idx_packet_from_node_id", "from_node_id"),
        Index("idx_packet_to_node_id", "to_node_id"),
        Index("idx_packet_import_time_us", desc("import_time_us")),
        Index("idx_packet_from_node_time_us", "from_node_id", desc("import_time_us")),
        # portnum and channel are filter columns on hot endpoints (/api/edges
        # neighbor lookup, /api/packets, /api/stats) but were previously
        # unindexed, forcing a full scan of the packet table.
        Index("idx_packet_portnum_time_us", "portnum", desc("import_time_us")),
        Index("idx_packet_channel", "channel"),
    )


class PacketSeen(Base):
    __tablename__ = "packet_seen"
    packet_id = mapped_column(ForeignKey("packet.id"), primary_key=True)
    node_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    node: Mapped["Node"] = relationship(
        lazy="joined",
        primaryjoin="PacketSeen.node_id == foreign(Node.node_id)",
        overlaps="from_node,to_node",
    )
    rx_time: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hop_limit: Mapped[int] = mapped_column(nullable=True)
    hop_start: Mapped[int] = mapped_column(nullable=True)
    channel: Mapped[str] = mapped_column(nullable=True)
    rx_snr: Mapped[float] = mapped_column(nullable=True)
    rx_rssi: Mapped[int] = mapped_column(nullable=True)
    topic: Mapped[str] = mapped_column(nullable=True)
    import_time_us: Mapped[int] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_packet_seen_node_id", "node_id"),
        # Index for /top endpoint performance - JOIN on packet_id
        Index("idx_packet_seen_packet_id", "packet_id"),
        Index("idx_packet_seen_import_time_us", "import_time_us"),
        # Per-node time-window lookups (node detail pages) would otherwise use
        # idx_packet_seen_node_id and then filter ~3.4M rows by time.
        Index("idx_packet_seen_node_time_us", "node_id", "import_time_us"),
    )


class Traceroute(Base):
    __tablename__ = "traceroute"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    packet_id = mapped_column(ForeignKey("packet.id"))
    packet: Mapped["Packet"] = relationship(
        primaryjoin="Traceroute.packet_id == foreign(Packet.id)", lazy="joined"
    )
    gateway_node_id: Mapped[int] = mapped_column(BigInteger, nullable=True)
    done: Mapped[bool] = mapped_column(nullable=True)
    route: Mapped[bytes] = mapped_column(nullable=True)
    route_return: Mapped[bytes] = mapped_column(nullable=True)
    import_time_us: Mapped[int] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_traceroute_packet_id", "packet_id"),
        Index("idx_traceroute_import_time_us", "import_time_us"),
        # NOTE: deliberately no unique index on (packet_id, gateway_node_id,
        # route). Exact duplicates run ~2.9% of rows, but route blobs average
        # 61 bytes, so the unique index would cost ~46MB to reclaim ~1.6MB.
        # Duplicates are bounded by the nightly retention cleanup rather than
        # accumulating, so there is nothing to prevent.
    )


class DailySnapshot(Base):
    __tablename__ = "daily_snapshot"

    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    node_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    packet_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    gateway_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    captured_at_us: Mapped[int] = mapped_column(BigInteger, nullable=False)
