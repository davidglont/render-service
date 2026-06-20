const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const RENDER_TOKEN = process.env.RENDER_TOKEN || ''; // setează-l pe Railway
const FILES_DIR = path.join(__dirname, 'public', 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

// servește PNG-urile generate static: /files/<jobId>/<n>.png
app.use('/files', express.static(FILES_DIR, { maxAge: '7d' }));

// browser reutilizat între request-uri (mai rapid, mai puțină memorie)
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    console.log('launching puppeteer...');
    browserPromise = puppeteer.launch({
      headless: 'new',
      timeout: 20000,
      protocolTimeout: 20000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--single-process',
        '--no-zygote',
        '--font-render-hinting=none'
      ]
    }).then((b) => {
      console.log('puppeteer launched ok');
      return b;
    }).catch((err) => {
      console.error('puppeteer launch FAILED:', err);
      browserPromise = null; // permite retry la următorul request
      throw err;
    });
  }
  return browserPromise;
}

// ---- TEMPLATE SLIDE (brand Neural Core: fundal închis, accent cyan/albastru) ----
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slideHtml(slide, meta) {
  const { width, height } = meta;
  const kicker = escapeHtml(slide.kicker || '');
  const headline = escapeHtml(slide.headline || '');
  const body = escapeHtml(slide.body || '');
  const num = `${meta.index}/${meta.total}`;
  const brand = escapeHtml(meta.brand || 'NEURAL CORE');

  return `<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${width}px; height:${height}px; }
  body {
    background: radial-gradient(120% 100% at 0% 0%, #101a33 0%, #0a0e1a 55%, #06080f 100%);
    color:#e9f0ff; font-family:'Inter',sans-serif;
    display:flex; flex-direction:column; justify-content:space-between;
    padding:90px 84px; position:relative; overflow:hidden;
  }
  .glow { position:absolute; width:520px; height:520px; border-radius:50%;
    background:radial-gradient(circle, rgba(34,211,238,0.22), transparent 70%);
    top:-160px; right:-120px; filter:blur(8px); }
  .top { display:flex; justify-content:space-between; align-items:center;
    font-size:30px; font-weight:700; letter-spacing:2px; color:#7dd3fc; z-index:2; }
  .num { color:#3b82f6; }
  .mid { z-index:2; }
  .kicker { font-size:30px; font-weight:700; letter-spacing:3px; text-transform:uppercase;
    color:#22d3ee; margin-bottom:28px; }
  .headline { font-family:'Archivo Black',sans-serif; line-height:1.04;
    font-size:${headline.length > 40 ? 76 : 96}px; letter-spacing:-1px; }
  .headline .hl { color:#22d3ee; }
  .body { font-size:40px; line-height:1.45; color:#aebfd9; margin-top:40px; max-width:90%; font-weight:400; }
  .bottom { display:flex; align-items:center; gap:18px; z-index:2; }
  .dot { width:14px; height:14px; border-radius:50%; background:#22d3ee; box-shadow:0 0 18px #22d3ee; }
  .brand { font-size:28px; font-weight:700; letter-spacing:4px; color:#5b7bb0; text-transform:uppercase; }
  .bar { position:absolute; left:0; bottom:0; height:10px; width:${Math.round((meta.index/meta.total)*100)}%;
    background:linear-gradient(90deg,#3b82f6,#22d3ee); z-index:3; }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="top"><span>${brand}</span><span class="num">${num}</span></div>
  <div class="mid">
    ${kicker ? `<div class="kicker">${kicker}</div>` : ''}
    <div class="headline">${headline}</div>
    ${body ? `<div class="body">${body}</div>` : ''}
  </div>
  <div class="bottom"><span class="dot"></span><span class="brand">${brand}</span></div>
  <div class="bar"></div>
</body>
</html>`;
}

function auth(req, res, next) {
  if (!RENDER_TOKEN) return next(); // dacă nu ai setat token, merge fără (nu recomandat)
  const h = req.headers.authorization || '';
  if (h === `Bearer ${RENDER_TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/', (req, res) => res.json({ ok: true, service: 'content-machine-render', node: process.version }));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/render', auth, async (req, res) => {
  try {
    const slides = Array.isArray(req.body.slides) ? req.body.slides : [];
    if (!slides.length) return res.status(400).json({ error: 'no slides' });

    const opts = req.body.options || {};
    const width = opts.width || 1080;   // 1080x1350 = carusel IG (4:5). Pentru TikTok pune 1080x1920.
    const height = opts.height || 1350;
    const brand = opts.brand || 'NEURAL CORE';

    const jobId = crypto.randomBytes(6).toString('hex');
    const jobDir = path.join(FILES_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const browser = await getBrowser();
    const urls = [];
    const base = (process.env.PUBLIC_URL
      || `${(req.headers['x-forwarded-proto'] || 'https')}://${req.headers.host}`).replace(/\/$/, '');

    for (let i = 0; i < slides.length; i++) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      const html = slideHtml(slides[i], {
        width, height, brand, index: i + 1, total: slides.length
      });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      const file = path.join(jobDir, `${i + 1}.png`);
      await page.screenshot({ path: file, type: 'png' });
      await page.close();
      urls.push(`${base}/files/${jobId}/${i + 1}.png`);
    }

    res.json({ jobId, count: urls.length, urls });
  } catch (err) {
    console.error('render error:', err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

console.log('booting render service, PORT=', PORT);
app.listen(PORT, () => console.log(`render service on :${PORT}`));
