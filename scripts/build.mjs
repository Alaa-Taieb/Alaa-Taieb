#!/usr/bin/env node
// Regenerates the profile README artwork from live GitHub, npm and PyPI data.
//
//   node scripts/build.mjs            fetch fresh data, then render every SVG
//   node scripts/build.mjs --offline  render from the cached data/profile.json
//
// Needs the gh CLI (logged in as the profile owner, for private-repo totals and
// traffic) and Python with fontTools (to embed subset Geist fonts in each SVG).
// GitHub Actions is not used: run this locally whenever the numbers should move.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'Alaa-Taieb';
const DATA_FILE = path.join(ROOT, 'data', 'profile.json');
const FONT_TOOL = path.join(ROOT, 'scripts', 'fonttool.py');
const PYTHON = process.env.PYTHON || 'python';

// Facts that no API knows. Edit these by hand.
const FACTS = {
  lectures: '200+',
  // Centre of Djerba island (33.77°N, 10.90°E) in the map-tunisia frame:
  // x = easting/1000 - 351, y = 4170 - northing/1000 (UTM 32N, 1 unit = 1 km).
  djerba: { x: 324.5, y: 432, label: '33.77°N · 10.90°E' },
};

// ---------------------------------------------------------------- data ----

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const ghJson = (args) => JSON.parse(gh(args));
const graphql = (query) => ghJson(['api', 'graphql', '-f', `query=${query}`]).data.user;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function fetchData() {
  const user = ghJson(['api', `users/${USER}`]);
  const repos = ghJson([
    'repo', 'list', USER, '--limit', '400', '--source',
    '--json', 'name,isPrivate,stargazerCount,forkCount,primaryLanguage,pushedAt,createdAt',
  ]).map((r) => ({
    name: r.name,
    private: r.isPrivate,
    stars: r.stargazerCount,
    forks: r.forkCount,
    language: r.primaryLanguage?.name ?? null,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
  }));

  const languages = {};
  for (const r of repos) {
    process.stdout.write(`\r  languages ${r.name.padEnd(48)}`);
    for (const [lang, bytes] of Object.entries(ghJson(['api', `repos/${USER}/${r.name}/languages`]))) {
      languages[lang] = (languages[lang] ?? 0) + bytes;
    }
  }
  process.stdout.write('\n');

  const contributionsByYear = {};
  const now = new Date();
  for (let y = new Date(user.created_at).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    contributionsByYear[y] = graphql(
      `query{user(login:"${USER}"){contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${y}-12-31T23:59:59Z"){contributionCalendar{totalContributions}}}}`,
    ).contributionsCollection.contributionCalendar.totalContributions;
  }
  const calendar = graphql(
    `query{user(login:"${USER}"){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`,
  ).contributionsCollection.contributionCalendar;

  const mapStars = gh([
    'api', '--paginate', '-H', 'Accept: application/vnd.github.star+json',
    `repos/${USER}/map-tunisia/stargazers?per_page=100`, '--jq', '.[].starred_at',
  ]).trim().split('\n').filter(Boolean);

  let mapViews = null;
  try {
    mapViews = ghJson(['api', `repos/${USER}/map-tunisia/traffic/views`]);
  } catch {
    console.warn('  traffic: unavailable (needs push access), skipping');
  }

  const npm = await getJson('https://api.npmjs.org/downloads/range/last-year/tunisia-kit');
  const pypi = await getJson('https://pypistats.org/api/packages/agentic-std/recent');

  // This file is public. Private repositories appear only as totals, except the
  // ones the README names on purpose.
  const shown = new Set(['map-tunisia', ...PROJECTS.map((p) => p.repo), ...WORKSHOP.map((w) => w.repo)]);
  return {
    generatedAt: now.toISOString(),
    user: { publicRepos: user.public_repos, followers: user.followers, createdAt: user.created_at },
    repoCount: repos.length,
    repos: repos.filter((r) => shown.has(r.name)),
    languages,
    contributions: {
      byYear: contributionsByYear,
      lastYear: calendar.totalContributions,
      days: calendar.weeks.flatMap((w) => w.contributionDays).map((d) => [d.date, d.contributionCount]),
    },
    mapTunisia: { stars: mapStars, views14d: mapViews && { count: mapViews.count, uniques: mapViews.uniques } },
    npm: { package: 'tunisia-kit', days: npm.downloads.map((d) => [d.day, d.downloads]) },
    pypi: { package: 'agentic-std', lastMonth: pypi.data.last_month },
  };
}

// ------------------------------------------------------------- metrics ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n) => n.toLocaleString('en-US');
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

