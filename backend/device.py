"""Device session lifecycle: tunneld discovery, DDI mount, DVT handshake.

pymobiledevice3 v9.x API.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from typing import Optional

from pymobiledevice3.exceptions import NoDeviceConnectedError
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import (
    LocationSimulation,
)
from pymobiledevice3.services.mobile_image_mounter import auto_mount
from pymobiledevice3.tunneld.api import get_tunneld_devices

log = logging.getLogger(__name__)


@dataclass
class DeviceInfo:
    udid: str
    name: str
    product_type: str
    ios_version: str


async def list_devices() -> list[DeviceInfo]:
    out = []
    for d in await get_tunneld_devices():
        out.append(DeviceInfo(
            udid=getattr(d, "udid", "unknown"),
            name=getattr(d, "name", None) or getattr(d, "udid", "iPhone"),
            product_type=getattr(d, "product_type", "iPhone"),
            ios_version=getattr(d, "product_version", "unknown"),
        ))
    return out


class DeviceSession:
    """One open DVT channel to one iPhone."""

    def __init__(self) -> None:
        self._rsd = None
        self._dvt: Optional[DvtProvider] = None
        self._sim: Optional[LocationSimulation] = None
        self._lock = asyncio.Lock()

    async def connect(self, udid: Optional[str] = None) -> DeviceInfo:
        async with self._lock:
            if self._sim is not None and (udid is None or getattr(self._rsd, "udid", None) == udid):
                return self._info()

            devices = await get_tunneld_devices()
            if not devices:
                raise NoDeviceConnectedError(
                    "No tunneld device. Start tunneld as admin/root "
                    "(`pymobiledevice3 remote tunneld`) — see README."
                )
            if udid:
                chosen = next((d for d in devices if getattr(d, "udid", None) == udid), None)
                if not chosen:
                    raise NoDeviceConnectedError(f"UDID {udid} not in tunneld list")
            else:
                chosen = devices[0]
            self._rsd = chosen

            try:
                await auto_mount(self._rsd)
            except Exception as exc:
                log.warning("DDI auto-mount returned: %s", exc)

            self._dvt = DvtProvider(self._rsd)
            await self._dvt.__aenter__()
            self._sim = LocationSimulation(self._dvt)
            await self._sim.__aenter__()
            log.info("DVT session open: %s", self._rsd.udid)
            return self._info()

    def _info(self) -> DeviceInfo:
        r = self._rsd
        return DeviceInfo(
            udid=getattr(r, "udid", "unknown"),
            name=getattr(r, "name", None) or getattr(r, "udid", "iPhone"),
            product_type=getattr(r, "product_type", "iPhone"),
            ios_version=getattr(r, "product_version", "unknown"),
        )

    def udid(self) -> Optional[str]:
        return getattr(self._rsd, "udid", None) if self._rsd else None

    def is_alive(self) -> bool:
        return self._sim is not None

    @property
    def sim(self) -> LocationSimulation:
        if self._sim is None:
            raise RuntimeError("Not connected. Call connect() first.")
        return self._sim

    async def close(self) -> None:
        async with self._lock:
            if self._sim is not None:
                try:
                    await self._sim.clear()
                except Exception:
                    pass
                try:
                    await self._sim.__aexit__(None, None, None)
                except Exception:
                    pass
            if self._dvt is not None:
                try:
                    await self._dvt.__aexit__(None, None, None)
                except Exception:
                    pass
            self._sim = None
            self._dvt = None
            self._rsd = None
