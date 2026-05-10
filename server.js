/**
 * SwiftPOS — Production Server
 * Sessions stored in Supabase (survive restarts)
 * Falls back to memory if possessions table doesn't exist yet
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT     = process.env.PORT         || 3000;
const SB_URL   = process.env.SUPABASE_URL || '';
const SB_KEY   = process.env.SUPABASE_KEY || '';
const IS_LOCAL = !process.env.PORT;
const POS_HTML = path.join(__dirname, 'pos.html');

function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPw(pw)  { return crypto.createHash('sha256').update(pw + 'swiftpos_salt_2024').digest('hex'); }

// ── Supabase ──────────────────────────────────────────────
let sb = null, dbReady = false, dbError = null;
let sessionsInDB = false; // true once possessions table confirmed to exist

async function connectDB() {
  if (!SB_URL || !SB_KEY) {
    dbError = 'SUPABASE_URL or SUPABASE_KEY not set';
    console.log('[DB]', dbError);
    return;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    // Test posdata table
    const { error } = await sb.from('posdata').select('key').limit(1);
    if (error && !['42P01','PGRST116'].includes(error.code) && !error.message.includes('does not exist')) {
      throw new Error(error.message);
    }
    dbReady = true; dbError = null;
    console.log('[DB] ✓ Connected to Supabase');
    // Check if possessions table exists
    const { error: se } = await sb.from('possessions').select('id').limit(1);
    if (!se) {
      sessionsInDB = true;
      console.log('[DB] ✓ Sessions table ready');
    } else {
      sessionsInDB = false;
      console.log('[DB] Sessions table not found — using memory sessions (create it in Supabase SQL editor)');
    }
    await ensureAdmin();
  } catch(e) {
    dbError = e.message; dbReady = false;
    console.error('[DB] Failed:', e.message);
  }
}

async function ensureAdmin() {
  try {
    const { data } = await sb.from('posusers').select('id').limit(1);
    if (!data || !data.length) {
      await sb.from('posusers').insert({
        username: 'admin', password_hash: hashPw('admin123'),
        role: 'admin', display_name: 'Administrator',
        active: true, created_at: new Date().toISOString()
      });
      console.log('[Auth] Default admin created: admin / admin123');
    }
  } catch(e) { console.log('[Auth]', e.message); }
}

// ── Session store (Supabase preferred, memory fallback) ───
const MEM_SESSIONS = {}; // fallback
const SESSION_TTL  = 8 * 60 * 60 * 1000; // 8 hours

async function createSession(userId, username, role, displayName) {
  const token   = makeToken();
  const expires = new Date(Date.now() + SESSION_TTL).toISOString();
  if (sessionsInDB) {
    try {
      await sb.from('possessions').insert({ token, user_id: String(userId), username, role, display_name: displayName, expires_at: expires });
      return token;
    } catch(e) {
      console.log('[Session] DB insert failed, using memory:', e.message);
      sessionsInDB = false;
    }
  }
  // Memory fallback
  MEM_SESSIONS[token] = { user_id: userId, username, role, display_name: displayName, expires_at: expires };
  return token;
}

async function getSession(token) {
  if (!token) return null;
  // Check memory first
  if (MEM_SESSIONS[token]) {
    const s = MEM_SESSIONS[token];
    if (new Date(s.expires_at) < new Date()) { delete MEM_SESSIONS[token]; return null; }
    MEM_SESSIONS[token].expires_at = new Date(Date.now() + SESSION_TTL).toISOString();
    return s;
  }
  // Check Supabase
  if (sessionsInDB && sb) {
    try {
      const { data } = await sb.from('possessions').select('*').eq('token', token).single();
      if (!data) return null;
      if (new Date(data.expires_at) < new Date()) {
        await sb.from('possessions').delete().eq('token', token);
        return null;
      }
      await sb.from('possessions').update({ expires_at: new Date(Date.now() + SESSION_TTL).toISOString() }).eq('token', token);
      return data;
    } catch(e) { return null; }
  }
  return null;
}

async function deleteSession(token) {
  delete MEM_SESSIONS[token];
  if (sessionsInDB && sb) {
    try { await sb.from('possessions').delete().eq('token', token); } catch(e) {}
  }
}

// ── Data helpers ──────────────────────────────────────────
async function dbGetAll() {
  if (!sb || !dbReady) return {};
  try {
    const { data, error } = await sb.from('posdata').select('key,value');
    if (error) return {};
    const out = {};
    (data||[]).forEach(r => { out[r.key] = r.value; });
    // Auto-migrate old sp_* keys
    const km = { sp_p:'products', sp_t:'transactions', sp_c:'customers', sp_b:'branding', sp_v:'vat', sp_si:'storeInfo', sp_cats:'categories', sp_q:'quotations', sp_m:'meta' };
    let migrated = false;
    Object.entries(km).forEach(([o,n]) => { if (out[o]!==undefined && out[n]===undefined) { out[n]=out[o]; migrated=true; } });
    if (migrated) {
      const rows = Object.entries(km).filter(([o]) => out[o]!==undefined).map(([o,n]) => ({ key:n, value:out[o], updated_at:new Date().toISOString() }));
      await sb.from('posdata').upsert(rows, { onConflict:'key' });
      console.log('[DB] Migrated', rows.length, 'old keys to new format');
    }
    return out;
  } catch(e) { return {}; }
}

async function dbSetAll(obj) {
  if (!sb || !dbReady) return false;
  try {
    const rows = Object.entries(obj).filter(([,v]) => v!=null).map(([key,value]) => ({ key, value, updated_at:new Date().toISOString() }));
    if (!rows.length) return true;
    const { error } = await sb.from('posdata').upsert(rows, { onConflict:'key' });
    if (error) { console.error('[DB] save error:', error.message); return false; }
    return true;
  } catch(e) { return false; }
}

async function dbGet(key) {
  if (!sb||!dbReady) return null;
  try { const {data}=await sb.from('posdata').select('value').eq('key',key).single(); return data?data.value:null; } catch(e) { return null; }
}
async function dbSet(key, value) {
  if (!sb||!dbReady) return false;
  try { const {error}=await sb.from('posdata').upsert({key,value,updated_at:new Date().toISOString()},{onConflict:'key'}); return !error; } catch(e) { return false; }
}

// ── HTTP helpers ──────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Session-Token');
}
function sendJ(res, code, obj) {
  cors(res);
  res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}
function getBody(req) {
  return new Promise((res,rej) => {
    let b='';
    req.on('data', c => b+=c);
    req.on('end', () => { try{res(b?JSON.parse(b):{});}catch(e){rej(e);} });
    req.on('error', rej);
  });
}

async function requireAuth(req, res) {
  if (IS_LOCAL) return { user_id:'local', username:'local', role:'admin', display_name:'Local User' };
  const sess = await getSession(req.headers['x-session-token']||'');
  if (!sess) { sendJ(res, 401, {ok:false, error:'Not logged in'}); return null; }
  return sess;
}
async function requireAdmin(req, res) {
  const sess = await requireAuth(req, res);
  if (!sess) return null;
  if (sess.role!=='admin') { sendJ(res, 403, {ok:false, error:'Admin access required'}); return null; }
  return sess;
}

// ── Server ────────────────────────────────────────────────
async function start() {
  await connectDB();

  http.createServer(async (req, res) => {
    const url = req.url.split('?')[0], method = req.method.toUpperCase();
    if (method==='OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (url==='/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── Public ────────────────────────────────────────────
    if (url==='/ping') return sendJ(res, 200, {ok:true, db:dbReady, sessions:sessionsInDB?'supabase':'memory'});

    if (url==='/debug') {
      const info = {
        server:'SwiftPOS', port:PORT, env:IS_LOCAL?'local':'cloud',
        node_version:process.version, db_connected:dbReady, db_error:dbError||'none',
        sessions_storage:sessionsInDB?'supabase':'memory (create possessions table)',
        supabase_url_set:!!SB_URL, supabase_key_set:!!SB_KEY,
        supabase_url_preview:SB_URL?SB_URL.slice(0,40)+'...':'NOT SET',
        uptime_seconds:Math.floor(process.uptime()), time:new Date().toISOString(),
      };
      if (dbReady) {
        try {
          const all = await dbGetAll();
          info.db_rows = Object.keys(all).length;
          info.db_products_count = Array.isArray(all.products) ? all.products.length : 0;
          info.db_transactions_count = Array.isArray(all.transactions) ? all.transactions.length : 0;
          info.db_keys = Object.keys(all);
          const {data:u} = await sb.from('posusers').select('username,role,active');
          info.users = u||[];
        } catch(e) { info.db_test_error = e.message; }
      }
      cors(res); res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify(info,null,2));
    }

    if (method==='GET' && (url==='/'||url==='/pos.html')) {
      if (!fs.existsSync(POS_HTML)) { res.writeHead(404); return res.end('pos.html not found'); }
      cors(res); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(POS_HTML));
    }

    // ── Auth ──────────────────────────────────────────────
    if (url==='/auth/login' && method==='POST') {
      try {
        const {username, password} = await getBody(req);
        if (!username||!password) return sendJ(res,400,{ok:false,error:'Username and password required'});
        if (IS_LOCAL) {
          const token = makeToken();
          MEM_SESSIONS[token] = {user_id:'local',username,role:'admin',display_name:username,expires_at:new Date(Date.now()+SESSION_TTL).toISOString()};
          return sendJ(res,200,{ok:true,token,role:'admin',displayName:username,username});
        }
        if (!dbReady) return sendJ(res,503,{ok:false,error:'Database not connected — check /debug'});
        const {data:users,error} = await sb.from('posusers').select('*').eq('username',username.toLowerCase().trim()).eq('active',true);
        if (error) throw new Error(error.message);
        if (!users?.length) return sendJ(res,401,{ok:false,error:'Invalid username or password'});
        const user = users[0];
        if (user.password_hash !== hashPw(password)) return sendJ(res,401,{ok:false,error:'Invalid username or password'});
        const token = await createSession(user.id, user.username, user.role, user.display_name||user.username);
        await sb.from('posusers').update({last_login:new Date().toISOString()}).eq('id',user.id);
        return sendJ(res,200,{ok:true,token,role:user.role,displayName:user.display_name||user.username,username:user.username});
      } catch(e) {
        console.error('[Login]', e.message);
        return sendJ(res,500,{ok:false,error:e.message});
      }
    }

    if (url==='/auth/logout' && method==='POST') {
      await deleteSession(req.headers['x-session-token']||'');
      return sendJ(res,200,{ok:true});
    }

    if (url==='/auth/me' && method==='GET') {
      if (IS_LOCAL) return sendJ(res,200,{ok:true,role:'admin',username:'local',displayName:'Local User'});
      const sess = await getSession(req.headers['x-session-token']||'');
      if (!sess) return sendJ(res,401,{ok:false,error:'Not logged in'});
      return sendJ(res,200,{ok:true,role:sess.role,username:sess.username,displayName:sess.display_name});
    }

    // ── Authenticated ─────────────────────────────────────
    if (url==='/data/all' && method==='GET') {
      if (!await requireAuth(req,res)) return;
      const data = await dbGetAll(); data._db = dbReady;
      return sendJ(res,200,data);
    }

    if (url==='/data/save' && method==='POST') {
      if (!await requireAuth(req,res)) return;
      try {
        const d = await getBody(req);
        if (!dbReady) return sendJ(res,200,{ok:false,db:false,error:'DB not connected'});
        const ok = await dbSetAll(d);
        return sendJ(res,200,{ok,db:true});
      } catch(e) { return sendJ(res,400,{ok:false,error:e.message}); }
    }

    if (url==='/data/transaction' && method==='POST') {
      if (!await requireAuth(req,res)) return;
      try {
        const tx = await getBody(req);
        const all = (await dbGet('transactions'))||[];
        all.unshift(tx); await dbSet('transactions',all);
        return sendJ(res,200,{ok:true});
      } catch(e) { return sendJ(res,400,{ok:false,error:e.message}); }
    }

    if (url==='/users' && method==='GET') {
      if (!await requireAdmin(req,res)) return;
      try {
        const {data,error} = await sb.from('posusers').select('id,username,role,display_name,active,created_at,last_login').order('created_at',{ascending:true});
        if (error) throw new Error(error.message);
        return sendJ(res,200,{ok:true,users:data||[]});
      } catch(e) { return sendJ(res,500,{ok:false,error:e.message}); }
    }

    if (url==='/users' && method==='POST') {
      if (!await requireAdmin(req,res)) return;
      try {
        const {username,password,role,displayName} = await getBody(req);
        if (!username||!password) return sendJ(res,400,{ok:false,error:'Username and password required'});
        if (!['admin','cashier'].includes(role)) return sendJ(res,400,{ok:false,error:'Role must be admin or cashier'});
        const {data:ex} = await sb.from('posusers').select('id').eq('username',username.toLowerCase().trim());
        if (ex?.length) return sendJ(res,400,{ok:false,error:'Username already exists'});
        const {error} = await sb.from('posusers').insert({username:username.toLowerCase().trim(),password_hash:hashPw(password),role,display_name:displayName||username,active:true,created_at:new Date().toISOString()});
        if (error) throw new Error(error.message);
        return sendJ(res,200,{ok:true});
      } catch(e) { return sendJ(res,500,{ok:false,error:e.message}); }
    }

    if (url.startsWith('/users/') && method==='POST') {
      if (!await requireAdmin(req,res)) return;
      try {
        const userId = url.split('/')[2];
        const body = await getBody(req);
        const updates = {};
        if (body.displayName!==undefined) updates.display_name=body.displayName;
        if (body.role!==undefined)        updates.role=body.role;
        if (body.active!==undefined)      updates.active=body.active;
        if (body.password)                updates.password_hash=hashPw(body.password);
        const {error} = await sb.from('posusers').update(updates).eq('id',userId);
        if (error) throw new Error(error.message);
        if (body.active===false||body.role) {
          if (sessionsInDB) await sb.from('possessions').delete().eq('user_id',userId);
          Object.keys(MEM_SESSIONS).forEach(t => { if (String(MEM_SESSIONS[t].user_id)===String(userId)) delete MEM_SESSIONS[t]; });
        }
        return sendJ(res,200,{ok:true});
      } catch(e) { return sendJ(res,500,{ok:false,error:e.message}); }
    }

    if (url.startsWith('/users/') && method==='DELETE') {
      const sess = await requireAdmin(req,res);
      if (!sess) return;
      try {
        const userId = url.split('/')[2];
        if (String(sess.user_id)===String(userId)) return sendJ(res,400,{ok:false,error:'Cannot delete your own account'});
        await sb.from('posusers').delete().eq('id',userId);
        if (sessionsInDB) await sb.from('possessions').delete().eq('user_id',userId);
        Object.keys(MEM_SESSIONS).forEach(t => { if (String(MEM_SESSIONS[t].user_id)===String(userId)) delete MEM_SESSIONS[t]; });
        return sendJ(res,200,{ok:true});
      } catch(e) { return sendJ(res,500,{ok:false,error:e.message}); }
    }

    if (url==='/backup/full' && method==='POST') {
      if (!await requireAdmin(req,res)) return;
      try { const d=await getBody(req); if(dbReady) await sb.from('posbackups').insert({data:d,created_at:new Date().toISOString()}); return sendJ(res,200,{ok:true,file:`backup-${Date.now()}.json`}); } catch(e){ return sendJ(res,200,{ok:true}); }
    }
    if (url==='/backup/list' && method==='GET') {
      if (!await requireAdmin(req,res)) return;
      try { if(dbReady){const{data}=await sb.from('posbackups').select('id,created_at').order('created_at',{ascending:false}).limit(20);return sendJ(res,200,{ok:true,backups:(data||[]).map(b=>({name:`backup-${b.created_at.slice(0,10)}.json`,size:0,modified:b.created_at}))});} return sendJ(res,200,{ok:true,backups:[]}); } catch(e){ return sendJ(res,200,{ok:true,backups:[]}); }
    }

    sendJ(res, 404, {ok:false, error:`Unknown: ${method} ${url}`});

  }).listen(PORT, '0.0.0.0', () => {
    console.log(`\nSwiftPOS on port ${PORT} | DB:${dbReady?'✓':'x'} | Sessions:${sessionsInDB?'Supabase':'memory'}\n`);
    if (IS_LOCAL) require('child_process').exec(process.platform==='win32'?`start http://localhost:${PORT}`:`open http://localhost:${PORT}`,()=>{});
  });
}

start();
process.on('uncaughtException', e => { console.error('Error:', e.message); if (e.code!=='ECONNRESET') process.exit(1); });