function metrics(data) {
  const repo = Object.fromEntries(data.repos.map((r) => [r.name, r]));
  const now = new Date(data.generatedAt);

  // Map Tunisia: stars since launch.
  const mt = repo['map-tunisia'];
  const launchDays = Math.floor((now - new Date(mt.createdAt)) / 864e5) + 1;
  const launchedWhen = launchDays <= 60
    ? `in its first ${launchDays} days`
    : `since ${MONTHS[new Date(mt.createdAt).getUTCMonth()]} ${new Date(mt.createdAt).getUTCFullYear()}`;

  // Contributions: 12 calendar months ending with the current one.
  const days = data.contributions.days;
  const monthly = new Map();
  for (const [date, n] of days) monthly.set(date.slice(0, 7), (monthly.get(date.slice(0, 7)) ?? 0) + n);
  const months = [...monthly.entries()].slice(-12).map(([key, n]) => ({
    key, n, label: MONTHS[Number(key.slice(5)) - 1], year: key.slice(0, 4),
  }));
  const best = days.reduce((a, b) => (b[1] > a[1] ? b : a));
  let longest = 0;
  let run = 0;
  for (const [, n] of days) { run = n > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  // Today may still be empty; a streak survives until a full day passes.
  let current = 0;
  const trail = [...days].reverse();
  if (trail[0] && trail[0][1] === 0) trail.shift();
  for (const [, n] of trail) { if (n > 0) current++; else break; }

  // Languages by bytes.
  const total = Object.values(data.languages).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(data.languages).sort((a, b) => b[1] - a[1]);
  const topLangs = ranked.slice(0, 7).map(([name, bytes]) => ({ name, share: bytes / total }));
  const otherShare = ranked.slice(7).reduce((a, [, b]) => a + b, 0) / total;
  topLangs.push({ name: 'Other', share: otherShare, count: ranked.length - 7 });

  // npm downloads per month.
  const npmMonthly = new Map();
  for (const [day, n] of data.npm.days) npmMonthly.set(day.slice(0, 7), (npmMonthly.get(day.slice(0, 7)) ?? 0) + n);

  return {
    repo,
    repoCount: data.repoCount,
    mapTunisia: {
      stars: mt.stars, forks: mt.forks, launchedWhen,
      views: data.mapTunisia.views14d?.count ?? null,
    },
    contributions: {
      lastYear: data.contributions.lastYear,
      thisYear: data.contributions.byYear[now.getUTCFullYear()],
      allTime: Object.values(data.contributions.byYear).reduce((a, b) => a + b, 0),
      months, best: { date: best[0], n: best[1] }, longest, current,
    },
    languages: { total, top: topLangs, count: ranked.length },
    npm: {
      total: data.npm.days.reduce((a, [, n]) => a + n, 0),
      monthly: [...npmMonthly.values()].slice(-12),
    },
    pypiLastMonth: data.pypi.lastMonth,
  };
}

// --------------------------------------------------------------- fonts ----

const FACES = {
  sans400: { file: 'Geist-Regular.ttf', family: 'GeistR', fallback: 'sans' },
  sans500: { file: 'Geist-Medium.ttf', family: 'GeistM', fallback: 'sans' },
  sans600: { file: 'Geist-SemiBold.ttf', family: 'GeistS', fallback: 'sans' },
  mono400: { file: 'GeistMono-Regular.ttf', family: 'GeistMonoR', fallback: 'mono' },
  mono500: { file: 'GeistMono-Medium.ttf', family: 'GeistMonoM', fallback: 'mono' },
};
const FALLBACK = {
  sans: "'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif",
  mono: 'ui-monospace,SFMono-Regular,Consolas,Menlo,monospace',
};
const fontFile = (face) => path.join(ROOT, 'scripts', 'fonts', FACES[face].file);

const WIDTHS = {};
for (const face of Object.keys(FACES)) {
  WIDTHS[face] = JSON.parse(execFileSync(PYTHON, [FONT_TOOL, 'widths', fontFile(face)], { encoding: 'utf8' }));
}

function measure(str, face, size, ls = 0) {
  let w = 0;
  for (const ch of str) w += WIDTHS[face][ch] ?? 0.6;
  return w * size + ls * Math.max(0, [...str].length - 1);
}

function wrap(str, face, size, max) {
  const lines = [];
  let line = '';
  for (const word of str.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, face, size) > max) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const subsetCache = new Map();
function fontFaceCss(face, chars) {
  const text = [...new Set(chars)].sort().join('');
  const key = `${face}:${text}`;
  if (!subsetCache.has(key)) {
    const b64 = execFileSync(PYTHON, [FONT_TOOL, 'subset', fontFile(face)], { input: text, encoding: 'utf8' }).trim();
    subsetCache.set(key, `@font-face{font-family:${FACES[face].family};src:url(data:font/woff;base64,${b64}) format('woff')}`);
  }
  return subsetCache.get(key);
}

// ---------------------------------------------------------------- theme ----

const THEMES = {
  dark: {
    name: 'dark', card: '#0F141B', raised: '#141B24', line: '#232C38', grid: '#1B232D',
    fg: '#E8EDF2', fg2: '#A6B0BB', fg3: '#7A8794',
    accent: '#F23A4B', data: '#25A08D', good: '#3FB950',
    land: '#1E2833', landHi: '#3A2027', border: '#0F141B',
  },
  light: {
    name: 'light', card: '#FCFBF9', raised: '#F5F2EC', line: '#E4DFD6', grid: '#EEEAE3',
    fg: '#1B1F24', fg2: '#55606B', fg3: '#6E7781',
    accent: '#D3091C', data: '#0E8C7B', good: '#1A7F37',
    land: '#E6E0D5', landHi: '#F6D5D3', border: '#FCFBF9',
  },
};

const CSS = `
text{font-kerning:normal;font-variant-numeric:tabular-nums}
.rise{animation:rise .8s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.fade{animation:fade 1.2s ease both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.draw{stroke-dasharray:1;animation:draw 2.6s cubic-bezier(.45,.05,.25,1) both,fill .9s ease 1.5s both}
@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes fill{from{fill-opacity:0}to{fill-opacity:1}}
.blink{animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.6s cubic-bezier(.2,.6,.3,1) infinite}
@keyframes pulse{from{transform:scale(1);opacity:.55}to{transform:scale(5);opacity:0}}
.grow{transform-box:fill-box;transform-origin:50% 100%;animation:grow 1s cubic-bezier(.2,.7,.2,1) both}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.growx{transform-box:fill-box;transform-origin:0 50%;animation:growx 1s cubic-bezier(.2,.7,.2,1) both}
@keyframes growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.trace{stroke-dasharray:1;animation:draw 1.8s ease-out .3s both}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;

// A document collects the characters each font face renders so the embedded
// fonts hold only those glyphs.
class Doc {
  constructor(T) { this.T = T; this.chars = {}; }

  text(x, y, str, o = {}) {
    const face = o.face ?? 'sans400';
    const size = o.size ?? 14;
    (this.chars[face] ??= []).push(...str);
    const { family, fallback } = FACES[face];
    const attrs = [
      `x="${r1(x)}"`, `y="${r1(y)}"`,
      `font-family="${family},${FALLBACK[fallback].replace(/"/g, "'")}"`,
      `font-size="${size}"`, `fill="${o.fill ?? this.T.fg}"`,
      o.anchor ? `text-anchor="${o.anchor}"` : '',
      o.ls ? `letter-spacing="${o.ls}"` : '',
      o.opacity ? `opacity="${o.opacity}"` : '',
    ].filter(Boolean).join(' ');
    return `<text ${attrs}>${esc(str)}</text>`;
  }

  // Shrinks the font until the string fits in `max` pixels.
  fit(x, y, str, max, o = {}) {
    let size = o.size ?? 14;
    while (size > 8 && measure(str, o.face ?? 'sans400', size, o.ls ?? 0) > max) size -= 0.5;
    return this.text(x, y, str, { ...o, size });
  }

  render({ w, h, title, desc }, body) {
    const faces = Object.entries(this.chars).map(([face, chars]) => fontFaceCss(face, chars)).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<style>${faces}${CSS}</style>
${body}
</svg>
`;
  }
}

const card = (T, w, h, extra = '') =>
  `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="16" fill="${T.card}" stroke="${T.line}"${extra}/>`;

const star = (x, y, s, fill) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? s * 0.42 : s;
    pts.push(`${r1(x + r * Math.cos(a))},${r1(y + r * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${fill}" stroke-width="1" stroke-linejoin="round"/>`;
};

// Header used by the full-width panels: title, subtitle, optional headline number.
function header(doc, w, { title, sub, number, numberLabel }) {
  const T = doc.T;
  // Without a title (the README heading already names the panel) the subtitle moves up.
  let out = title ? doc.text(28, 44, title, { face: 'sans600', size: 18, ls: -0.2 }) : '';
  const subMax = number ? w - 28 - 220 : w - 56;
  wrap(sub, 'sans400', 13, subMax).forEach((line, i) => {
    out += doc.text(28, (title ? 68 : 40) + i * 19, line, { size: 13, fill: T.fg2 });
  });
  if (number) {
    out += doc.text(w - 28, 48, number, { face: 'sans600', size: 30, anchor: 'end', ls: -0.8 });
    out += doc.text(w - 28, 68, numberLabel, { face: 'mono400', size: 11, anchor: 'end', fill: T.fg3 });
  }
  return out;
}

// ------------------------------------------------------------------ map ----

function loadMap(file) {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'map', file), 'utf8');
  return [...src.matchAll(/<path\b([^>]*)>/g)].map(([, attrs]) => {
    const a = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    return { id: a.id, name: a['data-name-en'], d: a.d };
  });
}

