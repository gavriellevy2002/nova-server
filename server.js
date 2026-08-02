// ============================================================
//  NOVA AGENT SERVER  v1.0  (Phase 1)
//  A cloud brain with real hands: web research, real email,
//  scheduled/recurring tasks, persistent memory.
//  Reachable from phone + Mac. Token-protected.
// ============================================================
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT       = process.env.PORT || 8080;
const MODEL      = process.env.MODEL || 'claude-sonnet-4-5';
const TOKEN      = process.env.NOVA_TOKEN || '';           // shared secret phone/mac must send
const OWNER_MAIL = process.env.OWNER_EMAIL || '';          // where "email me" goes
const TAVILY     = process.env.TAVILY_KEY || '';
// Where state lives. This MUST land on Render's mounted disk, otherwise every
// redeploy silently wipes memory, contacts, scheduled tasks and the voice choice.
// render.yaml mounts the disk at /app/data, but the app itself runs from a
// different directory, so __dirname/data is NOT the disk. Detect the mount.
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  for (const c of ['/app/data', '/var/data']) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch {}
  }
  return path.join(__dirname, 'data');
}
const DATA_DIR = pickDataDir();

// ---------- ElevenLabs (human voice) ----------
// NOTE: as of 2026 only `eleven_v3` supports Hebrew. The flash models are far
// cheaper/faster but English-only-ish, so we pick per language and fall back.
const EL_KEY      = process.env.ELEVEN_KEY || '';
const EL_MODEL_HE = process.env.ELEVEN_MODEL_HE || 'eleven_v3';
const EL_MODEL_EN = process.env.ELEVEN_MODEL_EN || 'eleven_flash_v2_5';
const EL_FALLBACK = 'eleven_multilingual_v2';
const EL_MAX_CHARS = Number(process.env.ELEVEN_MAX_CHARS || 1200);   // cost guard

if (!process.env.ANTHROPIC_API_KEY) console.error('\n⚠️  missing ANTHROPIC_API_KEY\n');
if (!TOKEN) console.error('\n⚠️  missing NOVA_TOKEN — anyone could use this server. Set one.\n');

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = n => path.join(DATA_DIR, n);
function loadJSON(n, def) { try { return JSON.parse(fs.readFileSync(FILE(n), 'utf8')); } catch { return def; } }
function saveJSON(n, v) {
  try { fs.writeFileSync(FILE(n), JSON.stringify(v, null, 2)); }
  catch (e) { console.error('could not save ' + n + ' to ' + DATA_DIR + ':', e.message); }
}

// Boot counter — the honest test of whether state actually survives a redeploy.
// If this stays at 1 forever, the disk is not mounted where we think it is.
const bootInfo = loadJSON('boot.json', { boots: 0, first: null });
bootInfo.boots += 1;
if (!bootInfo.first) bootInfo.first = new Date().toISOString();
bootInfo.last = new Date().toISOString();
saveJSON('boot.json', bootInfo);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- email (Gmail app password) ----------
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendMail(to, subject, body) {
  if (!mailer) throw new Error('email not configured (SMTP_USER/SMTP_PASS)');
  await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, text: body });
}

// ---------- memory ----------
let memory = loadJSON('memory.json', { facts: [], contacts: [] });
function remember(fact) {
  if (!fact || memory.facts.includes(fact)) return;
  memory.facts.push(fact); memory.facts = memory.facts.slice(-300); saveJSON('memory.json', memory);
}
function forget(match) {
  const b = memory.facts.length; const m = String(match).toLowerCase();
  memory.facts = memory.facts.filter(f => !f.toLowerCase().includes(m)); saveJSON('memory.json', memory);
  return b - memory.facts.length;
}
function knownContact(email) {
  return memory.contacts.map(c => c.toLowerCase()).includes(String(email).toLowerCase());
}
function addContact(email) {
  if (email && !knownContact(email)) { memory.contacts.push(email); saveJSON('memory.json', memory); }
}

