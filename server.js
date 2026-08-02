// ============================================================
//  NOVA AGENT SERVER  v1.0  (Phase 1)
//  A cloud brain with real hands: web research, real email,
//  scheduled/recurring tasks, persistent memory.
//  Reachable from phone + Mac. Token-protected.
// ============================================================
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { chromium } from 'playwright-core';
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
const OWNER_TZ   = process.env.TZ || 'America/New_York';   // Jackson/Lakewood NJ
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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // without these a stalled mail server hangs the whole request forever
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
}
async function sendMail(to, subject, body, headers) {
  if (!mailer) throw new Error('email not configured (SMTP_USER/SMTP_PASS)');
  await mailer.sendMail({ from: process.env.SMTP_USER, to, subject, text: body, ...(headers || {}) });
}

// ---------- inbox (IMAP, same Gmail app password — no OAuth needed) ----------
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const inboxReady = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);

async function withInbox(fn) {
  if (!inboxReady()) throw new Error('inbox not configured (SMTP_USER/SMTP_PASS)');
  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false, emitLogs: false
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try { return await fn(client); } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

const addrList = a => (a && a.length ? a.map(x => x.name ? `${x.name} <${x.address}>` : x.address).join(', ') : '');

async function listInbox({ limit = 15, unreadOnly = false, days = 7 } = {}) {
  return withInbox(async c => {
    const since = new Date(Date.now() - Math.max(1, days) * 86400000);
    const query = unreadOnly ? { seen: false, since } : { since };
    let uids = await c.search(query, { uid: true });
    if (!uids || !uids.length) return [];
    uids = uids.slice(-Math.min(limit, 40));
    const out = [];
    for await (const m of c.fetch({ uid: uids.join(',') }, { uid: true, envelope: true, flags: true, size: true })) {
      out.push({
        uid: m.uid,
        from: addrList(m.envelope.from),
        to: addrList(m.envelope.to),
        subject: m.envelope.subject || '(no subject)',
        date: m.envelope.date,
        unread: !(m.flags && m.flags.has('\\Seen')),
        kb: Math.round((m.size || 0) / 1024)
      });
    }
    return out.reverse();   // newest first
  });
}

async function readEmail(uid) {
  return withInbox(async c => {
    const meta = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true }, { uid: true });
    if (!meta) throw new Error('no message with uid ' + uid);
    const wasUnread = !(meta.flags && meta.flags.has('\\Seen'));

    const { content } = await c.download(String(uid), undefined, { uid: true });
    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    const parsed = await simpleParser(Buffer.concat(chunks));

    // reading it in Nova must not silently mark it read in Gmail
    if (wasUnread) await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true }).catch(() => {});

    return {
      uid: Number(uid),
      from: addrList(meta.envelope.from),
      fromAddress: (meta.envelope.from && meta.envelope.from[0] && meta.envelope.from[0].address) || '',
      to: addrList(meta.envelope.to),
      subject: meta.envelope.subject || '(no subject)',
      date: meta.envelope.date,
      messageId: meta.envelope.messageId || '',
      body: (parsed.text || parsed.html || '').replace(/\s+\n/g, '\n').slice(0, 6000),
      attachments: (parsed.attachments || []).map(a => a.filename).filter(Boolean)
    };
  });
}

