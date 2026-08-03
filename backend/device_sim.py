"""Reference DEVICE client — simulates the Android app talking to the backend.

Purpose:
  1. Proves the Phase-0 control loop end-to-end against a live backend.
  2. Serves as the exact executable spec the Kotlin app must mirror
     (same endpoints, same request/response shapes, same order).

Run (with the server up on :8000):
    .venv/Scripts/python device_sim.py
"""
import time

import httpx

BASE = "http://127.0.0.1:8000"
ADMIN = "dev-admin-key-change-me"


def main() -> None:
    c = httpx.Client(base_url=BASE, timeout=30)

    # --- (operator side, normally done in the Web Manager) ---------------------
    dev = c.post("/api/admin/devices", headers={"X-Admin-Key": ADMIN},
                 json={"name": "sim-phone"}).json()
    token, did = dev["token"], dev["device_id"]
    print(f"[provision] device_id={did}  token={token[:16]}…")
    c.post("/api/admin/datasets", headers={"X-Admin-Key": ADMIN}, json={
        "name": "Sim Dataset",
        "items": [{
            "product_id": 2001, "title": "ครีมกันแดด SPF50", "price": "259",
            "product_url": "https://shopee.co.th/product/1/2001",
            "review_summary": "ครีมกันแดดเนื้อบางเบา ไม่เหนียว รีวิวจากผู้ซื้อจริง",
        }],
    })

    H = {"Authorization": f"Bearer {token}"}  # every device call carries this

    # --- (device side) --------------------------------------------------------
    disc = c.post("/api/discover", json={"token": token}).json()
    print(f"[discover]  server_url={disc['server_url']}  member_id={disc['member_id']}")

    cfg = c.get("/api/app/config", headers=H).json()["config"]
    print(f"[config]    clip_len={cfg['clip_len_sec']}s  auto_post={cfg['auto_post']}  "
          f"delay={cfg['delay_min_sec']}-{cfg['delay_max_sec']}s")

    # operator presses Start in the dashboard:
    c.post("/api/admin/commands", headers={"X-Admin-Key": ADMIN},
           json={"device_id": did, "action": "start",
                 "params": {"pick_mode": "auto", "config": {"clip_count": 1}}})

    # poll loop (app polls every 4s; we poll a few times)
    for _ in range(4):
        cmd = c.get(f"/api/app/commands?device_id={did}", headers=H).json().get("command")
        if not cmd:
            time.sleep(1)
            continue
        print(f"[command]   id={cmd['id']} action={cmd['action']} params={cmd['params']}")
        try:
            run_job(c, H, did, cmd["params"], cfg)
            result, msg = "applied", None
        except Exception as e:  # noqa: BLE001
            result, msg = "rejected", str(e)
        c.post("/api/app/commands/ack", headers=H,
               json={"command_id": cmd["id"], "device_id": str(did),
                     "result": result, "message": msg})
        break

    st = c.get(f"/api/admin/status?device_id={did}",
               headers={"X-Admin-Key": ADMIN}).json()["status"]
    print(f"[dashboard] run_state={st['run_state']} produced={st['produced']}/{st['target']} "
          f"stage={st['stage']} · '{st['last_message']}'")


def _status(c, H, **kw):
    c.post("/api/app/status", headers=H, json=kw)


def run_job(c, H, did, params, cfg) -> None:
    merged = {**cfg, **(params.get("config") or {})}
    target = merged.get("clip_count", 1)
    _status(c, H, run_state="running", stage="PICK_DATASET", produced=0, target=target)

    ds = c.post("/api/app/datasets/auto-pick", headers=H,
                json={"reuse_touched": False}).json()
    if not ds.get("ok"):
        _status(c, H, run_state="failed", stage="-", last_message="no dataset")
        return
    dsid = ds["dataset"]["id"]
    print(f"[job]       dataset={dsid} target={target}")
    c.post(f"/api/app/datasets/{dsid}/opened", headers=H, json={"context": "bot"})

    _status(c, H, run_state="running", stage="LOAD_ITEMS", produced=0, target=target, dataset_id=dsid)
    items = c.get(f"/api/app/datasets/{dsid}/items", headers=H).json()["items"]
    pending = [it for it in items if it["status"] == "pending"]

    produced = 0
    for it in pending:
        if produced >= target:
            break
        pid = it["product_id"]

        _status(c, H, run_state="running", stage="LOCK", produced=produced, target=target,
                dataset_id=dsid, product_id=pid)
        r = c.post(f"/api/app/datasets/{dsid}/items/{pid}/start", headers=H,
                   json={"force": False, "device_id": str(did)})
        if r.status_code == 409:
            print(f"[job]       {pid} locked by another device → skip")
            continue

        detail = c.get(f"/api/app/datasets/{dsid}/items/{pid}", headers=H).json()

        _status(c, H, run_state="running", stage="CAPTION", produced=produced, target=target,
                dataset_id=dsid, product_id=pid)
        cap = c.post("/api/app/ai/caption", headers=H,
                     json={"product_summary": detail.get("summary", "")}).json()
        print(f"[job]       {pid} caption={cap.get('caption', '')[:38]!r} quote={cap.get('quote', '')!r}")

        _status(c, H, run_state="running", stage="COMPOSE", produced=produced, target=target,
                dataset_id=dsid, product_id=pid)
        time.sleep(0.4)  # stand-in for the Media3 render

        _status(c, H, run_state="running", stage="EXPORT", produced=produced, target=target,
                dataset_id=dsid, product_id=pid)

        # Phase 0 = no auto-post → verified=False (rendered only).
        # Phase 3 will set verified from a REAL Shopee upload-complete check.
        c.post(f"/api/app/datasets/{dsid}/items/{pid}/done", headers=H,
               json={"verified": False, "post_message": "rendered (phase-0, no auto-post yet)"})
        produced += 1
        print(f"[job]       {pid} done (verified=False)  {produced}/{target}")

    c.post(f"/api/app/datasets/{dsid}/closed", headers=H,
           json={"reason": "bot-stop", "posted_in_session": produced})
    _status(c, H, run_state="finished", stage="-", produced=produced, target=target,
            last_message=f"{produced}/{target} rendered")


if __name__ == "__main__":
    main()