// ---------- settings (voice choice etc.) ----------
let settings = loadJSON('settings.json', { voiceId: process.env.ELEVEN_VOICE || '' });
if (!settings.voiceId && process.env.ELEVEN_VOICE) settings.voiceId = process.env.ELEVEN_VOICE;
function saveSettings() { saveJSON('settings.json', settings); }

// ---------- pending approvals (email to NEW people) ----------
let pending = loadJSON('pending.json', []);
function addPending(p) { p.id = crypto.randomBytes(4).toString('hex'); p.ts = Date.now(); pending.push(p); saveJSON('pending.json', pending); return p.id; }

// ---------- web search (server-side: no CORS) ----------
async function fetchT(url, opts, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 15000);
  try { return await fetch(url, { ...(opts || {}), signal: c.signal }); } finally { clearTimeout(t); }
}
async function webSearch(q) {
  // 1) Tavily if key
  if (TAVILY) {
    try {
      const r = await fetchT('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY, query: q, max_results: 6, include_answer: true, search_depth: 'advanced' })
      });
      if (r.ok) { const j = await r.json();
        return JSON.stringify({ answer: j.answer || '', results: (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 350) })) }); }
    } catch {}
  }
  // 2) DuckDuckGo instant answer (free, no key)
  try {
    const r = await fetchT('https://api.duckduckgo.com/?format=json&no_html=1&q=' + encodeURIComponent(q));
    if (r.ok) { const j = await r.json(); const bits = [];
      if (j.AbstractText) bits.push(j.AbstractText + (j.AbstractURL ? ' — ' + j.AbstractURL : ''));
      (j.RelatedTopics || []).slice(0, 6).forEach(t => { if (t.Text) bits.push(t.Text + (t.FirstURL ? ' — ' + t.FirstURL : '')); });
      if (bits.length) return bits.join('\n'); }
  } catch {}
  return 'No results. Consider adding a free TAVILY_KEY for reliable search.';
}
async function readPage(url) {
  let u = String(url || '').trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const r = await fetchT('https://r.jina.ai/' + u, { headers: { Accept: 'text/plain' } });
  if (!r.ok) throw new Error('read ' + r.status);
  return (await r.text()).slice(0, 6000);
}

// ---------- scheduled tasks (persistent cron) ----------
let tasks = loadJSON('tasks.json', []);
const jobs = new Map();
function armTask(t) {
  if (jobs.has(t.id)) { jobs.get(t.id).stop(); jobs.delete(t.id); }
  if (!t.active || !cron.validate(t.cron)) return;
  const job = cron.schedule(t.cron, () => runTask(t).catch(e => console.error('task', t.id, e.message)),
    { timezone: t.tz || process.env.TZ || 'Asia/Jerusalem' });
  jobs.set(t.id, job);
}
async function runTask(t) {
  // a task is just an instruction Nova executes autonomously
  const out = await brain([{ role: 'user', content: 'MISSION (scheduled, run autonomously, no questions): ' + t.instruction }], true);
  t.lastRun = Date.now(); t.lastResult = (out || '').slice(0, 500); saveJSON('tasks.json', tasks);
  if (t.count) { t.count -= 1; if (t.count <= 0) { t.active = false; armTask(t); saveJSON('tasks.json', tasks); } }
}
function scheduleTask(instruction, cronExpr, count) {
  if (!cron.validate(cronExpr)) throw new Error('bad cron: ' + cronExpr);
  const t = { id: crypto.randomBytes(4).toString('hex'), instruction, cron: cronExpr, count: count || null, active: true, ts: Date.now() };
  tasks.push(t); saveJSON('tasks.json', tasks); armTask(t); return t;
}
tasks.forEach(armTask); // re-arm on boot

