"""Location modes: teleport, walking sim (A->B), drive (polyline), joystick."""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from geographiclib.geodesic import Geodesic

from device import DeviceSession

log = logging.getLogger(__name__)

# Per-mode push rate. CoreLocation will coalesce above ~10 Hz.
# Higher rate = smoother speed inference for apps like Life360.
PUSH_HZ = {"walk": 6.0, "drive": 10.0, "joystick": 10.0}
DEFAULT_HZ = 8.0

GEOD = Geodesic.WGS84


class Speed(float, Enum):
    walk = 1.4
    run = 3.0
    cycle = 6.0
    drive = 13.0


@dataclass
class LatLon:
    lat: float
    lon: float


@dataclass
class Progress:
    mode: str = "idle"
    distance_done_m: float = 0.0
    distance_total_m: float = 0.0
    speed_mps: float = 0.0
    eta_s: float = 0.0
    bearing_deg: float = 0.0


class LocationSimulator:
    def __init__(self, session: DeviceSession) -> None:
        self.session = session
        self._task: Optional[asyncio.Task] = None
        self._current = LatLon(0.0, 0.0)
        self._intended: Optional[LatLon] = None  # last-asked-for spot for keepalive
        self._lock_enabled = False
        self._joystick_vec = (0.0, 0.0)
        self._joystick_speed = 0.0
        self.progress = Progress()
        self._lock = asyncio.Lock()
        self._watchdog: Optional[asyncio.Task] = None

    @property
    def current(self) -> LatLon:
        return self._current

    async def stop(self) -> None:
        async with self._lock:
            if self._task and not self._task.done():
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
            self._task = None
            self.progress = Progress()

    async def reset(self) -> None:
        await self.stop()
        await self.stop_lock()
        self._intended = None
        await self.session.sim.clear()

    def lock_enabled(self) -> bool:
        return self._lock_enabled

    async def start_lock(self) -> None:
        self._lock_enabled = True
        if self._watchdog and not self._watchdog.done():
            return
        self._watchdog = asyncio.create_task(self._lock_loop())

    async def stop_lock(self) -> None:
        self._lock_enabled = False
        if self._watchdog and not self._watchdog.done():
            self._watchdog.cancel()
            try:
                await self._watchdog
            except asyncio.CancelledError:
                pass
        self._watchdog = None

    async def _lock_loop(self) -> None:
        """Every 4s, re-push intended location if no active mode + lock on.
        Auto-recovers from dead DVT session."""
        while self._lock_enabled:
            await asyncio.sleep(4.0)
            if not self._intended:
                continue
            # Skip if walk/drive/joystick already pushing.
            if self._task and not self._task.done():
                continue
            try:
                await self.session.sim.set(self._intended.lat, self._intended.lon)
                self._current = self._intended
            except Exception as exc:
                log.warning("lock heartbeat failed, reconnecting: %s", exc)
                try:
                    await self.session.close()
                    await self.session.connect()
                    await self.session.sim.set(self._intended.lat, self._intended.lon)
                    self._current = self._intended
                    log.info("lock recovered")
                except Exception as inner:
                    log.error("lock recovery failed: %s", inner)

    async def teleport(self, lat: float, lon: float) -> None:
        await self.stop()
        await self._push(lat, lon)
        self.progress = Progress(mode="teleport")

    async def walk(self, dst: LatLon, speed_mps: float) -> None:
        await self.stop()
        self._task = asyncio.create_task(self._linear_loop(dst, speed_mps, mode="walk"))

    async def drive(
        self,
        polyline: list[LatLon],
        speed_mps: float,
        life360: bool = False,
        segment_speeds: Optional[list[float]] = None,
    ) -> None:
        await self.stop()
        self._task = asyncio.create_task(
            self._drive_loop(polyline, speed_mps, life360, segment_speeds)
        )

    async def joystick_start(self) -> None:
        await self.stop()
        self._task = asyncio.create_task(self._joystick_loop())

    def joystick_set_vector(self, north_mps: float, east_mps: float) -> None:
        self._joystick_vec = (north_mps, east_mps)
        self._joystick_speed = math.hypot(north_mps, east_mps)

    async def _push(self, lat: float, lon: float) -> None:
        self._current = LatLon(lat, lon)
        self._intended = self._current
        await self.session.sim.set(lat, lon)

    async def _linear_loop(self, dst: LatLon, speed_mps: float, mode: str) -> None:
        interval = 1.0 / PUSH_HZ.get(mode, DEFAULT_HZ)
        src = self._current
        line = GEOD.InverseLine(src.lat, src.lon, dst.lat, dst.lon)
        total = line.s13
        bearing = line.azi1 % 360.0
        self.progress = Progress(mode=mode, distance_total_m=total, speed_mps=speed_mps,
                                 eta_s=total / max(speed_mps, 0.01), bearing_deg=bearing)
        if total < 0.5:
            await self._push(dst.lat, dst.lon)
            self.progress.distance_done_m = total
            return
        step_m = speed_mps * interval
        traveled = 0.0
        while traveled < total:
            traveled = min(traveled + step_m, total)
            pos = line.Position(traveled)
            await self._push(pos["lat2"], pos["lon2"])
            self.progress.distance_done_m = traveled
            self.progress.eta_s = max(0.0, (total - traveled) / max(speed_mps, 0.01))
            await asyncio.sleep(interval)

    async def _drive_loop(
        self,
        poly: list[LatLon],
        cap_mps: float,
        life360: bool,
        segment_speeds: Optional[list[float]] = None,
    ) -> None:
        """Animate along polyline. life360 adds jitter/var speed/stops/smooth bearing.
        segment_speeds[i] = m/s for segment i->i+1 (e.g. OSRM road maxspeed)."""
        interval = 1.0 / PUSH_HZ["drive"]
        if len(poly) < 2:
            return
        segs: list[tuple[LatLon, LatLon, float, float, float]] = []
        total = 0.0
        for i in range(len(poly) - 1):
            a, b = poly[i], poly[i + 1]
            line = GEOD.InverseLine(a.lat, a.lon, b.lat, b.lon)
            seg_target = (
                min(segment_speeds[i], cap_mps)
                if segment_speeds and i < len(segment_speeds) and segment_speeds[i] > 0.5
                else cap_mps
            )
            segs.append((a, b, line.s13, line.azi1 % 360.0, seg_target))
            total += line.s13

        self.progress = Progress(mode="drive", distance_total_m=total, speed_mps=cap_mps,
                                 eta_s=total / max(cap_mps, 0.01))
        await self._push(poly[0].lat, poly[0].lon)

        done = 0.0
        cur_mps = 0.0 if life360 else segs[0][4]
        cur_bearing = segs[0][3] if segs else 0.0
        for a, b, seg_len, bearing, seg_target in segs:
            if seg_len < 0.01:
                continue
            line = GEOD.InverseLine(a.lat, a.lon, b.lat, b.lon)
            # Random stop chance (traffic light / stop sign).
            if life360 and seg_len > 200 and random.random() < 0.06:
                stop_dur = random.uniform(6.0, 14.0)
                await self._idle_at_current(stop_dur, interval)
                cur_mps = 0.0

            traveled = 0.0
            while traveled < seg_len:
                if life360:
                    desired = seg_target * random.uniform(0.7, 1.15)
                    cur_mps += (desired - cur_mps) * 0.15
                    cur_bearing = _lerp_bearing(cur_bearing, bearing, 0.2)
                else:
                    # Smooth ramp toward seg_target so speed limit changes feel natural.
                    cur_mps += (seg_target - cur_mps) * 0.25
                    cur_bearing = bearing

                step_m = max(cur_mps, 0.5) * interval
                traveled = min(traveled + step_m, seg_len)
                pos = line.Position(traveled)
                lat, lon = pos["lat2"], pos["lon2"]
                if life360:
                    lat, lon = _jitter(lat, lon, sigma_m=2.5)
                await self._push(lat, lon)
                cur_done = done + traveled
                self.progress.distance_done_m = cur_done
                self.progress.speed_mps = cur_mps
                self.progress.bearing_deg = cur_bearing
                self.progress.eta_s = max(0.0, (total - cur_done) / max(cur_mps, 0.5))
                await asyncio.sleep(interval)
            done += seg_len
        self.progress.distance_done_m = total
        self.progress.eta_s = 0.0
        self.progress.speed_mps = 0.0

    async def _idle_at_current(self, dur_s: float, interval: float) -> None:
        """Hold position with tiny jitter — simulates stopped at light."""
        end = time.monotonic() + dur_s
        cur = self._current
        while time.monotonic() < end:
            lat, lon = _jitter(cur.lat, cur.lon, sigma_m=1.0)
            await self._push(lat, lon)
            self.progress.speed_mps = 0.0
            await asyncio.sleep(interval)

    async def _joystick_loop(self) -> None:
        interval = 1.0 / PUSH_HZ["joystick"]
        self.progress = Progress(mode="joystick")
        last = time.monotonic()
        while True:
            now = time.monotonic()
            dt = now - last
            last = now
            n, e = self._joystick_vec
            if n != 0.0 or e != 0.0:
                dist_m = math.hypot(n, e) * dt
                bearing = _bearing_deg(n, e)
                cur = self._current
                d = GEOD.Direct(cur.lat, cur.lon, bearing, dist_m)
                await self._push(d["lat2"], d["lon2"])
                self.progress.speed_mps = self._joystick_speed
                self.progress.bearing_deg = bearing
            else:
                await self._push(self._current.lat, self._current.lon)
                self.progress.speed_mps = 0.0
            await asyncio.sleep(interval)


def _bearing_deg(north_mps: float, east_mps: float) -> float:
    return (math.degrees(math.atan2(east_mps, north_mps)) + 360.0) % 360.0


def _jitter(lat: float, lon: float, sigma_m: float) -> tuple[float, float]:
    """Add gaussian GPS noise. 1m lat ≈ 1/111320 deg."""
    d_lat = random.gauss(0, sigma_m) / 111320.0
    d_lon = random.gauss(0, sigma_m) / (111320.0 * math.cos(math.radians(lat)))
    return lat + d_lat, lon + d_lon


def _lerp_bearing(a: float, b: float, t: float) -> float:
    """Shortest-path bearing interpolation."""
    diff = ((b - a + 540) % 360) - 180
    return (a + diff * t) % 360
