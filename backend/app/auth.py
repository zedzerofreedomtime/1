from fastapi import Depends, Header, HTTPException
from sqlmodel import Session, select

from .config import settings
from .db import get_session
from .models import Device


def get_device(
    authorization: str = Header(default=None),
    session: Session = Depends(get_session),
) -> Device:
    """Resolve the calling device from its `Authorization: Bearer <token>` header."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, {"error": "no_token", "message": "missing bearer token"})
    token = authorization[len("Bearer ") :].strip()
    # The app substitutes the literal "tampered" when its signature check fails.
    if token == "tampered":
        raise HTTPException(403, {"error": "tampered", "message": "integrity check failed"})
    device = session.exec(select(Device).where(Device.token == token)).first()
    if not device or not device.active:
        raise HTTPException(403, {"error": "invalid_token", "message": "unknown or revoked token"})
    return device


def require_admin(x_admin_key: str = Header(default=None)) -> bool:
    if x_admin_key != settings.admin_key:
        raise HTTPException(401, {"error": "admin_required", "message": "invalid admin key"})
    return True
