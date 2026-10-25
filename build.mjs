// Builds public topic feeds from RSS/Atom. Output: out/index.json, out/topics/<id>.json, out/state.json.
// State (seen items, ETags, og:image cache) is read back from the live site, so the repo stays commit-free.
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const SITE = process.env.SITE_URL || 'https://sybenx.github.io/topic-feeds';
const OUT = process.env.OUT_DIR || 'out';
const UA = 'topic-feeds/1 (+https://github.com/sybenx/topic-feeds)';
const SUMMARY_MAX = 280;
const FEED_ITEMS_MAX = 50; // only look at the newest N entries of a feed
const OG_FETCH_MAX = 60; // og:image page fetches per run
const VERSION = 1;

const config = JSON.parse(await readFile(new URL('./sources.json', import.meta.url)));
const D = config.defaults;
const now = Math.floor(Date.now() / 1000);

// ---------- state ----------

async function loadState() {
  if (process.env.STATE_FILE) return JSON.parse(await readFile(process.env.STATE_FILE, 'utf8'));
  try {
    const r = await fetch(`${SITE}/state.json`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (r.ok) return await r.json();
    console.log(`state: ${r.status}, starting fresh`);
  } catch (e) {
    console.log(`state: ${e.message}, starting fresh`);
  }
  return {};
}

const prev = await loadState();
const state = {
  version: VERSION,
  items: prev.version === VERSION ? prev.items || {} : {}, // key `${source}|${id}` -> item
  http: prev.http || {}, // feed url -> { etag, lastModified }
  og: prev.og || {}, // canonical url -> image url or ''
};

// ---------- text helpers ----------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function plain(html) {
  if (!html) return '';
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decode(s); // HTML escaped inside the XML
  s = s
    .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decode(decode(s)); // entities, sometimes double-escaped
  return s.replace(/\s+/g, ' ').trim();
}

function trim(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}

// Summaries that are just link boilerplate (HN, Lobsters, Stacker News) or a "continue reading" tail.
function cleanSummary(s, title) {
  s = s
    .replace(/\b(The post|This post) .{0,200} (appeared first on|was originally published) .*$/i, '')
    .replace(/\s*(Continue reading|Read more|Read the full story|Keep reading)\b.*$/i, '')
    .replace(/\s*submitted by \/u\/\S+.*$/i, '')
    .replace(/\[(…|\.\.\.|&#8230;)\]\s*$/, '…')
    .trim();
  s = s.replace(/\s*Comments$/, '');
  if (/^(comments?|article url:|submitted by)/i.test(s)) return '';
  if (s.toLowerCase() === title.toLowerCase()) return '';
  return trim(s, SUMMARY_MAX);
}

const DROP_PARAMS = /^(utm_|mc_|fbclid$|gclid$|ref$|ref_src$|source$|cmpid$|rss$|at_medium$|at_campaign$)/i;

function canonical(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.protocol = 'https:';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...url.searchParams.keys()]) if (DROP_PARAMS.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    let s = url.toString();
    if (url.pathname.length > 1 && s.endsWith('/') && !url.search) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

// The link we publish: the original, minus tracking parameters and fragment.
function cleanUrl(u) {
  const url = new URL(u);
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (DROP_PARAMS.test(k)) url.searchParams.delete(k);
  return url.toString();
}

const idOf = (canon) => createHash('sha256').update(canon).digest('hex').slice(0, 16);

const titleWords = (t) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function nearSameTitle(a, b) {
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length < 5 || b.length < 5) return false;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.8;
}

function goodImage(u, base) {
  if (!u) return null;
  try {
    const url = new URL(decode(String(u).trim()), base);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/\.(svg|gif)(\?|$)/i.test(url.pathname) || /pixel|tracking|feedburner|gravatar|emoji/i.test(url.href)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

// ---------- feed parsing ----------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: false, // the parser's entity limit trips on busy feeds; plain()/decode() handle entities
  htmlEntities: false,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'link', 'media:content', 'media:thumbnail', 'enclosure', 'category'].includes(name),
});

const text = (v) => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));
const first = (v) => (Array.isArray(v) ? v[0] : v);

