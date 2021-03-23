# matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
# Copyright (C) 2020-2021 Tulir Asokan, Andrew Ferrazzutti
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
from typing import Optional, Dict, TYPE_CHECKING, cast

from mautrix.bridge import BasePuppet
from mautrix.types import UserID
from mautrix.util.simple_template import SimpleTemplate

from .db import Puppet as DBPuppet
from .config import Config
from .rpc import Participant
from . import user as u

if TYPE_CHECKING:
    from .__main__ import MessagesBridge


class Puppet(DBPuppet, BasePuppet):
    by_mid: Dict[str, 'Puppet'] = {}
    hs_domain: str
    mxid_template: SimpleTemplate[str]

    bridge: 'MessagesBridge'
    config: Config

    default_mxid: UserID

    def __init__(self, mid: str, name: Optional[str] = None, avatar_url: Optional[str] = None,
                 is_registered: bool = False) -> None:
        super().__init__(mid=mid, name=name, avatar_url=avatar_url, is_registered=is_registered)
        self.log = self.log.getChild(mid)

        self.default_mxid = self.get_mxid_from_id(mid)
        self.intent = self.az.intent.user(self.default_mxid)

    @classmethod
    def init_cls(cls, bridge: 'MessagesBridge') -> None:
        cls.config = bridge.config
        cls.loop = bridge.loop
        cls.mx = bridge.matrix
        cls.az = bridge.az
        cls.bridge = bridge
        cls.hs_domain = cls.config["homeserver.domain"]
        cls.mxid_template = SimpleTemplate(cls.config["bridge.username_template"], "userid",
                                           prefix="@", suffix=f":{cls.hs_domain}", type=str)
        secret = cls.config["bridge.login_shared_secret"]
        if secret:
            cls.login_shared_secret_map[cls.hs_domain] = secret.encode("utf-8")
        cls.login_device_name = "LINE Bridge"

    async def update_info(self, info: Participant) -> None:
        update = False
        update = await self._update_name(info.name) or update
        update = await self._update_avatar(info.avatarURL) or update
        if update:
            await self.update()

    async def _update_name(self, name: str) -> bool:
        name = self.config["bridge.displayname_template"].format(displayname=name)
        if name != self.name:
            self.name = name
            await self.intent.set_displayname(self.name)
            return True
        return False

    async def _update_avatar(self, avatar_url: Optional[str]) -> bool:
        if avatar_url != self.avatar_url:
            self.avatar_url = avatar_url
            if avatar_url:
                # TODO set the avatar from bytes
                pass
            return True
        return False

    def _add_to_cache(self) -> None:
        self.by_mid[self.mid] = self

    async def save(self) -> None:
        await self.update()

    @classmethod
    async def get_by_mxid(cls, mxid: UserID, create: bool = True) -> Optional['Puppet']:
        mid = cls.get_id_from_mxid(mxid)
        if mid:
            return await cls.get_by_mid(mid, create)
        return None

    @classmethod
    def get_id_from_mxid(cls, mxid: UserID) -> Optional[str]:
        return cls.mxid_template.parse(mxid)

    @classmethod
    def get_mxid_from_id(cls, mid: str) -> UserID:
        return UserID(cls.mxid_template.format_full(mid))

    @classmethod
    async def get_by_mid(cls, mid: str, create: bool = True) -> Optional['Puppet']:
        # TODO Might need to parse a real id from "_OWN"
        try:
            return cls.by_mid[mid]
        except KeyError:
            pass

        puppet = cast(cls, await super().get_by_mid(mid))
        if puppet is not None:
            puppet._add_to_cache()
            return puppet

        if create:
            puppet = cls(mid)
            await puppet.insert()
            puppet._add_to_cache()
            return puppet

        return None

    @classmethod
    async def get_by_custom_mxid(cls, mxid: UserID) -> Optional['u.User']:
        # TODO double-puppeting
        #if mxid == cls.config["bridge.user"]:
        #    return await cls.bridge.get_user(mxid)
        return None
