import json

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import Dataset, ExtToken, Item, now

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


def get_ext(
    x_extension_token: str = Header(default=None),
    authorization: str = Header(default=None),
    session: Session = Depends(get_session),
) -> ExtToken:
    tok = x_extension_token
    if not tok and authorization and authorization.startswith("Bearer "):
        tok = authorization[len("Bearer ") :].strip()
    if not tok:
        raise HTTPException(401, {"error": "no_ext_token", "message": "missing extension token"})
    ext = session.exec(select(ExtToken).where(ExtToken.token == tok)).first()
    if not ext or not ext.active:
        raise HTTPException(403, {"error": "invalid_ext_token", "message": "unknown or revoked extension token"})
    return ext


@router.post("/connect")
def connect(ext: ExtToken = Depends(get_ext), session: Session = Depends(get_session)):
    ext.last_seen = now()
    session.add(ext)
    session.commit()
    return {"ok": True, "name": ext.name}


@router.post("/reviews")
def ingest_reviews(
    payload: dict = Body(...),
    ext: ExtToken = Depends(get_ext),
    session: Session = Depends(get_session),
):
    """The capture extension pushes one product's scraped reviews + media.

    Body: {dataset_name?, product_id, product_url?, title?, price?,
           review_texts: [str], media: [{url, type, reviewTimestamp, reviewDate}]}
    Idempotent per (dataset, product_id): media is merged & de-duped by url.
    """
    ext.last_seen = now()
    session.add(ext)

    ds_name = payload.get("dataset_name") or "Scraped Reviews"
    ds = session.exec(select(Dataset).where(Dataset.name == ds_name)).first()
    if not ds:
        ds = Dataset(name=ds_name)
        session.add(ds)
        session.commit()
        session.refresh(ds)

    pid = int(payload["product_id"])
    it = session.exec(
        select(Item).where(Item.dataset_id == ds.id, Item.product_id == pid)
    ).first()
    if it is not None and it.status == "done":
        return {"ok": True, "dataset_id": ds.id, "item_status": "done", "skipped": True}
    if it is None:
        it = Item(dataset_id=ds.id, product_id=pid)

    merged = json.loads(it.media_json or "[]")
    by_url = {m.get("url"): m for m in merged if m.get("url")}
    seen = set(by_url)
    added = 0
    for m in payload.get("media", []) or []:
        url = (m or {}).get("url")
        if url and url not in seen:
            entry = {"url": url, "type": (m.get("type") or "image")}
            if m.get("reviewTimestamp") is not None:
                entry["reviewTimestamp"] = m.get("reviewTimestamp")
            if m.get("reviewDate"):
                entry["reviewDate"] = m.get("reviewDate")
            merged.append(entry)
            by_url[url] = entry
            seen.add(url)
            added += 1
        elif url and url in by_url:
            # A re-scrape can enrich legacy URL-only media with the review date.
            if m.get("reviewTimestamp") is not None:
                by_url[url]["reviewTimestamp"] = m.get("reviewTimestamp")
            if m.get("reviewDate"):
                by_url[url]["reviewDate"] = m.get("reviewDate")

    it.title = payload.get("title") or it.title
    it.price = str(payload.get("price") or it.price)
    it.product_url = payload.get("product_url") or it.product_url
    it.review_summary = (
        _summary(payload.get("title", ""), payload.get("price", ""),
                 payload.get("review_texts", []) or [])
        or it.review_summary
    )
    it.media_json = json.dumps(merged, ensure_ascii=False)
    session.add(it)
    session.commit()

    images = sum(1 for m in merged if m.get("type", "image") == "image")
    videos = sum(1 for m in merged if m.get("type") == "video")
    return {
        "ok": True,
        "dataset_id": ds.id,
        "product_id": pid,
        "media_total": len(merged),
        "media_added": added,
        "images": images,
        "videos": videos,
    }


def _summary(title: str, price: str, texts: list) -> str:
    parts = []
    if title:
        parts.append(f"ชื่อสินค้า: {title}")
    if price:
        parts.append(f"ราคา: {price}")
    good = [t.strip() for t in texts if t and str(t).strip()][:6]
    if good:
        parts.append("รีวิวจริงจากผู้ซื้อ:")
        parts += [f"- {str(t)[:160]}" for t in good]
    return "\n".join(parts)