function parseDate(v) {
  const s = text(first(v)).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function entryLink(e) {
  return decode(rawLink(e) || '').trim();
}

function rawLink(e) {
  if (e.link == null) return text(e.guid);
  for (const l of e.link) {
    if (typeof l !== 'object') return l;
    if (l['@href'] && (!l['@rel'] || l['@rel'] === 'alternate')) return l['@href'];
    if (!l['@href'] && text(l)) return text(l);
  }
  return e.link[0]?.['@href'] || '';
}

function entryImage(e, html, base) {
  const candidates = [];
  for (const m of [...(e['media:content'] || []), ...(e['media:group']?.['media:content'] || [])])
    if (!m['@medium'] || m['@medium'] === 'image' || /^image\//.test(m['@type'] || '')) candidates.push(m['@url']);
  for (const m of [...(e['media:thumbnail'] || []), ...(e['media:group']?.['media:thumbnail'] || [])]) candidates.push(m['@url']);
  for (const enc of e.enclosure || []) if (/^image\//.test(enc['@type'] || '')) candidates.push(enc['@url']);
  if (e.image) candidates.push(text(e.image.url ?? e.image));
  if (/&lt;img/i.test(html)) html = decode(html);
  const img = html.match(/<img[^>]+?src=["']([^"']+)["']/i);
  if (img) candidates.push(img[1]);
  for (const c of candidates) {
    const g = goodImage(c, base);
    if (g) return g;
  }
  return null;
}

function parseFeed(xml, src) {
  const doc = parser.parse(xml);
  const entries = doc.rss?.channel?.item || doc['rdf:RDF']?.item || doc.feed?.entry || [];
  const out = [];
  entries.slice(0, FEED_ITEMS_MAX).forEach((e, rank) => {
    const title = trim(plain(text(e.title)), 200);
    const link = entryLink(e);
    const canon = canonical(link);
    if (!title || !canon) return;
    const rich = text(e['content:encoded']) || text(e.content) || '';
    const desc = text(e.description) || text(e.summary) || text(e['media:group']?.['media:description']) || '';
    // Summary only from the short description. Fall back to the start of the body, trimmed hard; never the full text.
    const summary = cleanSummary(plain(desc || rich), title);
    const comments = decode(text(first(e.comments))).trim();
    const discussion = comments && canonical(comments) !== canon ? comments : null;
    out.push({
      rank,
      id: idOf(canon),
      url: cleanUrl(link),
      canon,
      title,
      summary,
      image: entryImage(e, rich + desc, link),
      published_at: parseDate(e.pubDate ?? e.published ?? e['dc:date'] ?? e.updated),
      discussion,
    });
  });
  return out;
}

// ---------- fetching ----------

async function fetchText(url, headers = {}, ms = 20000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  return r;
}

async function fetchSource(topic, src) {
  const h = state.http[src.feed] || {};
  // Slow or touchy sources (Reddit) are fetched every few hours; their items stay in the pool meanwhile.
  if (src.everyHours && h.fetchedAt && now - h.fetchedAt < src.everyHours * 3600 - 300) return { status: 'skip', entries: null, ms: 0 };
  const headers = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' };
  if (h.etag) headers['if-none-match'] = h.etag;
  if (h.lastModified) headers['if-modified-since'] = h.lastModified;
  const t0 = Date.now();
  try {
    let r = await fetchText(src.feed, headers).catch(() => null);
    if (!r || r.status >= 500) {
      await new Promise((ok) => setTimeout(ok, 3000));
      r = await fetchText(src.feed, headers);
    }
    if (r.status === 304) {
      state.http[src.feed] = { ...h, fetchedAt: now };
      return { status: 304, entries: null, ms: Date.now() - t0 };
    }
    if (!r.ok) return { status: r.status, error: `HTTP ${r.status}`, ms: Date.now() - t0 };
    const xml = await r.text();
    const entries = parseFeed(xml, src);
    if (!entries.length) return { status: r.status, error: 'no entries', ms: Date.now() - t0 };
    state.http[src.feed] = { etag: r.headers.get('etag') || undefined, lastModified: r.headers.get('last-modified') || undefined, fetchedAt: now };
    return { status: r.status, entries, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message, ms: Date.now() - t0 };
  }
}

async function pool(list, n, fn) {
  const res = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < list.length) {
      const k = i++;
      res[k] = await fn(list[k]);
    }
  }));
  return res;
}

async function ogImage(url) {
  try {
    const r = await fetchText(url, { accept: 'text/html' }, 8000);
    if (!r.ok || !/html/.test(r.headers.get('content-type') || '')) return '';
    // Read only the head of the page.
    const reader = r.body.getReader();
    let html = '';
    const dec = new TextDecoder();
    while (html.length < 120000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/i);
    const c = m && m[0].match(/content=["']([^"']+)["']/i);
    return goodImage(c?.[1], url) || '';
  } catch {
    return '';
  }
}

// ---------- main ----------

const jobs = config.topics.flatMap((t) => t.sources.map((s) => ({ topic: t, src: s })));
const results = await pool(jobs, 8, ({ topic, src }) => fetchSource(topic, src));

const report = [];
jobs.forEach(({ topic, src }, k) => {
  const r = results[k];
  report.push({ topic: topic.id, source: src.id, status: r.status, error: r.error || null, items: r.entries?.length ?? null, ms: r.ms });
  if (!r.entries) return;
  const windowH = src.windowHours ?? topic.windowHours ?? D.windowHours;
  for (const e of r.entries) {
    const key = `${src.id}|${e.id}`;
    const old = state.items[key];
    const first_seen = old?.first_seen ?? now;
    let published_at = e.published_at ?? old?.published_at ?? first_seen;
    if (published_at > now + 600) published_at = first_seen; // future dates
    if (published_at < now - windowH * 3600) continue;
    state.items[key] = {
      ...e,
      image: e.image || old?.image || null,
      topic: topic.id,
      source: src.id,
      published_at,
      first_seen,
      rank: old ? old.rank : e.rank,
    };
  }
});

