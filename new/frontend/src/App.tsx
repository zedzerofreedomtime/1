import { useEffect, useMemo, useState } from 'react';
import {
  Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleStop, Eye, Film, Gauge,
  Home, Image, ListVideo, LockKeyhole, Menu, Plus, RefreshCw, ShieldCheck, X,
} from './icons';

type Job = {
  id: number; itemId: number; title: string; status: string; reviewText: string;
  selectedImagePath: string | null; sourceImageUrl: string | null; clipPaths: string[];
  finalVideoPath: string | null; errorMessage: string | null; retryCount: number; updatedAt: string;
  sourceProductImagePath: string | null; generatedImagePath: string | null;
  handGender: 'male' | 'female' | null; backgroundStyle: string | null;
  narrationRepairs: Array<{ clipIndex: number; rule: string; repairedFrom: string; replacement: string; reasons: string[] }>;
  targetDurationSeconds: 16 | 24; clipCount: number;
};

type ScrapeJob = {
  id: number; datasetName: string; productUrl: string; shopid: string; itemid: string;
  status: string; message: string; title: string; price: string;
  reviewsCount: number; mediaCount: number; updatedAt: string;
};

type Review = {
  id: number; displayNumber: number; title: string; productTitle: string;
  reviewText: string; imageCount: number; imageUrl: string | null; images: string[];
};

type Dashboard = {
  runtime: {
    connected: boolean; running: boolean; creditLocked: boolean; status: string;
    currentJobId: number | null; updatedAt: string;
  };
  scrapeJobs: ScrapeJob[];
  jobs: Job[];
  reviews: Review[];
};

const empty: Dashboard = {
  runtime: {
    connected: false, running: false, creditLocked: true,
    status: 'รอการเชื่อมต่อจาก Extension', currentJobId: null, updatedAt: '',
  },
  scrapeJobs: [],
  jobs: [],
  reviews: [],
};

const flowStatusMap: Record<string, { label: string; tone: string }> = {
  pending: { label: 'อยู่ในคิว', tone: 'waiting' },
  downloading_media: { label: 'เตรียมรูปรีวิว', tone: 'working' },
  generating_prompt: { label: 'Gemini เลือกรูป', tone: 'working' },
  generating_image: { label: 'Flow สร้างรูปตั้งต้น', tone: 'working' },
  generating_videos: { label: 'Flow สร้างคลิป', tone: 'working' },
  generating_tts: { label: 'สร้างเสียงพากย์', tone: 'working' },
  assembling: { label: 'ประกอบวิดีโอ', tone: 'working' },
  completed: { label: 'เสร็จแล้ว', tone: 'success' },
  failed: { label: 'หยุดเพื่อความปลอดภัย', tone: 'danger' },
};

const scrapeStatusMap: Record<string, { label: string; tone: string }> = {
  pending: { label: 'รอเก็บรีวิว', tone: 'waiting' },
  running: { label: 'กำลังเก็บรีวิว', tone: 'working' },
  done: { label: 'เก็บเสร็จ', tone: 'success' },
  failed: { label: 'เก็บไม่สำเร็จ', tone: 'danger' },
};

const mediaUrl = (path: string | null) => path ? `/api/media?path=${encodeURIComponent(path)}` : '';
const statusOf = (map: Record<string, { label: string; tone: string }>, status: string) =>
  map[status] || { label: status, tone: 'waiting' };

