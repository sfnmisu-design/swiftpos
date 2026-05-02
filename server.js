/**
 * SwiftPOS — Production Server
 * Works locally AND on Railway/Render cloud hosting
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = process.env.PORT || 3000;
const PASSWORD = process.env.POS_PASSWORD || 'swiftpos2024';
const DATA_DIR = path.join(__dirname, 'data');
const POS_HTML = path.join(__dirname, 'pos.html');
const IS_LOCAL = !process.env.PORT;

['', 'backups', 'receipts'].forEach(sub => {
  const dir = path.join(DATA_DIR, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const F = {
  products:     path.join(DATA_DIR, 'products.json'),
  transactions: path.join(DATA_DIR, 'transactions.json'),
  customers:    path.join(DATA_DIR, 'customers.json'),
  branding:     path.join(DATA_DIR, 'branding.json'),
  vat:          path.join(DATA_DIR, 'vat.json'),
  storeInfo:    path.join(DATA_DIR, 'storeinfo.json'),
  categories:   path.join(DATA_DIR, 'categories.json'),
  quotations:   path.join(DATA_DIR, 'quotations.json'),
  meta:         path.join(DATA_DIR, 'meta.json'),
};

function readJ(p)    { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : null; } catch(e){ return null; } }
function writeJ(p,d) { try { fs.writeFileSync(p, JSON.stringify(d,null,2),'utf8'); return true; } catch(e){ return false; } }
function ts()        { return new Date().toISOString().replace(/[:.]/g,'-').slice(0,19); }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function sendJ(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function getBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end',  () => { try { resolve(b ? JSON.parse(b) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}
function checkAuth(req, res) {
  if (IS_LOCAL) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SwiftPOS"');
    res.writeHead(401); res.end('Login required'); return false;
  }
  const pass = Buffer.from(auth.slice(6),'base64').toString().split(':').slice(1).join(':');
  if (pass !== PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SwiftPOS"');
    res.writeHead(401); res.end('Wrong password'); return false;
  }
  return true;
}

http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // Ping — no auth needed (lets pos.html detect connectivity)
  if (url === '/ping') return sendJ(res, 200, { ok: true });

  // Serve the POS app
  if (method === 'GET' && (url === '/' || url === '/pos.html')) {
    if (!checkAuth(req, res)) return;
    if (!fs.existsSync(POS_HTML)) { res.writeHead(404); return res.end('pos.html not found'); }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(POS_HTML));
  }

  if (!checkAuth(req, res)) return;

  if (url === '/data/all' && method === 'GET')
    return sendJ(res, 200, {
      products: readJ(F.products), transactions: readJ(F.transactions),
      customers: readJ(F.customers), branding: readJ(F.branding),
      vat: readJ(F.vat), storeInfo: readJ(F.storeInfo),
      categories: readJ(F.categories), quotations: readJ(F.quotations), meta: readJ(F.meta),
    });

  if (url === '/data/save' && method === 'POST') {
    try {
      const d = await getBody(req);
      Object.entries({ products:F.products, transactions:F.transactions, customers:F.customers,
        branding:F.branding, vat:F.vat, storeInfo:F.storeInfo,
        categories:F.categories, quotations:F.quotations, meta:F.meta })
        .forEach(([k,p]) => { if (d[k] != null) writeJ(p, d[k]); });
      return sendJ(res, 200, { ok: true });
    } catch(e) { return sendJ(res, 400, { ok:false, error: e.message }); }
  }

  if (url === '/data/transaction' && method === 'POST') {
    try {
      const tx = await getBody(req);
      const all = readJ(F.transactions) || [];
      all.unshift(tx); writeJ(F.transactions, all);
      writeJ(path.join(DATA_DIR,'receipts',`receipt-${tx.id}-${ts()}.json`), tx);
      return sendJ(res, 200, { ok:true, txId:tx.id });
    } catch(e) { return sendJ(res, 400, { ok:false, error:e.message }); }
  }

  if (url === '/backup/full' && method === 'POST') {
    try {
      const d = await getBody(req);
      const file = path.join(DATA_DIR,'backups',`full-backup-${ts()}.json`);
      writeJ(file, { ...d, exported: new Date().toISOString(), version:'1.0' });
      return sendJ(res, 200, { ok:true, file:path.basename(file) });
    } catch(e) { return sendJ(res, 400, { ok:false, error:e.message }); }
  }

  if (url === '/backup/list' && method === 'GET') {
    try {
      const dir = path.join(DATA_DIR,'backups');
      const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'))
        .map(f=>{ const s=fs.statSync(path.join(dir,f)); return {name:f,size:s.size,modified:s.mtime}; })
        .sort((a,b)=>new Date(b.modified)-new Date(a.modified));
      return sendJ(res, 200, { ok:true, backups:files });
    } catch(e) { return sendJ(res, 200, { ok:true, backups:[] }); }
  }

  if (url === '/status') return sendJ(res, 200, { ok:true, env: IS_LOCAL?'local':'cloud' });

  sendJ(res, 404, { ok:false, error:`Unknown: ${method} ${url}` });

}).listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  if (IS_LOCAL) {
    console.log('║      SwiftPOS — Running Locally              ║');
    console.log(`║   Open: http://localhost:${PORT}                  ║`);
    console.log('║   No password needed (local mode)            ║');
  } else {
    console.log('║      SwiftPOS — Running in Cloud             ║');
    console.log(`║   Port: ${String(PORT).padEnd(37)}║`);
    console.log('║   Password protection: ON                    ║');
  }
  console.log('╚══════════════════════════════════════════════╝\n');

  if (IS_LOCAL) {
    const u = `http://localhost:${PORT}`;
    const c = process.platform==='win32'?`start ${u}`:process.platform==='darwin'?`open ${u}`:`xdg-open ${u}`;
    require('child_process').exec(c, ()=>{});
  }
});

process.on('uncaughtException', e => {
  if (e.code==='EADDRINUSE') console.error(`\nPort ${PORT} already in use.\n`);
  else console.error('Error:', e.message);
  process.exit(1);
});
