import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import db from './database.js';
import { GoogleMapsScraper } from './scraper.js';
import { GoogleSearchScraper } from './google-scraper.js';
import * as XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { exec } from 'child_process';

const KOLAY_RESULTS_DIR = '/Users/nds/Desktop/kolay-randevu-scrapper/results';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// Serve frontend static files
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

// Active scrapers
const activeCampaigns = new Map();

// Import queue system — runs one at a time
const importQueue = [];
let importQueueRunning = false;

async function processImportQueue() {
  if (importQueueRunning || importQueue.length === 0) return;
  importQueueRunning = true;

  while (importQueue.length > 0) {
    const job = importQueue[0];
    broadcast('queue_status', { queue: importQueue.map(j => ({ id: j.id, name: j.name })), currentId: job.id });

    try {
      const scraper = new GoogleSearchScraper(
        job.id,
        job.businesses,
        (log) => broadcast('log', { campaignId: job.id, ...log }),
        (data) => broadcast('business_found', { campaignId: job.id, ...data }),
        (status) => broadcast('campaign_status', { campaignId: job.id, status })
      );
      activeCampaigns.set(job.id, scraper);
      await scraper.start();
    } catch (err) {
      console.error(`Queue job failed: ${job.name}`, err.message);
    } finally {
      activeCampaigns.delete(job.id);
      importQueue.shift();
      broadcast('queue_status', { queue: importQueue.map(j => ({ id: j.id, name: j.name })), currentId: null });
    }
  }

  importQueueRunning = false;
}

// WebSocket connections
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// === CAMPAIGN ENDPOINTS ===

app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  res.json(campaigns);
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Kampanya bulunamadı' });
  res.json(campaign);
});