// Drop items outside their window.
const sourceById = Object.fromEntries(jobs.map(({ topic, src }) => [src.id, { topic, src }]));
for (const [key, it] of Object.entries(state.items)) {
  const j = sourceById[it.source];
  const windowH = j ? (j.src.windowHours ?? j.topic.windowHours ?? D.windowHours) : 0;
  if (!j || it.published_at < now - windowH * 3600) delete state.items[key];
}

const day = (t) => Math.floor(t / 86400);

function select(topic) {
  const perTopicDay = topic.perTopicPerDay ?? D.perTopicPerDay;
  const maxItems = topic.maxItems ?? D.maxItems;
  const cands = Object.values(state.items)
    .filter((it) => it.topic === topic.id)
    .sort((a, b) => a.first_seen - b.first_seen || a.rank - b.rank || b.published_at - a.published_at);
  const kept = [], seenUrl = new Set(), titles = [], srcDay = {}, topicDay = {};
  for (const it of cands) {
    if (seenUrl.has(it.canon)) continue;
    const words = titleWords(it.title);
    if (titles.some((w) => nearSameTitle(w, words))) continue;
    const src = sourceById[it.source].src;
    const sd = `${it.source}|${day(it.published_at)}`, td = day(it.published_at);
    if ((srcDay[sd] || 0) >= (src.perSourcePerDay ?? topic.perSourcePerDay ?? D.perSourcePerDay)) continue;
    if ((topicDay[td] || 0) >= perTopicDay) continue;
    srcDay[sd] = (srcDay[sd] || 0) + 1;
    topicDay[td] = (topicDay[td] || 0) + 1;
    seenUrl.add(it.canon);
    titles.push(words);
    kept.push(it);
  }
  return kept.sort((a, b) => b.published_at - a.published_at).slice(0, maxItems);
}

const selected = Object.fromEntries(config.topics.map((t) => [t.id, select(t)]));

// og:image for selected items that have none, cached across runs.
const needOg = [...new Set(Object.values(selected).flat().filter((it) => !it.image && !(it.canon in state.og)).map((it) => it.canon))].slice(0, OG_FETCH_MAX);
const ogUrls = Object.fromEntries(Object.values(selected).flat().map((it) => [it.canon, it.url]));
const ogRes = await pool(needOg, 6, (c) => ogImage(ogUrls[c]));
needOg.forEach((c, k) => (state.og[c] = ogRes[k]));
const live = new Set(Object.values(state.items).map((it) => it.canon));
for (const c of Object.keys(state.og)) if (!live.has(c)) delete state.og[c];

const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

function card(it, topic) {
  const { src } = sourceById[it.source];
  return {
    id: it.id,
    url: it.url,
    title: it.title,
    summary: it.summary || null,
    image: it.image || state.og[it.canon] || null,
    source: { id: src.id, name: src.name, home: src.home },
    published_at: it.published_at,
    published: iso(it.published_at),
    first_seen: it.first_seen,
    discussion: it.discussion || null,
    topic: topic.id,
  };
}

await mkdir(`${OUT}/topics`, { recursive: true });
const index = { version: VERSION, generated_at: now, generated: iso(now), site: SITE, topics: [] };
for (const t of config.topics) {
  const items = selected[t.id].map((it) => card(it, t));
  const windowHours = Math.max(t.windowHours ?? D.windowHours, ...t.sources.map((s) => s.windowHours ?? D.windowHours));
  await writeFile(`${OUT}/topics/${t.id}.json`, JSON.stringify({ version: VERSION, generated_at: now, topic: { id: t.id, name: t.name }, window_hours: windowHours, items }, null, 1));
  index.topics.push({
    id: t.id,
    name: t.name,
    url: `${SITE}/topics/${t.id}.json`,
    count: items.length,
    newest_at: items[0]?.published_at ?? null,
    sources: t.sources.map((s) => {
      const r = report.find((x) => x.source === s.id);
      return { id: s.id, name: s.name, home: s.home, ok: !r.error };
    }),
  });
}
await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));
await writeFile(`${OUT}/state.json`, JSON.stringify(state));
await writeFile(`${OUT}/report.json`, JSON.stringify({ generated_at: now, sources: report }, null, 1));

for (const r of report) if (r.error) console.log(`FAIL ${r.topic}/${r.source}: ${r.error}`);
console.log(index.topics.map((t) => `${t.id}=${t.count}`).join(' '));
console.log(`pool ${Object.keys(state.items).length} items, og fetched ${needOg.length}`);