const MAPS = {
  hero: loadMap('tunisia-governorates-low-plain.svg'),
  country: loadMap('tunisia-country-tiny-plain.svg'),
  districts: loadMap('tunisia-districts-tiny-plain.svg'),
  regions: loadMap('tunisia-regions-tiny-plain.svg'),
  governorates: loadMap('tunisia-governorates-tiny-plain.svg'),
};
const MAP_W = 406;
const MAP_H = 838;

// ---------------------------------------------------------------- hero -----

function hero(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const H = 400;
  const s = 344 / MAP_H;
  const mx = 604;
  const my = 22;
  const pin = { x: mx + FACTS.djerba.x * s, y: my + FACTS.djerba.y * s };

  const governorates = MAPS.hero.map((g, i) => {
    const hi = g.id === 'TN-82';
    return `<path d="${g.d}" pathLength="1" class="draw" style="animation-delay:${(i * 0.04).toFixed(2)}s,${(1.4 + i * 0.03).toFixed(2)}s" fill="${hi ? T.landHi : T.land}" stroke="${hi ? T.accent : T.fg3}" stroke-opacity="${hi ? 0.9 : 0.55}" stroke-width="${(0.9 / s).toFixed(2)}" stroke-linejoin="round"/>`;
  }).join('\n');

  let left = '';
  left += `<g class="rise">${doc.text(48, 72, '~/djerba', { face: 'mono500', size: 13, fill: T.accent })}${doc.text(48 + measure('~/djerba ', 'mono500', 13), 72, '$ whoami', { face: 'mono400', size: 13, fill: T.fg3 })}<rect class="blink" x="${r1(48 + measure('~/djerba $ whoami ', 'mono400', 13))}" y="61" width="7" height="14" rx="1" fill="${T.fg3}"/></g>`;
  left += `<g class="rise" style="animation-delay:.12s">${doc.text(46, 138, 'Alaa Taieb', { face: 'sans600', size: 58, ls: -2.2 })}</g>`;
  left += `<g class="rise" style="animation-delay:.24s">${doc.text(48, 182, 'Full-stack developer for products', { face: 'sans500', size: 24, ls: -0.5 })}${doc.text(48, 212, 'that need to just work.', { face: 'sans500', size: 24, ls: -0.5, fill: T.fg2 })}</g>`;
  const bio = 'I build open-source infrastructure for Tunisian developers, products for local businesses, and local-first tools for AI agents.';
  left += `<g class="rise" style="animation-delay:.36s">${wrap(bio, 'sans400', 15, 500).map((l, i) => doc.text(48, 256 + i * 23, l, { size: 15, fill: T.fg2 })).join('')}</g>`;

  // Meta row: availability, place, languages.
  let x = 48;
  const metaY = 344;
  let meta = `<circle cx="${x + 4}" cy="${metaY - 4}" r="4" fill="${T.good}"/><circle class="pulse" cx="${x + 4}" cy="${metaY - 4}" r="4" fill="${T.good}"/>`;
  const items = ['Open for freelance & contract', 'Djerba, Tunisia · GMT+1', 'Arabic · English · French'];
  x += 16;
  items.forEach((item, i) => {
    meta += doc.text(x, metaY, item, { face: 'mono400', size: 12, fill: i === 0 ? T.fg : T.fg2 });
    x += measure(item, 'mono400', 12);
    if (i < items.length - 1) {
      meta += `<rect x="${r1(x + 12)}" y="${metaY - 10}" width="1" height="12" fill="${T.line}"/>`;
      x += 25;
    }
  });
  left += `<g class="rise" style="animation-delay:.48s">${meta}</g>`;

  const label = `<g class="rise" style="animation-delay:2.2s">
<path d="M${r1(pin.x + 7)} ${r1(pin.y)}H${r1(pin.x + 26)}" stroke="${T.fg3}" stroke-width="1"/>
${doc.text(pin.x + 32, pin.y + 1, 'Djerba', { face: 'sans600', size: 14 })}
${doc.text(pin.x + 32, pin.y + 17, FACTS.djerba.label, { face: 'mono400', size: 10, fill: T.fg3 })}
${doc.text(pin.x + 32, pin.y - 15, 'home', { face: 'mono400', size: 10, fill: T.fg3 })}
</g>`;

  const body = `<defs>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${T.fg3}" fill-opacity="${T.name === 'dark' ? 0.16 : 0.22}"/></pattern>
<radialGradient id="glow" cx="${r1(pin.x)}" cy="${r1(pin.y)}" r="300" gradientUnits="userSpaceOnUse"><stop stop-color="${T.accent}" stop-opacity="${T.name === 'dark' ? 0.16 : 0.09}"/><stop offset="1" stop-color="${T.accent}" stop-opacity="0"/></radialGradient>
<linearGradient id="fadeL" x1="0" x2="1"><stop offset=".35" stop-color="${T.card}"/><stop offset=".62" stop-color="${T.card}" stop-opacity="0"/></linearGradient>
<clipPath id="clip"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="15.5"/></clipPath>
</defs>
${card(T, W, H)}
<g clip-path="url(#clip)">
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#fadeL)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
</g>
<g transform="translate(${mx} ${my}) scale(${s.toFixed(5)})">
${governorates}
</g>
<g class="fade" style="animation-delay:2s"><circle class="pulse" cx="${r1(pin.x)}" cy="${r1(pin.y)}" r="4.5" fill="${T.accent}"/><circle cx="${r1(pin.x)}" cy="${r1(pin.y)}" r="4.5" fill="${T.accent}" stroke="${T.card}" stroke-width="2"/></g>
${label}
${left}
<g class="fade" style="animation-delay:2.4s">${doc.text(mx + (MAP_W * s) / 2, H - 16, 'drawn with map-tunisia · © OpenStreetMap contributors', { face: 'mono400', size: 9.5, fill: T.fg3, anchor: 'middle' })}</g>`;

  return doc.render({
    w: W, h: H,
    title: 'Alaa Taieb, full-stack developer in Djerba, Tunisia',
    desc: `Alaa Taieb. Full-stack developer for products that need to just work. ${bio} Open for freelance and contract work. Based in Djerba, Tunisia (GMT+1); speaks Arabic, English and French. The map of Tunisia's 24 governorates is drawn from Map Tunisia, with a pin on Djerba.`,
  }, body);
}

