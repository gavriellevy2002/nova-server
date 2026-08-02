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
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!process.env.ANTHROPIC_API_KEY) console.error('\n⚠️  missing ANTHROPIC_API_KEY\n');
if (!TOKEN) console.error('\n⚠️  missing NOVA_TOKEN — anyone could use this server. Set one.\n');

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = n => path.join(DATA_DIR, n);
function loadJSON(n, def) { try { return JSON.parse(fs.readFileSync(FILE(n), 'utf8')); } catch { return def; } }
function saveJSON(n, v) { fs.writeFileSync(FILE(n), JSON.stringify(v, null, 2)); }

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

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL, email: !!mailer, tasks: tasks.length }));

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
  console.log(`  model ${MODEL} · email ${mailer ? 'on' : 'off'} · tasks ${tasks.length} · token ${TOKEN ? 'set' : 'MISSING'}\n`);
});
