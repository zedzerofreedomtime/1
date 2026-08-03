import json
from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..auth import get_device
from ..config import settings
from ..db import get_session
from ..models import Command, Dataset, Device, Item, StatusReport, now

router = APIRouter(prefix="/api/app", tags=["app"])


@router.get("/version")
def version():
    return {
        "ok": True,
        "latest_code": settings.app_latest_code,
        "latest_name": settings.app_latest_name,
        "min_code": 1,
        "force": False,
        "apk_url": "",
        "changelog": "",
    }


@router.get("/config")
def run_config(device: Device = Depends(get_device)):
    """Default run config pushed to devices (values taken from the v1.12 demo).
    Later this becomes per-device / per-campaign, editable from the dashboard."""
    return {"ok": True, "config": settings.default_run_config()}


@router.post("/heartbeat")
def heartbeat(
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    device.last_seen = now()
    device.last_label = (payload or {}).get("device_label")
    session.add(device)
    session.commit()
    return {"ok": True}


@router.post("/status")
def status(
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    r = StatusReport(
        device_id=device.id,
        run_state=payload.get("run_state", "idle"),
        stage=payload.get("stage", "-"),
        produced=int(payload.get("produced", 0) or 0),
        target=int(payload.get("target", 0) or 0),
        dataset_id=int(payload.get("dataset_id", 0) or 0),
        product_id=int(payload.get("product_id", 0) or 0),
        last_message=str(payload.get("last_message", ""))[:500],
    )
    session.add(r)
    session.commit()
    return {"ok": True}


# ---- Command queue ----

@router.get("/commands")
def get_commands(
    device_id: str = Query(default=None),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    cmd = session.exec(
        select(Command)
        .where(Command.device_id == device.id, Command.status == "pending")
        .order_by(Command.id)
    ).first()
    if not cmd:
        return {"command": None}
    cmd.delivered_at = now()
    session.add(cmd)
    session.commit()
    return {
        "command": {
            "id": str(cmd.id),
            "action": cmd.action,
            "params": json.loads(cmd.params_json or "{}"),
        }
    }


@router.post("/commands/ack")
def ack(
    payload: dict = Body(...),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    cid = payload.get("command_id")
    cmd = session.get(Command, int(cid)) if cid else None
    if cmd and cmd.device_id == device.id and cmd.status == "pending":
        cmd.status = "applied" if payload.get("result") == "applied" else "rejected"
        cmd.acked_at = now()
        cmd.ack_message = payload.get("message")
        session.add(cmd)
        session.commit()
    return {"ok": True}


# ---- Datasets & items ----

@router.get("/datasets")
def datasets(device: Device = Depends(get_device), session: Session = Depends(get_session)):
    out = []
    for d in session.exec(select(Dataset).where(Dataset.active == True)).all():  # noqa: E712
        items = session.exec(select(Item).where(Item.dataset_id == d.id)).all()
        pending = [it for it in items if it.status == "pending"]
        posted = [it for it in items if it.status == "done"]
        verified = [it for it in posted if it.posted_verified]
        out.append(
            {
                "id": d.id,
                "name": d.name,
                "product_count": len(items),
                "pending_count": len(pending),
                "my_posted": len(posted),
                # honest split so the dashboard never shows a false "posted" count
                "posted_count": len(posted),
                "verified_count": len(verified),
                "unverified_count": len(posted) - len(verified),
            }
        )
    return {"ok": True, "datasets": out}


@router.post("/datasets/auto-pick")
def auto_pick(
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    for d in session.exec(select(Dataset).where(Dataset.active == True)).all():  # noqa: E712
        has_pending = session.exec(
            select(Item).where(Item.dataset_id == d.id, Item.status == "pending")
        ).first()
        if has_pending:
            return {"ok": True, "dataset": {"id": d.id, "name": d.name}}
    return {"ok": False, "error": "no_dataset", "message": "no dataset with pending items"}


@router.post("/datasets/{dataset_id}/opened")
def opened(dataset_id: int, payload: dict = Body(default={}), device: Device = Depends(get_device)):
    return {"ok": True}


@router.post("/datasets/{dataset_id}/closed")
def closed(dataset_id: int, payload: dict = Body(default={}), device: Device = Depends(get_device)):
    return {"ok": True}


@router.get("/datasets/{dataset_id}/items")
def items(
    dataset_id: int,
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    its = session.exec(select(Item).where(Item.dataset_id == dataset_id)).all()
    return {
        "ok": True,
        "items": [
            {
                "product_id": it.product_id,
                "title": it.title,
                "price": it.price,
                "status": it.status,
                "video_review_count": 1,
                "product_url": it.product_url,
            }
            for it in its
        ],
    }


@router.get("/datasets/{dataset_id}/items/{item_id}")
def item_detail(
    dataset_id: int,
    item_id: int,
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    it = _find_item(session, dataset_id, item_id)
    if not it:
        raise HTTPException(404, {"error": "not_found", "message": "item not found"})
    media = json.loads(it.media_json or "[]")
    return {
        "ok": True,
        "product": {"name": it.title, "price": it.price, "product_id": it.product_id},
        # `media` is the scraped review images/videos the device downloads to compose.
        "media": media,
        "reviews": [],
        "video_reviews": [],
        "review_count": len(media),
        "video_review_count": sum(1 for m in media if m.get("type") == "video"),
        "summary": it.review_summary,
    }


@router.post("/datasets/{dataset_id}/items/{item_id}/start")
def item_start(
    dataset_id: int,
    item_id: int,
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    """Lock an item to this device. Returns 409/already_posted if another device
    holds a still-valid lock (TTL) — this is the cross-device exclusion the
    original delegated entirely to the server but never bounded with a TTL."""
    it = _find_item(session, dataset_id, item_id)
    if not it:
        raise HTTPException(404, {"error": "not_found", "message": "item not found"})
    if it.status == "done":
        raise HTTPException(409, {"error": "already_posted", "message": "item already done"})
    ttl = timedelta(seconds=settings.lock_ttl_sec)
    lock_valid = it.locked_by and it.locked_at and (now() - it.locked_at) < ttl
    # A device request is not an administrative action.  Letting a client set
    # `force` would let any valid device steal active work from another device.
    if lock_valid and it.locked_by != device.id:
        raise HTTPException(409, {"error": "already_posted", "message": "locked by another device"})
    it.locked_by = device.id
    it.locked_at = now()
    session.add(it)
    session.commit()
    return {"ok": True}


@router.post("/datasets/{dataset_id}/items/{item_id}/done")
def item_done(
    dataset_id: int,
    item_id: int,
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    it = _find_item(session, dataset_id, item_id)
    if not it:
        raise HTTPException(404, {"error": "not_found", "message": "item not found"})
    if it.status == "done":
        raise HTTPException(409, {"error": "already_posted", "message": "item already done"})
    if it.locked_by != device.id:
        raise HTTPException(409, {"error": "not_lock_owner", "message": "item is not locked by this device"})

    # `verified` = the device actually confirmed the post went live (e.g. saw
    # the upload-complete / posted screen), NOT merely that Publish was tapped.
    verified = bool(payload.get("verified", False))
    it.status = "done"
    it.post_state = "posted" if verified else "rendered"
    it.posted_verified = verified
    it.post_message = str(payload.get("post_message", ""))[:500]
    it.post_ref = str(payload.get("post_ref", ""))[:300]
    it.done_by = device.id
    it.done_at = now()
    if verified:
        it.posted_at = now()
    it.locked_by = None
    it.locked_at = None
    session.add(it)
    session.commit()
    return {"ok": True}


@router.post("/datasets/{dataset_id}/items/{item_id}/release")
def item_release(
    dataset_id: int,
    item_id: int,
    payload: dict = Body(default={}),
    device: Device = Depends(get_device),
    session: Session = Depends(get_session),
):
    it = _find_item(session, dataset_id, item_id)
    if it and it.locked_by == device.id:
        it.locked_by = None
        it.locked_at = None
        session.add(it)
        session.commit()
    return {"ok": True}


def _find_item(session: Session, dataset_id: int, product_id: int):
    return session.exec(
        select(Item).where(Item.dataset_id == dataset_id, Item.product_id == product_id)
    ).first()