// --------------------------------------------------------------- stats -----

function stats(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const H = 132;
  const gap = 14;
  const tw = (W - gap * 3) / 4;
  const c = m.contributions;
  const tiles = [
    { label: 'Map Tunisia stars', value: fmt(m.mapTunisia.stars), sub: m.mapTunisia.launchedWhen, star: true },
    { label: 'npm downloads', value: fmt(m.npm.total), sub: 'tunisia-kit · last 12 months' },
    { label: 'Contributions', value: fmt(c.lastYear), sub: `last 12 months · ${c.current}-day streak` },
    { label: 'Lectures taught', value: FACTS.lectures, sub: 'full-stack at Coding Dojo' },
  ];
  const body = tiles.map((t, i) => {
    const x = i * (tw + gap);
    let g = `<rect x="${r1(x + 0.5)}" y=".5" width="${r1(tw - 1)}" height="${H - 1}" rx="14" fill="${T.card}" stroke="${T.line}"/>`;
    g += doc.text(x + 20, 34, t.label, { face: 'sans500', size: 13, fill: T.fg2 });
    g += doc.text(x + 19, 82, t.value, { face: 'sans600', size: 40, ls: -1.4 });
    if (t.star) g += star(x + 26 + measure(t.value, 'sans600', 40, -1.4), 58, 8, T.accent);
    g += doc.fit(x + 20, 108, t.sub, tw - 40, { face: 'mono400', size: 11, fill: T.fg3 });
    return `<g class="rise" style="animation-delay:${(i * 0.1).toFixed(1)}s">${g}</g>`;
  }).join('\n');
  return doc.render({
    w: W, h: H,
    title: 'Headline numbers',
    desc: tiles.map((t) => `${t.label}: ${t.value} (${t.sub})`).join('. '),
  }, body);
}

// ------------------------------------------------------------- activity ----

function niceMax(v) {
  const step = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * step >= v) return k * step;
  return 10 * step;
}

