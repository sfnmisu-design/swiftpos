/**
 * SwiftPOS — Production Server
 * MongoDB Atlas for persistent multi-device storage
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { MongoClient } = require('mongodb');

const PORT      = process.env.PORT || 3000;
const PASSWORD  = process.env.POS_PASSWORD || 'swiftpos2024';
const MONGO_URI = process.env.MONGODB_URI   || '';
const IS_LOCAL  = !process.env.PORT;
const POS_HTML  = path.join(__dirname, 'pos.html');

// ── MongoDB ───────────────────────────────────────────────
let db         = null;
let dbError    = null;
let dbConnected= false;

async function connectDB() {
  if (!MONGO_URI) {
    dbError = 'MONGODB_URI environment variable is not set in Render';
    console.error('[DB] ' + dbError);
    return false;
  }

  // Validate URI format
  if (!MONGO_URI.startsWith('mongodb')) {
    dbError = 'MONGODB_URI does not look like a valid MongoDB connection string';
    console.error('[DB] ' + dbError);
    return false;
  }

  console.log('[DB] Connecting to MongoDB Atlas...');
  console.log('[DB] URI starts with:', MONGO_URI.slice(0, 30) + '...');

  try {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS:         15000,
      socketTimeoutMS:          30000,
      retryWrites:              true,
      w:                        'majority',
    });

    await client.connect();

    // Test the connection actually works
    await client.db('admin').command({ ping: 1 });

    db          = client.db('swiftpos');
    dbConnected = true;
    dbError     = null;
    console.log('[DB] ✓ Connected to MongoDB Atlas — database: swiftpos');

    // Create indexes for faster queries
    try {
      await db.collection('store').createIndex({ updatedAt: 1 });
    } catch(e) {}

    // Handle disconnects — try to reconnect
    client.on('close', () => {
      dbConnected = false;
      console.log('[DB] Connection closed — will reconnect on next request');
      setTimeout(connectDB, 5000);
    });

    return true;
  } catch(e) {
    dbConnected = false;
    dbError = e.message;
    console.error('[DB] Connection FAILED:', e.message);
    console.error('[DB] Common causes:');
    console.error('[DB]   1. IP not whitelisted — go to Atlas > Network Access > Add 0.0.0.0/0');
    console.error('[DB]   2. Wrong password in connection string');
    console.error('[DB]   3. MONGODB_URI not set in Render environment variables');
    // Retry after 10 seconds
    setTimeout(connectDB, 10000);
    return false;
  }
}

// ── DB helpers ────────────────────────────────────────────
async function dbGet(key) {
  if (!db || !dbConnected) return null;
  try {
    const doc = await db.collection('store').findOne({ _id: key });
    return doc ? doc.value : null;
  } catch(e) {
    console.error('[DB] dbGet error:', e.message);
    return null;
  }
}

async function dbSet(key, value) {
  if (!db || !dbConnected) return false;
  try {
    await db.collection('store').replaceOne(
      { _id: key },
      { _id: key, value, updatedAt: new Date() },
      { upsert: true }
    );
    return true;
  } catch(e) {
    console.error('[DB] dbSet error for key', key, ':', e.message);
    return false;
  }
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
    req.on('data', c => { b += c; if (b.length > 10e6) reject(new Error('Body too large')); });
    req.on('end',  () => { try { resolve(b ? JSON.parse(b) : {}); } catch(e){ reject(e); }});
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

// ── Start ─────────────────────────────────────────────────
async function start() {
  // Start MongoDB connection (non-blocking — server starts regardless)
  connectDB();

  http.createServer(async (req, res) => {
    const url    = req.url.split('?')[0];
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── /ping — no auth needed ────────────────────────────
    if (url === '/ping') {
      return sendJ(res, 200, {
        ok:   true,
        db:   dbConnected,
        dbError: dbError || null,
      });
    }

    // ── /debug — shows connection status (no auth for easy checking) ──
    if (url === '/debug') {
      const info = {
        server:      'SwiftPOS running',
        port:        PORT,
        env:         IS_LOCAL ? 'local' : 'cloud',
        mongodb_uri_set: !!MONGO_URI,
        mongodb_uri_preview: MONGO_URI ? MONGO_URI.slice(0,40)+'...' : 'NOT SET',
        db_connected:   dbConnected,
        db_error:       dbError || 'none',
        node_version:   process.version,
        uptime_seconds: Math.floor(process.uptime()),
        time:           new Date().toISOString(),
      };
      // Try a live DB test
      if (db && dbConnected) {
        try {
          await db.command({ ping: 1 });
          info.db_live_ping = 'OK';
          const count = await db.collection('store').countDocuments();
          info.db_store_documents = count;
        } catch(e) {
          info.db_live_ping = 'FAILED: ' + e.message;
        }
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info, null, 2));
    }

    // ── Serve POS HTML ────────────────────────────────────
    if (method === 'GET' && (url === '/' || url === '/pos.html')) {
      if (!checkAuth(req, res)) return;
      if (!fs.existsSync(POS_HTML)) {
        res.writeHead(404); return res.end('pos.html not found next to server.js');
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(POS_HTML));
    }

    if (!checkAuth(req, res)) return;

    // ── /data/all ─────────────────────────────────────────
    if (url === '/data/all' && method === 'GET') {
      const keys = ['products','transactions','customers','branding',
                    'vat','storeInfo','categories','quotations','meta'];
      const result = {};
      if (dbConnected) {
        await Promise.all(keys.map(async k => { result[k] = await dbGet(k); }));
      }
      result._db = dbConnected;
      return sendJ(res, 200, result);
    }

    // ── /data/save ────────────────────────────────────────
    if (url === '/data/save' && method === 'POST') {
      try {
        const d = await getBody(req);
        if (!dbConnected) {
          return sendJ(res, 200, {
            ok: false,
            db: false,
            error: dbError || 'Database not connected',
          });
        }
        const keys = ['products','transactions','customers','branding',
                      'vat','storeInfo','categories','quotations','meta'];
        const results = await Promise.all(
          keys.map(async k => {
            if (d[k] == null) return true;
            const ok = await dbSet(k, d[k]);
            if (!ok) console.error('[DB] Failed to save key:', k);
            return ok;
          })
        );
        const allOk = results.every(Boolean);
        return sendJ(res, 200, { ok: allOk, db: true });
      } catch(e) {
        return sendJ(res, 400, { ok: false, error: e.message });
      }
    }

    // ── /data/transaction ─────────────────────────────────
    if (url === '/data/transaction' && method === 'POST') {
      try {
        const tx  = await getBody(req);
        const all = (await dbGet('transactions')) || [];
        all.unshift(tx);
        await dbSet('transactions', all);
        return sendJ(res, 200, { ok: true, txId: tx.id });
      } catch(e) {
        return sendJ(res, 400, { ok: false, error: e.message });
      }
    }

    // ── /backup/full ──────────────────────────────────────
    if (url === '/backup/full' && method === 'POST') {
      try {
        const d = await getBody(req);
        if (dbConnected) {
          await db.collection('backups').insertOne({
            ...d, exported: new Date().toISOString(), savedAt: new Date()
          });
        }
        return sendJ(res, 200, { ok: true, file: `backup-${Date.now()}.json` });
      } catch(e) {
        return sendJ(res, 400, { ok: false, error: e.message });
      }
    }

    // ── /backup/list ──────────────────────────────────────
    if (url === '/backup/list' && method === 'GET') {
      try {
        if (dbConnected) {
          const backups = await db.collection('backups')
            .find({}, { projection: { savedAt: 1 } })
            .sort({ savedAt: -1 }).limit(20).toArray();
          return sendJ(res, 200, {
            ok: true,
            backups: backups.map(b => ({
              name:     `backup-${new Date(b.savedAt).toISOString().slice(0,10)}.json`,
              size:     0,
              modified: b.savedAt,
            })),
          });
        }
        return sendJ(res, 200, { ok: true, backups: [] });
      } catch(e) {
        return sendJ(res, 200, { ok: true, backups: [] });
      }
    }

    if (url === '/status') {
      return sendJ(res, 200, {
        ok: true, db: dbConnected, dbError,
        env: IS_LOCAL ? 'local' : 'cloud',
      });
    }

    sendJ(res, 404, { ok: false, error: `Unknown: ${method} ${url}` });

  }).listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    if (IS_LOCAL) {
      console.log('║  SwiftPOS — Local                                ║');
      console.log(`║  Open: http://localhost:${PORT}                      ║`);
    } else {
      console.log('║  SwiftPOS — Cloud                                ║');
      console.log(`║  Port:     ${String(PORT).padEnd(38)}║`);
      console.log(`║  MongoDB:  ${(MONGO_URI ? 'URI set — connecting...' : 'NOT SET — add MONGODB_URI').padEnd(38)}║`);
    }
    console.log('║  Debug:    /debug  (check DB connection)         ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');

    if (IS_LOCAL) {
      const u = `http://localhost:${PORT}`;
      const c = process.platform === 'win32' ? `start ${u}`
              : process.platform === 'darwin' ? `open ${u}` : `xdg-open ${u}`;
      require('child_process').exec(c, () => {});
    }
  });
}

start();

process.on('uncaughtException', e => {
  console.error('Uncaught error:', e.message);
  if (e.code !== 'ECONNRESET') process.exit(1);
});