async function searchInbox(q, limit = 15) {
  return withInbox(async c => {
    const seen = new Set(); const hits = [];
    for (const query of [{ subject: q }, { from: q }, { body: q }]) {
      let uids = [];
      try { uids = await c.search(query, { uid: true }) || []; } catch { continue; }
      for (const uid of uids.slice(-limit)) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        hits.push(uid);
      }
      if (hits.length >= limit) break;
    }
    if (!hits.length) return [];
    const out = [];
    for await (const m of c.fetch({ uid: hits.slice(-limit).join(',') }, { uid: true, envelope: true, flags: true })) {
      out.push({
        uid: m.uid,
        from: addrList(m.envelope.from),
        subject: m.envelope.subject || '(no subject)',
        date: m.envelope.date,
        unread: !(m.flags && m.flags.has('\\Seen'))
      });
    }
    return out.reverse();
  });
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
    { timezone: t.tz || process.env.TZ || 'America/New_York' });
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
  { name: 'forget', description: 'Remove remembered facts containing this text.', input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } },
  { name: 'list_inbox', description: "List recent emails in the owner's inbox (newest first). Returns uid, from, subject, date, unread. Use unread_only for 'what's new', then read_email for the ones that matter.", input_schema: { type: 'object', properties: { limit: { type: 'number' }, unread_only: { type: 'boolean' }, days: { type: 'number' } } } },
  { name: 'read_email', description: 'Read one full email by its uid (from list_inbox or search_inbox). Reading does NOT mark it read in Gmail.', input_schema: { type: 'object', properties: { uid: { type: 'number' } }, required: ['uid'] } },
  { name: 'search_inbox', description: 'Search the inbox by sender, subject or body text.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'browse_open', description: "Open a real browser on a URL and read it. Returns the page text plus a numbered list of clickable elements. Use this when a site needs JavaScript, a login-free form, or interaction that read_page cannot do.", input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browse_click', description: "Click element number `ref` from the last browse result. Purchases, payments and destructive actions are refused by design.", input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'browse_type', description: "Type into element number `ref`. Set submit:true to press Enter after. Password/card/secret fields are refused.", input_schema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'browse_close', description: 'Close the browser session when finished.', input_schema: { type: 'object', properties: {} } },
  { name: 'reply_email', description: "Reply to an email by uid. The reply threads correctly. Replies ALWAYS go to the approval queue unless the recipient is already an approved contact — receiving mail from someone does not make them approved.", input_schema: { type: 'object', properties: { uid: { type: 'number' }, body: { type: 'string' } }, required: ['uid', 'body'] } }
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

    if (name === 'list_inbox') {
      const list = await listInbox({ limit: i.limit || 15, unreadOnly: !!i.unread_only, days: i.days || 7 });
      return list.length ? JSON.stringify(list) : 'Inbox is empty for that window.';
    }
    if (name === 'search_inbox') {
      const list = await searchInbox(i.query, i.limit || 15);
      return list.length ? JSON.stringify(list) : 'No matching email.';
    }
    if (name === 'read_email') return JSON.stringify(await readEmail(i.uid));

    if (name === 'browse_open')  return await serialize(() => browseOpen(i.url));
    if (name === 'browse_click') return await serialize(() => browseClick(i.ref));
    if (name === 'browse_type')  return await serialize(() => browseType(i.ref, i.text, i.submit));
    if (name === 'browse_close') { await serialize(() => closeSession('asked')); return 'Browser closed.'; }

    if (name === 'reply_email') {
      const src = await readEmail(i.uid);
      const to = src.fromAddress;
      if (!to) return 'Could not work out who to reply to.';
      const subject = /^re:/i.test(src.subject) ? src.subject : 'Re: ' + src.subject;
      const headers = src.messageId ? { inReplyTo: src.messageId, references: [src.messageId] } : {};
      // Someone emailing YOU does not make them an approved contact.
      if (knownContact(to)) { await sendMail(to, subject, i.body, headers); return 'Replied to ' + to + '.'; }
      const id = addPending({ to, subject, body: i.body, headers, replyTo: src.subject });
      return 'HELD FOR APPROVAL (reply to ' + to + ', queue #' + id + '). Tell the owner it is waiting.';
    }
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
- INBOX: you can read his email. list_inbox for what arrived, read_email for the full text, search_inbox to find something, reply_email to answer. When he asks what's new, list unread, read the ones that actually matter, and give him a short triage: what needs him today, what can wait, what is noise. Never claim an email exists without reading it.
- BROWSER: browse_open gives you a real Chromium. Use it when a page needs JavaScript or when you must interact; use read_page for plain reading, it is faster and cheaper. After opening you get numbered elements — click and type by number. Sessions are short, so act decisively: open, read, do the thing, browse_close.
- Browser limits are hard, not negotiable: banking, brokerage and payment sites are blocked outright; buy/pay/checkout/delete-account buttons are refused; password, card and secret fields are refused. If a task needs one of those, do everything up to that point and hand it to him with the exact link and what to press. Never present a refusal as a failure — it is the design.
- Replies to people who are not already approved contacts go to the approval queue. Someone emailing him does NOT make them approved — say the draft is waiting for him.
- Hebrew in → natural spoken Israeli Hebrew out. English in → English.
- Be concise and practical: one clear recommendation, then act.${f}
- Now: ${new Date().toLocaleString('en-GB', { timeZone: OWNER_TZ })} (${OWNER_TZ}). All times he mentions are HIS local time.${autonomous ? '\n- THIS IS A SCHEDULED AUTONOMOUS RUN. Complete the mission fully with tools and finish. No questions.' : ''}`;
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
//  BROWSER  (a real Chromium she can click in)
//  Runs on a cloud browser service over CDP. Chromium needs ~700MB RAM and
//  this server has 512MB, so running it locally here would OOM on page one.
// ============================================================
const BROWSER_WS  = process.env.BROWSER_WS || '';
const BROWSER_TTL = Number(process.env.BROWSER_TTL_MS || 55000);  // free tiers cap sessions ~1 min
const browserReady = () => !!BROWSER_WS;

// Hard refusals. Not "ask first" — refusals. His rule was: anything, as long as
// it cannot touch his money or wreck his environment.
const BLOCKED_HOSTS = [
  'chase.com','bankofamerica.com','wellsfargo.com','citi.com','citibank.com','capitalone.com',
  'usbank.com','pnc.com','tdbank.com','discover.com','amex.com','americanexpress.com',
  'paypal.com','venmo.com','cash.app','zellepay.com','wise.com','revolut.com','stripe.com',
  'coinbase.com','binance.com','kraken.com','crypto.com','robinhood.com','fidelity.com',
  'schwab.com','vanguard.com','etrade.com','irs.gov','ssa.gov',
  // add your own with BLOCKED_EXTRA="site1.com,site2.com" on Render
  ...String(process.env.BLOCKED_EXTRA || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
];
const DANGER_CLICK = /\b(buy|purchase|check\s?out|checkout|place (the )?order|pay(ment)? now|pay|complete (the )?order|confirm (and )?(pay|order|purchase)|subscribe|start (free )?trial|donate|transfer|withdraw|send money|wire|delete (my )?account|close account|deactivate|permanently delete)\b/i;
const SECRET_FIELD  = /(pass(word|wd)?|cvv|cvc|card|credit|debit|ssn|social.?security|routing|account.?number|pin\b|otp|2fa|mfa|secret|api.?key|token|seed.?phrase)/i;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function blockedUrl(u) {
  const h = hostOf(u);
  if (!h) return false;
  return BLOCKED_HOSTS.some(b => h === b || h.endsWith('.' + b));
}

let session = null;          // { browser, page, els, lastUse }
let sessionLock = Promise.resolve();
const serialize = fn => (sessionLock = sessionLock.then(fn, fn));

async function closeSession(why) {
  const s = session; session = null;
  if (!s) return;
  try { await s.browser.close(); } catch {}
  if (why) console.log('browser session closed:', why);
}

async function ensureSession() {
  if (!browserReady()) throw new Error('browser not configured — set BROWSER_WS');
  if (session) {
    if (Date.now() - session.lastUse < BROWSER_TTL && session.browser.isConnected()) return session;
    await closeSession('expired');
  }
  let browser;
  try {
    browser = /playwright/i.test(BROWSER_WS)
      ? await chromium.connect(BROWSER_WS, { timeout: 25000 })
      : await chromium.connectOverCDP(BROWSER_WS, { timeout: 25000 });
  } catch (e) { throw new Error('could not reach the cloud browser: ' + e.message); }

  const ctx = browser.contexts()[0] || await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(20000);
  session = { browser, page, els: [], lastUse: Date.now() };
  return session;
}

/* Tag every visible interactive element with a stable ref so the model can say
   "click 7" and we know exactly which node that is, even after the DOM moves. */
async function snapshot(page) {
  const els = await page.evaluate(() => {
    document.querySelectorAll('[data-nova-ref]').forEach(n => n.removeAttribute('data-nova-ref'));
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [role="tab"]';
    const out = []; let i = 0;
    for (const n of document.querySelectorAll(sel)) {
      if (i >= 60) break;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const st = getComputedStyle(n);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      n.setAttribute('data-nova-ref', String(i));
      const tag = n.tagName.toLowerCase();
      out.push({
        ref: i, tag,
        type: n.getAttribute('type') || '',
        name: n.getAttribute('name') || n.id || '',
        text: (n.innerText || n.value || n.placeholder || n.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 70)
      });
      i++;
    }
    return out;
  });
  return els;
}

async function pageState(s, note) {
  s.lastUse = Date.now();
  const page = s.page;
  const url = page.url();
  if (blockedUrl(url)) { await closeSession('navigated to blocked host'); throw new Error('That site is on the hard blocklist (banking / payments). I closed the browser.'); }
  const title = await page.title().catch(() => '');
  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  s.els = await snapshot(page).catch(() => []);
  return JSON.stringify({
    note: note || undefined,
    url, title,
    text: (text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3500),
    elements: s.els
  });
}

async function browseOpen(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (blockedUrl(u)) throw new Error('Refused: ' + hostOf(u) + ' is a banking/payment site. I never touch those.');
  const s = await ensureSession();
  await s.page.goto(u, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await s.page.waitForTimeout(700);
  return pageState(s);
}

async function browseClick(ref) {
  const s = await ensureSession();
  const el = s.els.find(e => e.ref === Number(ref));
  if (!el) throw new Error('No element ' + ref + ' on this page. Re-read the page first.');
  if (DANGER_CLICK.test(el.text)) {
    throw new Error('Refused: "' + el.text + '" looks like a purchase, payment or destructive action. ' +
      'I can get everything ready, but Gavriel presses that one himself.');
  }
  await s.page.click('[data-nova-ref="' + Number(ref) + '"]', { timeout: 15000 });
  await s.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await s.page.waitForTimeout(700);
  return pageState(s, 'clicked: ' + el.text);
}

async function browseType(ref, text, submit) {
  const s = await ensureSession();
  const el = s.els.find(e => e.ref === Number(ref));
  if (!el) throw new Error('No element ' + ref + ' on this page. Re-read the page first.');
  if (SECRET_FIELD.test(el.name + ' ' + el.type + ' ' + el.text) || el.type === 'password') {
    throw new Error('Refused: that field wants a password, card or other secret. I never type those.');
  }
  await s.page.fill('[data-nova-ref="' + Number(ref) + '"]', String(text), { timeout: 15000 });
  if (submit) {
    await s.page.press('[data-nova-ref="' + Number(ref) + '"]', 'Enter');
    await s.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await s.page.waitForTimeout(900);
  }
  return pageState(s, 'typed into: ' + (el.text || el.name));
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

// The whole app UI is baked into this file at build time, so deploying Nova is
// a single-file upload. In development it falls back to reading public/.
// This route is registered BEFORE express.static so it always wins over any
// stale public/index.html sitting in the repo.
let UI_HTML = Buffer.from('PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIiBkaXI9Imx0ciI+CjxoZWFkPgo8bWV0YSBjaGFyc2V0PSJVVEYtOCI+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xLG1heGltdW0tc2NhbGU9MSx1c2VyLXNjYWxhYmxlPW5vLHZpZXdwb3J0LWZpdD1jb3ZlciI+Cjx0aXRsZT5Ob3ZhPC90aXRsZT4KCjxsaW5rIHJlbD0ibWFuaWZlc3QiIGhyZWY9Ii9tYW5pZmVzdC53ZWJtYW5pZmVzdCI+CjxsaW5rIHJlbD0iYXBwbGUtdG91Y2gtaWNvbiIgaHJlZj0iL2ljb25zL2ljb24tMTgwLnBuZyI+CjxsaW5rIHJlbD0iaWNvbiIgaHJlZj0iL2ljb25zL2ljb24tMTkyLnBuZyI+CjxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CjxtZXRhIG5hbWU9Im1vYmlsZS13ZWItYXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CjxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXN0YXR1cy1iYXItc3R5bGUiIGNvbnRlbnQ9ImJsYWNrLXRyYW5zbHVjZW50Ij4KPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtdGl0bGUiIGNvbnRlbnQ9Ik5vdmEiPgo8bWV0YSBuYW1lPSJ0aGVtZS1jb2xvciIgY29udGVudD0iIzA2MDQwZiI+Cgo8c3R5bGU+Cjpyb290ewogIC0tYmc6IzA2MDQwZjsgLS1pbms6I2U5ZTZmZjsgLS1kaW06IzhiODZhZDsKICAtLXRlYWw6IzRiZThkMDsgLS12aW9sZXQ6IzlkN2JmZjsgLS1nb2xkOiNmY2QzNGQ7IC0tcmVkOiNmZjZiNmI7CiAgLS1zdDplbnYoc2FmZS1hcmVhLWluc2V0LXRvcCwwcHgpOyAtLXNiOmVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tLDBweCk7Cn0KKnttYXJnaW46MDtwYWRkaW5nOjA7Ym94LXNpemluZzpib3JkZXItYm94Oy13ZWJraXQtdGFwLWhpZ2hsaWdodC1jb2xvcjp0cmFuc3BhcmVudDsKICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU0YgUHJvIFRleHQiLCJTZWdvZSBVSSIsUm9ib3RvLHNhbnMtc2VyaWZ9Cmh0bWwsYm9keXtoZWlnaHQ6MTAwJTtvdmVyZmxvdzpoaWRkZW59CmJvZHl7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0taW5rKTtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO3Bvc2l0aW9uOnJlbGF0aXZlfQoKLyogLS0tLS0tLS0tLSBhbWJpZW50IGF1cmEgLS0tLS0tLS0tLSAqLwojYXVyYXtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3BvaW50ZXItZXZlbnRzOm5vbmU7ei1pbmRleDowOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KDYwJSA0NSUgYXQgNTAlIDMwJSwgcmdiYSgxNTcsMTIzLDI1NSwuMjApLCB0cmFuc3BhcmVudCA3MCUpLAogICAgICAgICAgICAgcmFkaWFsLWdyYWRpZW50KDkwJSA3MCUgYXQgNTAlIDExMCUsIHJnYmEoNzUsMjMyLDIwOCwuMTApLCB0cmFuc3BhcmVudCA3MCUpLAogICAgICAgICAgICAgdmFyKC0tYmcpOwogIHRyYW5zaXRpb246b3BhY2l0eSAuNXN9CiNhdXJhLmxpdmV7YW5pbWF0aW9uOmJyZWF0aGUgMy40cyBlYXNlLWluLW91dCBpbmZpbml0ZX0KQGtleWZyYW1lcyBicmVhdGhlezAlLDEwMCV7b3BhY2l0eTouNzV9NTAle29wYWNpdHk6MX19CgovKiAtLS0tLS0tLS0tIGhlYWRlciAtLS0tLS0tLS0tICovCmhlYWRlcntwb3NpdGlvbjpyZWxhdGl2ZTt6LWluZGV4OjI7cGFkZGluZzpjYWxjKHZhcigtLXN0KSArIDEycHgpIDE2cHggOHB4OwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjEwcHh9Ci5icmFuZHtmb250LWZhbWlseTpHZW9yZ2lhLCJUaW1lcyBOZXcgUm9tYW4iLHNlcmlmO2xldHRlci1zcGFjaW5nOi40MmVtO2ZvbnQtc2l6ZToxNnB4OwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweH0KLmJyYW5kIGl7Y29sb3I6dmFyKC0tdGVhbCk7Zm9udC1zdHlsZTpub3JtYWw7Zm9udC1zaXplOjEzcHh9Ci5oYnRuc3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHh9Ci5jaGlwe2JhY2tncm91bmQ6cmdiYSgxNTAsMTQwLDI1NSwuMTIpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNTAsMTQwLDI1NSwuMjUpOwogIGNvbG9yOnZhcigtLWluayk7Ym9yZGVyLXJhZGl1czo5OTlweDtwYWRkaW5nOjZweCAxMXB4O2ZvbnQtc2l6ZToxMnB4O2N1cnNvcjpwb2ludGVyOwogIHdoaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xNXN9Ci5jaGlwOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk0KX0KLmNoaXAub257YmFja2dyb3VuZDpyZ2JhKDc1LDIzMiwyMDgsLjE2KTtib3JkZXItY29sb3I6cmdiYSg3NSwyMzIsMjA4LC40NSk7Y29sb3I6dmFyKC0tdGVhbCl9CiNwZW5ke2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1jb2xvcjpyZ2JhKDI1MiwyMTEsNzcsLjQpO2JhY2tncm91bmQ6cmdiYSgyNTIsMjExLDc3LC4xKTtkaXNwbGF5Om5vbmV9CgovKiAtLS0tLS0tLS0tIG9yYiAtLS0tLS0tLS0tICovCiNvcmJXcmFwe3Bvc2l0aW9uOnJlbGF0aXZlO3otaW5kZXg6MjtoZWlnaHQ6MTA0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2ZsZXg6bm9uZTt0cmFuc2l0aW9uOmhlaWdodCAuMzVzfQojb3JiV3JhcC5taW5pe2hlaWdodDo1NnB4fQojb3Jie3dpZHRoOjcwcHg7aGVpZ2h0OjcwcHg7Ym9yZGVyLXJhZGl1czo1MCU7cG9zaXRpb246cmVsYXRpdmU7dHJhbnNpdGlvbjouMzVzOwogIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KGNpcmNsZSBhdCAzNCUgMzIlLCAjZmZmOSwgIzlkN2JmZiA0MiUsICMzZDJhN2EgNzQlLCAjMTQwZDMzKTsKICBib3gtc2hhZG93OjAgMCAzNHB4IDZweCByZ2JhKDE1NywxMjMsMjU1LC40MiksIGluc2V0IDAgMCAyMnB4IHJnYmEoMjU1LDI1NSwyNTUsLjE0KX0KI29yYldyYXAubWluaSAjb3Jie3dpZHRoOjQwcHg7aGVpZ2h0OjQwcHh9CiNvcmI6OmFmdGVye2NvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6LTE2cHg7Ym9yZGVyLXJhZGl1czo1MCU7CiAgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDE1NywxMjMsMjU1LC4yMil9CmJvZHkubGlzdGVuaW5nICNvcmJ7YmFja2dyb3VuZDpyYWRpYWwtZ3JhZGllbnQoY2lyY2xlIGF0IDM0JSAzMiUsICNmZmZjLCAjNGJlOGQwIDQyJSwgIzFjNmI2MCA3NCUsICMwNjI2MjIpOwogIGJveC1zaGFkb3c6MCAwIDQ4cHggMTJweCByZ2JhKDc1LDIzMiwyMDgsLjU1KSwgaW5zZXQgMCAwIDIycHggcmdiYSgyNTUsMjU1LDI1NSwuMik7CiAgYW5pbWF0aW9uOnB1bHNlIC45cyBlYXNlLWluLW91dCBpbmZpbml0ZX0KYm9keS50aGlua2luZyAjb3Jie2FuaW1hdGlvbjpzcGluIDEuNXMgbGluZWFyIGluZmluaXRlOwogIGJveC1zaGFkb3c6MCAwIDQwcHggOHB4IHJnYmEoMTU3LDEyMywyNTUsLjYpLCBpbnNldCAwIDAgMjJweCByZ2JhKDI1NSwyNTUsMjU1LC4xOCl9CmJvZHkuc3BlYWtpbmcgI29yYntiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUgYXQgMzQlIDMyJSwgI2ZmZjksICM0YmU4ZDAgMzglLCAjNmQ1YmQwIDc2JSwgIzE0MGQzMyk7CiAgYm94LXNoYWRvdzowIDAgNTZweCAxNHB4IHJnYmEoNzUsMjMyLDIwOCwuNSksIGluc2V0IDAgMCAyMnB4IHJnYmEoMjU1LDI1NSwyNTUsLjIpOwogIGFuaW1hdGlvbjp3YXZlIDEuMXMgZWFzZS1pbi1vdXQgaW5maW5pdGV9CkBrZXlmcmFtZXMgcHVsc2V7MCUsMTAwJXt0cmFuc2Zvcm06c2NhbGUoMSl9NTAle3RyYW5zZm9ybTpzY2FsZSgxLjEzKX19CkBrZXlmcmFtZXMgd2F2ZXswJSwxMDAle3RyYW5zZm9ybTpzY2FsZSgxKX0zMCV7dHJhbnNmb3JtOnNjYWxlKDEuMDcpfTYwJXt0cmFuc2Zvcm06c2NhbGUoLjk3KX19CkBrZXlmcmFtZXMgc3Bpbnt0b3t0cmFuc2Zvcm06cm90YXRlKDM2MGRlZyl9fQpib2R5Lmxpc3RlbmluZyAjYXVyYSxib2R5LnNwZWFraW5nICNhdXJhe29wYWNpdHk6MTsKICBiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudCg2NSUgNTAlIGF0IDUwJSAyOCUsIHJnYmEoNzUsMjMyLDIwOCwuMjYpLCB0cmFuc3BhcmVudCA3MCUpLAogICAgICAgICAgICAgcmFkaWFsLWdyYWRpZW50KDkwJSA3MCUgYXQgNTAlIDExMCUsIHJnYmEoMTU3LDEyMywyNTUsLjE0KSwgdHJhbnNwYXJlbnQgNzAlKSwKICAgICAgICAgICAgIHZhcigtLWJnKX0KCiNzdGF0ZXtwb3NpdGlvbjpyZWxhdGl2ZTt6LWluZGV4OjI7dGV4dC1hbGlnbjpjZW50ZXI7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tZGltKTsKICBoZWlnaHQ6MTZweDttYXJnaW4tYm90dG9tOjJweH0KCi8qIC0tLS0tLS0tLS0gbG9nIC0tLS0tLS0tLS0gKi8KI2xvZ3twb3NpdGlvbjpyZWxhdGl2ZTt6LWluZGV4OjI7ZmxleDoxO292ZXJmbG93LXk6YXV0bzstd2Via2l0LW92ZXJmbG93LXNjcm9sbGluZzp0b3VjaDsKICBwYWRkaW5nOjhweCAxNHB4IDRweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo5cHh9Ci5te21heC13aWR0aDo4OCU7cGFkZGluZzoxMXB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxNnB4O2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjEuNjsKICB3aGl0ZS1zcGFjZTpwcmUtd3JhcDt3b3JkLXdyYXA6YnJlYWstd29yZDthbmltYXRpb246cmlzZSAuMjJzIGVhc2Utb3V0fQpAa2V5ZnJhbWVzIHJpc2V7ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoN3B4KX19Ci51e2FsaWduLXNlbGY6ZmxleC1lbmQ7YmFja2dyb3VuZDojMmEyMzUyO2JvcmRlci1ib3R0b20tcmlnaHQtcmFkaXVzOjVweH0KLm57YWxpZ24tc2VsZjpmbGV4LXN0YXJ0O2JhY2tncm91bmQ6cmdiYSg3NSwyMzIsMjA4LC4wOSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc1LDIzMiwyMDgsLjIpOwogIGJvcmRlci1ib3R0b20tbGVmdC1yYWRpdXM6NXB4fQoubi5lcnJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwxMDcsMTA3LC4xKTtib3JkZXItY29sb3I6cmdiYSgyNTUsMTA3LDEwNywuMzUpO2NvbG9yOiNmZmM5Yzl9Ci5yZXBsYXl7YWxpZ24tc2VsZjpmbGV4LXN0YXJ0O2JhY2tncm91bmQ6bm9uZTtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZWFsKTtmb250LXNpemU6MTJweDsKICBjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjJweCA2cHg7bWFyZ2luLXRvcDotNXB4fQoKLyogLS0tLS0tLS0tLSBxdWljayBjaGlwcyAtLS0tLS0tLS0tICovCiNxdWlja3twb3NpdGlvbjpyZWxhdGl2ZTt6LWluZGV4OjI7ZGlzcGxheTpmbGV4O2dhcDo3cHg7b3ZlcmZsb3cteDphdXRvO3BhZGRpbmc6NnB4IDE0cHg7CiAgc2Nyb2xsYmFyLXdpZHRoOm5vbmV9CiNxdWljazo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfQojcXVpY2sgLmNoaXB7Zm9udC1zaXplOjEycHg7ZmxleDpub25lfQoKLyogLS0tLS0tLS0tLSBjb21wb3NlciAtLS0tLS0tLS0tICovCmZvcm17cG9zaXRpb246cmVsYXRpdmU7ei1pbmRleDoyO2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2FsaWduLWl0ZW1zOmNlbnRlcjsKICBwYWRkaW5nOjhweCAxMnB4IGNhbGModmFyKC0tc2IpICsgMTJweCl9CiNpbntmbGV4OjE7bWluLXdpZHRoOjA7YmFja2dyb3VuZDpyZ2JhKDE1MCwxNDAsMjU1LC4wOSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDE1MCwxNDAsMjU1LC4yKTsKICBib3JkZXItcmFkaXVzOjk5OXB4O2NvbG9yOnZhcigtLWluayk7cGFkZGluZzoxNHB4IDE4cHg7Zm9udC1zaXplOjE2cHg7b3V0bGluZTpub25lfQojaW46Zm9jdXN7Ym9yZGVyLWNvbG9yOnJnYmEoNzUsMjMyLDIwOCwuNDUpfQoucm5ke3dpZHRoOjUwcHg7aGVpZ2h0OjUwcHg7ZmxleDpub25lO2JvcmRlci1yYWRpdXM6NTAlO2JvcmRlcjpub25lO2ZvbnQtc2l6ZToyMHB4OwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOi4xNXN9Ci5ybmQ6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTIpfQojbWlje2JhY2tncm91bmQ6cmdiYSgxNTAsMTQwLDI1NSwuMTYpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNTAsMTQwLDI1NSwuMyk7Y29sb3I6dmFyKC0taW5rKX0KI21pYy5vbntiYWNrZ3JvdW5kOnZhcigtLXRlYWwpO2NvbG9yOiMwNDExMGU7Ym9yZGVyLWNvbG9yOnZhcigtLXRlYWwpOwogIGJveC1zaGFkb3c6MCAwIDIwcHggcmdiYSg3NSwyMzIsMjA4LC41NSl9CiNnb3tiYWNrZ3JvdW5kOnZhcigtLXRlYWwpO2NvbG9yOiMwNDExMGU7Zm9udC13ZWlnaHQ6NzAwfQoKLyogLS0tLS0tLS0tLSBnYXRlICYgc2hlZXRzIC0tLS0tLS0tLS0gKi8KI2dhdGV7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt6LWluZGV4OjIwO2JhY2tncm91bmQ6dmFyKC0tYmcpO2Rpc3BsYXk6ZmxleDsKICBmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjE0cHg7cGFkZGluZzoyNnB4O3RleHQtYWxpZ246Y2VudGVyfQojZ2F0ZS5oaWRle2Rpc3BsYXk6bm9uZX0KI2dhdGUgaW5wdXR7d2lkdGg6bWluKDM2MHB4LDg4dncpO3RleHQtYWxpZ246Y2VudGVyO2JhY2tncm91bmQ6cmdiYSgxNTAsMTQwLDI1NSwuMSk7CiAgYm9yZGVyOjFweCBzb2xpZCByZ2JhKDE1MCwxNDAsMjU1LC4yNSk7Ym9yZGVyLXJhZGl1czoxNHB4O2NvbG9yOnZhcigtLWluayk7CiAgcGFkZGluZzoxNHB4O2ZvbnQtc2l6ZToxNnB4O291dGxpbmU6bm9uZX0KI2dhdGUgYnV0dG9ue2JhY2tncm91bmQ6dmFyKC0tdGVhbCk7Y29sb3I6IzA0MTEwZTtmb250LXdlaWdodDo3MDA7Ym9yZGVyOm5vbmU7CiAgYm9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTNweCAzNHB4O2ZvbnQtc2l6ZToxNnB4O2N1cnNvcjpwb2ludGVyfQojZ2F0ZU1zZ3tmb250LXNpemU6MTNweDttaW4taGVpZ2h0OjE4cHg7Y29sb3I6dmFyKC0tcmVkKX0KCi5zaGVldHtwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTU7YmFja2dyb3VuZDpyZ2JhKDYsNCwxNSwuOSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMTRweCk7LXdlYmtpdC1iYWNrZHJvcC1maWx0ZXI6Ymx1cigxNHB4KTtkaXNwbGF5Om5vbmU7CiAgZmxleC1kaXJlY3Rpb246Y29sdW1uO3BhZGRpbmc6Y2FsYyh2YXIoLS1zdCkgKyAxOHB4KSAxOHB4IGNhbGModmFyKC0tc2IpICsgMThweCl9Ci5zaGVldC5zaG93e2Rpc3BsYXk6ZmxleH0KLnNoZWV0IGgze2ZvbnQtc2l6ZToxN3B4O21hcmdpbi1ib3R0b206MTJweDtmb250LXdlaWdodDo2MDB9Ci5zaGVldCAuYm9keXtmbGV4OjE7b3ZlcmZsb3cteTphdXRvO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEwcHh9Ci5jYXJke2JhY2tncm91bmQ6cmdiYSgxNTAsMTQwLDI1NSwuMDgpO2JvcmRlcjoxcHggc29saWQgcmdiYSgxNTAsMTQwLDI1NSwuMTgpOwogIGJvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjEzcHg7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NX0KLmNhcmQgYntjb2xvcjp2YXIoLS10ZWFsKTtmb250LXdlaWdodDo2MDB9Ci5jYXJkIC5yb3d7ZGlzcGxheTpmbGV4O2dhcDo4cHg7bWFyZ2luLXRvcDoxMHB4fQouY2FyZCAucm93IGJ1dHRvbntmbGV4OjE7Ym9yZGVyOm5vbmU7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4O2ZvbnQtc2l6ZToxM3B4OwogIGZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcn0KLm9re2JhY2tncm91bmQ6dmFyKC0tdGVhbCk7Y29sb3I6IzA0MTEwZX0KLm5ve2JhY2tncm91bmQ6cmdiYSgyNTUsMTA3LDEwNywuMTgpO2NvbG9yOiNmZmI0YjR9Ci5zaGVldD4uY2xvc2V7bWFyZ2luLXRvcDoxMnB4O2JhY2tncm91bmQ6cmdiYSgxNTAsMTQwLDI1NSwuMTQpO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLWluayk7CiAgYm9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTNweDtmb250LXNpemU6MTVweDtjdXJzb3I6cG9pbnRlcn0KLm11dGVke2NvbG9yOnZhcigtLWRpbSk7Zm9udC1zaXplOjEzcHg7bGluZS1oZWlnaHQ6MS42fQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJhdXJhIiBjbGFzcz0ibGl2ZSI+PC9kaXY+Cgo8IS0tID09PT09PT09PT09PSB0b2tlbiBnYXRlID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0iZ2F0ZSI+CiAgPGRpdiBjbGFzcz0iYnJhbmQiIHN0eWxlPSJmb250LXNpemU6MjJweCI+TiBPIFYgQSA8aT7inKY8L2k+PC9kaXY+CiAgPGRpdiBjbGFzcz0ibXV0ZWQiPlBhc3RlIHlvdXIgYWNjZXNzIGNvZGU8L2Rpdj4KICA8aW5wdXQgaWQ9InRvayIgcGxhY2Vob2xkZXI9Ik5PVkFfVE9LRU4iIGF1dG9jYXBpdGFsaXplPSJvZmYiIGF1dG9jb3JyZWN0PSJvZmYiIHNwZWxsY2hlY2s9ImZhbHNlIiB0eXBlPSJwYXNzd29yZCI+CiAgPGJ1dHRvbiBvbmNsaWNrPSJ0cnlUb2tlbigpIj5FbnRlcjwvYnV0dG9uPgogIDxkaXYgaWQ9ImdhdGVNc2ciPjwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IGFwcCA9PT09PT09PT09PT0gLS0+CjxoZWFkZXI+CiAgPGRpdiBjbGFzcz0iYnJhbmQiPk4gTyBWIEEgPGk+4pymPC9pPjwvZGl2PgogIDxkaXYgY2xhc3M9ImhidG5zIj4KICAgIDxidXR0b24gY2xhc3M9ImNoaXAiIGlkPSJwZW5kIiBvbmNsaWNrPSJvcGVuUGVuZGluZygpIj48L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImNoaXAiIGlkPSJ3YWtlQnRuIiBvbmNsaWNrPSJ0b2dnbGVXYWtlKCkiIHRpdGxlPSJBbHdheXMgbGlzdGVuaW5nIj7wn5GCPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJjaGlwIiBvbmNsaWNrPSJvcGVuTWVudSgpIj7imLA8L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8ZGl2IGlkPSJvcmJXcmFwIj48ZGl2IGlkPSJvcmIiPjwvZGl2PjwvZGl2Pgo8ZGl2IGlkPSJzdGF0ZSI+PC9kaXY+CjxkaXYgaWQ9ImxvZyI+PC9kaXY+Cgo8ZGl2IGlkPSJxdWljayI+CiAgPGJ1dHRvbiBjbGFzcz0iY2hpcCIgb25jbGljaz0icXVpY2soJ09wZW4gdGhpcyBzaXRlIGluIHRoZSBicm93c2VyLCBmaW5kIHRoZSBpbmZvIEkgbmVlZCwgYW5kIHRlbGwgbWUgd2hhdCB5b3Ugc2VlOiAnKSI+8J+MkCBCcm93c2UgYSBzaXRlPC9idXR0b24+CiAgPGJ1dHRvbiBjbGFzcz0iY2hpcCIgb25jbGljaz0icXVpY2soJ0dvIHRocm91Z2ggbXkgdW5yZWFkIGVtYWlsIGFuZCBnaXZlIG1lIGEgc2hvcnQgdHJpYWdlOiB3aGF0IG5lZWRzIG1lIHRvZGF5LCB3aGF0IGNhbiB3YWl0LCB3aGF0IGlzIG5vaXNlLicpIj7wn5OlIEluYm94IHRyaWFnZTwvYnV0dG9uPgogIDxidXR0b24gY2xhc3M9ImNoaXAiIG9uY2xpY2s9InF1aWNrKCdSZXNlYXJjaCB0aGlzIGFuZCBlbWFpbCBtZSBhIHN1bW1hcnk6ICcpIj7wn5OnIFJlc2VhcmNoIOKGkiBlbWFpbDwvYnV0dG9uPgogIDxidXR0b24gY2xhc3M9ImNoaXAiIG9uY2xpY2s9InF1aWNrKCdXaGF0IHNjaGVkdWxlZCB0YXNrcyBkbyBJIGhhdmU/JykiPuKPsCBNeSB0YXNrczwvYnV0dG9uPgogIDxidXR0b24gY2xhc3M9ImNoaXAiIG9uY2xpY2s9InF1aWNrKCdXaGF0IHNob3VsZCBJIGtub3cgdG9kYXk/JykiPvCfk7AgQnJpZWZpbmc8L2J1dHRvbj4KICA8YnV0dG9uIGNsYXNzPSJjaGlwIiBvbmNsaWNrPSJxdWljaygnV2hhdCBkbyB5b3UgcmVtZW1iZXIgYWJvdXQgbWU/JykiPvCfp6AgTWVtb3J5PC9idXR0b24+CjwvZGl2PgoKPGZvcm0gb25zdWJtaXQ9InNlbmQoZXZlbnQpIj4KICA8aW5wdXQgaWQ9ImluIiBwbGFjZWhvbGRlcj0iVGFsayB0byBOb3Zh4oCmIiBhdXRvY29tcGxldGU9Im9mZiIgYXV0b2NvcnJlY3Q9Im9mZiI+CiAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJybmQiIGlkPSJtaWMiIG9uY2xpY2s9InRvZ2dsZU1pYygpIj7wn46ZPC9idXR0b24+CiAgPGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJybmQiIGlkPSJnbyI+4oaRPC9idXR0b24+CjwvZm9ybT4KCjwhLS0gPT09PT09PT09PT09IHNoZWV0cyA9PT09PT09PT09PT0gLS0+CjxkaXYgY2xhc3M9InNoZWV0IiBpZD0icGVuZFNoZWV0Ij4KICA8aDM+4pqgIEVtYWlscyB3YWl0aW5nIGZvciB5b3VyIGFwcHJvdmFsPC9oMz4KICA8ZGl2IGNsYXNzPSJib2R5IiBpZD0icGVuZEJvZHkiPjwvZGl2PgogIDxidXR0b24gY2xhc3M9ImNsb3NlIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCdwZW5kU2hlZXQnKSI+Q2xvc2U8L2J1dHRvbj4KPC9kaXY+Cgo8ZGl2IGNsYXNzPSJzaGVldCIgaWQ9Im1lbnVTaGVldCI+CiAgPGgzPlNldHRpbmdzPC9oMz4KICA8ZGl2IGNsYXNzPSJib2R5IiBpZD0ibWVudUJvZHkiPjwvZGl2PgogIDxidXR0b24gY2xhc3M9ImNsb3NlIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCdtZW51U2hlZXQnKSI+Q2xvc2U8L2J1dHRvbj4KPC9kaXY+Cgo8c2NyaXB0PgondXNlIHN0cmljdCc7CmNvbnN0ICQgPSBzID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Iocyk7CmNvbnN0IExTID0geyB0b2s6J252X3RvaycsIHZvaWNlOidudl92b2ljZU9uJywgd2FrZTonbnZfd2FrZScgfTsKY29uc3QgTEFORyA9ICdlbic7CgpsZXQgVE9LRU4gICAgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMUy50b2spIHx8ICcnOwpsZXQgVk9JQ0VfT04gPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMUy52b2ljZSkgIT09ICcwJzsKbGV0IGJ1c3kgPSBmYWxzZTsKCi8qID09PT09PT09PT09PT09PT09IHN0YXRlIC8gYXVyYSA9PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzZXRTdGF0ZShtb2RlLCB0ZXh0KSB7CiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKCdsaXN0ZW5pbmcnLCd0aGlua2luZycsJ3NwZWFraW5nJyk7CiAgaWYgKG1vZGUpIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChtb2RlKTsKICAkKCcjc3RhdGUnKS50ZXh0Q29udGVudCA9IHRleHQgfHwgJyc7Cn0KCi8qID09PT09PT09PT09PT09PT09IHRva2VuIGdhdGUgPT09PT09PT09PT09PT09PT0gKi8KaWYgKFRPS0VOKSAkKCcjZ2F0ZScpLmNsYXNzTGlzdC5hZGQoJ2hpZGUnKTsKCmFzeW5jIGZ1bmN0aW9uIHRyeVRva2VuKCkgewogIGNvbnN0IHYgPSAkKCcjdG9rJykudmFsdWUudHJpbSgpOwogIGlmICghdikgeyAkKCcjZ2F0ZU1zZycpLnRleHRDb250ZW50ID0gJ0VudGVyIHlvdXIgY29kZSc7IHJldHVybjsgfQogICQoJyNnYXRlTXNnJykuc3R5bGUuY29sb3IgPSAndmFyKC0tZGltKSc7CiAgJCgnI2dhdGVNc2cnKS50ZXh0Q29udGVudCA9ICdDaGVja2luZ+KApic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCgnL2FwaS90YXNrcycsIHsgaGVhZGVyczp7ICd4LW5vdmEtdG9rZW4nOiB2IH0gfSk7CiAgICBpZiAoci5zdGF0dXMgPT09IDQwMSkgewogICAgICAkKCcjZ2F0ZU1zZycpLnN0eWxlLmNvbG9yID0gJ3ZhcigtLXJlZCknOwogICAgICAkKCcjZ2F0ZU1zZycpLnRleHRDb250ZW50ID0gJ1dyb25nIGNvZGUg4oCUIHRoaXMgaXMgeW91ciBOT1ZBX1RPS0VOIGZyb20gUmVuZGVyJzsKICAgICAgcmV0dXJuOwogICAgfQogICAgVE9LRU4gPSB2OwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTFMudG9rLCB2KTsKICAgICQoJyNnYXRlJykuY2xhc3NMaXN0LmFkZCgnaGlkZScpOwogICAgJCgnI2dhdGVNc2cnKS50ZXh0Q29udGVudCA9ICcnOwogICAgdW5sb2NrQXVkaW8oKTsKICAgIGJvb3QoKTsKICB9IGNhdGNoIChlKSB7CiAgICAkKCcjZ2F0ZU1zZycpLnN0eWxlLmNvbG9yID0gJ3ZhcigtLXJlZCknOwogICAgJCgnI2dhdGVNc2cnKS50ZXh0Q29udGVudCA9ICdDYW5ub3QgcmVhY2ggdGhlIHNlcnZlcic7CiAgfQp9CiQoJyN0b2snKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgdHJ5VG9rZW4oKTsgfSk7CgovKiA9PT09PT09PT09PT09PT09PSBjaGF0ID09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIGFkZCh3aG8sIHRleHQsIGlzRXJyKSB7CiAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIGQuY2xhc3NOYW1lID0gJ20gJyArIHdobyArIChpc0VyciA/ICcgZXJyJyA6ICcnKTsKICBkLnRleHRDb250ZW50ID0gdGV4dDsKICAkKCcjbG9nJykuYXBwZW5kQ2hpbGQoZCk7CiAgJCgnI2xvZycpLnNjcm9sbFRvcCA9IDFlOTsKICByZXR1cm4gZDsKfQoKZnVuY3Rpb24gcXVpY2sodCkgewogICQoJyNpbicpLnZhbHVlID0gdDsKICBpZiAodC50cmltKCkuZW5kc1dpdGgoJzonKSkgeyAkKCcjaW4nKS5mb2N1cygpOyByZXR1cm47IH0gICAvLyBuZWVkcyB0aGUgdXNlciB0byBmaW5pc2ggdGhlIHNlbnRlbmNlCiAgc2VuZChuZXcgRXZlbnQoJ3gnKSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNlbmQoZSkgewogIGlmIChlICYmIGUucHJldmVudERlZmF1bHQpIGUucHJldmVudERlZmF1bHQoKTsKICBjb25zdCB0ZXh0ID0gJCgnI2luJykudmFsdWUudHJpbSgpOwogIGlmICghdGV4dCB8fCBidXN5KSByZXR1cm47CiAgJCgnI2luJykudmFsdWUgPSAnJzsKICBwYXVzZVJlYygpOyAgICAgICAgICAvLyBtaWMgc3RheXMgc2h1dCB1bnRpbCBzaGUgZmluaXNoZXMgYW5zd2VyaW5nCiAgYWRkKCd1JywgdGV4dCk7CiAgYnVzeSA9IHRydWU7CiAgc2V0U3RhdGUoJ3RoaW5raW5nJywgJ05vdmEgaXMgdGhpbmtpbmfigKYnKTsKICAkKCcjb3JiV3JhcCcpLmNsYXNzTGlzdC5hZGQoJ21pbmknKTsKICBjb25zdCBidWJibGUgPSBhZGQoJ24nLCAn4oCmJyk7CgogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goJy9hcGkvY2hhdCcsIHsKICAgICAgbWV0aG9kOiAnUE9TVCcsCiAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nLCAneC1ub3ZhLXRva2VuJzogVE9LRU4gfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtZXNzYWdlOiB0ZXh0IH0pCiAgICB9KTsKICAgIGlmIChyLnN0YXR1cyA9PT0gNDAxKSB0aHJvdyBuZXcgRXJyb3IoJ0FjY2VzcyBjb2RlIHJlamVjdGVkLiBPcGVuIOKYsCDihpIgQ2hhbmdlIGFjY2VzcyBjb2RlLicpOwogICAgY29uc3QgaiA9IGF3YWl0IHIuanNvbigpOwogICAgaWYgKGouZXJyb3IpIHRocm93IG5ldyBFcnJvcihqLmVycm9yKTsKICAgIGJ1YmJsZS50ZXh0Q29udGVudCA9IGoucmVwbHk7CiAgICByZWZyZXNoUGVuZGluZyhqLnBlbmRpbmcpOwogICAgc2V0U3RhdGUobnVsbCwgJycpOwogICAgc3BlYWsoai5yZXBseSk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICBidWJibGUudGV4dENvbnRlbnQgPSAnRXJyb3I6ICcgKyBlcnIubWVzc2FnZTsKICAgIGJ1YmJsZS5jbGFzc0xpc3QuYWRkKCdlcnInKTsKICAgIHNldFN0YXRlKG51bGwsICcnKTsKICAgIHJlc3VtZVJlYygpOyAgICAgICAgICAgICAgICAgLy8gbmV2ZXIgbGVhdmUgdGhlIG1pYyBzdHVjayBjbG9zZWQgYWZ0ZXIgYSBmYWlsdXJlCiAgfSBmaW5hbGx5IHsKICAgIGJ1c3kgPSBmYWxzZTsKICAgICQoJyNsb2cnKS5zY3JvbGxUb3AgPSAxZTk7CiAgfQp9CgovKiA9PT09PT09PT09PT09PT09PSBzcGVlY2ggT1VUID09PT09PT09PT09PT09PT09CiAgIFR3byBlbmdpbmVzOiBFbGV2ZW5MYWJzIHRocm91Z2ggb3VyIG93biBzZXJ2ZXIgKHRoZSBrZXkgbmV2ZXIgdG91Y2hlcyB0aGUKICAgYnJvd3NlciksIGFuZCB0aGUgYnJvd3NlcidzIGJ1aWx0LWluIHZvaWNlIGFzIGEgZnJlZSBmYWxsYmFjay4gaU9TIG9ubHkgbGV0cwogICBhdWRpbyBwbGF5IGZyb20gYSBjaGFpbiB0aGF0IGJlZ2FuIHdpdGggYSByZWFsIHVzZXIgZ2VzdHVyZSwgc28gd2UgYnVpbGQgT05FCiAgIDxhdWRpbz4gZWxlbWVudCBvbiB0aGUgZmlyc3QgdG91Y2ggYW5kIHJldXNlIGl0IGZvcmV2ZXIuICovCmNvbnN0IFNJTEVOVF9XQVYgPSAnZGF0YTphdWRpby93YXY7YmFzZTY0LFVrbEdSaVFBQUFCWFFWWkZabTEwSUJBQUFBQUJBQUVBZ0Q0QUFBQjlBQUFDQUJBQVpHRjBZUUFBQUFBPSc7CmxldCBhdWRpb1JlYWR5ID0gZmFsc2U7CmxldCBwbGF5ZXIgPSBudWxsOwpsZXQgSEVBTFRIID0geyB2b2ljZVJlYWR5OmZhbHNlIH07CmxldCBlbEZhaWxzID0gMDsKCmZ1bmN0aW9uIHVubG9ja0F1ZGlvKCkgewogIGlmIChhdWRpb1JlYWR5KSByZXR1cm47CiAgYXVkaW9SZWFkeSA9IHRydWU7CiAgdHJ5IHsKICAgIGNvbnN0IHUgPSBuZXcgU3BlZWNoU3ludGhlc2lzVXR0ZXJhbmNlKCcgJyk7CiAgICB1LnZvbHVtZSA9IDA7CiAgICBzcGVlY2hTeW50aGVzaXMuc3BlYWsodSk7CiAgfSBjYXRjaCAoZSkge30KICB0cnkgewogICAgcGxheWVyID0gbmV3IEF1ZGlvKCk7CiAgICBwbGF5ZXIucHJlbG9hZCA9ICdhdXRvJzsKICAgIHBsYXllci5zcmMgPSBTSUxFTlRfV0FWOwogICAgY29uc3QgcCA9IHBsYXllci5wbGF5KCk7CiAgICBpZiAocCAmJiBwLmNhdGNoKSBwLmNhdGNoKCgpID0+IHt9KTsKICB9IGNhdGNoIChlKSB7fQp9CmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNoc3RhcnQnLCB1bmxvY2tBdWRpbywgeyBvbmNlOnRydWUgfSk7CmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdW5sb2NrQXVkaW8sIHsgb25jZTp0cnVlIH0pOwoKbGV0IHZvaWNlcyA9IFtdOwpmdW5jdGlvbiBsb2FkVm9pY2VzKCkgeyB2b2ljZXMgPSBzcGVlY2hTeW50aGVzaXMuZ2V0Vm9pY2VzKCkgfHwgW107IH0KbG9hZFZvaWNlcygpOwppZiAodHlwZW9mIHNwZWVjaFN5bnRoZXNpcyAhPT0gJ3VuZGVmaW5lZCcpIHNwZWVjaFN5bnRoZXNpcy5vbnZvaWNlc2NoYW5nZWQgPSBsb2FkVm9pY2VzOwoKZnVuY3Rpb24gcGlja1ZvaWNlKCkgewogIGlmICghdm9pY2VzLmxlbmd0aCkgbG9hZFZvaWNlcygpOwogIGNvbnN0IHBvb2wgPSB2b2ljZXMuZmlsdGVyKHYgPT4gKHYubGFuZyB8fCAnJykudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKCdlbicpKTsKICBpZiAoIXBvb2wubGVuZ3RoKSByZXR1cm4gbnVsbDsKICBjb25zdCBuaWNlID0gWydTYW1hbnRoYScsJ0F2YScsJ0FsbGlzb24nLCdTaXJpJywnR29vZ2xlIFVTJywnUHJlbWl1bScsJ0VuaGFuY2VkJywnTmV1cmFsJ107CiAgZm9yIChjb25zdCBuIG9mIG5pY2UpIHsKICAgIGNvbnN0IGhpdCA9IHBvb2wuZmluZCh2ID0+ICh2Lm5hbWUgfHwgJycpLmluY2x1ZGVzKG4pKTsKICAgIGlmIChoaXQpIHJldHVybiBoaXQ7CiAgfQogIHJldHVybiBwb29sWzBdOwp9CgpmdW5jdGlvbiBjbGVhbih0KSB7CiAgcmV0dXJuIFN0cmluZyh0KQogICAgLnJlcGxhY2UoL2BgYFtcc1xTXSo/YGBgL2csICcgJykKICAgIC5yZXBsYWNlKC9odHRwcz86XC9cL1xTKy9nLCAnICcpCiAgICAucmVwbGFjZSgvWypfI2A+fH5cW1xdXS9nLCAnICcpCiAgICAucmVwbGFjZSgvXHMrL2csICcgJykKICAgIC50cmltKCkKICAgIC5zbGljZSgwLCA5MDApOwp9CgpmdW5jdGlvbiBzcGVhayh0ZXh0KSB7CiAgaWYgKCFWT0lDRV9PTiB8fCAhdGV4dCkgeyByZXN1bWVSZWMoKTsgcmV0dXJuOyB9CiAgY29uc3Qgc2F5ID0gY2xlYW4odGV4dCk7CiAgaWYgKCFzYXkpIHsgcmVzdW1lUmVjKCk7IHJldHVybjsgfQogIHN0b3BBbGxBdWRpbygpOwogIGlmIChIRUFMVEgudm9pY2VSZWFkeSAmJiBlbEZhaWxzIDwgMikgc3BlYWtFbGV2ZW4oc2F5KTsKICBlbHNlIHNwZWFrQnJvd3NlcihzYXkpOwp9CgpmdW5jdGlvbiBzdG9wQWxsQXVkaW8oKSB7CiAgdHJ5IHsgc3BlZWNoU3ludGhlc2lzLmNhbmNlbCgpOyB9IGNhdGNoIChlKSB7fQogIGlmIChwbGF5ZXIpIHsgdHJ5IHsgcGxheWVyLnBhdXNlKCk7IH0gY2F0Y2ggKGUpIHt9IH0KfQoKbGV0IGxhc3RCbG9iVXJsID0gbnVsbDsKYXN5bmMgZnVuY3Rpb24gc3BlYWtFbGV2ZW4oc2F5KSB7CiAgc2V0U3RhdGUoJ3RoaW5raW5nJywgJ0dlbmVyYXRpbmcgdm9pY2XigKYnKTsKICB0cnkgewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoKCcvYXBpL3NwZWFrJywgewogICAgICBtZXRob2Q6J1BPU1QnLAogICAgICBoZWFkZXJzOnsgJ0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nLCAneC1ub3ZhLXRva2VuJzogVE9LRU4gfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB0ZXh0OiBzYXksIGxhbmc6IExBTkcgfSkKICAgIH0pOwogICAgaWYgKCFyLm9rKSB7CiAgICAgIGxldCByZWFzb24gPSAnb3RoZXInOwogICAgICB0cnkgeyByZWFzb24gPSAoYXdhaXQgci5qc29uKCkpLnJlYXNvbiB8fCAnb3RoZXInOyB9IGNhdGNoIChlKSB7fQogICAgICBjb25zdCBlcnIgPSBuZXcgRXJyb3IoJ3R0cyAnICsgci5zdGF0dXMpOyBlcnIucmVhc29uID0gcmVhc29uOyB0aHJvdyBlcnI7CiAgICB9CiAgICBjb25zdCBibG9iID0gYXdhaXQgci5ibG9iKCk7CiAgICBpZiAoIWJsb2Iuc2l6ZSkgdGhyb3cgbmV3IEVycm9yKCdlbXB0eSBhdWRpbycpOwoKICAgIGlmICghcGxheWVyKSBwbGF5ZXIgPSBuZXcgQXVkaW8oKTsKICAgIGlmIChsYXN0QmxvYlVybCkgeyBVUkwucmV2b2tlT2JqZWN0VVJMKGxhc3RCbG9iVXJsKTsgbGFzdEJsb2JVcmwgPSBudWxsOyB9CiAgICBsYXN0QmxvYlVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CgogICAgcGxheWVyLm9ucGxheSAgPSAoKSA9PiBzZXRTdGF0ZSgnc3BlYWtpbmcnLCAnU3BlYWtpbmfigKYnKTsKICAgIHBsYXllci5vbmVuZGVkID0gKCkgPT4geyBzZXRTdGF0ZShudWxsLCcnKTsgcmVzdW1lUmVjKCk7IH07CiAgICBwbGF5ZXIub25lcnJvciA9ICgpID0+IHsgZWxGYWlscysrOyBzcGVha0Jyb3dzZXIoc2F5KTsgfTsKCiAgICBwbGF5ZXIuc3JjID0gbGFzdEJsb2JVcmw7CiAgICBjb25zdCBwID0gcGxheWVyLnBsYXkoKTsKICAgIGlmIChwICYmIHAuY2F0Y2gpIHAuY2F0Y2goKCkgPT4gb2ZmZXJUYXBBdWRpbygpKTsKICAgIGVsRmFpbHMgPSAwOwogIH0gY2F0Y2ggKGUpIHsKICAgIGVsRmFpbHMrKzsKICAgIGlmIChlbEZhaWxzID09PSAxKSB7CiAgICAgIGNvbnN0IHdoeSA9IGUucmVhc29uID09PSAnY3JlZGl0cycKICAgICAgICA/ICdZb3VyIEVsZXZlbkxhYnMgY3JlZGl0cyByYW4gb3V0LCBzbyBJIHN3aXRjaGVkIHRvIHRoZSBidWlsdC1pbiB2b2ljZS4gT3BlbiDimLAgdG8gc2VlIHRoZSBleGFjdCBiYWxhbmNlIGFuZCByZXNldCBkYXRlLicKICAgICAgICA6IGUucmVhc29uID09PSAnYXV0aCcKICAgICAgICA/ICdFbGV2ZW5MYWJzIHJlamVjdGVkIHRoZSBrZXkuIENoZWNrIEVMRVZFTl9LRVkgb24gUmVuZGVyIOKAlCBhbmQgdGhhdCB0aGUga2V5IGhhcyBUZXh0IHRvIFNwZWVjaCArIFZvaWNlczpSZWFkIHBlcm1pc3Npb24uJwogICAgICAgIDogJ0h1bWFuIHZvaWNlIGhpY2N1cGVkLCB1c2luZyB0aGUgYnVpbHQtaW4gdm9pY2UgZm9yIG5vdy4nOwogICAgICBhZGQoJ24nLCB3aHksIHRydWUpOwogICAgfQogICAgc3BlYWtCcm93c2VyKHNheSk7CiAgfQp9CgpmdW5jdGlvbiBvZmZlclRhcEF1ZGlvKCkgewogIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsKICBiLmNsYXNzTmFtZSA9ICdyZXBsYXknOwogIGIudGV4dENvbnRlbnQgPSAn8J+UiiBUYXAgdG8gcGxheSc7CiAgYi5vbmNsaWNrID0gKCkgPT4geyBiLnJlbW92ZSgpOyBpZiAocGxheWVyKSBwbGF5ZXIucGxheSgpLmNhdGNoKCgpID0+IHt9KTsgfTsKICAkKCcjbG9nJykuYXBwZW5kQ2hpbGQoYik7CiAgJCgnI2xvZycpLnNjcm9sbFRvcCA9IDFlOTsKICBzZXRTdGF0ZShudWxsLCAnJyk7Cn0KCmxldCBzcGVha1RpbWVyID0gbnVsbDsKZnVuY3Rpb24gc3BlYWtCcm93c2VyKHNheSkgewogIHRyeSB7IHNwZWVjaFN5bnRoZXNpcy5jYW5jZWwoKTsgfSBjYXRjaCAoZSkge30KICBjb25zdCB1ID0gbmV3IFNwZWVjaFN5bnRoZXNpc1V0dGVyYW5jZShzYXkpOwogIHUubGFuZyA9ICdlbi1VUyc7CiAgY29uc3QgdiA9IHBpY2tWb2ljZSgpOwogIGlmICh2KSB1LnZvaWNlID0gdjsKICB1LnJhdGUgPSAxLjA7IHUucGl0Y2ggPSAxLjAyOwoKICBsZXQgc3RhcnRlZCA9IGZhbHNlOwogIHUub25zdGFydCA9ICgpID0+IHsgc3RhcnRlZCA9IHRydWU7IGNsZWFyVGltZW91dChzcGVha1RpbWVyKTsgc2V0U3RhdGUoJ3NwZWFraW5nJywnU3BlYWtpbmfigKYnKTsgfTsKICB1Lm9uZW5kICAgPSAoKSA9PiB7IHNldFN0YXRlKG51bGwsJycpOyByZXN1bWVSZWMoKTsgfTsKICB1Lm9uZXJyb3IgPSAoKSA9PiB7IHNldFN0YXRlKG51bGwsJycpOyByZXN1bWVSZWMoKTsgfTsKCiAgY2xlYXJUaW1lb3V0KHNwZWFrVGltZXIpOwogIHNwZWFrVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsKICAgIGlmICghc3RhcnRlZCkgewogICAgICBzZXRTdGF0ZShudWxsLCcnKTsKICAgICAgb2ZmZXJUYXBCcm93c2VyKHNheSk7CiAgICAgIHJlc3VtZVJlYygpOwogICAgfQogIH0sIDE3MDApOwoKICB0cnkgeyBzcGVlY2hTeW50aGVzaXMuc3BlYWsodSk7IH0KICBjYXRjaCAoZSkgeyBvZmZlclRhcEJyb3dzZXIoc2F5KTsgfQp9CgpmdW5jdGlvbiBvZmZlclRhcEJyb3dzZXIoc2F5KSB7CiAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogIGIuY2xhc3NOYW1lID0gJ3JlcGxheSc7CiAgYi50ZXh0Q29udGVudCA9ICfwn5SKIFRhcCB0byBoZWFyIChjaGVjayB0aGUgc2lsZW50IHN3aXRjaCBvbiB0aGUgc2lkZSknOwogIGIub25jbGljayA9ICgpID0+IHsKICAgIGIucmVtb3ZlKCk7CiAgICBjb25zdCB1ID0gbmV3IFNwZWVjaFN5bnRoZXNpc1V0dGVyYW5jZShzYXkpOwogICAgdS5sYW5nID0gJ2VuLVVTJzsKICAgIGNvbnN0IHYgPSBwaWNrVm9pY2UoKTsgaWYgKHYpIHUudm9pY2UgPSB2OwogICAgdS5vbnN0YXJ0ID0gKCkgPT4gc2V0U3RhdGUoJ3NwZWFraW5nJywnU3BlYWtpbmfigKYnKTsKICAgIHUub25lbmQgPSAoKSA9PiBzZXRTdGF0ZShudWxsLCcnKTsKICAgIHNwZWVjaFN5bnRoZXNpcy5zcGVhayh1KTsKICB9OwogICQoJyNsb2cnKS5hcHBlbmRDaGlsZChiKTsKICAkKCcjbG9nJykuc2Nyb2xsVG9wID0gMWU5Owp9CgovKiA9PT09PT09PT09PT09PT09PSBzcGVlY2ggSU4gPT09PT09PT09PT09PT09PT0KICAgVHdvIHdheXMgdG8gdGFsayB0byBoZXI6CiAgICAg4oCiIHB1c2gtdG8tdGFsayAg4oCUIHRhcCB0aGUgbWljLCBzcGVhaywgaXQgc2VuZHMgd2hlbiB5b3Ugc3RvcC4KICAgICDigKIgYWx3YXlzLW9uIPCfkYIgIOKAlCB0aGUgbWljIG5ldmVyIGNsb3Nlcy4gU2hlIGlnbm9yZXMgZXZlcnl0aGluZyB1bnRpbCBzaGUKICAgICAgICAgICAgICAgICAgICAgICBoZWFycyAiSGV5IE5vdmEiLCB0aGVuIGNhcHR1cmVzIHdoYXRldmVyIGZvbGxvd3MuCiAgIFRoZSBtaWMgaXMgZGVsaWJlcmF0ZWx5IGNsb3NlZCB3aGlsZSBzaGUgdGhpbmtzIGFuZCBzcGVha3MsIG90aGVyd2lzZSBzaGUKICAgaGVhcnMgaGVyIG93biB2b2ljZSB0aHJvdWdoIHRoZSBzcGVha2VyIGFuZCBhbnN3ZXJzIGhlcnNlbGYuIFJpZ2h0IGFmdGVyIHNoZQogICBmaW5pc2hlcyB0aGVyZSBpcyBhIGdyYWNlIHdpbmRvdyB3aGVyZSB5b3UgY2FuIHJlcGx5IFdJVEhPVVQgdGhlIHdha2Ugd29yZCwKICAgc28gYSByZWFsIGJhY2stYW5kLWZvcnRoIGRvZXNuJ3QgbmVlZCAiSGV5IE5vdmEiIGV2ZXJ5IHNpbmdsZSB0dXJuLiAqLwpjb25zdCBTUiA9IHdpbmRvdy5TcGVlY2hSZWNvZ25pdGlvbiB8fCB3aW5kb3cud2Via2l0U3BlZWNoUmVjb2duaXRpb247CmNvbnN0IFdBS0VfUkUgID0gL1xiKD86aGV5fGhpfG9rfG9rYXl8eW8pWyxcc10rbm92YVxifF5ccypub3ZhXGIvaTsKY29uc3QgR1JBQ0VfTVMgPSAxMjAwMDsgICAvLyByZXBseSB3aXRob3V0IHRoZSB3YWtlIHdvcmQgZm9yIHRoaXMgbG9uZyBhZnRlciBzaGUgc3BlYWtzCmNvbnN0IFBBVVNFX01TID0gMTMwMDsgICAgLy8gc2lsZW5jZSB0aGF0IG1lYW5zICJJIGZpbmlzaGVkIG15IHNlbnRlbmNlIgoKbGV0IHJlYyA9IG51bGw7CmxldCByZWNSdW5uaW5nID0gZmFsc2U7CmxldCB3YWtlTW9kZSAgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMUy53YWtlKSA9PT0gJzEnOwpsZXQgcGF1c2VkICAgID0gZmFsc2U7ICAgIC8vIHRydWUgd2hpbGUgc2hlIGlzIHRoaW5raW5nIG9yIHNwZWFraW5nCmxldCBhcm1lZCAgICAgPSBmYWxzZTsgICAgLy8gdHJ1ZSBvbmNlIHRoZSB3YWtlIHdvcmQgbGFuZGVkIChvciB3ZSdyZSBpbiBncmFjZSkKbGV0IGdyYWNlVW50aWwgPSAwOwpsZXQgcGF1c2VUaW1lciA9IG51bGw7CmxldCBmaW5hbEJ1ZiAgPSAnJzsKbGV0IGlkbGVUYWlsICA9ICcnOyAgIC8vIHJvbGxpbmcgdGFpbCBvZiBpZ25vcmVkIHNwZWVjaCwgZm9yIHNwbGl0IHdha2UgcGhyYXNlcwpsZXQgZmFpbFN0cmVhayA9IDAsIGxhc3RTdGFydCA9IDA7CgpmdW5jdGlvbiBtaWNTdXBwb3J0ZWQoKSB7IHJldHVybiAhIVNSOyB9CgpmdW5jdGlvbiBidWlsZFJlYygpIHsKICBjb25zdCByID0gbmV3IFNSKCk7CiAgci5sYW5nID0gJ2VuLVVTJzsKICByLmNvbnRpbnVvdXMgPSB3YWtlTW9kZTsgICAgICAvLyBvbmx5IGhvbGQgdGhlIG1pYyBvcGVuIGluIGFsd2F5cy1vbiBtb2RlCiAgci5pbnRlcmltUmVzdWx0cyA9IHRydWU7CiAgci5tYXhBbHRlcm5hdGl2ZXMgPSAxOwogIHIub25zdGFydCAgPSAoKSA9PiB7IHJlY1J1bm5pbmcgPSB0cnVlOyBwYWludE1pYygpOyBzaG93SWRsZUxpc3RlbmluZygpOyB9OwogIHIub25yZXN1bHQgPSBoYW5kbGVSZXN1bHQ7CiAgci5vbmVycm9yICA9IGhhbmRsZUVycm9yOwogIHIub25lbmQgICAgPSBoYW5kbGVFbmQ7CiAgcmV0dXJuIHI7Cn0KCmZ1bmN0aW9uIHNob3dJZGxlTGlzdGVuaW5nKCkgewogIGlmIChwYXVzZWQpIHJldHVybjsKICBpZiAod2FrZU1vZGUgJiYgIWFybWVkKSBzZXRTdGF0ZSgnbGlzdGVuaW5nJywgJ1NheSAiSGV5IE5vdmEiJyk7CiAgZWxzZSBzZXRTdGF0ZSgnbGlzdGVuaW5nJywgJ0xpc3RlbmluZ+KApicpOwp9CgpmdW5jdGlvbiBoYW5kbGVSZXN1bHQoZXYpIHsKICBsZXQgaW50ZXJpbSA9ICcnLCBmaW5hbHMgPSAnJzsKICBmb3IgKGxldCBpID0gZXYucmVzdWx0SW5kZXg7IGkgPCBldi5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7CiAgICBjb25zdCB0ID0gZXYucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0OwogICAgaWYgKGV2LnJlc3VsdHNbaV0uaXNGaW5hbCkgZmluYWxzICs9IHQgKyAnICc7IGVsc2UgaW50ZXJpbSArPSB0OwogIH0KICBjb25zdCBmcmVzaCA9IChmaW5hbHMgKyAnICcgKyBpbnRlcmltKS5yZXBsYWNlKC9ccysvZywgJyAnKS50cmltKCk7CgogIGlmICghd2FrZU1vZGUpIHsgICAgICAgICAgICAgICAgICAgICAgIC8vIHB1c2gtdG8tdGFsazogZXZlcnkgd29yZCBjb3VudHMKICAgIGZpbmFsQnVmICs9IGZpbmFsczsKICAgICQoJyNpbicpLnZhbHVlID0gKGZpbmFsQnVmICsgaW50ZXJpbSkudHJpbSgpOwogICAgcmV0dXJuOwogIH0KCiAgaWYgKCFhcm1lZCkgewogICAgaWYgKCFmcmVzaCkgcmV0dXJuOwogICAgaWYgKERhdGUubm93KCkgPCBncmFjZVVudGlsKSB7CiAgICAgIGFybWVkID0gdHJ1ZTsgZmluYWxCdWYgPSAnJzsgICAgICAgLy8gbWlkLWNvbnZlcnNhdGlvbiwgbm8gd2FrZSB3b3JkIG5lZWRlZAogICAgfSBlbHNlIHsKICAgICAgLy8gTG9vayBpbiB0aGlzIHV0dGVyYW5jZSBmaXJzdCwgc28gYSBiYXJlICJOb3ZhLCAuLi4iIHN0aWxsIGNvdW50cyBldmVuCiAgICAgIC8vIHdoZW4gdW5yZWxhdGVkIGNoYXR0ZXIgY2FtZSBiZWZvcmUgaXQuIFRoZW4gbG9vayBhY3Jvc3MgdGhlIGJvdW5kYXJ5LAogICAgICAvLyBpbiBjYXNlICJoZXkiIGFuZCAibm92YSIgbGFuZGVkIGluIHNlcGFyYXRlIHJlc3VsdCBldmVudHMuCiAgICAgIGxldCBtID0gV0FLRV9SRS5leGVjKGZyZXNoKSwgc3JjID0gZnJlc2g7CiAgICAgIGlmICghbSkgewogICAgICAgIGNvbnN0IHByb2JlID0gKGlkbGVUYWlsICsgJyAnICsgZnJlc2gpLnJlcGxhY2UoL1xzKy9nLCAnICcpLnRyaW0oKTsKICAgICAgICBtID0gV0FLRV9SRS5leGVjKHByb2JlKTsgc3JjID0gcHJvYmU7CiAgICAgIH0KICAgICAgaWYgKCFtKSB7IGlkbGVUYWlsID0gZnJlc2guc2xpY2UoLTYwKTsgcmV0dXJuOyB9ICAgLy8gcm9sbGluZyB3aW5kb3csIG5ldmVyIGdyb3dzCiAgICAgIGlkbGVUYWlsID0gJyc7CiAgICAgIGFybWVkID0gdHJ1ZTsKICAgICAgZmluYWxCdWYgPSBzcmMuc2xpY2UobS5pbmRleCArIG1bMF0ubGVuZ3RoKS50cmltKCkgKyAnICc7CiAgICAgIGJsaXAoKTsKICAgICAgY29uc3QgZmlyc3QgPSBmaW5hbEJ1Zi50cmltKCk7CiAgICAgICQoJyNpbicpLnZhbHVlID0gZmlyc3Q7CiAgICAgIHNldFN0YXRlKCdsaXN0ZW5pbmcnLCAnTGlzdGVuaW5n4oCmJyk7CiAgICAgIGNsZWFyVGltZW91dChwYXVzZVRpbWVyKTsKICAgICAgaWYgKGZpcnN0KSBwYXVzZVRpbWVyID0gc2V0VGltZW91dChzdWJtaXRWb2ljZSwgUEFVU0VfTVMpOwogICAgICByZXR1cm47CiAgICB9CiAgfQoKICBmaW5hbEJ1ZiArPSBmaW5hbHM7CiAgY29uc3QgY21kID0gKGZpbmFsQnVmICsgaW50ZXJpbSkudHJpbSgpOwogICQoJyNpbicpLnZhbHVlID0gY21kOwogIHNldFN0YXRlKCdsaXN0ZW5pbmcnLCAnTGlzdGVuaW5n4oCmJyk7CiAgY2xlYXJUaW1lb3V0KHBhdXNlVGltZXIpOwogIGlmIChjbWQpIHBhdXNlVGltZXIgPSBzZXRUaW1lb3V0KHN1Ym1pdFZvaWNlLCBQQVVTRV9NUyk7Cn0KCmZ1bmN0aW9uIHN1Ym1pdFZvaWNlKCkgewogIGNvbnN0IHQgPSAkKCcjaW4nKS52YWx1ZS50cmltKCk7CiAgZmluYWxCdWYgPSAnJzsgYXJtZWQgPSBmYWxzZTsKICBpZiAoIXQpIHJldHVybjsKICBwYXVzZVJlYygpOwogIHNlbmQobmV3IEV2ZW50KCd4JykpOwp9CgpmdW5jdGlvbiBoYW5kbGVFcnJvcihldikgewogIGlmIChldi5lcnJvciA9PT0gJ25vdC1hbGxvd2VkJyB8fCBldi5lcnJvciA9PT0gJ3NlcnZpY2Utbm90LWFsbG93ZWQnKSB7CiAgICB3YWtlTW9kZSA9IGZhbHNlOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShMUy53YWtlLCAnMCcpOyBwYWludFdha2UoKTsKICAgIHN0b3BSZWMoKTsKICAgIGFkZCgnbicsICdNaWNyb3Bob25lIHBlcm1pc3Npb24gZGVuaWVkLiBpUGhvbmU6IFNldHRpbmdzIOKGkiBTYWZhcmkg4oaSIE1pY3JvcGhvbmUg4oaSIEFsbG93LiBNYWM6IGNsaWNrIHRoZSBsb2NrIGljb24gaW4gdGhlIGFkZHJlc3MgYmFyIOKGkiBNaWNyb3Bob25lIOKGkiBBbGxvdy4nLCB0cnVlKTsKICB9CiAgLy8gbm8tc3BlZWNoIC8gYWJvcnRlZCAvIG5ldHdvcmsgYWxsIGZhbGwgdGhyb3VnaCB0byBvbmVuZCwgd2hpY2ggcmVzdGFydHMKfQoKZnVuY3Rpb24gaGFuZGxlRW5kKCkgewogIHJlY1J1bm5pbmcgPSBmYWxzZTsKICBwYWludE1pYygpOwogIGNsZWFyVGltZW91dChwYXVzZVRpbWVyKTsKCiAgaWYgKCF3YWtlTW9kZSkgeyAgICAgICAgICAgICAgICAgICAgICAgIC8vIHB1c2gtdG8tdGFsazogc2VuZCB3aGF0IHdhcyBjYXB0dXJlZAogICAgY29uc3Qgc2FpZCA9ICQoJyNpbicpLnZhbHVlLnRyaW0oKTsKICAgIGZpbmFsQnVmID0gJyc7CiAgICBzZXRTdGF0ZShudWxsLCAnJyk7CiAgICBpZiAoc2FpZCkgc2VuZChuZXcgRXZlbnQoJ3gnKSk7CiAgICByZXR1cm47CiAgfQoKICBpZiAocGF1c2VkKSB7IHNldFN0YXRlKG51bGwsICcnKTsgcmV0dXJuOyB9CgogIC8vIGFsd2F5cy1vbjogYnJvd3NlcnMgY2xvc2UgdGhlIG1pYyBwZXJpb2RpY2FsbHkuIEp1c3QgcmVvcGVuIGl0LgogIGNvbnN0IG5vdyA9IERhdGUubm93KCk7CiAgZmFpbFN0cmVhayA9IChub3cgLSBsYXN0U3RhcnQgPCA1MDApID8gZmFpbFN0cmVhayArIDEgOiAwOwogIGlmIChmYWlsU3RyZWFrID4gNikgewogICAgd2FrZU1vZGUgPSBmYWxzZTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oTFMud2FrZSwgJzAnKTsgcGFpbnRXYWtlKCk7CiAgICBzZXRTdGF0ZShudWxsLCAnJyk7CiAgICBhZGQoJ24nLCAnWW91ciBicm93c2VyIGtlZXBzIGNsb3NpbmcgdGhlIG1pYywgc28gSSBzdG9wcGVkIGFsd2F5cy1vbiBsaXN0ZW5pbmcuIE9uIGlQaG9uZSB0aGlzIGlzIGFuIEFwcGxlIGxpbWl0YXRpb24g4oCUIHVzZSB0aGUgbWljIGJ1dHRvbiB0aGVyZSwgb3IgcnVuIGFsd2F5cy1vbiBmcm9tIHRoZSBNYWMuIFRhcCB0aGUgZWFyIGljb24gdG8gdHJ5IGFnYWluLicsIHRydWUpOwogICAgcmV0dXJuOwogIH0KICBzZXRUaW1lb3V0KHN0YXJ0UmVjLCAyNTApOwp9CgpmdW5jdGlvbiBzdGFydFJlYygpIHsKICBpZiAoIW1pY1N1cHBvcnRlZCgpIHx8IHJlY1J1bm5pbmcgfHwgcGF1c2VkIHx8IGJ1c3kpIHJldHVybjsKICB1bmxvY2tBdWRpbygpOwogIGlmICghcmVjKSByZWMgPSBidWlsZFJlYygpOwogIGxhc3RTdGFydCA9IERhdGUubm93KCk7CiAgdHJ5IHsgcmVjLnN0YXJ0KCk7IH0KICBjYXRjaCAoZSkgewogICAgdHJ5IHsgcmVjLmFib3J0KCk7IH0gY2F0Y2ggKGUyKSB7fQogICAgcmVjID0gYnVpbGRSZWMoKTsKICAgIHRyeSB7IHJlYy5zdGFydCgpOyB9IGNhdGNoIChlMykgeyByZWNSdW5uaW5nID0gZmFsc2U7IH0KICB9Cn0KCmZ1bmN0aW9uIHN0b3BSZWMoKSB7CiAgY2xlYXJUaW1lb3V0KHBhdXNlVGltZXIpOwogIGZpbmFsQnVmID0gJyc7IGlkbGVUYWlsID0gJyc7IGFybWVkID0gZmFsc2U7CiAgaWYgKHJlYykgeyB0cnkgeyByZWMuc3RvcCgpOyB9IGNhdGNoIChlKSB7fSB9CiAgcmVjUnVubmluZyA9IGZhbHNlOwogIHBhaW50TWljKCk7Cn0KCi8qIGNsb3NlIHRoZSBtaWMgd2hpbGUgc2hlIHRhbGtzIHNvIHNoZSBjYW5ub3QgaGVhciBoZXJzZWxmICovCmZ1bmN0aW9uIHBhdXNlUmVjKCkgewogIHBhdXNlZCA9IHRydWU7CiAgY2xlYXJUaW1lb3V0KHBhdXNlVGltZXIpOwogIGlmIChyZWMpIHsgdHJ5IHsgcmVjLnN0b3AoKTsgfSBjYXRjaCAoZSkge30gfQogIHJlY1J1bm5pbmcgPSBmYWxzZTsKICBwYWludE1pYygpOwp9CgpmdW5jdGlvbiByZXN1bWVSZWMoKSB7CiAgcGF1c2VkID0gZmFsc2U7CiAgZmluYWxCdWYgPSAnJzsgaWRsZVRhaWwgPSAnJzsgYXJtZWQgPSBmYWxzZTsKICBncmFjZVVudGlsID0gRGF0ZS5ub3coKSArIEdSQUNFX01TOyAgIC8vIGFuc3dlciBoZXIgd2l0aG91dCBzYXlpbmcgdGhlIHdha2Ugd29yZAogIGlmICh3YWtlTW9kZSkgc2V0VGltZW91dChzdGFydFJlYywgMzAwKTsKfQoKZnVuY3Rpb24gcGFpbnRNaWMoKSB7ICQoJyNtaWMnKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicsIHJlY1J1bm5pbmcpOyB9CgovKiBzaG9ydCBjaGltZSBzbyB5b3Uga25vdyB0aGUgd2FrZSB3b3JkIHJlZ2lzdGVyZWQgKi8KZnVuY3Rpb24gYmxpcCgpIHsKICB0cnkgewogICAgY29uc3QgQyA9IHdpbmRvdy5BdWRpb0NvbnRleHQgfHwgd2luZG93LndlYmtpdEF1ZGlvQ29udGV4dDsKICAgIGlmICghQykgcmV0dXJuOwogICAgY29uc3QgY3R4ID0gYmxpcC5jdHggfHwgKGJsaXAuY3R4ID0gbmV3IEMoKSk7CiAgICBjb25zdCBvID0gY3R4LmNyZWF0ZU9zY2lsbGF0b3IoKSwgZyA9IGN0eC5jcmVhdGVHYWluKCk7CiAgICBvLnR5cGUgPSAnc2luZSc7IG8uZnJlcXVlbmN5LnZhbHVlID0gODgwOwogICAgZy5nYWluLnNldFZhbHVlQXRUaW1lKDAuMDAwMSwgY3R4LmN1cnJlbnRUaW1lKTsKICAgIGcuZ2Fpbi5leHBvbmVudGlhbFJhbXBUb1ZhbHVlQXRUaW1lKDAuMTIsIGN0eC5jdXJyZW50VGltZSArIDAuMDIpOwogICAgZy5nYWluLmV4cG9uZW50aWFsUmFtcFRvVmFsdWVBdFRpbWUoMC4wMDAxLCBjdHguY3VycmVudFRpbWUgKyAwLjE2KTsKICAgIG8uY29ubmVjdChnKTsgZy5jb25uZWN0KGN0eC5kZXN0aW5hdGlvbik7CiAgICBvLnN0YXJ0KCk7IG8uc3RvcChjdHguY3VycmVudFRpbWUgKyAwLjE4KTsKICB9IGNhdGNoIChlKSB7fQp9CgpmdW5jdGlvbiB0b2dnbGVNaWMoKSB7CiAgaWYgKCFtaWNTdXBwb3J0ZWQoKSkgewogICAgYWRkKCduJywnVGhpcyBicm93c2VyIGRvZXMgbm90IHN1cHBvcnQgc3BlZWNoIHJlY29nbml0aW9uLiBVc2UgU2FmYXJpIG9uIGlQaG9uZSwgb3IgQ2hyb21lL1NhZmFyaSBvbiBNYWMuJywgdHJ1ZSk7CiAgICByZXR1cm47CiAgfQogIGlmICh3YWtlTW9kZSkgeyAgICAgICAgICAgICAgICAgLy8gbWFudWFsIGFybSDigJQgc2tpcCBoYXZpbmcgdG8gc2F5ICJIZXkgTm92YSIKICAgIGFybWVkID0gdHJ1ZTsgZmluYWxCdWYgPSAnJzsKICAgIGdyYWNlVW50aWwgPSBEYXRlLm5vdygpICsgR1JBQ0VfTVM7CiAgICBpZiAoIXJlY1J1bm5pbmcpIHN0YXJ0UmVjKCk7IGVsc2Ugc2V0U3RhdGUoJ2xpc3RlbmluZycsJ0xpc3RlbmluZ+KApicpOwogICAgcmV0dXJuOwogIH0KICBpZiAocmVjUnVubmluZykgeyBzdG9wUmVjKCk7IHNldFN0YXRlKG51bGwsJycpOyB9IGVsc2UgeyBzdGFydFJlYygpOyB9Cn0KCi8qID09PT09PT09PT09PT09PT09IGFsd2F5cy1vbiBtb2RlID09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIHRvZ2dsZVdha2UoKSB7CiAgaWYgKCFtaWNTdXBwb3J0ZWQoKSkgewogICAgYWRkKCduJywnVGhpcyBicm93c2VyIGRvZXMgbm90IHN1cHBvcnQgc3BlZWNoIHJlY29nbml0aW9uLiBVc2UgU2FmYXJpIG9uIGlQaG9uZSwgb3IgQ2hyb21lL1NhZmFyaSBvbiBNYWMuJywgdHJ1ZSk7CiAgICByZXR1cm47CiAgfQogIHdha2VNb2RlID0gIXdha2VNb2RlOwogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKExTLndha2UsIHdha2VNb2RlID8gJzEnIDogJzAnKTsKICBwYWludFdha2UoKTsKICBzdG9wUmVjKCk7CiAgcmVjID0gbnVsbDsgICAgICAgICAgICAgICAgICAgICAvLyB0aGUgY29udGludW91cyBmbGFnIG9ubHkgYXBwbGllcyB0byBhIGZyZXNoIGluc3RhbmNlCiAgaWYgKHdha2VNb2RlKSB7CiAgICBhZGQoJ24nLCdBbHdheXMtb24gaXMgbGl2ZS4gVGhlIG1pYyBzdGF5cyBvcGVuIOKAlCBqdXN0IHNheSAiSGV5IE5vdmEiIGFuZCBJIHdha2UgdXAuIEZvciBhYm91dCAxMiBzZWNvbmRzIGFmdGVyIEkgYW5zd2VyIHlvdSBjYW4ga2VlcCB0YWxraW5nIHdpdGhvdXQgdGhlIHdha2Ugd29yZC4nKTsKICAgIHBhdXNlZCA9IGZhbHNlOwogICAgc3RhcnRSZWMoKTsKICB9IGVsc2UgewogICAgc2V0U3RhdGUobnVsbCwnJyk7CiAgfQp9CmZ1bmN0aW9uIHBhaW50V2FrZSgpIHsgJCgnI3dha2VCdG4nKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicsIHdha2VNb2RlKTsgfQoKLyogPT09PT09PT09PT09PT09PT0gcGVuZGluZyBlbWFpbHMgPT09PT09PT09PT09PT09PT0gKi8KYXN5bmMgZnVuY3Rpb24gcmVmcmVzaFBlbmRpbmcobikgewogIGlmIChuID09PSB1bmRlZmluZWQpIHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCgnL2FwaS9wZW5kaW5nJywgeyBoZWFkZXJzOnsgJ3gtbm92YS10b2tlbic6IFRPS0VOIH0gfSk7CiAgICAgIGlmICghci5vaykgeyBuID0gMDsgfSBlbHNlIHsgY29uc3QgaiA9IGF3YWl0IHIuanNvbigpOyBuID0gQXJyYXkuaXNBcnJheShqKSA/IGoubGVuZ3RoIDogMDsgfQogICAgfSBjYXRjaCAoZSkgeyBuID0gMDsgfQogIH0KICBjb25zdCBlbCA9ICQoJyNwZW5kJyk7CiAgZWwuc3R5bGUuZGlzcGxheSA9IG4gPyAnYmxvY2snIDogJ25vbmUnOwogIGVsLnRleHRDb250ZW50ID0gbiA/ICgn4pqgICcgKyBuKSA6ICcnOwp9Cgphc3luYyBmdW5jdGlvbiBvcGVuUGVuZGluZygpIHsKICBjb25zdCBib2R5ID0gJCgnI3BlbmRCb2R5Jyk7CiAgYm9keS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0ibXV0ZWQiPkxvYWRpbmfigKY8L2Rpdj4nOwogICQoJyNwZW5kU2hlZXQnKS5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CiAgbGV0IGxpc3QgPSBbXTsKICB0cnkgewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoKCcvYXBpL3BlbmRpbmcnLCB7IGhlYWRlcnM6eyAneC1ub3ZhLXRva2VuJzogVE9LRU4gfSB9KTsKICAgIGxpc3QgPSBhd2FpdCByLmpzb24oKTsKICB9IGNhdGNoIChlKSB7fQogIGlmICghbGlzdC5sZW5ndGgpIHsgYm9keS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0ibXV0ZWQiPk5vdGhpbmcgd2FpdGluZy48L2Rpdj4nOyByZXR1cm47IH0KICBib2R5LmlubmVySFRNTCA9ICcnOwogIGxpc3QuZm9yRWFjaChwID0+IHsKICAgIGNvbnN0IGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGMuY2xhc3NOYW1lID0gJ2NhcmQnOwogICAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgaGVhZC5pbm5lckhUTUwgPSAnPGI+VG86PC9iPiAnICsgZXNjKHAudG8pICsgJzxicj48Yj5TdWJqZWN0OjwvYj4gJyArIGVzYyhwLnN1YmplY3QgfHwgJycpOwogICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBwcmUuc3R5bGUuY3NzVGV4dCA9ICdtYXJnaW4tdG9wOjhweDtjb2xvcjp2YXIoLS1kaW0pO3doaXRlLXNwYWNlOnByZS13cmFwO21heC1oZWlnaHQ6MjAwcHg7b3ZlcmZsb3c6YXV0byc7CiAgICBwcmUudGV4dENvbnRlbnQgPSBwLmJvZHkgfHwgJyc7CiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIHJvdy5jbGFzc05hbWUgPSAncm93JzsKICAgIGNvbnN0IHllcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgeWVzLmNsYXNzTmFtZSA9ICdvayc7IHllcy50ZXh0Q29udGVudCA9ICfinJMgU2VuZCc7CiAgICB5ZXMub25jbGljayA9ICgpID0+IGFjdCgnL2FwaS9hcHByb3ZlJywgcC5pZCwgYyk7CiAgICBjb25zdCBubyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgbm8uY2xhc3NOYW1lID0gJ25vJzsgbm8udGV4dENvbnRlbnQgPSAn4pyVIERpc2NhcmQnOwogICAgbm8ub25jbGljayA9ICgpID0+IGFjdCgnL2FwaS9yZWplY3QnLCBwLmlkLCBjKTsKICAgIHJvdy5hcHBlbmQoeWVzLCBubyk7CiAgICBjLmFwcGVuZChoZWFkLCBwcmUsIHJvdyk7CiAgICBib2R5LmFwcGVuZENoaWxkKGMpOwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiBhY3QodXJsLCBpZCwgY2FyZCkgewogIGNhcmQuc3R5bGUub3BhY2l0eSA9ICcuNDUnOwogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godXJsLCB7CiAgICAgIG1ldGhvZDonUE9TVCcsCiAgICAgIGhlYWRlcnM6eyAnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbicsICd4LW5vdmEtdG9rZW4nOiBUT0tFTiB9LAogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkIH0pCiAgICB9KTsKICAgIGNvbnN0IGogPSBhd2FpdCByLmpzb24oKTsKICAgIGlmIChqLmVycm9yKSB0aHJvdyBuZXcgRXJyb3Ioai5lcnJvcik7CiAgICBjYXJkLnJlbW92ZSgpOwogIH0gY2F0Y2ggKGUpIHsKICAgIGNhcmQuc3R5bGUub3BhY2l0eSA9ICcxJzsKICAgIGFsZXJ0KCdFcnJvcjogJyArIGUubWVzc2FnZSk7CiAgfQogIHJlZnJlc2hQZW5kaW5nKCk7CiAgaWYgKCEkKCcjcGVuZEJvZHknKS5jaGlsZHJlbi5sZW5ndGgpICQoJyNwZW5kQm9keScpLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJtdXRlZCI+Tm90aGluZyB3YWl0aW5nLjwvZGl2Pic7Cn0KCmZ1bmN0aW9uIGVzYyhzKSB7IGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC50ZXh0Q29udGVudCA9IHMgPT0gbnVsbCA/ICcnIDogczsgcmV0dXJuIGQuaW5uZXJIVE1MOyB9CgovKiA9PT09PT09PT09PT09PT09PSBzZXR0aW5ncyA9PT09PT09PT09PT09PT09PSAqLwphc3luYyBmdW5jdGlvbiBvcGVuTWVudSgpIHsKICBjb25zdCBiID0gJCgnI21lbnVCb2R5Jyk7CiAgYi5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0ibXV0ZWQiPkxvYWRpbmfigKY8L2Rpdj4nOwogICQoJyNtZW51U2hlZXQnKS5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7CgogIGxldCBoZWFsdGggPSB7fSwgdGFza3MgPSBbXTsKICB0cnkgeyBoZWFsdGggPSBhd2FpdCAoYXdhaXQgZmV0Y2goJy9oZWFsdGgnKSkuanNvbigpOyBIRUFMVEggPSBoZWFsdGg7IH0gY2F0Y2ggKGUpIHt9CiAgdHJ5IHsgdGFza3MgID0gYXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL3Rhc2tzJywgeyBoZWFkZXJzOnsgJ3gtbm92YS10b2tlbic6IFRPS0VOIH0gfSkpLmpzb24oKTsgfSBjYXRjaCAoZSkge30KICBpZiAoIUFycmF5LmlzQXJyYXkodGFza3MpKSB0YXNrcyA9IFtdOwoKICBiLmlubmVySFRNTCA9ICcnOwoKICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBzdGF0dXMuY2xhc3NOYW1lID0gJ2NhcmQnOwogIHN0YXR1cy5pbm5lckhUTUwgPQogICAgJzxiPlNlcnZlciBzdGF0dXM8L2I+PGJyPicgKwogICAgJ0JyYWluOiAnICsgZXNjKGhlYWx0aC5tb2RlbCB8fCAn4oCUJykgKyAnPGJyPicgKwogICAgJ0VtYWlsIHNlbmRpbmc6ICcgKyAoaGVhbHRoLmVtYWlsID8gJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZWFsKSI+b24g4pyTPC9zcGFuPicgOiAnPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXJlZCkiPm9mZiDinJU8L3NwYW4+JykgKyAnPGJyPicgKwogICAgJ0luYm94IHJlYWRpbmc6ICcgKyAoaGVhbHRoLmluYm94ID8gJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZWFsKSI+b24g4pyTPC9zcGFuPicgOiAnPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXJlZCkiPm9mZiDinJU8L3NwYW4+JykgKyAnPGJyPicgKwogICAgJ0Jyb3dzZXI6ICcgKyAoaGVhbHRoLmJyb3dzZXIgPyAnPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRlYWwpIj5vbiDinJM8L3NwYW4+JyA6ICc8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tZGltKSI+b2ZmIChzZXQgQlJPV1NFUl9XUyk8L3NwYW4+JykgKyAnPGJyPicgKwogICAgJ1RpbWUgem9uZTogJyArIGVzYyhoZWFsdGgudHogfHwgJ+KAlCcpICsgJzxicj4nICsKICAgICdTY2hlZHVsZWQgdGFza3M6ICcgKyAodGFza3MubGVuZ3RoIHx8IDApICsgJzxicj4nICsKICAgICdNZW1vcnk6ICcgKyAoaGVhbHRoLm1lbW9yaWVzIHx8IDApICsgJyBmYWN0cywgJyArIChoZWFsdGguY29udGFjdHMgfHwgMCkgKyAnIGNvbnRhY3RzPGJyPicgKwogICAgJ1N0b3JhZ2U6ICcgKyAoaGVhbHRoLnBlcnNpc3RlZAogICAgICA/ICc8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGVhbCkiPnBlcnNpc3RlbnQg4pyTPC9zcGFuPicKICAgICAgOiAnPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXJlZCkiPk5PVCBwZXJzaXN0ZW50IOKclSDigJQgZXZlcnl0aGluZyByZXNldHMgb24gZGVwbG95PC9zcGFuPicpICsKICAgICcgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLWRpbSkiPihib290ICMnICsgKGhlYWx0aC5ib290cyB8fCAnPycpICsgJyk8L3NwYW4+JzsKICBiLmFwcGVuZENoaWxkKHN0YXR1cyk7CgogIGlmIChoZWFsdGgudm9pY2UpIHsKICAgIGNvbnN0IHVjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICB1Yy5jbGFzc05hbWUgPSAnY2FyZCc7CiAgICB1Yy5pbm5lckhUTUwgPSAnPGI+RWxldmVuTGFicyBjcmVkaXRzPC9iPjxkaXYgY2xhc3M9Im11dGVkIiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPkNoZWNraW5n4oCmPC9kaXY+JzsKICAgIGIuYXBwZW5kQ2hpbGQodWMpOwogICAgZmV0Y2goJy9hcGkvdXNhZ2UnLCB7IGhlYWRlcnM6eyAneC1ub3ZhLXRva2VuJzogVE9LRU4gfSB9KQogICAgICAudGhlbihyID0+IHIuanNvbigpKQogICAgICAudGhlbih1ID0+IHsKICAgICAgICBpZiAodS5lcnJvcikgdGhyb3cgbmV3IEVycm9yKHUuZXJyb3IpOwogICAgICAgIGNvbnN0IGxvdyA9IHUubGltaXQgJiYgdS5yZW1haW5pbmcgLyB1LmxpbWl0IDwgMC4xOwogICAgICAgIGNvbnN0IHJlc2V0ID0gdS5yZXNldHNBdCA/IG5ldyBEYXRlKHUucmVzZXRzQXQpLnRvTG9jYWxlRGF0ZVN0cmluZyh1bmRlZmluZWQse21vbnRoOidzaG9ydCcsZGF5OidudW1lcmljJ30pIDogJ+KAlCc7CiAgICAgICAgdWMuaW5uZXJIVE1MID0gJzxiPkVsZXZlbkxhYnMgY3JlZGl0czwvYj4nICsKICAgICAgICAgICc8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweDtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6JyArCiAgICAgICAgICAgIChsb3cgPyAndmFyKC0tcmVkKScgOiAndmFyKC0tdGVhbCknKSArICciPicgKyB1LnJlbWFpbmluZy50b0xvY2FsZVN0cmluZygpICsgJzwvZGl2PicgKwogICAgICAgICAgJzxkaXYgY2xhc3M9Im11dGVkIj5sZWZ0IG9mICcgKyB1LmxpbWl0LnRvTG9jYWxlU3RyaW5nKCkgKyAnIMK3ICcgKyB1LnBjdCArICclIHVzZWQgwrcgJyArCiAgICAgICAgICBlc2ModS50aWVyKSArICcgcGxhbiDCtyByZXNldHMgJyArIHJlc2V0ICsgJzwvZGl2PicgKwogICAgICAgICAgJzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6OXB4O2hlaWdodDo2cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpyZ2JhKDE1MCwxNDAsMjU1LC4xOCk7b3ZlcmZsb3c6aGlkZGVuIj4nICsKICAgICAgICAgICAgJzxkaXYgc3R5bGU9ImhlaWdodDoxMDAlO3dpZHRoOicgKyBNYXRoLm1pbigxMDAsIHUucGN0KSArICclO2JhY2tncm91bmQ6JyArCiAgICAgICAgICAgIChsb3cgPyAndmFyKC0tcmVkKScgOiAndmFyKC0tdGVhbCknKSArICciPjwvZGl2PjwvZGl2PicgKwogICAgICAgICAgKGxvdyA/ICc8ZGl2IGNsYXNzPSJtdXRlZCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O2NvbG9yOnZhcigtLXJlZCkiPkFsbW9zdCBvdXQg4oCUIHNoZSB3aWxsIGZhbGwgYmFjayB0byB0aGUgYnVpbHQtaW4gdm9pY2UuPC9kaXY+JyA6ICcnKTsKICAgICAgfSkKICAgICAgLmNhdGNoKGUgPT4gewogICAgICAgIHVjLmlubmVySFRNTCA9ICc8Yj5FbGV2ZW5MYWJzIGNyZWRpdHM8L2I+PGRpdiBjbGFzcz0ibXV0ZWQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+Q291bGQgbm90IHJlYWQgdXNhZ2U6ICcgKyBlc2MoZS5tZXNzYWdlKSArICc8L2Rpdj4nOwogICAgICB9KTsKICB9CgogIGNvbnN0IGVuZ2luZSA9IGhlYWx0aC52b2ljZVJlYWR5ID8gJ0h1bWFuIHZvaWNlIOKAlCBFbGV2ZW5MYWJzIOKckycKICAgICAgICAgICAgICAgOiBoZWFsdGgudm9pY2UgICAgICA/ICdFbGV2ZW5MYWJzIGNvbm5lY3RlZCDigJQgcGljayBhIHZvaWNlIGJlbG93JwogICAgICAgICAgICAgICA6ICdCdWlsdC1pbiBicm93c2VyIHZvaWNlJzsKICBjb25zdCB2YyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHZjLmNsYXNzTmFtZSA9ICdjYXJkJzsKICB2Yy5pbm5lckhUTUwgPSAnPGI+Vm9pY2U8L2I+PGRpdiBjbGFzcz0ibXV0ZWQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+RW5naW5lOiAnICsgZXNjKGVuZ2luZSkgKyAnPC9kaXY+JzsKICBjb25zdCB2cm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IHZyb3cuY2xhc3NOYW1lID0gJ3Jvdyc7CiAgY29uc3QgdmIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsKICB2Yi5jbGFzc05hbWUgPSBWT0lDRV9PTiA/ICdvaycgOiAnbm8nOwogIHZiLnRleHRDb250ZW50ID0gVk9JQ0VfT04gPyAn8J+UiiBWb2ljZSBvbicgOiAn8J+UhyBWb2ljZSBvZmYnOwogIHZiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBWT0lDRV9PTiA9ICFWT0lDRV9PTjsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKExTLnZvaWNlLCBWT0lDRV9PTiA/ICcxJyA6ICcwJyk7CiAgICB2Yi5jbGFzc05hbWUgPSBWT0lDRV9PTiA/ICdvaycgOiAnbm8nOwogICAgdmIudGV4dENvbnRlbnQgPSBWT0lDRV9PTiA/ICfwn5SKIFZvaWNlIG9uJyA6ICfwn5SHIFZvaWNlIG9mZic7CiAgfTsKICBjb25zdCB0YiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogIHRiLmNsYXNzTmFtZSA9ICdvayc7IHRiLnRleHRDb250ZW50ID0gJ/CfjqcgVGVzdCB2b2ljZSc7CiAgdGIub25jbGljayA9ICgpID0+IHsgZWxGYWlscyA9IDA7IHNwZWFrKCdIZXkgR2F2cmllbCwgdGhpcyBpcyBOb3ZhLiBJIGhlYXIgeW91IGxvdWQgYW5kIGNsZWFyLicpOyB9OwogIHZyb3cuYXBwZW5kKHZiLCB0Yik7IHZjLmFwcGVuZENoaWxkKHZyb3cpOwogIGIuYXBwZW5kQ2hpbGQodmMpOwoKICBpZiAoaGVhbHRoLnZvaWNlKSB7CiAgICBjb25zdCBwYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgcGMuY2xhc3NOYW1lID0gJ2NhcmQnOwogICAgcGMuaW5uZXJIVE1MID0gJzxiPlBpY2sgYSB2b2ljZTwvYj48ZGl2IGNsYXNzPSJtdXRlZCIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij5Mb2FkaW5nIHZvaWNlc+KApjwvZGl2Pic7CiAgICBiLmFwcGVuZENoaWxkKHBjKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCgnL2FwaS92b2ljZXMnLCB7IGhlYWRlcnM6eyAneC1ub3ZhLXRva2VuJzogVE9LRU4gfSB9KTsKICAgICAgY29uc3QgaiA9IGF3YWl0IHIuanNvbigpOwogICAgICBpZiAoai5lcnJvcikgdGhyb3cgbmV3IEVycm9yKGouZXJyb3IpOwogICAgICBwYy5pbm5lckhUTUwgPSAnPGI+UGljayBhIHZvaWNlPC9iPjxkaXYgY2xhc3M9Im11dGVkIiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPicgKwogICAgICAgIGoudm9pY2VzLmxlbmd0aCArICcgdm9pY2VzIGluIHlvdXIgRWxldmVuTGFicyBhY2NvdW50LiBUYXAgb25lIHRvIG1ha2UgaXQgaGVycy48L2Rpdj4nOwogICAgICBqLnZvaWNlcy5mb3JFYWNoKHYgPT4gewogICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgICAgIGNvbnN0IGFjdGl2ZSA9IHYuaWQgPT09IGouY3VycmVudDsKICAgICAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7dGV4dC1hbGlnbjpsZWZ0O21hcmdpbi10b3A6OHB4O3BhZGRpbmc6MTBweCAxMnB4OycgKwogICAgICAgICAgJ2JvcmRlci1yYWRpdXM6MTFweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcjtib3JkZXI6MXB4IHNvbGlkICcgKwogICAgICAgICAgKGFjdGl2ZSA/ICdyZ2JhKDc1LDIzMiwyMDgsLjU1KScgOiAncmdiYSgxNTAsMTQwLDI1NSwuMiknKSArICc7YmFja2dyb3VuZDonICsKICAgICAgICAgIChhY3RpdmUgPyAncmdiYSg3NSwyMzIsMjA4LC4xNCknIDogJ3JnYmEoMTUwLDE0MCwyNTUsLjA2KScpICsgJztjb2xvcjp2YXIoLS1pbmspJzsKICAgICAgICBjb25zdCB0YWdzID0gW3YubGFiZWxzLmFjY2VudCwgdi5sYWJlbHMuZ2VuZGVyLCB2LmxhYmVscy5kZXNjcmlwdGlvbl0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyDCtyAnKTsKICAgICAgICByb3cuaW5uZXJIVE1MID0gKGFjdGl2ZSA/ICfinJMgJyA6ICcnKSArICc8YiBzdHlsZT0iY29sb3I6aW5oZXJpdCI+JyArIGVzYyh2Lm5hbWUpICsgJzwvYj4nICsKICAgICAgICAgICh0YWdzID8gJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1kaW0pO2ZvbnQtc2l6ZToxMnB4Ij4g4oCUICcgKyBlc2ModGFncykgKyAnPC9zcGFuPicgOiAnJyk7CiAgICAgICAgcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgICAgICB0cnkgewogICAgICAgICAgICBhd2FpdCBmZXRjaCgnL2FwaS92b2ljZScsIHsKICAgICAgICAgICAgICBtZXRob2Q6J1BPU1QnLAogICAgICAgICAgICAgIGhlYWRlcnM6eyAnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbicsICd4LW5vdmEtdG9rZW4nOiBUT0tFTiB9LAogICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgdm9pY2VJZDogdi5pZCB9KQogICAgICAgICAgICB9KTsKICAgICAgICAgICAgZWxGYWlscyA9IDA7CiAgICAgICAgICAgIEhFQUxUSC52b2ljZVJlYWR5ID0gdHJ1ZTsKICAgICAgICAgICAgY2xvc2VTaGVldCgnbWVudVNoZWV0Jyk7CiAgICAgICAgICAgIHNwZWFrKCdUaGlzIGlzIG15IHZvaWNlIGZyb20gbm93IG9uLiBTb3VuZCBnb29kPycpOwogICAgICAgICAgfSBjYXRjaCAoZSkgeyBhbGVydCgnRXJyb3I6ICcgKyBlLm1lc3NhZ2UpOyB9CiAgICAgICAgfTsKICAgICAgICBwYy5hcHBlbmRDaGlsZChyb3cpOwogICAgICB9KTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcGMuaW5uZXJIVE1MID0gJzxiPlBpY2sgYSB2b2ljZTwvYj48ZGl2IGNsYXNzPSJtdXRlZCIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij5Db3VsZCBub3QgbG9hZCB2b2ljZXM6ICcgKyBlc2MoZS5tZXNzYWdlKSArICc8L2Rpdj4nOwogICAgfQogIH0KCiAgaWYgKHRhc2tzLmxlbmd0aCkgewogICAgY29uc3QgdGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIHRjLmNsYXNzTmFtZSA9ICdjYXJkJzsKICAgIHRjLmlubmVySFRNTCA9ICc8Yj5TY2hlZHVsZWQgdGFza3M8L2I+JzsKICAgIHRhc2tzLmZvckVhY2godCA9PiB7CiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdtYXJnaW4tdG9wOjhweDtjb2xvcjp2YXIoLS1kaW0pO2ZvbnQtc2l6ZToxM3B4JzsKICAgICAgcm93LnRleHRDb250ZW50ID0gJ+KAoiAnICsgKHQuaW5zdHJ1Y3Rpb24gfHwgJycpICsgJyAgWycgKyAodC5jcm9uIHx8ICcnKSArICddJzsKICAgICAgdGMuYXBwZW5kQ2hpbGQocm93KTsKICAgIH0pOwogICAgY29uc3QgaGludCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgaGludC5jbGFzc05hbWUgPSAnbXV0ZWQnOwogICAgaGludC5zdHlsZS5tYXJnaW5Ub3AgPSAnOHB4JzsKICAgIGhpbnQudGV4dENvbnRlbnQgPSAnVG8gY2FuY2VsIG9uZSwganVzdCB0ZWxsIE5vdmE6ICJjYW5jZWwgdGhlIHRhc2sgYWJvdXTigKYiJzsKICAgIHRjLmFwcGVuZENoaWxkKGhpbnQpOwogICAgYi5hcHBlbmRDaGlsZCh0Yyk7CiAgfQoKICBjb25zdCBsYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIGxjLmNsYXNzTmFtZSA9ICdjYXJkJzsKICBsYy5pbm5lckhUTUwgPSAnPGI+TGlzdGVuaW5nPC9iPjxkaXYgY2xhc3M9Im11dGVkIiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPicgKwogICAgJ/CfjpkgTWljIGJ1dHRvbiDigJQgdGFwLCB0YWxrLCBpdCBzZW5kcyB3aGVuIHlvdSBzdG9wLjxicj4nICsKICAgICfwn5GCIEFsd2F5cy1vbiDigJQgdGhlIG1pYyBzdGF5cyBvcGVuLiBTYXkgPGIgc3R5bGU9ImNvbG9yOmluaGVyaXQiPiJIZXkgTm92YSI8L2I+IGFuZCBJIHdha2UgdXAuICcgKwogICAgJ0ZvciB+MTIgc2Vjb25kcyBhZnRlciBJIGFuc3dlciB5b3UgY2FuIGtlZXAgdGFsa2luZyB3aXRob3V0IHRoZSB3YWtlIHdvcmQuPGJyPicgKwogICAgJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1kaW0pIj5BbHdheXMtb24gd29ya3MgYmVzdCBvbiB0aGUgTWFjLiBPbiBpUGhvbmUsIEFwcGxlIGNsb3NlcyB0aGUgbWljIG9uIGl0cyBvd24sICcgKwogICAgJ3NvIGl0IHdpbGwgaGFuZCBiYWNrIHRvIHRoZSBtaWMgYnV0dG9uLjwvc3Bhbj48L2Rpdj4nOwogIGIuYXBwZW5kQ2hpbGQobGMpOwoKICBjb25zdCBoZWxwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgaGVscC5jbGFzc05hbWUgPSAnY2FyZCc7CiAgaGVscC5pbm5lckhUTUwgPSAnPGI+SW5zdGFsbDwvYj48ZGl2IGNsYXNzPSJtdXRlZCIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij4nICsKICAgICdpUGhvbmU6IFNoYXJlIGJ1dHRvbiDirIYg4oaSICJBZGQgdG8gSG9tZSBTY3JlZW4iLjxicj4nICsKICAgICdNYWMgKFNhZmFyaSk6IEZpbGUg4oaSICJBZGQgdG8gRG9jayIuPGJyPicgKwogICAgJ01hYyAoQ2hyb21lKTogdGhlIGluc3RhbGwgaWNvbiBpbiB0aGUgYWRkcmVzcyBiYXIuPC9kaXY+JzsKICBiLmFwcGVuZENoaWxkKGhlbHApOwoKICBjb25zdCBvdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBvdXQuY2xhc3NOYW1lID0gJ2NhcmQnOwogIGNvbnN0IG9iID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7CiAgb2IuY2xhc3NOYW1lID0gJ25vJzsKICBvYi5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjEwMCU7Ym9yZGVyOm5vbmU7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6MTBweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXInOwogIG9iLnRleHRDb250ZW50ID0gJ0NoYW5nZSBhY2Nlc3MgY29kZSc7CiAgb2Iub25jbGljayA9ICgpID0+IHsKICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKExTLnRvayk7CiAgICBUT0tFTiA9ICcnOwogICAgJCgnI3RvaycpLnZhbHVlID0gJyc7CiAgICBjbG9zZVNoZWV0KCdtZW51U2hlZXQnKTsKICAgICQoJyNnYXRlJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZScpOwogIH07CiAgb3V0LmFwcGVuZENoaWxkKG9iKTsKICBiLmFwcGVuZENoaWxkKG91dCk7Cn0KCmZ1bmN0aW9uIGNsb3NlU2hlZXQoaWQpIHsgJCgnIycgKyBpZCkuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpOyB9CgovKiA9PT09PT09PT09PT09PT09PSBib290ID09PT09PT09PT09PT09PT09ICovCmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7CiAgcGFpbnRXYWtlKCk7CiAgcmVmcmVzaFBlbmRpbmcoKTsKICBpZiAoIW1pY1N1cHBvcnRlZCgpKSB7CiAgICAkKCcjbWljJykuc3R5bGUub3BhY2l0eSA9ICcuNCc7CiAgICAkKCcjd2FrZUJ0bicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgfQogIGlmICghJCgnI2xvZycpLmNoaWxkcmVuLmxlbmd0aCkgewogICAgYWRkKCduJywgIkhleSBHYXZyaWVsLiBJJ20gTm92YS4gSSBjYW4gcmVzZWFyY2ggdGhlIHdlYiwgYWN0dWFsbHkgc2VuZCBlbWFpbCwgc2NoZWR1bGUgdGFza3MgdGhhdCBydW4gb24gdGhlaXIgb3duLCBhbmQgcmVtZW1iZXIgd2hhdCBtYXR0ZXJzIHRvIHlvdS4gVGFwIHRoZSBtaWMgdG8gdGFsayDigJQgb3IgdGFwIHRoZSBlYXIgaWNvbiBhbmQgSSdsbCBzdGF5IGxpc3RlbmluZyBmb3IgXCJIZXkgTm92YVwiLiIpOwogIH0KICB0cnkgeyBIRUFMVEggPSBhd2FpdCAoYXdhaXQgZmV0Y2goJy9oZWFsdGgnKSkuanNvbigpOyB9IGNhdGNoIChlKSB7IEhFQUxUSCA9IHsgdm9pY2VSZWFkeTpmYWxzZSB9OyB9CiAgaWYgKEhFQUxUSC52b2ljZSAmJiAhSEVBTFRILnZvaWNlUmVhZHkpIHsKICAgIGFkZCgnbicsICdFbGV2ZW5MYWJzIGlzIGNvbm5lY3RlZCBidXQgbm8gdm9pY2UgaXMgY2hvc2VuIHlldC4gT3BlbiDimLAg4oaSIFBpY2sgYSB2b2ljZS4nKTsKICB9Cn0KCmlmIChUT0tFTikgYm9vdCgpOwoKaWYgKCdzZXJ2aWNlV29ya2VyJyBpbiBuYXZpZ2F0b3IpIHsKICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbG9hZCcsICgpID0+IG5hdmlnYXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCcvc3cuanMnKS5jYXRjaCgoKSA9PiB7fSkpOwp9CgppZiAod2luZG93LnZpc3VhbFZpZXdwb3J0KSB7CiAgd2luZG93LnZpc3VhbFZpZXdwb3J0LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsICgpID0+IHsKICAgICQoJyNvcmJXcmFwJykuY2xhc3NMaXN0LnRvZ2dsZSgnbWluaScsIHdpbmRvdy52aXN1YWxWaWV3cG9ydC5oZWlnaHQgPCA1MjApOwogIH0pOwp9Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K', 'base64').toString('utf8');   // UI baked in at build time
function uiHtml() {
  if (UI_HTML) return UI_HTML;
  try { return fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); }
  catch { return '<!doctype html><h1>Nova UI not found</h1>'; }
}
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(uiHtml());
});

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
  inbox: inboxReady(), tz: OWNER_TZ, browser: browserReady(),
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
  try { await sendMail(p.to, p.subject, p.body, p.headers); addContact(p.to);
    pending = pending.filter(x => x.id !== p.id); saveJSON('pending.json', pending);
    res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/reject', auth, (req, res) => { pending = pending.filter(x => x.id !== req.body.id); saveJSON('pending.json', pending); res.json({ ok: true }); });
app.get('/api/tasks', auth, (req, res) => res.json(tasks));

app.listen(PORT, () => {
  console.log(`\n✦ NOVA agent server on :${PORT}`);
  const v = !EL_KEY ? 'browser (free)' : (settings.voiceId ? 'ElevenLabs ✓' : 'ElevenLabs — pick a voice in ☰');
  console.log(`  model ${MODEL} · email ${mailer ? 'on' : 'off'} · tasks ${tasks.length} · token ${TOKEN ? 'set' : 'MISSING'} · voice ${v}`);
  console.log(`  inbox ${inboxReady() ? 'IMAP on ' + IMAP_HOST : 'off'} · tz ${OWNER_TZ}`);
  console.log(`  browse ${browserReady() ? 'cloud browser connected' : 'off (set BROWSER_WS)'}`);
  console.log(`  data  ${DATA_DIR}  (boot #${bootInfo.boots}, ${memory.facts.length} memories, ${tasks.length} tasks)`);
  if (bootInfo.boots === 1) console.log('  ⚠ first boot on this storage — if this says #1 after every deploy, the disk is NOT persisting\n');
  else console.log('');
});