function activity(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const H = 330;
  const c = m.contributions;
  const x0 = 72;
  const x1 = W - 28;
  const top = 116;
  const base = 262;
  const max = niceMax(Math.max(...c.months.map((d) => d.n)));
  const y = (v) => base - (v / max) * (base - top);
  const band = (x1 - x0) / c.months.length;
  const bw = Math.min(34, band * 0.52);

  let body = card(T, W, H);
  body += header(doc, W, {
    title: 'Shipping cadence',
    sub: 'Contributions per month on GitHub. Most of them land in private client and product repositories, so the public repo list shows only part of the work.',
    number: fmt(c.lastYear),
    numberLabel: 'contributions, last 12 months',
  });

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    body += `<path d="M${x0} ${r1(y(v))}H${x1}" stroke="${i === 0 ? T.fg3 : T.grid}" stroke-width="1"${i === 0 ? ` stroke-opacity=".6"` : ''}/>`;
    body += doc.text(x0 - 12, y(v) + 3.5, fmt(v), { face: 'mono400', size: 10, fill: T.fg3, anchor: 'end' });
  }

  const peak = c.months.reduce((a, b) => (b.n > a.n ? b : a));
  const last = c.months[c.months.length - 1];
  c.months.forEach((d, i) => {
    const cx = x0 + band * (i + 0.5);
    const yt = y(d.n);
    const h = base - yt;
    const rr = Math.min(4, h);
    if (d.n > 0) {
      body += `<path class="grow" style="animation-delay:${(0.2 + i * 0.05).toFixed(2)}s" d="M${r1(cx - bw / 2)} ${base}V${r1(yt + rr)}Q${r1(cx - bw / 2)} ${r1(yt)} ${r1(cx - bw / 2 + rr)} ${r1(yt)}H${r1(cx + bw / 2 - rr)}Q${r1(cx + bw / 2)} ${r1(yt)} ${r1(cx + bw / 2)} ${r1(yt + rr)}V${base}Z" fill="${T.data}"${d === last ? ` fill-opacity=".55"` : ''}><title>${d.label} ${d.year}: ${fmt(d.n)}</title></path>`;
    }
    body += doc.text(cx, base + 18, d.label, { face: 'mono400', size: 10.5, fill: T.fg3, anchor: 'middle' });
    if (i === 0 || d.label === 'Jan') body += doc.text(cx, base + 32, d.year, { face: 'mono400', size: 9.5, fill: T.fg3, anchor: 'middle', opacity: 0.8 });
    if (d === peak || d === last) {
      body += `<g class="fade" style="animation-delay:1.1s">${doc.text(cx, yt - 9, fmt(d.n), { face: 'sans600', size: 12.5, anchor: 'middle' })}</g>`;
      if (d === last && d !== peak) body += `<g class="fade" style="animation-delay:1.1s">${doc.text(cx, yt - 23, 'to date', { face: 'mono400', size: 9.5, anchor: 'middle', fill: T.fg3 })}</g>`;
    }
  });

  const years = Object.entries(m.yearsShown).map(([yr, n]) => `${yr} ${fmt(n)}`).join('  ·  ');
  body += doc.text(28, H - 16, `Best day ${fmt(c.best.n)} on ${shortDate(c.best.date)}, ${c.best.date.slice(0, 4)}  ·  longest streak ${c.longest} days`, { face: 'mono400', size: 10.5, fill: T.fg2 });
  body += doc.text(W - 28, H - 16, years, { face: 'mono400', size: 10.5, fill: T.fg3, anchor: 'end' });

  return doc.render({
    w: W, h: H,
    title: 'Contributions per month, last 12 months',
    desc: `${fmt(c.lastYear)} contributions in the last 12 months. ${c.months.map((d) => `${d.label} ${d.year}: ${d.n}`).join(', ')}. Best day: ${c.best.n} on ${c.best.date}. Longest streak: ${c.longest} days. By year: ${years}.`,
  }, body);
}

// ------------------------------------------------------------ languages ----

function languages(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const H = 252;
  const L = m.languages;
  const max = Math.max(...L.top.map((l) => l.share));
  const colW = (W - 56 - 40) / 2;
  const nameW = 112;
  const barMax = colW - nameW - 60;
  const mb = L.total / 1e6;

  let body = card(T, W, H);
  body += header(doc, W, {
    title: 'What I write',
    sub: `Share of code by bytes across all ${m.repoCount} of my repositories, public and private, as counted by GitHub Linguist.`,
    number: `${mb.toFixed(1)} MB`,
    numberLabel: `of code in ${L.count} languages`,
  });

  L.top.forEach((l, i) => {
    const col = i < 4 ? 0 : 1;
    const row = i % 4;
    const x = 28 + col * (colW + 40);
    const y = 124 + row * 32;
    const bw = Math.max(3, (l.share / max) * barMax);
    const pct = l.share >= 0.01 ? `${(l.share * 100).toFixed(1)}%` : `${(l.share * 100).toFixed(2)}%`;
    const name = l.name === 'Other' ? `Other (${l.count})` : l.name;
    body += doc.text(x, y + 4, String(i + 1).padStart(2, '0'), { face: 'mono400', size: 10.5, fill: T.fg3 });
    body += doc.text(x + 26, y + 4.5, name, { face: 'sans500', size: 13.5 });
    body += `<rect class="growx" style="animation-delay:${(0.2 + i * 0.06).toFixed(2)}s" x="${x + nameW}" y="${y - 7}" width="${r1(bw)}" height="14" rx="4" fill="${T.data}"${l.name === 'Other' ? ` fill-opacity=".45"` : ''}><title>${esc(name)}: ${pct}</title></rect>`;
    body += doc.text(x + nameW + bw + 10, y + 4, pct, { face: 'mono400', size: 11.5, fill: T.fg2 });
  });

  return doc.render({
    w: W, h: H,
    title: 'Languages by bytes of code',
    desc: `${mb.toFixed(1)} MB of code across ${m.repoCount} repositories. ${L.top.map((l) => `${l.name}: ${(l.share * 100).toFixed(1)}%`).join(', ')}.`,
  }, body);
}

// ------------------------------------------------------------ map card -----