app.post('/api/campaigns', (req, res) => {
  const { name, keyword, country, city, districts } = req.body;
  if (!name || !keyword) return res.status(400).json({ error: 'Kampanya adı ve anahtar kelime gerekli' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO campaigns (id, name, keyword, country, city, districts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, keyword, country || 'Türkiye', city || '', JSON.stringify(districts || []));

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  broadcast('campaign_created', campaign);
  res.json(campaign);
});

app.delete('/api/campaigns/:id', (req, res) => {
  const scraper = activeCampaigns.get(req.params.id);
  if (scraper) {
    scraper.cancel();
    activeCampaigns.delete(req.params.id);
  }
  db.prepare('DELETE FROM businesses WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  broadcast('campaign_deleted', { id: req.params.id });
  res.json({ success: true });
});

// === CAMPAIGN CONTROL ===

app.post('/api/campaigns/:id/start', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Kampanya bulunamadı' });

  if (activeCampaigns.has(req.params.id)) {
    return res.status(400).json({ error: 'Kampanya zaten çalışıyor' });
  }

  const scraper = new GoogleMapsScraper(
    req.params.id,
    (log) => broadcast('log', { campaignId: req.params.id, ...log }),
    (data) => broadcast('business_found', { campaignId: req.params.id, ...data }),
    (status) => broadcast('campaign_status', { campaignId: req.params.id, status })
  );

  activeCampaigns.set(req.params.id, scraper);
  scraper.start().finally(() => activeCampaigns.delete(req.params.id));

  res.json({ success: true, message: 'Kampanya başlatıldı' });
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  const scraper = activeCampaigns.get(req.params.id);
  if (!scraper) return res.status(400).json({ error: 'Kampanya çalışmıyor' });
  scraper.pause();
  res.json({ success: true });
});

app.post('/api/campaigns/:id/resume', (req, res) => {
  const scraper = activeCampaigns.get(req.params.id);
  if (!scraper) return res.status(400).json({ error: 'Kampanya çalışmıyor' });
  scraper.resume();
  res.json({ success: true });
});

app.post('/api/campaigns/:id/cancel', (req, res) => {
  const scraper = activeCampaigns.get(req.params.id);
  if (!scraper) return res.status(400).json({ error: 'Kampanya çalışmıyor' });
  scraper.cancel();
  activeCampaigns.delete(req.params.id);
  res.json({ success: true });
});

app.post('/api/campaigns/start-all', (req, res) => {
  const pending = db.prepare("SELECT * FROM campaigns WHERE status IN ('pending', 'paused')").all();
  let started = 0;
  for (const campaign of pending) {
    if (!activeCampaigns.has(campaign.id)) {
      const scraper = new GoogleMapsScraper(
        campaign.id,
        (log) => broadcast('log', { campaignId: campaign.id, ...log }),
        (data) => broadcast('business_found', { campaignId: campaign.id, ...data }),
        (status) => broadcast('campaign_status', { campaignId: campaign.id, status })
      );
      activeCampaigns.set(campaign.id, scraper);
      scraper.start().finally(() => activeCampaigns.delete(campaign.id));
      started++;
    }
  }
  res.json({ success: true, started });
});

// === BUSINESS DATA ENDPOINTS ===

app.get('/api/campaigns/:id/businesses', (req, res) => {
  const businesses = db.prepare('SELECT * FROM businesses WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  res.json(businesses);
});

app.get('/api/businesses', (req, res) => {
  const { search, campaign_id } = req.query;
  let query = 'SELECT b.*, c.name as campaign_name FROM businesses b JOIN campaigns c ON b.campaign_id = c.id WHERE 1=1';
  const params = [];

  if (campaign_id) {
    query += ' AND b.campaign_id = ?';
    params.push(campaign_id);
  }
  if (search) {
    query += ' AND (b.name LIKE ? OR b.phone LIKE ? OR b.email LIKE ? OR b.address LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  query += ' ORDER BY b.id DESC';
  const businesses = db.prepare(query).all(...params);
  res.json(businesses);
});

// === EXPORT ===

app.get('/api/campaigns/:id/export', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Kampanya bulunamadı' });

  const filter = req.query.filter;
  let businesses;
  if (filter === 'no-website') {
    businesses = db.prepare("SELECT * FROM businesses WHERE campaign_id = ? AND (website = '' OR website IS NULL) ORDER BY id").all(req.params.id);
  } else if (filter === 'has-website') {
    businesses = db.prepare("SELECT * FROM businesses WHERE campaign_id = ? AND website != '' AND website IS NOT NULL ORDER BY id").all(req.params.id);
  } else {
    businesses = db.prepare('SELECT * FROM businesses WHERE campaign_id = ? ORDER BY id').all(req.params.id);
  }

  const data = businesses.map((b, i) => ({
    '#': i + 1,
    'İşletme Adı': b.name,
    'Telefon': b.phone,
    'Cep Tel.': b.mobile,
    'Web Sitesi': b.website,
    'E-Posta': b.email,
    'Adres': b.address,
    'İl': b.city,
    'İlçe': b.district,
    'Puan': b.rating,
    'Yorum Sayısı': b.review_count,
    'Kategori': b.category,
    'Google Maps': b.google_maps_url
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'İşletmeler');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `${campaign.name.replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ\s]/g, '')}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
});

// === JSON EXPORT ===

app.get('/api/campaigns/:id/export-json', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Kampanya bulunamadı' });

  const businesses = db.prepare('SELECT * FROM businesses WHERE campaign_id = ? ORDER BY id').all(req.params.id);

  const filename = `${campaign.name.replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ\s]/g, '')}_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.json(businesses);
});

// === IMPORT PARTNER DATA (no scraping, direct DB insert) ===

app.post('/api/campaigns/import-data', express.json({ limit: '50mb' }), (req, res) => {
  const { campaignName, businesses: rawBusinesses } = req.body;
  if (!campaignName || !Array.isArray(rawBusinesses) || rawBusinesses.length === 0) {
    return res.status(400).json({ error: 'Kampanya adı ve işletme listesi gerekli' });
  }

  const seen = new Set();
  const businesses = rawBusinesses
    .filter(item => item && item.name)
    .filter(item => {
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (businesses.length === 0) {
    return res.status(400).json({ error: 'Geçerli işletme bulunamadı' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO campaigns (id, name, keyword, country, city, districts, status, total_found)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
  `).run(id, campaignName, 'ortak-verisi', 'Türkiye', '', '[]', businesses.length);

  const insertBusiness = db.prepare(`
    INSERT INTO businesses (campaign_id, name, phone, mobile, website, email, address, city, district, rating, review_count, category, google_maps_url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((list) => {
    for (const b of list) {
      insertBusiness.run(
        id,
        b.name || '',
        b.phone || '',
        b.mobile || '',
        b.website || '',
        b.email || '',
        b.address || '',
        b.city || '',
        b.district || '',
        b.rating || 0,
        b.review_count || 0,
        b.category || '',
        b.google_maps_url || '',
        b.notes || ''
      );
    }
  });

  insertMany(businesses);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  broadcast('campaign_created', campaign);

  res.json({ success: true, campaign, totalBusinesses: businesses.length });
});

// === BUSINESS NOTES ===

app.patch('/api/businesses/:id/notes', (req, res) => {
  const { notes } = req.body;
  if (typeof notes !== 'string') return res.status(400).json({ error: 'notes alanı gerekli' });
  const result = db.prepare('UPDATE businesses SET notes = ? WHERE id = ?').run(notes, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'İşletme bulunamadı' });
  res.json({ success: true });
});

// === JSON IMPORT ===

app.get('/api/import/files', (req, res) => {
  try {
    if (!fs.existsSync(KOLAY_RESULTS_DIR)) {
      return res.json({ files: [], error: 'Klasor bulunamadi: ' + KOLAY_RESULTS_DIR });
    }
    const files = fs.readdirSync(KOLAY_RESULTS_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('discovered_') && !f.startsWith('all_businesses'))
      .map(filename => {
        try {
          const filePath = path.join(KOLAY_RESULTS_DIR, filename);
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          const count = Array.isArray(data) ? data.length : 0;
          return { filename, count };
        } catch {
          return { filename, count: 0 };
        }
      })
      .sort((a, b) => b.count - a.count);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/import/start', async (req, res) => {
  const { filename, campaignName } = req.body;
  if (!filename || !campaignName) {
    return res.status(400).json({ error: 'Dosya adi ve kampanya adi gerekli' });
  }

  const filePath = path.join(KOLAY_RESULTS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Dosya bulunamadi: ' + filename });
  }

  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'JSON parse hatasi: ' + err.message });
  }

  if (!Array.isArray(rawData)) {
    return res.status(400).json({ error: 'Dosya gecerli bir dizi icermiyor' });
  }

  // Deduplicate by name
  const seen = new Set();
  const businesses = rawData
    .filter(item => item && item.name)
    .filter(item => {
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (businesses.length === 0) {
    return res.status(400).json({ error: 'Dosyada gecerli isletme bulunamadi' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO campaigns (id, name, keyword, country, city, districts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, campaignName, filename, 'Türkiye', '', '[]');

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  broadcast('campaign_created', campaign);

  // Add to queue instead of starting immediately
  importQueue.push({ id, name: campaignName, businesses });
  processImportQueue();

  res.json({ success: true, campaign, totalBusinesses: businesses.length, queuePosition: importQueue.length });
});

// Batch queue: add multiple JSON files at once
app.post('/api/import/batch', (req, res) => {
  const { filenames } = req.body;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ error: 'Dosya listesi gerekli' });
  }

  const added = [];
  for (const filename of filenames) {
    const filePath = path.join(KOLAY_RESULTS_DIR, filename);
    if (!fs.existsSync(filePath)) continue;

    let rawData;
    try { rawData = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (!Array.isArray(rawData)) continue;

    const seen = new Set();
    const businesses = rawData.filter(item => item && item.name).filter(item => {
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (businesses.length === 0) continue;

    const id = uuidv4();
    const campaignName = filename.replace('.json', '') + ' - Google Tarama';
    db.prepare(`INSERT INTO campaigns (id, name, keyword, country, city, districts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, campaignName, filename, 'Türkiye', '', '[]');

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    broadcast('campaign_created', campaign);

    importQueue.push({ id, name: campaignName, businesses });
    added.push({ id, name: campaignName, count: businesses.length });
  }

  processImportQueue();
  res.json({ success: true, added, queueLength: importQueue.length });
});

// Queue status
app.get('/api/import/queue', (req, res) => {
  res.json({
    running: importQueueRunning,
    queue: importQueue.map(j => ({ id: j.id, name: j.name, count: j.businesses.length }))
  });
});

app.post('/api/import/upload', express.json({ limit: '50mb' }), (req, res) => {
  const { campaignName, businesses: rawBusinesses } = req.body;
  if (!campaignName || !Array.isArray(rawBusinesses) || rawBusinesses.length === 0) {
    return res.status(400).json({ error: 'Kampanya adi ve isletme listesi gerekli' });
  }

  const seen = new Set();
  const businesses = rawBusinesses
    .filter(item => item && item.name)
    .filter(item => {
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (businesses.length === 0) {
    return res.status(400).json({ error: 'Gecerli isletme bulunamadi' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO campaigns (id, name, keyword, country, city, districts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, campaignName, 'yuklenen-dosya', 'Türkiye', '', '[]');

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  broadcast('campaign_created', campaign);

  importQueue.push({ id, name: campaignName, businesses });
  processImportQueue();

  res.json({ success: true, campaign, totalBusinesses: businesses.length, queuePosition: importQueue.length });
});

// === UPDATE ===

app.get('/api/update/check', (req, res) => {
  const rootDir = path.join(__dirname, '..');
  exec('git fetch && git log HEAD..origin/main --oneline', { cwd: rootDir }, (err, stdout) => {
    if (err) return res.json({ hasUpdate: false, error: err.message });
    const commits = stdout.trim().split('\n').filter(Boolean);
    res.json({ hasUpdate: commits.length > 0, commits });
  });
});

app.post('/api/update/apply', (req, res) => {
  const rootDir = path.join(__dirname, '..');
  res.json({ success: true, message: 'Güncelleme başladı, uygulama yeniden başlayacak...' });

  broadcast('update_status', { step: 'pulling', message: 'Güncellemeler indiriliyor...' });

  const steps = [
    { cmd: 'git pull', label: 'Kod güncelleniyor...' },
    { cmd: 'cd backend && npm install --silent', label: 'Backend paketleri güncelleniyor...' },
    { cmd: 'cd frontend && npm install --silent && npm run build', label: 'Frontend derleniyor...' },
  ];

  let i = 0;
  function runNext() {
    if (i >= steps.length) {
      broadcast('update_status', { step: 'done', message: 'Güncelleme tamamlandı! Yeniden başlatılıyor...' });
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    const step = steps[i++];
    broadcast('update_status', { step: 'running', message: step.label });
    exec(step.cmd, { cwd: rootDir, shell: '/bin/bash' }, (err) => {
      if (err) {
        broadcast('update_status', { step: 'error', message: `Hata: ${err.message}` });
        return;
      }
      runNext();
    });
  }
  setTimeout(runNext, 500);
});

// === STATS ===

app.get('/api/stats', (req, res) => {
  const totalCampaigns = db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c;
  const totalBusinesses = db.prepare('SELECT COUNT(*) as c FROM businesses').get().c;
  const activeCampaignCount = activeCampaigns.size;
  res.json({ totalCampaigns, totalBusinesses, activeCampaigns: activeCampaignCount });
});

// SPA fallback
app.get('*', (req, res) => {
  const indexPath = path.join(frontendDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Frontend build not found. Run: cd frontend && npm run build' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}`);
});
