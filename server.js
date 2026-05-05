/**
 * SwiftPOS — Production Server
 * Uses Supabase (free PostgreSQL) for persistent storage.
 * Requires Node.js 22+ (has native WebSocket built in)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = process.env.PORT           || 3000;
const PASSWORD = process.env.POS_PASSWORD   || 'swiftpos2024';
const SB_URL   = process.env.SUPABASE_URL   || '';
const SB_KEY   = process.env.SUPABASE_KEY   || '';
const IS_LOCAL = !process.env.PORT;
const POS_HTML = path.join(__dirname, 'pos.html');

// ── Supabase ──────────────────────────────────────────────
let supabase = null;
let dbReady  = false;
let dbError  = null;

async function connectDB() {
  if (!SB_URL || !SB_KEY) {
    dbError = 'SUPABASE_URL or SUPABASE_KEY not set';
    console.log('[DB]', dbError);
    return false;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    // Node 22 has native WebSocket — no ws package needed
    supabase = createClient(SB_URL, SB_KEY, {
      auth: { persistSession: false },
    });
    // Test with a real query
    const { error } = await supabase.from('posdata').select('key').limit(1);
    if (error && !error.message.includes('does not exist') && error.code !== '42P01' && error.code !== 'PGRST116') {
      throw new Error(error.message);
    }
    dbReady = true;
    dbError = null;
    console.log('[DB] ✓ Connected to Supabase');
    return true;
  } catch(e) {
    dbError = e.message;
    dbReady = false;
    console.error('[DB] Failed:', e.message);
    return false;
  }
}

// ── DB helpers ────────────────────────────────────────────
async function dbGetAll() {
  if (!supabase || !dbReady) return {};
  try {
    const { data, error } = await supabase.from('posdata').select('key,value');
    if (error) return {};
    const out = {};
    (data || []).forEach(r => { out[r.key] = r.value; });
    return out;
  } catch(e) { return {}; }
}

async function dbSetAll(obj) {
  if (!supabase || !dbReady) return false;
  try {
    const now  = new Date().toISOString();
    const rows = Object.entries(obj)
      .filter(([, v]) => v != null)
      .map(([key, value]) => ({ key, value, updated_at: now }));
    if (!rows.length) return true;
    const { error } = await supabase
      .from('posdata')
      .upsert(rows, { onConflict: 'key' });
    if (error) { console.error('[DB] upsert error:', error.message); return false; }
    return true;
  } catch(e) { console.error('[DB] setAll error:', e.message); return false; }
}

async function dbGet(key) {
  if (!supabase || !dbReady) return null;
  try {
    const { data, error } = await supabase
      .from('posdata').select('value').eq('key', key).single();
    if (error) return null;
    return data ? data.value : null;
  } catch(e) { return null; }
}

async function dbSet(key, value) {
  if (!supabase || !dbReady) return false;
  try {
    const { error } = await supabase.from('posdata')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    return !error;
  } catch(e) { return false; }
}

// ── HTTP helpers ──────────────────────────────────────────
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
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch(e) { reject(e); } });
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
  const pass = Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':');
  if (pass !== PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="SwiftPOS"');
    res.writeHead(401); res.end('Wrong password'); return false;
  }
  return true;
}

// ── Server ────────────────────────────────────────────────
async function start() {
  await connectDB();

  http.createServer(async (req, res) => {
    const url    = req.url.split('?')[0];
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // Ping — no auth
    if (url === '/ping') return sendJ(res, 200, { ok: true, db: dbReady, dbError });

    // Debug — no auth, shows full status
    if (url === '/debug') {
      const info = {
        server:              'SwiftPOS running',
        port:                PORT,
        env:                 IS_LOCAL ? 'local' : 'cloud',
        database:            'Supabase (PostgreSQL)',
        node_version:        process.version,
        supabase_url_set:    !!SB_URL,
        supabase_key_set:    !!SB_KEY,
        supabase_url_preview:SB_URL ? SB_URL.slice(0, 40) + '...' : 'NOT SET',
        db_connected:        dbReady,
        db_error:            dbError || 'none',
        uptime_seconds:      Math.floor(process.uptime()),
        time:                new Date().toISOString(),
      };
      if (dbReady) {
        try {
          const all = await dbGetAll();
          info.db_rows              = Object.keys(all).length;
          info.db_keys              = Object.keys(all);
          info.db_products_count    = Array.isArray(all.products)    ? all.products.length    : 0;
          info.db_transactions_count= Array.isArray(all.transactions)? all.transactions.length: 0;
          info.db_customers_count   = Array.isArray(all.customers)   ? all.customers.length   : 0;
        } catch(e) { info.db_test_error = e.message; }
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info, null, 2));
    }

    // Serve POS
    if (method === 'GET' && (url === '/' || url === '/pos.html')) {
      if (!checkAuth(req, res)) return;
      if (!fs.existsSync(POS_HTML)) { res.writeHead(404); return res.end('pos.html not found'); }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(POS_HTML));
    }

    if (!checkAuth(req, res)) return;

    // Load all
    if (url === '/data/all' && method === 'GET') {
      const data = await dbGetAll();
      data._db = dbReady;
      return sendJ(res, 200, data);
    }

    // Save all
    if (url === '/data/save' && method === 'POST') {
      try {
        const d = await getBody(req);
        if (!dbReady) return sendJ(res, 200, { ok: false, db: false, error: dbError || 'DB not connected' });
        const ok = await dbSetAll(d);
        return sendJ(res, 200, { ok, db: true });
      } catch(e) { return sendJ(res, 400, { ok: false, error: e.message }); }
    }

    // Save transaction
    if (url === '/data/transaction' && method === 'POST') {
      try {
        const tx  = await getBody(req);
        const all = (await dbGet('transactions')) || [];
        all.unshift(tx);
        await dbSet('transactions', all);
        return sendJ(res, 200, { ok: true, txId: tx.id });
      } catch(e) { return sendJ(res, 400, { ok: false, error: e.message }); }
    }

    // Backup
    if (url === '/backup/full' && method === 'POST') {
      try {
        const d = await getBody(req);
        if (dbReady) await supabase.from('posbackups').insert({ data: d, created_at: new Date().toISOString() });
        return sendJ(res, 200, { ok: true, file: `backup-${Date.now()}.json` });
      } catch(e) { return sendJ(res, 200, { ok: true }); }
    }

    if (url === '/backup/list' && method === 'GET') {
      try {
        if (dbReady) {
          const { data } = await supabase.from('posbackups').select('id,created_at').order('created_at', { ascending: false }).limit(20);
          return sendJ(res, 200, { ok: true, backups: (data||[]).map(b => ({ name: `backup-${b.created_at.slice(0,10)}.json`, size: 0, modified: b.created_at })) });
        }
        return sendJ(res, 200, { ok: true, backups: [] });
      } catch(e) { return sendJ(res, 200, { ok: true, backups: [] }); }
    }

    if (url === '/status') return sendJ(res, 200, { ok: true, db: dbReady, env: IS_LOCAL ? 'local' : 'cloud' });

    sendJ(res, 404, { ok: false, error: `Unknown: ${method} ${url}` });

  }).listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    if (IS_LOCAL) {
      console.log('║  SwiftPOS — Local                                ║');
      console.log(`║  http://localhost:${PORT}                            ║`);
    } else {
      console.log('║  SwiftPOS — Cloud (Render)                       ║');
      console.log(`║  Port: ${String(PORT).padEnd(44)}║`);
      console.log(`║  Node: ${process.version.padEnd(44)}║`);
      console.log(`║  DB:   ${(dbReady ? 'Supabase ✓' : 'Connecting...').padEnd(44)}║`);
    }
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    if (IS_LOCAL) require('child_process').exec(
      process.platform === 'win32' ? `start http://localhost:${PORT}` : `open http://localhost:${PORT}`,
      () => {}
    );
  });
}

start();
process.on('uncaughtException', e => { console.error('Error:', e.message); if (e.code !== 'ECONNRESET') process.exit(1); });