function mapCard(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const H = 304;
  const mt = m.mapTunisia;
  let body = card(T, W, H);

  body += `<circle cx="33" cy="40" r="3.5" fill="${T.accent}"/>`;
  body += doc.text(44, 44, 'FLAGSHIP · OPEN SOURCE · MIT + ODbL', { face: 'mono500', size: 10.5, ls: 1.1, fill: T.fg3 });
  body += doc.text(28, 86, 'Map Tunisia', { face: 'sans600', size: 32, ls: -1 });
  const desc = 'The most accurate open-source SVG maps of Tunisia. Six partitions nest with zero gaps or overlaps, built from OpenStreetMap and ISIE electoral data, with names in Arabic, French and English on every shape. Five levels of detail, eight modes; SVG, GeoJSON and TopoJSON.';
  wrap(desc, 'sans400', 14, 440).forEach((l, i) => { body += doc.text(28, 118 + i * 21, l, { size: 14, fill: T.fg2 }); });

  const kpis = [
    { v: fmt(mt.stars), l: 'stars', star: true },
    { v: fmt(mt.forks), l: 'forks' },
    ...(mt.views ? [{ v: fmt(mt.views), l: 'views, last 14 days' }] : []),
    { v: '140', l: 'SVG files' },
  ];
  let kx = 28;
  kpis.forEach((k) => {
    body += doc.text(kx, 254, k.v, { face: 'sans600', size: 24, ls: -0.6 });
    const vw = measure(k.v, 'sans600', 24, -0.6);
    if (k.star) body += star(kx + vw + 11, 245, 6.5, T.accent);
    body += doc.text(kx, 274, k.l, { face: 'mono400', size: 10.5, fill: T.fg3 });
    kx += Math.max(vw + (k.star ? 22 : 0), measure(k.l, 'mono400', 10.5)) + 30;
  });

  const levels = [
    { key: 'country', n: '1', l: 'country' },
    { key: 'districts', n: '5', l: 'districts' },
    { key: 'regions', n: '7', l: 'regions' },
    { key: 'governorates', n: '24', l: 'governorates' },
  ];
  const s = 186 / MAP_H;
  const mw = MAP_W * s;
  const gap = 10;
  const startX = W - 28 - levels.length * mw - (levels.length - 1) * gap;
  levels.forEach((lv, i) => {
    const x = startX + i * (mw + gap);
    const paths = MAPS[lv.key].map((p) => `<path d="${p.d}" fill="${p.id === 'TN-82' ? T.landHi : T.land}" stroke="${p.id === 'TN-82' ? T.accent : T.fg3}" stroke-opacity="${p.id === 'TN-82' ? 0.9 : 0.6}" stroke-width="${(0.8 / s).toFixed(2)}" stroke-linejoin="round"/>`).join('');
    body += `<g class="rise" style="animation-delay:${(0.15 + i * 0.15).toFixed(2)}s"><rect x="${r1(x - 4)}" y="34" width="${r1(mw + 8)}" height="196" rx="10" fill="${T.raised}"/><g transform="translate(${r1(x)} 39) scale(${s.toFixed(5)})">${paths}</g>`;
    body += doc.text(x + mw / 2, 256, lv.n, { face: 'sans600', size: 17, anchor: 'middle' });
    body += doc.text(x + mw / 2, 274, lv.l, { face: 'mono400', size: 10, fill: T.fg3, anchor: 'middle' });
    body += '</g>';
  });
  body += doc.text(W - 28, 294, '… down to 279 delegations and 2,083 imadas', { face: 'mono400', size: 9.5, fill: T.fg3, anchor: 'end' });

  return doc.render({
    w: W, h: H,
    title: 'Map Tunisia, open-source SVG maps of Tunisia',
    desc: `${desc} ${kpis.map((k) => `${k.v} ${k.l}`).join(', ')}.`,
  }, body);
}

// --------------------------------------------------------- project cards ---

