import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import Dataset, Item, ScrapeJob, now

router = APIRouter(prefix="/api/scrape", tags=["scrape"])


def _parse_shopee_url(url: str) -> tuple[str, str]:
    text = (url or "").strip()
    patterns = [
        r"/product/(\d+)/(\d+)",
        r"/shop/(\d+)/item/(\d+)",
        r"[?&]shopid=(\d+).*?[?&]itemid=(\d+)",
        r"i\.(\d+)\.(\d+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1), match.group(2)
    raise HTTPException(400, {"error": "bad_url", "message": "Shopee URL must include shop id and item id"})


def _dataset(session: Session, name: str) -> Dataset:
    ds = session.exec(select(Dataset).where(Dataset.name == name)).first()
    if not ds:
        ds = Dataset(name=name)
        session.add(ds)
        session.commit()
        session.refresh(ds)
    return ds


@router.post("/jobs")
def create_jobs(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    dataset_name = (payload.get("dataset_name") or "Shopee Scrape").strip() or "Shopee Scrape"
    urls = payload.get("urls") or []
    if isinstance(urls, str):
        urls = [line.strip() for line in urls.splitlines() if line.strip()]
    created = []
    for url in urls:
        shopid, itemid = _parse_shopee_url(str(url))
        job = ScrapeJob(dataset_name=dataset_name, product_url=str(url).strip(), shopid=shopid, itemid=itemid)
        session.add(job)
        session.commit()
        session.refresh(job)
        created.append(job.model_dump())
    return {"ok": True, "created": created}


@router.post("/next")
def next_job(session: Session = Depends(get_session)):
    job = session.exec(
        select(ScrapeJob).where(ScrapeJob.status == "pending").order_by(ScrapeJob.id)
    ).first()
    if not job:
        return {"ok": True, "job": None}
    job.status = "running"
    job.message = "sent to extension"
    job.updated_at = now()
    session.add(job)
    session.commit()
    session.refresh(job)
    return {
        "ok": True,
        "job": {
            "id": job.id,
            "product_url": job.product_url,
            "shopid": job.shopid,
            "itemid": job.itemid,
            "filter": job.filter,
        },
    }


@router.post("/ingest")
def ingest(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    job_id = payload.get("job_id")
    job = session.get(ScrapeJob, int(job_id)) if job_id else None
    dataset_name = job.dataset_name if job else (payload.get("dataset_name") or "Shopee Scrape")
    ds = _dataset(session, dataset_name)
    product_id = int(payload.get("product_id") or (job.itemid if job else 0))
    if not product_id:
        raise HTTPException(400, {"error": "missing_product", "message": "missing product id"})

    item = session.exec(select(Item).where(Item.dataset_id == ds.id, Item.product_id == product_id)).first()
    if item is None:
        item = Item(dataset_id=ds.id, product_id=product_id)

    merged = json.loads(item.media_json or "[]")
    by_url = {m.get("url"): m for m in merged if m.get("url")}
    added = 0
    for media in payload.get("media", []) or []:
        url = (media or {}).get("url")
        if not url:
            continue
        if url not in by_url:
            entry = {"url": url, "type": media.get("type") or "image"}
            if media.get("reviewTimestamp") is not None:
                entry["reviewTimestamp"] = media.get("reviewTimestamp")
            if media.get("reviewDate"):
                entry["reviewDate"] = media.get("reviewDate")
            merged.append(entry)
            by_url[url] = entry
            added += 1

    reviews = [str(t).strip() for t in (payload.get("review_texts") or []) if str(t).strip()]
    item.title = payload.get("title") or item.title
    item.price = str(payload.get("price") or item.price)
    item.product_url = payload.get("product_url") or item.product_url
    if reviews:
        item.review_summary = "\n".join(["รีวิวจริงจากผู้ซื้อ:", *[f"- {t[:180]}" for t in reviews[:8]]])
    item.media_json = json.dumps(merged, ensure_ascii=False)
    session.add(item)

    if job:
        job.title = item.title or job.title
        job.price = item.price or job.price
        job.reviews_count += len(reviews)
        job.media_count = len(merged)
        job.message = f"received {len(reviews)} reviews, +{added} media"
        job.updated_at = now()
        session.add(job)
    session.commit()
    return {"ok": True, "media_total": len(merged), "media_added": added}


@router.post("/{job_id}/done")
def done(job_id: int, payload: dict = Body(default={}), session: Session = Depends(get_session)):
    job = session.get(ScrapeJob, job_id)
    if job:
        job.status = "done"
        job.message = payload.get("message") or "done"
        job.updated_at = now()
        session.add(job)
        session.commit()
    return {"ok": True}


@router.post("/{job_id}/failed")
def failed(job_id: int, payload: dict = Body(default={}), session: Session = Depends(get_session)):
    job = session.get(ScrapeJob, job_id)
    if job:
        job.status = "failed"
        job.message = payload.get("message") or "failed"
        job.updated_at = now()
        session.add(job)
        session.commit()
    return {"ok": True}


@router.post("/status")
def status(payload: dict = Body(default={})):
    return {"ok": True}
