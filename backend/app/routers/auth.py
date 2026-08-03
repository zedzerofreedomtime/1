from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..models import Device

router = APIRouter(tags=["auth"])


@router.post("/api/discover")
def discover(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    """Device sends its token; we validate it and hand back the API base URL.

    Single-backend design: `server_url` is this server. (The original used a
    seed→locate hop to route to a per-customer VPS; we don't need that.)
    """
    token = (payload or {}).get("token", "").strip()
    device = session.exec(select(Device).where(Device.token == token)).first()
    if not device or not device.active:
        raise HTTPException(403, {"error": "invalid_token", "message": "unknown or revoked token"})
    return {
        "ok": True,
        "server_url": settings.server_url,
        "device_id": device.id,
        "member_id": device.member_id,
        "kind": "clipbot",
    }