function App() {
  const [data, setData] = useState<Dashboard>(empty);
  const [notice, setNotice] = useState('');
  const [nav, setNav] = useState<'overview' | 'scrape' | 'flow' | 'gallery'>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('Shopee Scrape');
  const [urls, setUrls] = useState('');
  const [scrapeNotice, setScrapeNotice] = useState('');

  const load = async () => {
    try {
      const response = await fetch('/api/dashboard');
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || 'อ่านสถานะไม่สำเร็จ');
      setData({ ...empty, ...next, scrapeJobs: next.scrapeJobs || [], reviews: next.reviews || [] });
      setNotice('');
    } catch (error: any) {
      setNotice(error.message);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const addScrapeJobs = async () => {
    setScrapeNotice('กำลังเพิ่มคิว...');
    try {
      const response = await fetch('/api/scrape/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetName, urls }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'เพิ่มคิวไม่สำเร็จ');
      setUrls('');
      setScrapeNotice(`เพิ่ม ${result.created.length} งานแล้ว`);
      await load();
    } catch (error: any) {
      setScrapeNotice(error.message);
    }
  };

  const deleteScrape = async (id: number) => {
    await fetch(`/api/admin/scrape-jobs/${id}`, { method: 'DELETE' });
    await load();
  };

  const latest = data.jobs[0];
  const active = data.jobs.find((job) => job.id === data.runtime.currentJobId)
    || data.jobs.find((job) => !['completed', 'failed'].includes(job.status));
  const stats = useMemo(() => ({
    scrapePending: data.scrapeJobs.filter((job) => job.status === 'pending').length,
    scrapeRunning: data.scrapeJobs.filter((job) => job.status === 'running').length,
    flowQueued: data.jobs.filter((job) => job.status === 'pending').length,
    flowWorking: data.jobs.filter((job) => !['pending', 'completed', 'failed'].includes(job.status)).length,
    flowCompleted: data.jobs.filter((job) => job.status === 'completed').length,
  }), [data.jobs, data.scrapeJobs]);

  return (
    <div className="app-shell monitor-only">
      <header className="topbar">
        <div className="brand">
          <button className="menu-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label="เมนู" aria-expanded={menuOpen}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button>
          <span className="brand-mark"><Bot size={25} /></span><strong>ClipBot Control Dashboard</strong>
        </div>
        <div className="monitor-badges">
          <span className={data.runtime.connected ? 'monitor-badge online' : 'monitor-badge'}>
            <span className="dot" />{data.runtime.connected ? 'Flow Extension online' : 'Flow Extension offline'}
          </span>
          <span className="readonly-badge"><Eye size={16} /> backend 8110</span>
        </div>
      </header>

      <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <nav>
          {([
            ['overview', 'ภาพรวม', Home],
            ['scrape', 'เก็บรีวิว Shopee', Plus],
            ['gallery', 'รูปที่เก็บมา', Image],
            ['flow', 'สร้างวิดีโอ', ListVideo],
          ] as const).map(([key, label, Icon]) => (
            <button key={key} className={nav === key ? 'active' : ''} onClick={() => { setNav(key); setMenuOpen(false); }}>
              <Icon size={20} />{label}
            </button>
          ))}
        </nav>
        <div className="connection">
          <span className={data.runtime.connected ? 'dot on' : 'dot'} />
          <div><strong>{data.runtime.connected ? 'ระบบสร้างวิดีโอออนไลน์' : 'รอ Extension สร้างวิดีโอ'}</strong><small>Harvester ใช้ backend เดียวกันที่ 8110</small></div>
        </div>
      </aside>

      <main>
        <div className="page-heading">
          <div>
            <h1>{nav === 'scrape' ? 'เก็บรีวิว Shopee' : nav === 'flow' ? 'สร้างวิดีโอจากรีวิว' : nav === 'gallery' ? 'รูปที่เก็บมา' : 'ภาพรวมระบบบอท'}</h1>
            <p>หน้าเดียวสำหรับเก็บรีวิวเข้าฐานข้อมูล แล้วส่งต่อให้คิวสร้างวิดีโอใช้งาน</p>
          </div>
          <button className="icon-button" onClick={load} aria-label="รีเฟรช"><RefreshCw size={18} /></button>
        </div>

        {notice && <div className="notice"><CircleAlert size={18} />{notice}</div>}

        <section className="monitor-strip">
          <div><small>Harvester queue</small><strong>{stats.scrapePending} รอ · {stats.scrapeRunning} กำลังเก็บ</strong></div>
          <div><small>Flow queue</small><strong>{stats.flowQueued} รอ · {stats.flowWorking} กำลังทำ</strong></div>
          <div><small>เครดิต Flow</small><strong className={data.runtime.creditLocked ? 'safe' : 'warning'}><LockKeyhole size={16} />{data.runtime.creditLocked ? 'ล็อกอยู่' : 'ปลดล็อกแล้ว'}</strong></div>
          <div><small>สถานะล่าสุด</small><strong>{data.runtime.status}</strong></div>
        </section>

        {nav === 'overview' && (
          <div className="overview-grid">
            <section className="panel overview-card">
              <h2>ลำดับงาน</h2>
              <p>1. วางลิงก์สินค้า Shopee ในแท็บเก็บรีวิว</p>
              <p>2. Extension Auto Harvester ดึงคิวจาก backend นี้และเก็บรีวิวเข้า Dataset</p>
              <p>3. Flow Extension เลือกรีวิวที่มีรูป แล้วสร้างวิดีโอจากคิวเดียวกัน</p>
            </section>
            <section className="panel overview-card">
              <h2>Backend URL</h2>
              <p className="endpoint">http://127.0.0.1:8110</p>
              <p>ใช้ URL นี้กับ extension ทั้งตัวเก็บรีวิวและตัวสร้างวิดีโอ เพื่อไม่ให้ข้อมูลแยกกันอีก</p>
            </section>
          </div>
        )}

        {nav === 'scrape' && (
          <section className="workspace-main">
            <div className="panel scrape-composer">
              <label>
                Dataset name
                <input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} />
              </label>
              <label>
                Shopee product URLs
                <textarea value={urls} onChange={(event) => setUrls(event.target.value)} placeholder="วางลิงก์ Shopee บรรทัดละ 1 ลิงก์" />
              </label>
              <div className="composer-footer">
                <button className="primary-action" onClick={addScrapeJobs}><Plus size={17} />เข้าคิวเก็บรีวิว</button>
                <span className="muted-message">{scrapeNotice || 'Extension Auto Harvester จะดึงงานจาก /api/scrape/next'}</span>
              </div>
            </div>
            <ScrapeTable jobs={data.scrapeJobs} onDelete={deleteScrape} />
          </section>
        )}

        {nav === 'gallery' && <GalleryView reviews={data.reviews} onReload={load} />}

        {nav === 'flow' && (
          <div className="workspace-grid">
            <section className="workspace-main">
              <FlowTable jobs={data.jobs} stats={stats} />
            </section>
            <aside className="preview-rail">
              <ContinuityPanel active={active} />
              <LatestOutput latest={latest} />
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

// รูปทั้งหมดของรีวิว — ใช้ images (ครบ) ถ้ามี; ถ้า service ยังไม่ reload field นี้ fallback เป็นรูปปก
const reviewImages = (review: Review): string[] =>
  review.images?.length ? review.images : (review.imageUrl ? [review.imageUrl] : []);

const GALLERY_PREVIEW_LIMIT = 12;

function GalleryView({ reviews, onReload }: { reviews: Review[]; onReload: () => void }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) => setExpandedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const withImages = reviews.filter((review) => reviewImages(review).length > 0);
  const totalImages = withImages.reduce((sum, review) => sum + reviewImages(review).length, 0);

  const del = async (payloads: Array<{ mode: 'image' | 'item'; itemId?: number; url?: string }>) => {
    try {
      for (const payload of payloads) {
        const res = await fetch('/api/gallery/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'ลบไม่สำเร็จ');
      }
      onReload();
    } catch (error: any) { window.alert(error.message); }
  };
  const deleteImage = (itemId: number, url: string) => {
    if (window.confirm('ลบรูปนี้ออกจากคลัง?')) del([{ mode: 'image', itemId, url }]);
  };
  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allSelected = withImages.length > 0 && selected.size === withImages.length;
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(withImages.map((r) => r.id)));
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const deleteSelected = () => {
    if (selected.size === 0) return;
    if (window.confirm(`ลบรูปทั้งหมดของ ${selected.size} สินค้าที่เลือก?\n(ย้อนกลับไม่ได้ — ต้องเก็บรีวิวใหม่)`)) {
      del([...selected].map((itemId) => ({ mode: 'item' as const, itemId }))).then(exitSelect);
    }
  };

  return (
    <section className="workspace-main">
      <div className="section-title">
        <h2>รูปที่เก็บมาจากรีวิว</h2>
        <div className="gallery-head-actions">
          <span>{withImages.length} สินค้า · {totalImages} รูป</span>
          {!selectMode && totalImages > 0 && (
            <button className="text-button danger" onClick={() => setSelectMode(true)}><X size={13} /> เลือกลบ</button>
          )}
          {selectMode && <>
            <button className="text-button" onClick={selectAll}>{allSelected ? 'ไม่เลือกเลย' : 'เลือกทั้งหมด'}</button>
            <button className="text-button danger" disabled={selected.size === 0} onClick={deleteSelected}><X size={13} /> ลบที่เลือก ({selected.size})</button>
            <button className="text-button" onClick={exitSelect}>ยกเลิก</button>
          </>}
        </div>
      </div>
      {selectMode && <div className="muted-message">ติ๊กหัวข้อสินค้าที่ต้องการลบ แล้วกด "ลบที่เลือก" (ลบรูปทีละรูปใช้ ✕ บนรูปได้เหมือนเดิม)</div>}
      {withImages.length === 0 && <div className="empty-row">ยังไม่มีรูปที่เก็บมา — เก็บรีวิว Shopee ที่มีรูปก่อน</div>}
      {withImages.map((review) => {
        const images = reviewImages(review);
        const checked = selected.has(review.id);
        const expanded = expandedIds.has(review.id);
        const canCollapse = images.length > GALLERY_PREVIEW_LIMIT;
        const shown = expanded || !canCollapse ? images : images.slice(0, GALLERY_PREVIEW_LIMIT);
        return (
          <div className={`panel gallery-product${selectMode && checked ? ' selected' : ''}`} key={review.id}>
            <div className="section-title">
              <label className="gallery-product-head">
                {selectMode && <input type="checkbox" checked={checked} onChange={() => toggle(review.id)} />}
                <h2>{review.productTitle || review.title}</h2>
              </label>
              <span>{review.images?.length ? `${images.length} รูป` : `${review.imageCount} รูป (รอ service reload เพื่อดูครบ)`}</span>
            </div>
            <div className="gallery-grid">
              {shown.map((url, index) => (
                <div className="gallery-cell" key={index}>
                  <a href={url} target="_blank" rel="noreferrer" title={`รูปที่ ${index + 1}`}>
                    <img src={url} alt={`${review.productTitle} รูปที่ ${index + 1}`} loading="lazy" />
                  </a>
                  {!selectMode && <button className="gallery-del" onClick={() => deleteImage(review.id, url)} aria-label="ลบรูปนี้"><X size={14} /></button>}
                </div>
              ))}
            </div>
            {canCollapse && (
              <button className="gallery-expand" onClick={() => toggleExpand(review.id)}>
                <ChevronDown size={16} className={expanded ? 'flip' : ''} />
                {expanded ? 'ย่อลง' : `ดูทั้งหมด (${images.length} รูป)`}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ScrapeTable({ jobs, onDelete }: { jobs: ScrapeJob[]; onDelete: (id: number) => void }) {
  return (
    <section className="queue-section">
      <div className="section-title"><h2>คิวเก็บรีวิว</h2><span>{jobs.length} งานล่าสุด</span></div>
      <div className="job-table scrape-table">
        <div className="job-head"><span>#</span><span>สินค้า</span><span>Dataset</span><span>สถานะ</span><span>รีวิว/มีเดีย</span><span>จัดการ</span></div>
        {jobs.length === 0 && <div className="empty-row">ยังไม่มีงานในคิวเก็บรีวิว</div>}
        {jobs.map((job) => {
          const status = statusOf(scrapeStatusMap, job.status);
          return <div className="job-row" key={job.id}>
            <span>{String(job.id).padStart(3, '0')}</span>
            <div className="job-name"><strong>{job.title || `สินค้า ${job.itemid}`}</strong><small>{job.productUrl || job.message}</small></div>
            <span>{job.datasetName}</span>
            <span className={`status ${status.tone}`}>{status.tone === 'success' ? <Check /> : status.tone === 'danger' ? <CircleStop /> : <Gauge />}{status.label}</span>
            <span>{job.reviewsCount} / {job.mediaCount}</span>
            <button className="text-button" onClick={() => onDelete(job.id)}>ลบ</button>
          </div>;
        })}
      </div>
    </section>
  );
}

function FlowTable({ jobs, stats }: { jobs: Job[]; stats: any }) {
  return (
    <section className="queue-section">
      <div className="section-title"><h2>คิวสร้างวิดีโอ</h2><span>{stats.flowQueued} รอ · {stats.flowWorking} กำลังทำ · {stats.flowCompleted} เสร็จ</span></div>
      <div className="job-table readonly-table">
        <div className="job-head"><span>#</span><span>งาน</span><span>รูปต้นทาง</span><span>สถานะ</span><span>อัปเดตล่าสุด</span></div>
        {jobs.length === 0 && <div className="empty-row">ยังไม่มีงานสร้างวิดีโอ</div>}
        {jobs.map((job) => {
          const status = statusOf(flowStatusMap, job.status);
          const imageSrc = job.selectedImagePath ? mediaUrl(job.selectedImagePath) : job.sourceImageUrl || '';
          return <div className="job-row" key={job.id}>
            <span>{String(job.id).padStart(3, '0')}</span>
            <div className="job-name">
              <strong>{job.title}</strong>
              <small>{job.targetDurationSeconds} วิ · {job.clipCount} คลิป · {job.reviewText?.slice(0, 48)}</small>
              {!!job.narrationRepairs?.length && (
                <small className="repair-warning">
                  <CircleAlert size={12} /> บทถูกแทน {job.narrationRepairs.length} คลิป · {job.narrationRepairs.map((repair) => repair.rule).join(', ')}
                </small>
              )}
            </div>
            <div className="thumb">{imageSrc ? <img src={imageSrc} alt="" /> : <Image size={18} />}</div>
            <span className={`status ${status.tone}`}>{status.tone === 'success' ? <Check /> : status.tone === 'danger' ? <CircleStop /> : <Gauge />}{status.label}</span>
            <time>{new Date(job.updatedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</time>
          </div>;
        })}
      </div>
    </section>
  );
}

function ContinuityPanel({ active }: { active?: Job }) {
  return (
    <div className="panel continuity">
      <div className="section-title"><h2>ความต่อเนื่องของงานปัจจุบัน</h2><span>{active?.clipCount || 3} คลิป · {active?.targetDurationSeconds || 24} วิ</span></div>
      <div className="frames">
        {Array.from({ length: active?.clipCount || 3 }, (_, index) => index).map((index) => {
          const src = active?.clipPaths[index] ? mediaUrl(active.clipPaths[index]) : active?.selectedImagePath ? mediaUrl(active.selectedImagePath) : active?.sourceImageUrl || '';
          return <div className="frame-wrap" key={index}><span>คลิป {index + 1}</span><div className="frame">{src ? (active?.clipPaths[index] ? <video src={src} muted /> : <img src={src} alt="" />) : <Film />}</div>{index < (active?.clipCount || 3) - 1 && <ChevronRight className="frame-arrow" />}</div>;
        })}
      </div>
      <div className="continuity-note"><RefreshCw size={16} />ใช้เฟรมสุดท้ายต่อคลิปถัดไป</div>
    </div>
  );
}

function LatestOutput({ latest }: { latest?: Job }) {
  const status = latest ? statusOf(flowStatusMap, latest.status) : null;
  return (
    <div className="panel latest-output">
      <div className="section-title"><h2>วิดีโอที่สร้างล่าสุด</h2></div>
      {latest?.finalVideoPath ? <video controls src={mediaUrl(latest.finalVideoPath)} /> : <div className="output-empty"><Film size={34} /><p>ยังไม่มีวิดีโอที่ประกอบเสร็จ</p></div>}
      {latest && status && <div className="output-info"><strong>{latest.title}</strong><span className={`status ${status.tone}`}>{status.label}</span><small>จำนวนคลิป: {latest.clipPaths.length} จาก {latest.clipCount} · {latest.targetDurationSeconds} วิ</small></div>}
    </div>
  );
}

export default App;
