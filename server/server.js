/**
 * Digital Resilience Assessment — Backend Server v2.0
 * =====================================================
 * v2 adds: user auth (register/login), roles (standard|admin),
 * SSE live dashboard for admins, session tokens in data/_sessions.json,
 * users in data/_users.json (bcrypt-hashed passwords).
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY            = process.env.DRA_API_KEY            || '';
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY      || '';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL     || 'https://api.anthropic.com';
const DATA_DIR           = path.join(__dirname, 'data');
const BCRYPT_ROUNDS      = 10;
const SESSION_TTL_MS     = 8 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Auth-Token'],
}));

// ── Company file helpers ──────────────────────────────────────────────────────
function getCompanyKey(company) {
  return 'DRA_' + (company || 'DEFAULT').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}
function companyFilePath(companyKey) {
  const safe = companyKey.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
  return path.join(DATA_DIR, safe + '.json');
}
function readCompany(companyKey) {
  const fp = companyFilePath(companyKey);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return null; }
}
function writeCompany(companyKey, data) {
  fs.writeFileSync(companyFilePath(companyKey), JSON.stringify(data, null, 2), 'utf8');
}

// ── User helpers ──────────────────────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, '_users.json');
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { return {}; }
}
function writeUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), 'utf8'); }

// ── Session helpers ───────────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(DATA_DIR, '_sessions.json');
function readSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch(e) { return {}; }
}
function writeSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf8'); }

function createSession(username, role) {
  const token = uuidv4();
  const sessions = readSessions();
  for (const [t, s] of Object.entries(sessions)) {
    if (s.username === username) delete sessions[t];
  }
  sessions[token] = { username, role, created_at: Date.now(), expires_at: Date.now() + SESSION_TTL_MS, last_seen: Date.now() };
  writeSessions(sessions);
  return token;
}

function resolveSession(token) {
  if (!token) return null;
  const sessions = readSessions();
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() > s.expires_at) { delete sessions[token]; writeSessions(sessions); return null; }
  s.last_seen = Date.now();
  sessions[token] = s;
  writeSessions(sessions);
  return s;
}

function deleteSession(token) {
  const sessions = readSessions();
  delete sessions[token];
  writeSessions(sessions);
}

// ── SSE admin broadcast ───────────────────────────────────────────────────────
const adminClients = new Set();
function broadcastToAdmins(eventType, payload) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of adminClients) {
    try { client.write(msg); } catch(e) { adminClients.delete(client); }
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = resolveSession(req.headers['x-auth-token']);
  if (!session) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  req.session = session; next();
}
function requireAdmin(req, res, next) {
  const session = resolveSession(req.headers['x-auth-token']);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  req.session = session; next();
}
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

// ── Frontend ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const hp = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(hp)) res.sendFile(hp);
  else res.status(404).send('Place security-assessment-app.html in /public as index.html');
});

// ════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { username, password, displayName, company, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 3)   return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)   return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = readUsers();
  const key = username.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  users[key] = {
    username: key,
    displayName: displayName || username,
    password: hash,
    role: 'standard',
    profile: {
      name:    displayName || username,
      company: company || '',
      role:    role    || '',
    },
    created_at: new Date().toISOString(),
    last_login: null,
  };
  writeUsers(users);

  const token = createSession(key, 'standard');
  console.log(`[AUTH] Registered: ${key}`);
  res.status(201).json({
    ok: true, token,
    username:    key,
    displayName: users[key].displayName,
    role:        'standard',
    profile:     users[key].profile,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const users = readUsers();
  const key   = username.toLowerCase().trim();
  const user  = users[key];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const match = await bcrypt.compare(password, user.password);
  if (!match)  return res.status(401).json({ error: 'Invalid username or password' });

  user.last_login = new Date().toISOString();
  users[key] = user;
  writeUsers(users);

  const token = createSession(key, user.role);
  console.log(`[AUTH] Login: ${key} (${user.role})`);
  res.json({
    ok: true, token,
    username:    key,
    displayName: user.displayName,
    role:        user.role,
    profile:     user.profile || { name: user.displayName, company: '', role: '' },
  });
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(req.headers['x-auth-token']);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = readUsers()[req.session.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    username:    user.username,
    displayName: user.displayName,
    role:        user.role,
    profile:     user.profile || { name: user.displayName, company: '', role: '' },
    created_at:  user.created_at,
    last_login:  user.last_login,
  });
});

app.get('/api/auth/check-username/:username', (req, res) => {
  const users = readUsers();
  const key = req.params.username.toLowerCase().trim();
  res.json({ exists: !!users[key] });
});

// ════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const list = Object.values(readUsers()).map(u => ({
    username: u.username, displayName: u.displayName, role: u.role,
    created_at: u.created_at, last_login: u.last_login
  }));
  res.json(list);
});

app.patch('/api/admin/users/:username/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin','standard'].includes(role)) return res.status(400).json({ error: 'role must be admin or standard' });
  const users = readUsers();
  const key = req.params.username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  if (key === req.session.username && role !== 'admin') return res.status(400).json({ error: 'Cannot demote yourself' });
  users[key].role = role;
  writeUsers(users);
  res.json({ ok: true, username: key, role });
});

app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const users = readUsers();
  const key = req.params.username.toLowerCase();
  if (key === req.session.username) return res.status(400).json({ error: 'Cannot delete yourself' });
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  delete users[key];
  writeUsers(users);
  res.json({ ok: true });
});

function buildSnapshot() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  return files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return {
        company: d.company, last_updated: d.last_updated,
        scores: d.scores || {},
        score_changelog: (d.score_changelog || []).slice(-50),
        respondent_count: Object.keys(d.respondents || {}).length,
        respondents: Object.entries(d.respondents || {}).map(([k, r]) => ({
          key: k, name: r.name, role: r.role,
          services_covered: Object.keys(r.services || {}).length,
        })),
      };
    } catch(e) { return null; }
  }).filter(Boolean);
}

app.get('/api/admin/snapshot', requireAdmin, (req, res) => res.json(buildSnapshot()));

app.get('/api/admin/live', (req, res) => {
  // EventSource can't set headers — accept token from query param OR header
  const token = req.query.token || req.headers['x-auth-token'];
  const session = resolveSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  req.session = session;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);
  adminClients.add(res);
  console.log(`[SSE] Admin ${req.session.username} connected (${adminClients.size} online)`);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) { clearInterval(ping); }}, 25000);
  req.on('close', () => { adminClients.delete(res); clearInterval(ping); console.log(`[SSE] Admin ${req.session.username} left`); });
});

// ════════════════════════════════════════════════════════
// COMPANY / ASSESSMENT ROUTES
// ════════════════════════════════════════════════════════

app.get('/api/company/:company', requireAuth, (req, res) => {
  const key  = getCompanyKey(req.params.company);
  const data = readCompany(key);
  if (!data) return res.json({ company: req.params.company, last_updated: null, respondents: {}, scores: {}, score_changelog: [] });
  res.json(data);
});

app.post('/api/company/:company', requireAuth, (req, res) => {
  const key      = getCompanyKey(req.params.company);
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Invalid body' });

  const existing = readCompany(key) || { company: req.params.company, last_updated: null, respondents: {}, scores: {}, score_changelog: [] };
  if (incoming.respondents)   existing.respondents   = { ...existing.respondents, ...incoming.respondents };
  if (incoming.scores)        existing.scores        = { ...existing.scores, ...incoming.scores };
  if (Array.isArray(incoming.score_changelog) && incoming.score_changelog.length > 0) {
    existing.score_changelog = [...(existing.score_changelog || []), ...incoming.score_changelog].slice(-500);
  }
  existing.last_updated = new Date().toISOString();
  writeCompany(key, existing);

  broadcastToAdmins('update', {
    company: existing.company, last_updated: existing.last_updated,
    scores: existing.scores,
    score_changelog: (existing.score_changelog || []).slice(-50),
    respondent_count: Object.keys(existing.respondents || {}).length,
    respondents: Object.entries(existing.respondents || {}).map(([k, r]) => ({
      key: k, name: r.name, role: r.role,
      services_covered: Object.keys(r.services || {}).length,
    })),
  });
  res.json({ ok: true });
});

app.get('/api/company/:company/respondents', requireAuth, (req, res) => {
  const data = readCompany(getCompanyKey(req.params.company));
  if (!data) return res.json([]);
  res.json(Object.entries(data.respondents).map(([k, r]) => ({
    key: k, name: r.name, role: r.role, session: r.session,
    services_covered: Object.keys(r.services || {}).length,
  })));
});

app.delete('/api/company/:company/respondent', requireAuth, (req, res) => {
  const { respondentKey } = req.body;
  if (!respondentKey) return res.status(400).json({ error: 'respondentKey required' });
  const key  = getCompanyKey(req.params.company);
  const data = readCompany(key);
  if (!data || !data.respondents[respondentKey]) return res.status(404).json({ error: 'Not found' });
  delete data.respondents[respondentKey];
  data.last_updated = new Date().toISOString();
  writeCompany(key, data);
  res.json({ ok: true });
});

app.get('/api/companies', requireAuth, (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  res.json(files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return { company: d.company, last_updated: d.last_updated, respondent_count: Object.keys(d.respondents || {}).length };
    } catch(e) { return null; }
  }).filter(Boolean));
});

app.post('/api/claude', requireAuth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const r = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch(err) { res.status(502).json({ error: 'Claude API unreachable' }); }
});

app.get('/api/health', (req, res) => {
  const users = readUsers();
  res.json({
    status: 'ok', version: '2.0.0',
    users_registered: Object.keys(users).length,
    admin_count: Object.values(users).filter(u => u.role === 'admin').length,
    admin_sessions: adminClients.size,
    anthropic_key: ANTHROPIC_KEY ? 'configured' : 'missing',
    anthropic_url: ANTHROPIC_BASE_URL,
    api_key_guard: API_KEY ? 'enabled' : 'disabled',
  });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  const users = readUsers();
  const adminCount = Object.values(users).filter(u => u.role === 'admin').length;
  console.log(`\n🛡️  Digital Resilience Assessment Server v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Users: ${Object.keys(users).length} (${adminCount} admin)`);
  console.log(`   Anthropic key: ${ANTHROPIC_KEY ? 'configured ✓' : 'MISSING'}`);
  if (adminCount === 0) console.log(`\n   ⚠️  No admins yet! Register, then set role:"admin" in data/_users.json\n`);
});
