"""FastAPI app: WebSocket control + REST status/token."""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from device import DeviceSession, list_devices
from simulator import LatLon, LocationSimulator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spoofer")

TUNNELD_URL = "http://127.0.0.1:49151"

session = DeviceSession()
sim: LocationSimulator | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await session.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def ensure_session() -> LocationSimulator:
    global sim
    if sim is None:
        await session.connect()
        sim = LocationSimulator(session)
    return sim


@app.get("/health")
async def health() -> dict:
    tunnel = await _tunnel_status()
    return {"backend": "ok", "tunnel": tunnel}


@app.post("/reconnect")
async def reconnect(udid: str | None = None) -> dict:
    global sim
    await session.close()
    sim = None
    try:
        info = await session.connect(udid=udid)
    except Exception as exc:
        log.warning("reconnect failed: %s", exc)
        raise HTTPException(503, f"Reconnect failed: {exc}")
    return {"udid": info.udid, "name": info.name, "iosVersion": info.ios_version}


@app.post("/select-device")
async def select_device(udid: str) -> dict:
    global sim
    await session.close()
    sim = None
    try:
        info = await session.connect(udid=udid)
    except Exception as exc:
        raise HTTPException(503, f"Select failed: {exc}")
    return {"udid": info.udid, "name": info.name, "iosVersion": info.ios_version}


@app.get("/devices/all")
async def devices_all() -> dict:
    try:
        items = await list_devices()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {
        "devices": [
            {"udid": d.udid, "name": d.name, "productType": d.product_type, "iosVersion": d.ios_version}
            for d in items
        ],
        "active": session.udid(),
    }


@app.get("/devices")
async def devices() -> dict:
    try:
        info = await session.connect()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {
        "udid": info.udid,
        "name": info.name,
        "productType": info.product_type,
        "iosVersion": info.ios_version,
    }


@app.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    await socket.accept()
    try:
        s = await ensure_session()
    except Exception as exc:
        await socket.send_json({"type": "error", "message": str(exc)})
        await socket.close()
        return
    await socket.send_json({"type": "ready"})

    pump = asyncio.create_task(_progress_pump(s, socket))
    try:
        while True:
            msg = await socket.receive_json()
            await _dispatch(s, msg, socket)
    except WebSocketDisconnect:
        await s.stop()
    finally:
        pump.cancel()


async def _progress_pump(s: LocationSimulator, socket: WebSocket) -> None:
    """Stream live coord + progress at 4 Hz."""
    last_sent = None
    try:
        while True:
            await asyncio.sleep(0.25)
            p = s.progress
            payload = {
                "type": "progress",
                "lat": s.current.lat,
                "lon": s.current.lon,
                "mode": p.mode,
                "doneM": p.distance_done_m,
                "totalM": p.distance_total_m,
                "speedMps": p.speed_mps,
                "etaS": p.eta_s,
                "bearingDeg": p.bearing_deg,
            }
            if payload == last_sent:
                continue
            last_sent = payload
            await socket.send_json(payload)
    except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
        pass


DEVICE_CMDS = {"teleport", "walk", "drive", "joystick_start", "joystick_vec", "stop", "reset", "lock"}


async def _ensure_alive() -> bool:
    """Reconnect if session died. Returns True if alive after."""
    if session.is_alive():
        return True
    try:
        await session.connect()
        return True
    except Exception as exc:
        log.warning("auto-reconnect failed: %s", exc)
        return False


async def _dispatch(s: LocationSimulator, msg: dict, socket: WebSocket, _retry: bool = False) -> None:
    cmd = msg.get("cmd")
    if cmd in DEVICE_CMDS:
        if not await _ensure_alive():
            await socket.send_json({"type": "error", "message": "Device unreachable. Check USB/Trust/tunneld."})
            return
    try:
        if cmd == "teleport":
            await s.teleport(float(msg["lat"]), float(msg["lon"]))
        elif cmd == "walk":
            dst = LatLon(float(msg["lat"]), float(msg["lon"]))
            await s.walk(dst, float(msg.get("speed", 1.4)))
        elif cmd == "drive":
            poly = [LatLon(float(p[0]), float(p[1])) for p in msg["polyline"]]
            speeds = msg.get("segment_speeds")
            seg_speeds = [float(x) for x in speeds] if speeds else None
            await s.drive(poly, float(msg.get("speed", 13.0)), bool(msg.get("life360", False)), seg_speeds)
        elif cmd == "joystick_start":
            await s.joystick_start()
        elif cmd == "joystick_vec":
            s.joystick_set_vector(float(msg.get("n", 0.0)), float(msg.get("e", 0.0)))
        elif cmd == "stop":
            await s.stop()
        elif cmd == "reset":
            await s.reset()
        elif cmd == "lock":
            on = bool(msg.get("on", True))
            if on:
                await s.start_lock()
            else:
                await s.stop_lock()
            await socket.send_json({"type": "lock", "on": s.lock_enabled()})
            return
        elif cmd == "ping":
            await socket.send_json({"type": "pong"})
            return
        else:
            await socket.send_json({"type": "error", "message": f"unknown cmd {cmd}"})
            return
        await socket.send_json({
            "type": "state",
            "lat": s.current.lat,
            "lon": s.current.lon,
        })
    except RuntimeError as exc:
        if "Not connected" in str(exc) and not _retry:
            log.warning("session died mid-cmd, reconnecting + retry")
            await session.close()
            if await _ensure_alive():
                return await _dispatch(s, msg, socket, _retry=True)
        await socket.send_json({"type": "error", "message": str(exc)})
    except Exception as exc:
        log.exception("dispatch failed")
        await socket.send_json({"type": "error", "message": str(exc)})


async def _tunnel_status() -> str:
    def probe() -> str:
        try:
            with urllib.request.urlopen(f"{TUNNELD_URL}/", timeout=1.5) as r:
                return "up" if r.status < 500 else "error"
        except Exception:
            return "down"
    return await asyncio.to_thread(probe)
