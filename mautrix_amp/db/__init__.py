from mautrix.util.async_db import Database

from .upgrade import upgrade_table
from .user import User
from .puppet import Puppet
from .portal import Portal
from .message import Message


def init(db: Database) -> None:
    for table in (User, Puppet, Portal, Message):
        table.db = db


__all__ = ["upgrade_table", "User", "Puppet", "Portal", "Message"]
