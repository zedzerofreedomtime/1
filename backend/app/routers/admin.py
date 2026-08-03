import json

from fastapi import APIRouter, Body, Depends, Query
from sqlmodel import Session, select

from ..auth import require_admin
from ..db import get_session
from ..models import Command, Dataset, Device, ExtToken, Item, StatusReport, new_ext_token, new_token

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.post("/devices")
def create_device(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    d = Device(name=(payload or {}).get("name", "device"), token=new_token())
    session.add(d)
    session.commit()
    session.refresh(d)
    return {"ok": True, "device_id": d.id, "name": d.name, "token": d.token}


@router.get("/devices")
def list_devices(session: Session = Depends(get_session)):
    return {
        "ok": True,
        "devices": [
            {"id": d.id, "name": d.name, "active": d.active, "last_seen": str(d.last_seen)}
            for d in session.exec(select(Device)).all()
        ],
    }


@router.post("/devices/{device_id}/revoke")
def revoke(device_id: int, session: Session = Depends(get_session)):
    d = session.get(Device, device_id)
    if d:
        d.active = False
        session.add(d)
        session.commit()
    return {"ok": True}


@router.post("/ext-tokens")
def create_ext_token(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    e = ExtToken(name=(payload or {}).get("name", "extension"), token=new_ext_token())
    session.add(e)
    session.commit()
    session.refresh(e)
    return {"ok": True, "ext_token_id": e.id, "name": e.name, "token": e.token}


@router.get("/ext-tokens")
def list_ext_tokens(session: Session = Depends(get_session)):
    return {
        "ok": True,
        "ext_tokens": [
            {"id": e.id, "name": e.name, "active": e.active, "last_seen": str(e.last_seen)}
            for e in session.exec(select(ExtToken)).all()
        ],
    }


@router.post("/commands")
def push_command(payload: dict = Body(...), session: Session = Depends(get_session)):
    c = Command(
        device_id=int(payload["device_id"]),
        action=payload["action"],
        params_json=json.dumps(payload.get("params", {}), ensure_ascii=False),
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return {"ok": True, "command_id": c.id}


@router.post("/datasets")
def create_dataset(payload: dict = Body(...), session: Session = Depends(get_session)):
    d = Dataset(name=payload.get("name", "dataset"))
    session.add(d)
    session.commit()
    session.refresh(d)
    for it in payload.get("items", []):
        session.add(
            Item(
                dataset_id=d.id,
                product_id=int(it["product_id"]),
                title=it.get("title", ""),
                price=it.get("price", ""),
                product_url=it.get("product_url", ""),
                review_summary=it.get("review_summary", ""),
            )
        )
    session.commit()
    return {"ok": True, "dataset_id": d.id, "items": len(payload.get("items", []))}


@router.get("/status")
def latest_status(device_id: int = Query(...), session: Session = Depends(get_session)):
    r = session.exec(
        select(StatusReport)
        .where(StatusReport.device_id == device_id)
        .order_by(StatusReport.id.desc())
    ).first()
    return {"ok": True, "status": (r.model_dump() if r else None)}
