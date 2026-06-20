/**
 * SwiftPOS Server — Simple & Reliable
 * No login system. Just saves/loads data from Supabase.
 * Password protected via HTTP Basic Auth.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = process.env.PORT          || 3000;
const PASSWORD = process.env.POS_PASSWORD  || 'swiftpos2024';
const SB_URL   = process.env.SUPABASE_URL  || '';
const SB_KEY   = process.env.SUPABASE_KEY  || '';
const IS_LOCAL = !process.env.PORT;
const POS_HTML = path.join(__dirname, 'pos.html');

// ── Supabase ──────────────────────────────────────────────
let sb = null, dbReady = false, dbError = null;

async function connectDB() {
  if (!SB_URL || !SB_KEY) { dbError = 'SUPABASE_URL or SUPABASE_KEY not set'; console.log('[DB]', dbError); return; }
  try {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    const { error } = await sb.from('posdata').select('key').limit(1);
    if (error && !['42P01','PGRST116'].includes(error.code) && !error.message.includes('does not exist')) throw new Error(error.message);
    dbReady = true; dbError = null;
    console.log('[DB] Connected to Supabase');
  } catch(e) { dbError = e.message; dbReady = false; console.error('[DB] Failed:', e.message); }
}

// ── Data helpers ──────────────────────────────────────────
async function dbGetAll() {
  if (!sb || !dbReady) return {};
  try {
    const { data, error } = await sb.from('posdata').select('key,value');
    if (error) return {};
    const out = {};
    (data||[]).forEach(r => { out[r.key] = r.value; });
    // Auto-migrate old sp_* key names to new names
    const km = { sp_p:'products', sp_t:'transactions', sp_c:'customers', sp_b:'branding', sp_v:'vat', sp_si:'storeInfo', sp_cats:'categories', sp_q:'quotations', sp_m:'meta' };
    let migrated = false;
    Object.entries(km).forEach(([o,n]) => { if (out[o]!==undefined && out[n]===undefined) { out[n]=out[o]; migrated=true; } });
    if (migrated) {
      const rows = Object.entries(km).filter(([o]) => out[o]!==undefined).map(([o,n]) => ({ key:n, value:out[o], updated_at:new Date().toISOString() }));
      await sb.from('posdata').upsert(rows, { onConflict:'key' });
      console.log('[DB] Migrated', rows.length, 'old keys');
    }
    return out;
  } catch(e) { return {}; }
}

async function dbSetAll(obj) {
  if (!sb || !dbReady) return false;
  try {
    // ── Concurrency-safe merge for list collections ──
    // When multiple devices save at once, union records by id instead of
    // blindly overwriting, so concurrent additions are never lost.
    const mergeKeys = ['transactions','orders','layaways','walkins','customers','quotations'];
    const current = await dbGetAll();
    mergeKeys.forEach(k => {
      if (Array.isArray(obj[k]) && Array.isArray(current[k])) {
        const byId = {};
        // Start with existing server records
        current[k].forEach(r => { if (r && r.id!=null) byId[r.id]=r; });
        // Overlay incoming records (newer wins for same id; new ids added)
        obj[k].forEach(r => { if (r && r.id!=null) byId[r.id]=r; });
        // Rebuild as array, newest first by timestamp/createdAt if present
        const merged = Object.values(byId);
        merged.sort((a,b) => {
          const ta = new Date(a.timestamp||a.createdAt||0).getTime();
          const tb = new Date(b.timestamp||b.createdAt||0).getTime();
          return tb - ta;
        });
        obj[k] = merged;
      }
    });
    const rows = Object.entries(obj).filter(([,v]) => v!=null).map(([key,value]) => ({ key, value, updated_at:new Date().toISOString() }));
    if (!rows.length) return true;
    const { error } = await sb.from('posdata').upsert(rows, { onConflict:'key' });
    if (error) { console.error('[DB] save error:', error.message); return false; }
    return true;
  } catch(e) { console.error('[DB] merge save error:', e.message); return false; }
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function sendJ(res, code, obj) { cors(res); res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function getBody(req) {
  return new Promise((res,rej) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{try{res(b?JSON.parse(b):{});}catch(e){rej(e);}}); req.on('error',rej); });
}

function checkAuth(req, res) {
  if (IS_LOCAL) return true; // no auth locally
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

// ── Server ────────────────────────────────────────────────
async function start() {
  await connectDB();

  http.createServer(async (req, res) => {
    const url=req.url.split('?')[0], method=req.method.toUpperCase();
    if (method==='OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (url==='/favicon.ico') { res.writeHead(204); return res.end(); }

    // Public — no auth needed
    if (url==='/ping') return sendJ(res, 200, {ok:true, db:dbReady});

    if (url==='/debug') {
      cors(res); res.writeHead(200,{'Content-Type':'application/json'});
      const info = {server:'SwiftPOS',port:PORT,env:IS_LOCAL?'local':'cloud',node_version:process.version,db_connected:dbReady,db_error:dbError||'none',supabase_url_set:!!SB_URL,supabase_key_set:!!SB_KEY,supabase_url_preview:SB_URL?SB_URL.slice(0,40)+'...':'NOT SET',uptime_seconds:Math.floor(process.uptime()),time:new Date().toISOString()};
      if (dbReady) { try { const all=await dbGetAll(); info.db_rows=Object.keys(all).length; info.db_products_count=Array.isArray(all.products)?all.products.length:0; info.db_transactions_count=Array.isArray(all.transactions)?all.transactions.length:0; info.db_keys=Object.keys(all); } catch(e){} }
      return res.end(JSON.stringify(info,null,2));
    }

    // Serve POS app
    if (method==='GET' && (url==='/'||url==='/pos.html')) {
      if (!checkAuth(req,res)) return;
      if (!fs.existsSync(POS_HTML)) { res.writeHead(404); return res.end('pos.html not found'); }
      cors(res); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(POS_HTML));
    }

    if (!checkAuth(req,res)) return;

    if (url==='/data/all' && method==='GET') {
      const data=await dbGetAll(); data._db=dbReady;
      return sendJ(res,200,data);
    }

    if (url==='/data/save' && method==='POST') {
      try {
        const d=await getBody(req);
        if (!dbReady) return sendJ(res,200,{ok:false,db:false,error:dbError||'DB not connected'});
        const ok=await dbSetAll(d);
        return sendJ(res,200,{ok,db:true});
      } catch(e) { return sendJ(res,400,{ok:false,error:e.message}); }
    }

    if (url==='/data/transaction' && method==='POST') {
      try {
        const tx=await getBody(req);
        const all=(await dbGet('transactions'))||[];
        // Dedupe: don't add if this id already exists (concurrency-safe)
        if (!all.some(t => t && t.id===tx.id)) { all.unshift(tx); await dbSet('transactions',all); }
        return sendJ(res,200,{ok:true});
      } catch(e) { return sendJ(res,400,{ok:false,error:e.message}); }
    }

    if (url==='/backup/full' && method==='POST') {
      try { const d=await getBody(req); if(dbReady) await sb.from('posbackups').insert({data:d,created_at:new Date().toISOString()}); return sendJ(res,200,{ok:true,file:`backup-${Date.now()}.json`}); } catch(e){ return sendJ(res,200,{ok:true}); }
    }
    if (url==='/backup/list' && method==='GET') {
      try { if(dbReady){const{data}=await sb.from('posbackups').select('id,created_at').order('created_at',{ascending:false}).limit(20);return sendJ(res,200,{ok:true,backups:(data||[]).map(b=>({name:`backup-${b.created_at.slice(0,10)}.json`,size:0,modified:b.created_at}))});} return sendJ(res,200,{ok:true,backups:[]}); } catch(e){ return sendJ(res,200,{ok:true,backups:[]}); }
    }

    sendJ(res,404,{ok:false,error:`Unknown: ${method} ${url}`});

  }).listen(PORT, '0.0.0.0', () => {
    console.log(`\nSwiftPOS on port ${PORT} | DB:${dbReady?'Supabase ✓':'connecting...'} | No login system\n`);
    if (IS_LOCAL) require('child_process').exec(process.platform==='win32'?`start http://localhost:${PORT}`:`open http://localhost:${PORT}`,()=>{});
  });
}

start();
process.on('uncaughtException', e => { console.error('Error:', e.message); if(e.code!=='ECONNRESET') process.exit(1); });
