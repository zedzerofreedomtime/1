from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlmodel import Session, select

from .db import get_session
from .models import ScrapeJob

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def dashboard():
    return HTML


@router.get("/api/dashboard/scrape")
def scrape_dashboard(session: Session = Depends(get_session)):
    jobs = session.exec(select(ScrapeJob).order_by(ScrapeJob.id.desc()).limit(100)).all()
    return {"ok": True, "jobs": [job.model_dump() for job in jobs]}


@router.get("/api/admin/scrape-jobs")
def admin_list_scrape_jobs(session: Session = Depends(get_session)):
    jobs = session.exec(select(ScrapeJob).order_by(ScrapeJob.id.desc()).limit(200)).all()
    return {"ok": True, "jobs": [job.model_dump() for job in jobs]}


@router.post("/api/admin/scrape-jobs")
def admin_create_scrape_jobs(payload: dict = Body(default={}), session: Session = Depends(get_session)):
    from .routers.scrape import create_jobs

    return create_jobs(payload, session)


@router.delete("/api/admin/scrape-jobs/{job_id}")
def admin_delete_scrape_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(ScrapeJob, job_id)
    if not job:
        raise HTTPException(404, {"error": "not_found", "message": "job not found"})
    session.delete(job)
    session.commit()
    return {"ok": True}


HTML = """<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clip Bot Auto Harvester</title>
  <style>
    :root { color-scheme: dark; font-family: Tahoma, Arial, sans-serif; background:#090d12; color:#eef6ff; }
    body { margin:0; background:#090d12; }
    header { padding:22px 28px; border-bottom:1px solid #26313f; display:flex; justify-content:space-between; align-items:center; }
    h1 { margin:0; font-size:22px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:22px; padding:24px 28px; }
    section { border:1px solid #2a3645; border-radius:8px; background:#0e151e; }
    .panel { padding:18px; }
    label { display:block; color:#9db3cb; font-size:12px; margin-bottom:8px; }
    input, textarea { width:100%; box-sizing:border-box; background:#101820; color:#eef6ff; border:1px solid #334254; border-radius:6px; padding:10px; font:inherit; }
    textarea { min-height:190px; resize:vertical; }
    button { width:100%; margin-top:12px; border:0; border-radius:6px; padding:12px; background:#ff6a00; color:white; font-weight:700; cursor:pointer; }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid #26313f; text-align:left; padding:12px; font-size:13px; vertical-align:top; }
    th { color:#9db3cb; font-weight:600; }
    .pill { display:inline-block; border:1px solid #344356; border-radius:999px; padding:3px 8px; }
    .pending { color:#ffd166; }
    .running { color:#61dafb; }
    .done { color:#69f0ae; }
    .failed { color:#ff7b72; }
    .muted { color:#8da2b8; }
    @media (max-width: 900px) { main { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Clip Bot Auto Harvester Dashboard</h1>
    <div class="muted">Backend: http://127.0.0.1:8100</div>
  </header>
  <main>
    <section class="panel">
      <label>Dataset name</label>
      <input id="dataset" value="Shopee Scrape">
      <label style="margin-top:14px">Shopee product URLs</label>
      <textarea id="urls" placeholder="วางลิงก์ Shopee บรรทัดละ 1 ลิงก์"></textarea>
      <button id="add">+ เข้าคิว</button>
      <p id="msg" class="muted"></p>
    </section>
    <section>
      <table>
        <thead><tr><th>#</th><th>สินค้า</th><th>สถานะ</th><th>รีวิว/มีเดีย</th><th>ข้อความ</th><th>อัปเดต</th></tr></thead>
        <tbody id="jobs"></tbody>
      </table>
    </section>
  </main>
  <script>
    async function load() {
      const res = await fetch('/api/dashboard/scrape');
      const data = await res.json();
      jobs.innerHTML = data.jobs.map(j => `
        <tr>
          <td>${j.id}</td>
          <td><b>${j.title || j.itemid || '-'}</b><br><span class="muted">${j.product_url || ''}</span></td>
          <td><span class="pill ${j.status}">${j.status}</span></td>
          <td>${j.reviews_count || 0} / ${j.media_count || 0}</td>
          <td>${j.message || ''}</td>
          <td>${new Date(j.updated_at).toLocaleString('th-TH')}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">ยังไม่มีงานในคิว</td></tr>';
    }
    add.onclick = async () => {
      msg.textContent = 'กำลังเพิ่มงาน...';
      const res = await fetch('/api/scrape/jobs', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({dataset_name: dataset.value, urls: urls.value})
      });
      const data = await res.json();
      msg.textContent = data.ok ? `เพิ่ม ${data.created.length} งานแล้ว` : (data.message || 'เพิ่มงานไม่สำเร็จ');
      if (data.ok) urls.value = '';
      load();
    };
    load();
    setInterval(load, 3000);
  </script>
</body>
</html>"""