function chips(doc, x, y, labels, maxW) {
  const T = doc.T;
  let out = '';
  let cx = x;
  const size = 10.5;
  labels.forEach((label, i) => {
    const w = measure(label, 'mono400', size) + 16;
    out += `<g class="rise" style="animation-delay:${(0.2 + i * 0.12).toFixed(2)}s"><rect x="${r1(cx)}" y="${y - 15}" width="${r1(w)}" height="22" rx="6" fill="${T.raised}" stroke="${T.line}"/>${doc.text(cx + 8, y, label, { face: 'mono400', size, fill: T.fg2 })}</g>`;
    cx += w;
    if (i < labels.length - 1) {
      out += `<path d="M${r1(cx + 4)} ${y - 4}h8m-3-3 3 3-3 3" stroke="${T.fg3}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      cx += 16;
    }
  });
  if (cx - x > maxW) console.warn(`  chips overflow by ${Math.round(cx - x - maxW)}px: ${labels.join(' ')}`);
  return out;
}

function projectCard(T, m, p) {
  const doc = new Doc(T);
  const W = 442;
  const H = 214;
  let body = card(T, W, H);
  body += doc.text(24, 38, p.kicker, { face: 'mono500', size: 10, ls: 1, fill: T.fg3 });
  body += doc.text(24, 70, p.title, { face: 'sans600', size: 22, ls: -0.5 });
  // A small star count undersells a young project, so it only shows from 10 up.
  if (p.stars >= 10) {
    const sw = measure(fmt(p.stars), 'mono400', 12);
    body += star(W - 24 - sw - 12, 62.5, 5.5, T.accent);
    body += doc.text(W - 24, 67, fmt(p.stars), { face: 'mono400', size: 12, fill: T.fg2, anchor: 'end' });
  }
  wrap(p.desc, 'sans400', 13.5, W - 48).slice(0, 3).forEach((l, i) => {
    body += doc.text(24, 98 + i * 20, l, { size: 13.5, fill: T.fg2 });
  });
  body += p.footer(doc, W, H);
  return doc.render({ w: W, h: H, title: p.title, desc: `${p.kicker}. ${p.desc} ${p.alt ?? ''}` }, body);
}

function sparkline(T, values, x, y, w, h) {
  const max = Math.max(...values);
  const pts = values.map((v, i) => [x + (i / (values.length - 1)) * w, y + h - (v / max) * h]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${r1(px)} ${r1(py)}`).join('');
  const [ex, ey] = pts[pts.length - 1];
  return `<path d="${line}L${r1(x + w)} ${y + h}L${x} ${y + h}Z" fill="${T.data}" fill-opacity=".14" class="fade" style="animation-delay:1s"/>
<path d="${line}" pathLength="1" class="trace" stroke="${T.data}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${r1(ex)}" cy="${r1(ey)}" r="3.5" fill="${T.data}" stroke="${T.card}" stroke-width="2" class="fade" style="animation-delay:1.8s"/>`;
}

const PROJECTS = [
  {
    file: 'tunisia-kit',
    repo: 'tunisia-kit',
    kicker: 'NPM · TYPESCRIPT · ZERO DEPENDENCIES',
    title: 'tunisia-kit',
    desc: 'The TypeScript toolkit for Tunisian data: validate CIN, RIB and phone numbers, format dinars, and look up banks, regions and other local reference data.',
    footer: (m) => (doc, W, H) => {
      const T = doc.T;
      return doc.text(24, H - 34, fmt(m.npm.total), { face: 'sans600', size: 22, ls: -0.6 })
        + doc.text(24, H - 16, 'npm downloads, last 12 months', { face: 'mono400', size: 10, fill: T.fg3 })
        + sparkline(T, m.npm.monthly, W - 24 - 150, H - 68, 150, 36)
        + doc.text(W - 24, H - 16, 'per month', { face: 'mono400', size: 10, fill: T.fg3, anchor: 'end' });
    },
    alt: (m) => `${fmt(m.npm.total)} npm downloads in the last 12 months.`,
  },
  {
    file: 'open-codemap',
    repo: 'Open-Codemap',
    kicker: 'LIBRARY + CLI · TYPESCRIPT · MIT',
    title: 'Open-Codemap',
    desc: 'A local-first codebase indexer for AI agents. It gives a model the exact functions it needs and how they connect, instead of whole files.',
    footer: () => (doc, W, H) => chips(doc, 24, H - 26, ['tree-sitter', 'chunks', 'embeddings', 'call graph'], W - 48),
    alt: () => 'Pipeline: tree-sitter parsing, structural chunks, embeddings, call and import graph.',
  },
  {
    file: 'element-lens',
    repo: 'element-lens',
    kicker: 'CHROME + EDGE EXTENSION · MANIFEST V3',
    title: 'Element Lens',
    desc: 'Point at any element on a web page and hand it to an AI agent as ready-made context: markup, styles and where it lives on the page.',
    footer: () => (doc, W, H) => chips(doc, 24, H - 26, ['pick element', 'capture context', 'paste to agent'], W - 48),
    alt: () => 'Flow: pick an element, capture its context, paste it to an agent.',
  },
  {
    file: 'agentic-std',
    repo: 'agentic-std',
    kicker: 'PYPI · PYTHON CLI',
    title: 'agentic-std',
    desc: 'Scaffolds an .agent/ directory from my Agentic Coding Standard, so every coding agent starts a project with the same context.',
    footer: (m) => (doc, W, H) => {
      const T = doc.T;
      const cmd = '$ pip install agentic-std';
      const w = measure(cmd, 'mono400', 11.5) + 22;
      return `<rect x="24" y="${H - 50}" width="${r1(w)}" height="30" rx="8" fill="${T.raised}" stroke="${T.line}"/>`
        + doc.text(35, H - 30.5, '$', { face: 'mono400', size: 11.5, fill: T.accent })
        + doc.text(35 + measure('$ ', 'mono400', 11.5), H - 30.5, 'pip install agentic-std', { face: 'mono400', size: 11.5, fill: T.fg })
        + doc.text(W - 24, H - 39, fmt(m.pypiLastMonth), { face: 'sans600', size: 18, anchor: 'end', ls: -0.4 })
        + doc.text(W - 24, H - 22, 'downloads, last month', { face: 'mono400', size: 10, fill: T.fg3, anchor: 'end' });
    },
    alt: (m) => `${m.pypiLastMonth} PyPI downloads last month.`,
  },
];

// ------------------------------------------------------------- workshop ----

const WORKSHOP = [
  { repo: 'tunic-screen-recorder', title: 'Tunic Screen Recorder', desc: 'Screen Studio-grade recording for Windows: automatic zooms, smooth cursor, GPU export. Local-first.' },
  { repo: 'TunisAPI', title: 'TunisAPI', desc: 'A directory and gateway for Tunisian APIs, with first-party APIs where local data is missing.' },
  { repo: 'Alabrain', title: 'Alabrain', desc: 'A private memory of my computer work that my AI agents query over MCP, with every answer citing its sources.' },
  { repo: 'Northstar', title: 'Northstar', desc: 'Keeps a project’s vision, roadmap and verified progress, so any coding agent can pick up where the last one stopped.' },
];

function workshop(T, m) {
  const doc = new Doc(T);
  const W = 900;
  const rowH = 66;
  const top = 66;
  const H = top + WORKSHOP.length * rowH + 4;
  let body = card(T, W, H);
  body += header(doc, W, {
    sub: 'Products I am building now in private repositories. They go public, or on sale, when they are ready.',
  });
  WORKSHOP.forEach((w, i) => {
    const r = m.repo[w.repo];
    const y = top + i * rowH;
    let g = i ? `<path d="M28 ${y}H${W - 28}" stroke="${T.line}"/>` : '';
    g += `<circle cx="38" cy="${y + 26}" r="4" fill="${T.accent}"/>`;
    if (i === 0) g += `<circle class="pulse" cx="38" cy="${y + 26}" r="4" fill="${T.accent}"/>`;
    g += doc.text(56, y + 31, w.title, { face: 'sans600', size: 16, ls: -0.2 });
    const tw = measure(w.title, 'sans600', 16, -0.2);
    g += doc.fit(56, y + 52, w.desc, W - 56 - 150, { size: 13, fill: T.fg2 });
    const lang = r?.language ?? '';
    const lw = measure(lang, 'mono400', 10.5) + 14;
    g += `<rect x="${r1(56 + tw + 12)}" y="${y + 17}" width="${r1(lw)}" height="19" rx="5" fill="${T.raised}" stroke="${T.line}"/>`;
    g += doc.text(56 + tw + 19, y + 30, lang, { face: 'mono400', size: 10.5, fill: T.fg2 });
    g += doc.text(W - 28, y + 31, r ? `last push ${shortDate(r.pushedAt)}` : '', { face: 'mono400', size: 11, fill: T.fg3, anchor: 'end' });
    g += doc.text(W - 28, y + 50, 'private', { face: 'mono400', size: 10, fill: T.fg3, anchor: 'end', opacity: 0.8 });
    body += `<g class="rise" style="animation-delay:${(i * 0.1).toFixed(1)}s">${g}</g>`;
  });
  return doc.render({
    w: W, h: H,
    title: 'In the workshop: products in development',
    desc: WORKSHOP.map((w) => `${w.title}: ${w.desc}`).join(' '),
  }, body);
}

// ------------------------------------------------------------- timeline ----

const PATH = [
  { year: '2022', title: 'Bachelor’s degree', desc: 'Web development. Capstone: a full-stack app in Angular and Spring Boot.' },
  { year: '2023', title: 'Instructor, Coding Dojo', desc: 'Two years teaching full-stack development across the web, Python and C# stacks.' },
  { year: '2025', title: 'Co-founder, CodePal', desc: 'Client software: a bus operations console, storefronts, Flux Convert.' },
  { year: '2026', title: 'Open source for Tunisia', desc: 'tunisia-kit, Open-Codemap and Map Tunisia, while building my own products.' },
];

function timeline(T) {
  const doc = new Doc(T);
  const W = 900;
  const H = 236;
  const lineY = 112;
  const colW = (W - 56) / PATH.length;
  let body = card(T, W, H);
  body += doc.text(28, 44, 'Path', { face: 'sans600', size: 18, ls: -0.2 });
  body += `<path d="M28 ${lineY}H${W - 28}" stroke="${T.line}" stroke-width="1.5"/>`;
  body += `<path d="M28 ${lineY}H${W - 28}" stroke="${T.fg3}" stroke-width="1.5" pathLength="1" class="trace" stroke-opacity=".5"/>`;
  PATH.forEach((p, i) => {
    const x = 28 + i * colW;
    const now = i === PATH.length - 1;
    let g = doc.text(x, lineY - 18, p.year, { face: 'mono500', size: 12, fill: now ? T.accent : T.fg3 });
    g += `<circle cx="${x + 5}" cy="${lineY}" r="5" fill="${now ? T.accent : T.card}" stroke="${now ? T.accent : T.fg3}" stroke-width="1.5"/>`;
    if (now) g += `<circle class="pulse" cx="${x + 5}" cy="${lineY}" r="5" fill="${T.accent}"/>`;
    g += doc.text(x, lineY + 34, p.title, { face: 'sans600', size: 15, ls: -0.2 });
    wrap(p.desc, 'sans400', 12.5, colW - 26).slice(0, 3).forEach((l, j) => {
      g += doc.text(x, lineY + 56 + j * 18, l, { size: 12.5, fill: T.fg2 });
    });
    body += `<g class="rise" style="animation-delay:${(0.3 + i * 0.2).toFixed(1)}s">${g}</g>`;
  });
  return doc.render({
    w: W, h: H,
    title: 'Path',
    desc: PATH.map((p) => `${p.year}: ${p.title}. ${p.desc}`).join(' '),
  }, body);
}

// ----------------------------------------------------------------- main ----

async function main() {
  const offline = process.argv.includes('--offline');
  let data;
  if (offline) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Rendering from cached data (${data.generatedAt})`);
  } else {
    console.log('Fetching live data…');
    data = await fetchData();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 1)}\n`);
  }

  const m = metrics(data);
  const thisYear = new Date(data.generatedAt).getUTCFullYear();
  m.yearsShown = Object.fromEntries(
    Object.entries(data.contributions.byYear).filter(([y, n]) => Number(y) >= thisYear - 3 && n > 0),
  );

  const assets = {
    hero: (T) => hero(T, m),
    stats: (T) => stats(T, m),
    'map-tunisia': (T) => mapCard(T, m),
    workshop: (T) => workshop(T, m),
    activity: (T) => activity(T, m),
    languages: (T) => languages(T, m),
    path: (T) => timeline(T),
  };
  for (const p of PROJECTS) {
    assets[p.file] = (T) => projectCard(T, m, {
      ...p, stars: m.repo[p.repo].stars, footer: p.footer(m), alt: p.alt(m),
    });
  }

  for (const T of Object.values(THEMES)) {
    const dir = path.join(ROOT, 'assets', T.name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, render] of Object.entries(assets)) {
      const svg = render(T);
      fs.writeFileSync(path.join(dir, `${name}.svg`), svg);
      console.log(`  assets/${T.name}/${name}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