// ============================================================
//  TOOLS
// ============================================================
const TOOLS = [
  { name: 'web_search', description: 'Search the live web. Use for anything current, local, priced, reviewed.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_page', description: 'Fetch and read a web page you have the URL for.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'send_email', description: "Send an email for real. If the recipient is new (not a known contact), it goes to an approval queue instead of sending. To email the owner himself, leave 'to' empty.", input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] } },
  { name: 'schedule_task', description: "Schedule a recurring or future task Nova will run by herself. cron is 5-field (min hour dom mon dow), e.g. '0 7 * * *' = every day 07:00. count = how many times before it stops (omit for forever).", input_schema: { type: 'object', properties: { instruction: { type: 'string' }, cron: { type: 'string' }, count: { type: 'number' } }, required: ['instruction', 'cron'] } },
  { name: 'list_tasks', description: 'List all scheduled tasks.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_task', description: 'Cancel a scheduled task by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'remember', description: 'Save a lasting fact about the owner or his life/business.', input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'forget', description: 'Remove remembered facts containing this text.', input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } }
];

async function runTool(name, i, autonomous) {
  try {
    if (name === 'web_search') return await webSearch(i.query);
    if (name === 'read_page')  return await readPage(i.url).catch(e => 'Could not read: ' + e.message);
    if (name === 'send_email') {
      const to = (i.to && i.to.trim()) ? i.to.trim() : OWNER_MAIL;
      if (!to) return 'No recipient and no OWNER_EMAIL configured.';
      const toOwner = to.toLowerCase() === OWNER_MAIL.toLowerCase();
      if (toOwner || knownContact(to)) { await sendMail(to, i.subject, i.body); if (!toOwner) addContact(to); return 'Sent to ' + to + '.'; }
      // new person → approval queue (smart mix)
      const id = addPending({ to, subject: i.subject, body: i.body });
      return 'HELD FOR APPROVAL (new recipient ' + to + '). It is waiting in the approval queue as #' + id + '. Tell the owner it needs his approval before it sends.';
    }
    if (name === 'schedule_task') { const t = scheduleTask(i.instruction, i.cron, i.count); return 'Scheduled #' + t.id + ' (' + t.cron + ').'; }
    if (name === 'list_tasks')  return JSON.stringify(tasks.map(t => ({ id: t.id, instruction: t.instruction, cron: t.cron, active: t.active, count: t.count })));
    if (name === 'cancel_task') { const t = tasks.find(x => x.id === i.id); if (!t) return 'No such task.'; t.active = false; armTask(t); saveJSON('tasks.json', tasks); return 'Cancelled #' + i.id + '.'; }
    if (name === 'remember')    { remember(i.fact); return 'Saved.'; }
    if (name === 'forget')      return 'Removed ' + forget(i.match) + ' fact(s).';
  } catch (e) { return 'Tool error: ' + e.message; }
  return 'Unknown tool';
}

// ============================================================
//  BRAIN
// ============================================================
function systemPrompt(autonomous) {
  const f = memory.facts.length ? '\n\n## Long-term memory about the owner\n' + memory.facts.map(x => '- ' + x).join('\n') : '';
  return `You are Nova (נובה) — Gavriel's personal AI chief of staff. Bilingual Hebrew/English, brilliant, warm, sharp, funny, ruthlessly effective. You have real hands via tools: live web search, reading pages, sending real email, scheduling tasks that run by themselves, and permanent memory.

RULES
- Actually DO things with tools instead of describing them. If he asks for research and to email it — search, read, compile, and send_email. Don't ask permission for safe actions.
- Money & safety: never spend money, never touch banking, never buy. Those are off-limits, full stop.
- Email to NEW people goes to an approval queue automatically — tell him it's waiting. Email to himself or known contacts sends immediately.
- Use remember generously for his life and business (anniversaries, his wife's taste, contacts, preferences, recurring errands).
- Hebrew in → natural spoken Israeli Hebrew out. English in → English.
- Be concise and practical: one clear recommendation, then act.${f}
- Now: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })} (Israel).${autonomous ? '\n- THIS IS A SCHEDULED AUTONOMOUS RUN. Complete the mission fully with tools and finish. No questions.' : ''}`;
}

async function brain(messages, autonomous) {
  let msgs = messages.slice(-30);
  while (msgs.length && msgs[0].role !== 'user') msgs = msgs.slice(1);
  let reply = '';
  for (let hop = 0; hop < 8; hop++) {
    let j;
    for (let a = 0; a < 3; a++) {
      try { j = await anthropic.messages.create({ model: MODEL, max_tokens: 1500, system: systemPrompt(autonomous), tools: TOOLS, messages: msgs }); break; }
      catch (e) { if (a === 2) throw e; await new Promise(r => setTimeout(r, 600 * (a + 1))); }
    }
    reply += j.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
    const tus = j.content.filter(b => b.type === 'tool_use');
    if (j.stop_reason === 'tool_use' && tus.length) {
      const results = [];
      for (const tu of tus) results.push({ type: 'tool_result', tool_use_id: tu.id, content: await runTool(tu.name, tu.input, autonomous) });
      msgs = msgs.concat([{ role: 'assistant', content: j.content }, { role: 'user', content: results }]);
      continue;
    }
    break;
  }
  return reply.trim();
}

// ============================================================
//  VOICE  (ElevenLabs, server-side so the key never hits the browser)
// ============================================================
const EL_BASE = 'https://api.elevenlabs.io/v1';

// tiny LRU so replaying the same line doesn't cost credits twice
const audioCache = new Map();
const AUDIO_CACHE_MAX = 40;
function cacheGet(k) {
  if (!audioCache.has(k)) return null;
  const v = audioCache.get(k);
  audioCache.delete(k); audioCache.set(k, v);   // refresh recency
  return v;
}
function cachePut(k, buf) {
  audioCache.set(k, buf);
  while (audioCache.size > AUDIO_CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
}

async function elVoices() {
  if (!EL_KEY) return [];
  const r = await fetchT(EL_BASE + '/voices', { headers: { 'xi-api-key': EL_KEY } }, 12000);
  if (!r.ok) throw new Error('elevenlabs voices ' + r.status);
  const j = await r.json();
  return (j.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels || {},
    preview: v.preview_url || ''
  }));
}

async function elUsage() {
  if (!EL_KEY) return null;
  const r = await fetchT(EL_BASE + '/user/subscription', { headers: { 'xi-api-key': EL_KEY } }, 12000);
  if (!r.ok) throw new Error('elevenlabs usage ' + r.status);
  const j = await r.json();
  const used = j.character_count || 0, limit = j.character_limit || 0;
  return {
    tier: j.tier || 'free',
    used, limit,
    remaining: Math.max(0, limit - used),
    pct: limit ? Math.round((used / limit) * 100) : 0,
    resetsAt: j.next_character_count_reset_unix
      ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null
  };
}

async function elTTS(text, lang) {
  if (!EL_KEY) throw new Error('no ELEVEN_KEY');
  const voiceId = settings.voiceId;
  if (!voiceId) throw new Error('no voice selected');

  const say = String(text || '').slice(0, EL_MAX_CHARS);
  if (!say.trim()) throw new Error('empty text');

  const primary = lang === 'he' ? EL_MODEL_HE : EL_MODEL_EN;
  const chain = [primary, EL_FALLBACK].filter((m, i, a) => a.indexOf(m) === i);

  const key = crypto.createHash('sha1').update(voiceId + '|' + primary + '|' + say).digest('hex');
  const hit = cacheGet(key);
  if (hit) return hit;

  let lastErr = null;
  for (const model_id of chain) {
    try {
      const r = await fetchT(
        EL_BASE + '/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3_44100_128',
        {
          method: 'POST',
          headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({
            text: say,
            model_id,
            voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true }
          })
        },
        30000
      );
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        lastErr = new Error('elevenlabs ' + r.status + ' (' + model_id + ') ' + detail.slice(0, 220));
        lastErr.status = r.status;
        // classify so the app can say something useful instead of "tts 503"
        if (/quota|credit|exceed/i.test(detail) || r.status === 429) lastErr.reason = 'credits';
        else if (r.status === 401 || r.status === 403) lastErr.reason = 'auth';
        else lastErr.reason = 'other';
        if (lastErr.reason !== 'other') break;   // key/quota problems won't fix themselves
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { lastErr = new Error('empty audio'); continue; }
      cachePut(key, buf);
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('tts failed');
}

// ============================================================
//  HTTP
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (!TOKEN) return next();
  const t = req.get('x-nova-token') || req.query.token || '';
  if (t !== TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
}

app.get('/health', (req, res) => res.json({
  ok: true, model: MODEL, email: !!mailer, tasks: tasks.length,
  voice: !!EL_KEY, voiceReady: !!(EL_KEY && settings.voiceId), voiceId: settings.voiceId || '',
  dataDir: DATA_DIR, boots: bootInfo.boots,
  persisted: DATA_DIR === '/app/data' || DATA_DIR === '/var/data' || !!process.env.DATA_DIR,
  memories: memory.facts.length, contacts: memory.contacts.length
}));

app.get('/api/usage', auth, async (req, res) => {
  try { res.json(await elUsage() || { error: 'no key' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- voice ----------
app.get('/api/voices', auth, async (req, res) => {
  try { res.json({ voices: await elVoices(), current: settings.voiceId || '' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voice', auth, (req, res) => {
  const id = String(req.body.voiceId || '').trim();
  if (!id) return res.status(400).json({ error: 'voiceId required' });
  settings.voiceId = id; saveSettings();
  res.json({ ok: true, voiceId: id });
});

app.post('/api/speak', auth, async (req, res) => {
  try {
    const buf = await elTTS(req.body.text, req.body.lang === 'he' ? 'he' : 'en');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('tts:', e.message);
    // client falls back to the browser voice, but now it can say WHY
    res.status(503).json({ error: e.message, reason: e.reason || 'other' });
  }
});

const conv = []; // simple shared history for the built-in UI
app.post('/api/chat', auth, async (req, res) => {
  try {
    const text = String(req.body.message || '').trim();
    if (!text) return res.json({ reply: '...' });
    conv.push({ role: 'user', content: text });
    const reply = await brain(conv, false);
    conv.push({ role: 'assistant', content: reply });
    while (conv.length > 30) conv.shift();
    res.json({ reply, pending: pending.length });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/pending', auth, (req, res) => res.json(pending));
app.post('/api/approve', auth, async (req, res) => {
  const p = pending.find(x => x.id === req.body.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try { await sendMail(p.to, p.subject, p.body); addContact(p.to);
    pending = pending.filter(x => x.id !== p.id); saveJSON('pending.json', pending);
    res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/reject', auth, (req, res) => { pending = pending.filter(x => x.id !== req.body.id); saveJSON('pending.json', pending); res.json({ ok: true }); });
app.get('/api/tasks', auth, (req, res) => res.json(tasks));

app.listen(PORT, () => {
  console.log(`\n✦ NOVA agent server on :${PORT}`);
  const v = !EL_KEY ? 'browser (free)' : (settings.voiceId ? 'ElevenLabs ✓' : 'ElevenLabs — pick a voice in ☰');
  console.log(`  model ${MODEL} · email ${mailer ? 'on' : 'off'} · tasks ${tasks.length} · token ${TOKEN ? 'set' : 'MISSING'} · voice ${v}`);
  console.log(`  data  ${DATA_DIR}  (boot #${bootInfo.boots}, ${memory.facts.length} memories, ${tasks.length} tasks)`);
  if (bootInfo.boots === 1) console.log('  ⚠ first boot on this storage — if this says #1 after every deploy, the disk is NOT persisting\n');
  else console.log('');
});
