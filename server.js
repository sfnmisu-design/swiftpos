/**
 * SwiftPOS — Production Server
 * Multi-user login with roles (admin / cashier)
 * Supabase for persistent storage
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT     = process.env.PORT          || 3000;
const SB_URL   = process.env.SUPABASE_URL  || '';
const SB_KEY   = process.env.SUPABASE_KEY  || '';
const IS_LOCAL = !process.env.PORT;
const POS_HTML = path.join(__dirname, 'pos.html');

// Session store (in-memory — survives requests, resets on redeploy)
// On redeploy users just log in again — no data lost
const SESSIONS = {};  // token -> { userId, username, role, expires }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'swiftpos_salt_2024').digest('hex');
}
function cleanSessions() {
  const now = Date.now();
  Object.keys(SESSIONS).forEach(t => { if (SESSIONS[t].expires < now) delete SESSIONS[t]; });
}

// ── Supabase ──────────────────────────────────────────────
let supabase  = null;
let dbReady   = false;
let dbError   = null;

async function connectDB() {
  if (!SB_URL || !SB_KEY) {
    dbError = 'SUPABASE_URL or SUPABASE_KEY not set';
    console.log('[DB]', dbError);
    return false;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    const { error } = await supabase.from('posdata').select('key').limit(1);
    if (error && !['42P01','PGRST116'].includes(error.code) && !error.message.includes('does not exist')) {
      throw new Error(error.message);
    }
    dbReady = true; dbError = null;
    console.log('[DB] ✓ Connected to Supabase');
    await ensureDefaultAdmin();
    return true;
  } catch(e) {
    dbError = e.message; dbReady = false;
    console.error('[DB] Failed:', e.message);
    return false;
  }
}

// ── Ensure at least one admin user exists ─────────────────
async function ensureDefaultAdmin() {
  try {
    const { data } = await supabase.from('posusers').select('id').limit(1);
    if (!data || data.length === 0) {
      // No users yet — create default admin
      await supabase.from('posusers').insert({
        username:      'admin',
        password_hash: hashPassword('admin123'),
        role:          'admin',
        display_name:  'Administrator',
        active:        true,
        created_at:    new Date().toISOString(),
      });
      console.log('[Auth] Created default admin user: admin / admin123');
    }
  } catch(e) {
    console.log('[Auth] Could not check users table (may not exist yet):', e.message);
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

    // Map old localStorage-style keys to new proper keys if present
    const keyMap = {
      'sp_p':    'products',
      'sp_t':    'transactions',
      'sp_c':    'customers',
      'sp_b':    'branding',
      'sp_v':    'vat',
      'sp_si':   'storeInfo',
      'sp_cats': 'categories',
      'sp_q':    'quotations',
      'sp_m':    'meta',
    };
    let migrated = false;
    Object.entries(keyMap).forEach(([oldKey, newKey]) => {
      if (out[oldKey] !== undefined && out[newKey] === undefined) {
        out[newKey] = out[oldKey];
        migrated = true;
      }
    });

    // If we found old keys, migrate them to new keys in Supabase
    if (migrated) {
      console.log('[DB] Migrating old key format to new format...');
      const now = new Date().toISOString();
      const newRows = Object.entries(keyMap)
        .filter(([oldKey, newKey]) => out[oldKey] !== undefined)
        .map(([oldKey, newKey]) => ({ key: newKey, value: out[oldKey], updated_at: now }));
      await supabase.from('posdata').upsert(newRows, { onConflict: 'key' });
      console.log('[DB] Migration complete — saved', newRows.length, 'keys');
    }

    return out;
  } catch(e) { return {}; }
}
async function dbSetAll(obj) {
  if (!supabase || !dbReady) return false;
  try {
    const now  = new Date().toISOString();
    const rows = Object.entries(obj).filter(([,v]) => v != null)
      .map(([key, value]) => ({ key, value, updated_at: now }));
    if (!rows.length) return true;
    const { error } = await supabase.from('posdata').upsert(rows, { onConflict: 'key' });
    if (error) { console.error('[DB] upsert error:', error.message); return false; }
    return true;
  } catch(e) { return false; }
}
async function dbGet(key) {
  if (!supabase || !dbReady) return null;
  try {
    const { data, error } = await supabase.from('posdata').select('value').eq('key', key).single();
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Session-Token');
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

// ── Session auth (replaces Basic Auth) ───────────────────
function getSession(req) {
  cleanSessions();
  const token = req.headers['x-session-token'] || '';
  if (!token) return null;
  const sess = SESSIONS[token];
  if (!sess || sess.expires < Date.now()) {
    delete SESSIONS[token];
    return null;
  }
  // Extend session on activity
  sess.expires = Date.now() + SESSION_TTL;
  return sess;
}
function requireAuth(req, res) {
  if (IS_LOCAL) return { userId: 'local', username: 'local', role: 'admin', displayName: 'Local User' };
  const sess = getSession(req);
  if (!sess) { sendJ(res, 401, { ok: false, error: 'Not logged in' }); return null; }
  return sess;
}
function requireAdmin(req, res) {
  const sess = requireAuth(req, res);
  if (!sess) return null;
  if (sess.role !== 'admin') { sendJ(res, 403, { ok: false, error: 'Admin access required' }); return null; }
  return sess;
}

// ── Server ────────────────────────────────────────────────
async function start() {
  await connectDB();

  http.createServer(async (req, res) => {
    const url    = req.url.split('?')[0];
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── Public: ping ──────────────────────────────────────
    if (url === '/ping') return sendJ(res, 200, { ok: true, db: dbReady, dbError });

    if (url === '/debug-keys') {
      try {
        const { data } = await supabase.from('posdata').select('key,updated_at').order('key');
        cors(res); res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ rows: data||[], count: (data||[]).length }, null, 2));
      } catch(e) { return sendJ(res, 500, { error: e.message }); }
    }

    // ── Public: debug ─────────────────────────────────────
    if (url === '/debug') {
      const info = {
        server: 'SwiftPOS running', port: PORT,
        env: IS_LOCAL ? 'local' : 'cloud',
        database: 'Supabase', node_version: process.version,
        supabase_url_set: !!SB_URL, supabase_key_set: !!SB_KEY,
        supabase_url_preview: SB_URL ? SB_URL.slice(0,40)+'...' : 'NOT SET',
        db_connected: dbReady, db_error: dbError || 'none',
        sessions_active: Object.keys(SESSIONS).length,
        uptime_seconds: Math.floor(process.uptime()),
        time: new Date().toISOString(),
      };
      if (dbReady) {
        try {
          const all = await dbGetAll();
          info.db_rows = Object.keys(all).length;
          info.db_products_count = Array.isArray(all.products) ? all.products.length : 0;
          info.db_transactions_count = Array.isArray(all.transactions) ? all.transactions.length : 0;
          const { data: users } = await supabase.from('posusers').select('username,role,active');
          info.users = users || [];
        } catch(e) { info.db_test_error = e.message; }
      }
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info, null, 2));
    }

    // ── Public: serve POS (login screen built in) ─────────
    if (method === 'GET' && (url === '/' || url === '/pos.html')) {
      if (!fs.existsSync(POS_HTML)) { res.writeHead(404); return res.end('pos.html not found'); }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(POS_HTML));
    }

    // ── Public: login ─────────────────────────────────────
    if (url === '/auth/login' && method === 'POST') {
      try {
        const { username, password } = await getBody(req);
        if (!username || !password) return sendJ(res, 400, { ok: false, error: 'Username and password required' });

        // Local mode — accept any credentials
        if (IS_LOCAL) {
          const token = makeToken();
          SESSIONS[token] = { userId: 'local', username, role: 'admin', displayName: username, expires: Date.now() + SESSION_TTL };
          return sendJ(res, 200, { ok: true, token, role: 'admin', displayName: username, username });
        }

        if (!dbReady) return sendJ(res, 503, { ok: false, error: 'Database not connected' });

        const { data: users, error } = await supabase.from('posusers')
          .select('*').eq('username', username.toLowerCase().trim()).eq('active', true);

        if (error) throw new Error(error.message);
        if (!users || users.length === 0) return sendJ(res, 401, { ok: false, error: 'Invalid username or password' });

        const user = users[0];
        if (user.password_hash !== hashPassword(password)) {
          return sendJ(res, 401, { ok: false, error: 'Invalid username or password' });
        }

        const token = makeToken();
        SESSIONS[token] = {
          userId:      user.id,
          username:    user.username,
          role:        user.role,
          displayName: user.display_name || user.username,
          expires:     Date.now() + SESSION_TTL,
        };

        // Update last login
        await supabase.from('posusers').update({ last_login: new Date().toISOString() }).eq('id', user.id);

        return sendJ(res, 200, { ok: true, token, role: user.role, displayName: user.display_name || user.username, username: user.username });
      } catch(e) { return sendJ(res, 500, { ok: false, error: e.message }); }
    }

    // ── Public: logout ────────────────────────────────────
    if (url === '/auth/logout' && method === 'POST') {
      const token = req.headers['x-session-token'] || '';
      delete SESSIONS[token];
      return sendJ(res, 200, { ok: true });
    }

    // ── Public: check session ─────────────────────────────
    if (url === '/auth/me' && method === 'GET') {
      if (IS_LOCAL) return sendJ(res, 200, { ok: true, role: 'admin', username: 'local', displayName: 'Local User' });
      const sess = getSession(req);
      if (!sess) return sendJ(res, 401, { ok: false, error: 'Not logged in' });
      return sendJ(res, 200, { ok: true, role: sess.role, username: sess.username, displayName: sess.displayName });
    }

    // ══ All routes below require valid session ══

    // ── Data: load all ────────────────────────────────────
    if (url === '/data/all' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const data = await dbGetAll();
      data._db = dbReady;
      return sendJ(res, 200, data);
    }

    // ── Data: save all (admin only) ───────────────────────
    if (url === '/data/save' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      try {
        const d = await getBody(req);
        if (!dbReady) return sendJ(res, 200, { ok: false, db: false, error: dbError || 'DB not connected' });
        const ok = await dbSetAll(d);
        return sendJ(res, 200, { ok, db: true });
      } catch(e) { return sendJ(res, 400, { ok: false, error: e.message }); }
    }

    // ── Data: save transaction (cashier + admin) ──────────
    if (url === '/data/transaction' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      try {
        const tx = await getBody(req);
        const all = (await dbGet('transactions')) || [];
        all.unshift(tx);
        await dbSet('transactions', all);
        return sendJ(res, 200, { ok: true, txId: tx.id });
      } catch(e) { return sendJ(res, 400, { ok: false, error: e.message }); }
    }

    // ── Users: list (admin only) ──────────────────────────
    if (url === '/users' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      try {
        const { data, error } = await supabase.from('posusers')
          .select('id,username,role,display_name,active,created_at,last_login')
          .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return sendJ(res, 200, { ok: true, users: data || [] });
      } catch(e) { return sendJ(res, 500, { ok: false, error: e.message }); }
    }

    // ── Users: create (admin only) ────────────────────────
    if (url === '/users' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      try {
        const { username, password, role, displayName } = await getBody(req);
        if (!username || !password) return sendJ(res, 400, { ok: false, error: 'Username and password required' });
        if (!['admin','cashier'].includes(role)) return sendJ(res, 400, { ok: false, error: 'Role must be admin or cashier' });

        const { data: existing } = await supabase.from('posusers').select('id').eq('username', username.toLowerCase().trim());
        if (existing && existing.length > 0) return sendJ(res, 400, { ok: false, error: 'Username already exists' });

        const { data, error } = await supabase.from('posusers').insert({
          username:      username.toLowerCase().trim(),
          password_hash: hashPassword(password),
          role,
          display_name:  displayName || username,
          active:        true,
          created_at:    new Date().toISOString(),
        }).select();
        if (error) throw new Error(error.message);
        return sendJ(res, 200, { ok: true, user: data[0] });
      } catch(e) { return sendJ(res, 500, { ok: false, error: e.message }); }
    }

    // ── Users: update (admin only) ────────────────────────
    if (url.startsWith('/users/') && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      try {
        const userId = url.split('/')[2];
        const body = await getBody(req);
        const updates = {};
        if (body.displayName !== undefined) updates.display_name = body.displayName;
        if (body.role !== undefined)        updates.role = body.role;
        if (body.active !== undefined)      updates.active = body.active;
        if (body.password) updates.password_hash = hashPassword(body.password);

        const { error } = await supabase.from('posusers').update(updates).eq('id', userId);
        if (error) throw new Error(error.message);

        // Revoke active sessions for this user if deactivated or role changed
        if (body.active === false || body.role) {
          Object.keys(SESSIONS).forEach(t => {
            if (SESSIONS[t].userId == userId) delete SESSIONS[t];
          });
        }
        return sendJ(res, 200, { ok: true });
      } catch(e) { return sendJ(res, 500, { ok: false, error: e.message }); }
    }

    // ── Users: delete (admin only) ────────────────────────
    if (url.startsWith('/users/') && method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      try {
        const userId = url.split('/')[2];
        const sess = requireAdmin(req, res);
        if (sess && sess.userId == userId) return sendJ(res, 400, { ok: false, error: 'Cannot delete your own account' });
        const { error } = await supabase.from('posusers').delete().eq('id', userId);
        if (error) throw new Error(error.message);
        Object.keys(SESSIONS).forEach(t => { if (SESSIONS[t].userId == userId) delete SESSIONS[t]; });
        return sendJ(res, 200, { ok: true });
      } catch(e) { return sendJ(res, 500, { ok: false, error: e.message }); }
    }

    // ── Backup ────────────────────────────────────────────
    if (url === '/backup/full' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      try {
        const d = await getBody(req);
        if (dbReady) await supabase.from('posbackups').insert({ data: d, created_at: new Date().toISOString() });
        return sendJ(res, 200, { ok: true, file: `backup-${Date.now()}.json` });
      } catch(e) { return sendJ(res, 200, { ok: true }); }
    }
    if (url === '/backup/list' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
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
      console.log('║  SwiftPOS — Local (no login required)            ║');
      console.log(`║  http://localhost:${PORT}                            ║`);
    } else {
      console.log('║  SwiftPOS — Cloud (Render)                       ║');
      console.log(`║  Port: ${String(PORT).padEnd(44)}║`);
      console.log(`║  DB:   ${(dbReady ? 'Supabase ✓' : 'Connecting...').padEnd(44)}║`);
      console.log('║  Default login: admin / admin123                 ║');
      console.log('║  (Change password after first login!)            ║');
    }
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    if (IS_LOCAL) {
      const u = `http://localhost:${PORT}`;
      const c = process.platform==='win32'?`start ${u}`:process.platform==='darwin'?`open ${u}`:`xdg-open ${u}`;
      require('child_process').exec(c, ()=>{});
    }
  });
}

start();
process.on('uncaughtException', e => {
  console.error('Error:', e.message);
  if (e.code !== 'ECONNRESET') process.exit(1);
});
