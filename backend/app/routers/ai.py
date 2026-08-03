import json

import httpx
from fastapi import APIRouter, Body, Depends

from ..auth import get_device
from ..config import settings
from ..models import Device

router = APIRouter(prefix="/api/app/ai", tags=["ai"])

_JSON_SUFFIX = (
    "\n\nตอบกลับเป็น JSON ล้วน ๆ เท่านั้น (ห้ามมีข้อความอื่นนอก JSON) รูปแบบ:\n"
    '{"caption":"...","hashtags":"#a #b #c","quote":"คำคมสั้นเกี่ยวกับสินค้านี้ ไม่เกิน 12 คำ"}'
)


@router.post("/caption")
async def caption(payload: dict = Body(...), device: Device = Depends(get_device)):
    """Server-side AI proxy. The device sends only the product summary; the
    provider API key lives on the server and is NEVER shipped to the device
    (the key-on-device design was the original app's biggest data-exposure)."""
    product_summary = payload.get("product_summary", "") or "สินค้ารีวิวจาก Shopee"
    idea = payload.get("caption_idea", "เขียนแคปชั่นขายของสั้น กระชับ ดึงดูด พร้อมแฮชแท็ก")
    prompt = f"{idea}\n\nข้อมูลสินค้า:\n{product_summary}{_JSON_SUFFIX}"
    try:
        if settings.ai_provider == "openai" and settings.openai_api_key:
            data = await _openai(prompt)
        elif settings.ai_provider == "gemini" and settings.gemini_api_key:
            data = await _gemini(prompt)
        else:
            data = _stub(product_summary)
        return {"ok": True, **data}
    except Exception as e:  # graceful: never 500 the device
        return {"ok": False, "error": "ai_failed", "message": str(e), **_stub(product_summary)}


def _stub(summary: str) -> dict:
    head = (summary.strip().splitlines() or ["สินค้ารีวิว"])[0][:40]
    return {
        "caption": f"รีวิวจริง {head} ตัวนี้ดีงามบอกต่อ!",
        "hashtags": "#รีวิว #ของดีบอกต่อ #Shopee",
        "quote": "ของดีต้องบอกต่อ",
    }


def _parse(text: str) -> dict:
    i, j = text.find("{"), text.rfind("}")
    if 0 <= i < j:
        try:
            o = json.loads(text[i : j + 1])
            return {
                "caption": o.get("caption", ""),
                "hashtags": o.get("hashtags", ""),
                "quote": o.get("quote", ""),
            }
        except Exception:
            pass
    return {"caption": text.strip(), "hashtags": "", "quote": ""}


async def _openai(prompt: str) -> dict:
    async with httpx.AsyncClient(timeout=40) as c:
        r = await c.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json={
                "model": settings.ai_model,
                "temperature": 0.4,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        r.raise_for_status()
        return _parse(r.json()["choices"][0]["message"]["content"])


async def _gemini(prompt: str) -> dict:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{settings.ai_model}:generateContent?key={settings.gemini_api_key}"
    )
    async with httpx.AsyncClient(timeout=40) as c:
        r = await c.post(url, json={"contents": [{"parts": [{"text": prompt}]}]})
        r.raise_for_status()
        return _parse(r.json()["candidates"][0]["content"]["parts"][0]["text"])
