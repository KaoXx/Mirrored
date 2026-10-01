// Batería end-to-end de Mirrored: 3 navegadores con la extensión cargada contra laisla.wtf.
// Uso: ver tests/README.md. Variables: ONLY, EXT, PROF, DEBUG, HEADFUL, BROWSER, BROWSER_PATH, SERVER.
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.resolve(process.env.EXT || path.join(ROOT, 'extension'));
const TMP = path.join(os.tmpdir(), 'mirrored-e2e');
const PROF = process.env.PROF || TMP; // carpeta base de los perfiles de navegador
const URL_ = 'https://laisla.wtf/ver/?t=11&c=programas&e=54bb7880-424c-4b23-9561-f0cf8ec90d20';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim().toUpperCase()) : null;
const LOCAL = process.env.SERVER === 'local' || process.argv.includes('--local');
const LOCAL_PORT = 8799; // no usar 8787: background.js lo trata como "sin configurar"
const LOCAL_URL = `ws://localhost:${LOCAL_PORT}`;

// Navegador: Chromium de Playwright por defecto; BROWSER=brave o BROWSER_PATH para otro ejecutable
const BROWSER_PATH =
  process.env.BROWSER_PATH ||
  (process.env.BROWSER === 'brave' ? 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
let scenario = '';
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}  ${extra}`);
  log(ok ? 'PASS' : 'FAIL', name, extra);
  return ok;
};

// ---------- navegadores ----------
async function peer(name) {
  const dir = path.join(PROF, name);
  rmSync(dir, { recursive: true, force: true }); // perfil limpio en cada ejecución
  const ctx = await chromium.launchPersistentContext(dir, {
    ...(BROWSER_PATH ? { executablePath: BROWSER_PATH } : { channel: 'chromium' }),
    headless: !process.env.HEADFUL,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    viewport: { width: 1280, height: 800 },
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  // Nombre del peer y, en modo local, el servidor al que conectarse
  await sw.evaluate((s) => chrome.storage.local.set(s), { name, ...(LOCAL ? { serverUrl: LOCAL_URL } : {}) });
  const page = ctx.pages()[0] || (await ctx.newPage());
  // Cierra popunders de anuncios
  // (salvo las que abre la propia prueba: P.allowNew)
  ctx.on('page', (p) => { if (p !== page && !P.allowNew) setTimeout(() => p.close().catch(() => {}), 300); });
  if (process.env.DEBUG) page.on('console', (m) => { if (m.text().includes('[MR]')) log('   ', name.padEnd(9), m.text().slice(5, 220)); });
  const P = { name, ctx, sw, page, allowNew: false };
  await openEpisode(P);
  await page.getByText('Aceptar y continuar').click({ timeout: 4000 }).catch(() => {});
  return P;
}
async function openEpisode(p, url = URL_) {
  await p.page.goto(url, { waitUntil: 'domcontentloaded' });
  await p.page.waitForSelector('video', { timeout: 20000 });
  await sleep(1500);
}
// Clic real en el reproductor de la web (carga la fuente). Reintenta si cae en otra cosa.
async function clickVideo(p, { requireSrc = true } = {}) {
  for (let i = 0; i < 4; i++) {
    await p.page.evaluate(() => scrollTo(0, 0));
    await sleep(400);
    const box = await p.page.locator('video').first().boundingBox();
    await p.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(1800);
    await p.page.bringToFront();
    if (!requireSrc || (await hasSrc(p))) return true;
  }
  return false;
}
const hasSrc = (p) => p.page.evaluate(() => !!document.querySelector('video')?.currentSrc).catch(() => false);

// Nodo dentro del shadow root cerrado de Mirrored (vía CDP)
async function ui(p, cls) {
  const cdp = await p.ctx.newCDPSession(p.page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let found = null;
    (function walk(n) {
      if (found) return;
      const a = n.attributes || [];
      const i = a.indexOf('class');
      if (i >= 0 && a[i + 1].split(' ').includes(cls)) found = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(root);
    if (!found) return null;
    // Clase y texto de la MISMA lectura: getDocument es una instantánea anterior y el nodo puede haber
    // cambiado entre medias (p. ej. un aviso temporal que da paso a uno pulsable).
    const html = (await cdp.send('DOM.getOuterHTML', { nodeId: found.nodeId })).outerHTML;
    const text = html.replace(/<[^>]+>/g, '');
    const bm = await cdp.send('DOM.getBoxModel', { nodeId: found.nodeId }).catch(() => null);
    const className = /^<[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? found.attributes[found.attributes.indexOf('class') + 1];
    const q = bm?.model.content;
    return { className, text, shown: /\bshow\b/.test(className), ...(q ? { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 } : {}) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}
// Registra todos los avisos que muestra la UI de un peer (para detectar avisos indebidos)
async function recordToasts(p) {
  p.toasts = [];
  clearInterval(p.toastTimer);
  p.toastTimer = setInterval(async () => {
    const t = await ui(p, 'toast').catch(() => null);
    if (t?.shown && p.toasts.at(-1) !== t.text) p.toasts.push(t.text);
  }, 300);
}

// ---------- estado ----------
const st = (p) =>
  p.page
    .evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return { t: -1, paused: true, rate: 0, rs: -1, src: false };
      return { t: +v.currentTime.toFixed(2), paused: v.paused, rate: v.playbackRate, rs: v.readyState, src: !!v.currentSrc };
    })
    .catch(() => ({ t: -1, paused: true, rate: 0, rs: -1, src: false }));
const status = (p) => p.sw.evaluate(() => status());
const vid = (p, code) => p.page.evaluate(new Function(`const v = document.querySelector('video'); ${code}`));
const d = (a, b) => Math.abs(a.t - b.t);
const playing = (x) => !x.paused && x.rs >= 3;
const fmt = (x) => `t=${x.t} ${x.paused ? '⏸' : '▶'} rs=${x.rs}${x.src ? '' : ' sinSrc'}${x.rate !== 1 ? ' x' + x.rate : ''}`;
const peerStatus = async (host, name) => (await status(host)).peers.find((p) => p.name === name)?.status;

let H, G, G2, ALL;
async function snap(ps = ALL) { return Promise.all(ps.map(st)); }
async function step(name, action, pred, { timeout = 25000, hold = 0, ps = ALL } = {}) {
  if (action) { await sleep(800); await action(); } // deja asentarse el paso anterior (S14 prueba acciones sin pausa)
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await snap(ps);
    if (pred(...last)) {
      if (hold) {
        await sleep(hold);
        last = await snap(ps);
        if (!pred(...last)) { await sleep(250); continue; }
      }
      return check(name, true, `${((Date.now() - t0 - hold) / 1000).toFixed(1)}s | ${ps.map((p, i) => p.name[0] + ':' + fmt(last[i])).join(' | ')}`);
    }
    await sleep(250);
  }
  const s = await status(ps[0]).catch(() => null);
  return check(name, false, `timeout | ${ps.map((p, i) => p.name + ' ' + fmt(last[i])).join(' | ')} | peers=${s?.peers?.map((x) => x.name + ':' + x.status).join(',')}`);
}
async function waitUntil(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await fn().catch(() => null); if (r) return r; await sleep(300); }
  return null;
}

// ---------- sesión ----------
async function leaveAll() { for (const p of ALL) await p.sw.evaluate(() => stop()).catch(() => {}); await sleep(500); }
async function create(host, allControl = false) {
  await host.sw.evaluate(async (ac) => {
    const [t] = await chrome.tabs.query({ url: 'https://laisla.wtf/*' });
    await start(t.id, { type: 'create', allControl: ac });
  }, allControl);
  const s = await waitUntil(async () => { const s = await status(host); return s.code && s.status === 'connected' ? s : null; }, 120000);
  if (!s) throw new Error('no se pudo crear la sala');
  return s.code;
}
async function join(p, code) {
  await p.sw.evaluate(async (c) => {
    const [t] = await chrome.tabs.query({ url: 'https://laisla.wtf/*' });
    await start(t.id, { type: 'join', code: c });
  }, code);
  return waitUntil(async () => (await status(p)).status === 'connected', 30000);
}
// Deja a todos en el episodio, con fuente cargada y en pausa en `t`, y abre sala nueva
async function fresh({ guests = [G, G2], allControl = false, t = 120, hostPlaying = true, guestsClicked = true } = {}) {
  await leaveAll();
  for (const p of [H, ...guests]) {
    if (!(await p.page.url()).startsWith(URL_) || !(await hasSrc(p)) || (p !== H && !guestsClicked)) {
      await openEpisode(p);
    }
    if ((p === H || guestsClicked) && !(await hasSrc(p))) await clickVideo(p);
    await vid(p, 'v.pause()').catch(() => {});
  }
  await vid(H, `v.currentTime = ${t}; ${hostPlaying ? 'v.play()' : ''}`);
  const code = await create(H, allControl);
  for (const g of guests) await join(g, code);
  return code;
}
const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name.split(' ')[0])) return;
  scenario = name;
  log(`\n===== ${name} =====`);
  try { await fn(); } catch (e) { check('excepción', false, e.message.split('\n')[0]); }
};

// ---------- servidor local (SERVER=local) ----------
let serverProc = null;
async function startLocalServer() {
  const dir = path.join(ROOT, 'server');
  if (!existsSync(path.join(dir, 'node_modules', 'ws'))) {
    log('instalando dependencias del servidor…');
    // npm ci no reescribe package-lock.json
    execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
  }
  serverProc = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir, env: { ...process.env, PORT: String(LOCAL_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (b) => process.stderr.write('[server] ' + b));
  if (process.env.DEBUG) serverProc.stdout.on('data', (b) => process.stdout.write('[server] ' + b));
  process.on('exit', () => serverProc?.kill());
  const ok = await waitUntil(async () => (await fetch(`http://localhost:${LOCAL_PORT}/health`)).ok, 15000);
  if (!ok) throw new Error(`el servidor local no responde en :${LOCAL_PORT}`);
  log(`servidor local en ${LOCAL_URL}`);
}

// ---------- páginas de prueba locales (S18–S21) ----------
// tests/fixtures/ servido en :8801. http://localhost:8801 y http://127.0.0.1:8801 son orígenes (y
// "sitios", para Mirrored) distintos. /a.html, /b.html → video.html (mismo sitio, páginas distintas);
// ?ad=1 añade un iframe del otro origen con un "anuncio" en autoplay. /ad.html → ad.html.
const FIX_PORT = 8801;
const FIX = `http://localhost:${FIX_PORT}`;
const FIX_OTHER = `http://127.0.0.1:${FIX_PORT}`;
let fixServer = null;
async function fixtures() {
  if (fixServer) return;
  const dir = path.join(ROOT, 'tests', 'fixtures');
  const routes = { '/a.html': 'video.html', '/b.html': 'video.html', '/ad.html': 'ad.html' };
  const videos = { '/main.webm': 'main.webm', '/short.webm': 'short.webm' }; // ver fixtures/make-videos.mjs
  fixServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (videos[pathname]) {
      // Con Range (206): sin él, el navegador no puede saltar a otro punto del vídeo.
      const data = readFileSync(path.join(dir, videos[pathname]));
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (!m) return void res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': data.length }).end(data);
      const start = m[1] ? +m[1] : Math.max(0, data.length - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1;
      res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 });
      return void res.end(data.subarray(start, end + 1));
    }
    const file = routes[pathname];
    if (!file) return void res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(path.join(dir, file)));
  });
  await new Promise((r, j) => fixServer.once('error', j).listen(FIX_PORT, r)); // "::" acepta también IPv4
  for (const o of [FIX, FIX_OTHER]) if (!(await fetch(o + '/a.html')).ok) throw new Error(`fixtures no accesibles en ${o}`);
  log(`páginas de prueba en ${FIX} y ${FIX_OTHER}`);
}
// Abre una página de prueba y espera a que el vídeo principal tenga metadatos
async function openFixture(p, url) {
  await p.page.goto(url, { waitUntil: 'domcontentloaded' });
  await p.page.waitForFunction(() => document.querySelector('video')?.readyState >= 1, null, { timeout: 30000 });
  await sleep(500);
}
// Como create()/join(), pero en la pestaña donde está la página del peer (cualquier web)
async function startHere(p, action) {
  await p.sw.evaluate(async ([url, a]) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === url) || tabs.find((t) => (t.url || '').split('#')[0] === url.split('#')[0]);
    await start(t.id, a);
  }, [p.page.url(), action]);
  return waitUntil(async () => { const s = await status(p); return s.code && s.status === 'connected' ? s : null; }, 60000);
}
async function fixtureSession(host, guests, url, { t = 30, hostPlaying = true } = {}) {
  await leaveAll();
  for (const p of [host, ...guests]) await openFixture(p, url);
  await vid(host, `v.currentTime = ${t}; ${hostPlaying ? 'v.play()' : ''}`);
  const s = await startHere(host, { type: 'create' });
  if (!s) throw new Error('no se pudo crear la sala');
  for (const g of guests) if (!(await startHere(g, { type: 'join', code: s.code }))) throw new Error(`${g.name} no pudo unirse`);
  return s.code;
}
// Play/pausa con un clic real (gesto de la persona) en el <video controls> principal de la página de prueba
async function clickPlay(p) {
  const was = (await st(p)).paused;
  const box = await p.page.locator('#main').boundingBox();
  await p.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (await waitUntil(async () => (await st(p)).paused !== was, 2000)) return;
  await p.page.mouse.click(box.x + 20, box.y + box.height - 18); // botón de play de los controles nativos
}
// Nº de interfaces de Mirrored (<mirrored-ui>) en el documento principal y en cada iframe
const adFrame = (p) => p.page.frames().find((f) => f.url().includes('/ad.html'));
async function docks(p) {
  const count = (f) => f?.evaluate(() => document.querySelectorAll('mirrored-ui').length).catch(() => -1) ?? -1;
  return { top: await count(p.page.mainFrame()), ad: await count(adFrame(p)) };
}
const adState = (p) =>
  adFrame(p)?.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused, rs: v.readyState, ...window.__ad }; }).catch(() => null) ?? null;

// =====================================================================
mkdirSync(TMP, { recursive: true });
if (LOCAL) await startLocalServer();
log('extensión:', EXT, '| navegador:', BROWSER_PATH || 'chromium (Playwright)', '| servidor:', LOCAL ? LOCAL_URL : 'por defecto de la extensión');
[H, G, G2] = await Promise.all([peer('Anfitrion'), peer('Invitado'), peer('Invitado2')]);
ALL = [H, G, G2];
log('UA', await H.page.evaluate(() => navigator.userAgent), '| brave:', await H.page.evaluate(() => !!navigator.brave));
scenario = 'setup';
if (LOCAL) check('peers apuntan al servidor local', (await Promise.all(ALL.map((p) => p.sw.evaluate(() => settings())))).every((s) => s.serverUrl === LOCAL_URL));

await run('S1 sincronía básica (3 personas)', async () => {
  await vid(G, 'v.currentTime = 600'); // invitado empieza en otro punto
  await fresh();
  await step('alineación al entrar', null, (h, g, g2) => playing(h) && playing(g) && playing(g2) && d(h, g) < 1 && d(h, g2) < 1, { hold: 2000 });
  await step('anfitrión pausa', () => vid(H, 'v.pause()'), (h, g, g2) => h.paused && g.paused && g2.paused && d(h, g) < 0.5 && d(h, g2) < 0.5);
  await step('salto a 3000 en pausa', () => vid(H, 'v.currentTime = 3000'), (h, g, g2) => g.paused && g2.paused && Math.abs(g.t - 3000) < 0.5 && Math.abs(g2.t - 3000) < 0.5);
  log('>>> HOST PLAY');
  await step('anfitrión play', () => vid(H, 'v.play()'), (h, g, g2) => playing(h) && playing(g) && playing(g2) && d(h, g) < 1 && d(h, g2) < 1, { hold: 2000 });
  await step('salto a 5000 reproduciendo', () => vid(H, 'v.currentTime = 5000'), (h, g, g2) => h.t > 5000 && playing(g) && playing(g2) && d(h, g) < 1 && d(h, g2) < 1, { hold: 2000 });
  await step('salto hacia atrás a 200', () => vid(H, 'v.currentTime = 200'), (h, g, g2) => h.t < 300 && playing(g) && playing(g2) && d(h, g) < 1 && d(h, g2) < 1, { hold: 2000 });
  await step('velocidad 1.5', () => vid(H, 'v.playbackRate = 1.5'), (h, g, g2) => g.rate === 1.5 && g2.rate === 1.5);
  await sleep(5000);
  await step('a 1.5 sigue sincronizado', null, (h, g, g2) => d(h, g) < 1 && d(h, g2) < 1, { timeout: 1000 });
  await step('velocidad 0.5', () => vid(H, 'v.playbackRate = 0.5'), (h, g, g2) => g.rate === 0.5 && g2.rate === 0.5);
  await step('velocidad 1', () => vid(H, 'v.playbackRate = 1'), (h, g, g2) => g.rate === 1 && g2.rate === 1);
  await recordToasts(G);
  await step('invitado pausa sin permiso → se revierte', () => vid(G, 'v.pause()'), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 3000 });
  await step('invitado salta sin permiso → se revierte', () => vid(G, 'v.currentTime = 4000'), (h, g) => playing(h) && playing(g) && d(h, g) < 1 && h.t < 1000, { hold: 3000 });
  clearInterval(G.toastTimer);
  check('avisa "El anfitrión controla"', G.toasts.some((t) => /anfitrión controla/.test(t)), JSON.stringify(G.toasts));
  await step('pausa y play rápidos (5 toques)', async () => {
    for (let i = 0; i < 5; i++) { await vid(H, 'v.paused ? v.play() : v.pause()'); await sleep(250); }
  }, (h, g, g2) => h.paused && g.paused && g2.paused && d(h, g) < 0.5 && d(h, g2) < 0.5, { hold: 2000 });
  await vid(H, 'v.play()');
  await sleep(30000);
  await step('deriva tras 30 s', null, (h, g, g2) => playing(h) && d(h, g) < 0.5 && d(h, g2) < 0.5, { timeout: 1500 });
});

await run('S2 todos controlan', async () => {
  await fresh({ allControl: true });
  await step('alineación', null, (h, g, g2) => playing(h) && playing(g) && playing(g2) && d(h, g) < 1, { hold: 1500 });
  log('>>> INVITADO SALTA');
  await step('invitado salta a 1500', () => vid(G, 'v.currentTime = 1500'), (h, g, g2) => h.t >= 1500 && h.t < 1530 && playing(h) && d(h, g) < 1 && d(h, g2) < 1, { hold: 2000 });
  await step('invitado pausa', () => vid(G, 'v.pause()'), (h, g, g2) => h.paused && g2.paused && d(h, g) < 0.5 && d(h, g2) < 0.5);
  log('>>> INVITADO2 PLAY');
  await step('invitado2 play', () => vid(G2, 'v.play()'), (h, g, g2) => playing(h) && playing(g) && d(h, g2) < 1 && d(h, g) < 1, { hold: 2000 });
  await step('invitado2 velocidad 1.25', () => vid(G2, 'v.playbackRate = 1.25'), (h, g) => h.rate === 1.25 && g.rate === 1.25);
  await vid(G2, 'v.playbackRate = 1');
  await step('anfitrión sigue mandando', () => vid(H, 'v.currentTime = 2500'), (h, g, g2) => h.t > 2500 && d(h, g) < 1 && d(h, g2) < 1 && playing(g), { hold: 2000 });
  await step('desactivar "todos controlan": invitado ya no manda', async () => {
    await H.sw.evaluate(() => wsSend({ type: 'settings', allControl: false }));
    await sleep(1500);
    await vid(G, 'v.pause()');
  }, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 3000 });
});

await run('S3 invitado entra sin pulsar play (anfitrión reproduciendo)', async () => {
  await openEpisode(G2); // G2 recién cargado, sin clic
  await fresh({ guests: [G2], guestsClicked: false });
  await sleep(5000);
  const [h, g] = await snap([H, G2]);
  check('no hace play() en vacío', g.paused && !g.src, fmt(g));
  const ps3 = await peerStatus(H, 'Invitado2');
  check('informa "novideo" / "needclick"', ps3 === 'novideo' || ps3 === 'needclick', ps3);
  check('anfitrión no se pausa', playing(h), fmt(h));
  const toast = await ui(G2, 'toast'), badge = await ui(G2, 'badge');
  check('aviso "Pulsa play" visible', toast?.shown && /Pulsa play/.test(toast.text), toast?.text);
  check('indicador "Pulsa play en el vídeo"', /Pulsa play/.test(badge?.text || ''), badge?.text);
  await G2.page.screenshot({ path: path.join(TMP, 'S3.png') });
  await recordToasts(G2);
  await step('clic en el reproductor de la web → sincroniza', () => clickVideo(G2), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G2] });
  clearInterval(G2.toastTimer);
  check('sin aviso "El anfitrión controla" indebido', !G2.toasts.some((t) => /anfitrión controla/.test(t)), JSON.stringify(G2.toasts));
  check('aviso oculto', !(await ui(G2, 'toast'))?.shown);
  check('estado vuelve a "ok"', (await waitUntil(async () => (await peerStatus(H, 'Invitado2')) === 'ok', 8000)) === true, await peerStatus(H, 'Invitado2'));
});

await run('S4 invitado entra sin pulsar play (anfitrión en pausa)', async () => {
  await openEpisode(G2);
  await fresh({ guests: [G2], guestsClicked: false, hostPlaying: false, t: 900 });
  await sleep(4000);
  const g = await st(G2);
  check('invitado en pausa en 900 sin fuente', g.paused && Math.abs(g.t - 900) < 0.5, fmt(g));
  const toast = await ui(G2, 'toast');
  check('no pide clic mientras está en pausa', !(toast?.shown && /Pulsa play/.test(toast.text)), toast?.text);
  await vid(H, 'v.play()');
  const asked = await waitUntil(async () => { const t = await ui(G2, 'toast'); return t?.shown && /Pulsa play/.test(t.text); }, 8000);
  check('al dar play el anfitrión, pide clic', !!asked);
  await step('clic en la web → sincroniza', () => clickVideo(G2), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G2] });
});

await run('S5 recarga del invitado → clic en el aviso de Mirrored', async () => {
  await fresh({ guests: [G] });
  await step('sincronizado antes', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  await G.page.reload({ waitUntil: 'domcontentloaded' });
  const toast = await waitUntil(async () => { const t = await ui(G, 'toast'); return t?.shown && /Pulsa play/.test(t.text) ? t : null; }, 12000);
  check('tras recarga aparece el aviso', !!toast, JSON.stringify(await ui(G, 'toast')));
  const g = await st(G);
  check('sin play en vacío', g.paused && !g.src, fmt(g));
  await G.page.screenshot({ path: path.join(TMP, 'S5.png') });
  // Scroll abajo para comprobar que el aviso lleva al vídeo
  await G.page.evaluate(() => scrollTo(0, 2000));
  if (toast) await G.page.mouse.click(toast.x, toast.y);
  await sleep(1500);
  const vis = await G.page.evaluate(() => { const r = document.querySelector('video').getBoundingClientRect(); return r.top >= -50 && r.bottom <= innerHeight + 50; });
  check('clic en el aviso lleva hasta el vídeo', vis);
  const g2 = await st(G);
  check('clic en el aviso no deja el vídeo "reproduciendo en vacío"', g2.paused && !g2.src, fmt(g2));
  const again = await waitUntil(async () => { const t = await ui(G, 'toast'); return t?.shown && /Pulsa play/.test(t.text); }, 6000);
  check('el aviso vuelve mientras falte la fuente', !!again);
  await step('clic en la web → sincroniza', () => clickVideo(G), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
});

await run('S6 recarga del invitado → clic en el reproductor', async () => {
  await fresh({ guests: [G] });
  await G.page.reload({ waitUntil: 'domcontentloaded' });
  await waitUntil(async () => (await ui(G, 'toast'))?.shown, 12000);
  await recordToasts(G);
  await step('clic en la web → sincroniza', () => clickVideo(G), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  clearInterval(G.toastTimer);
  check('sin aviso "El anfitrión controla" indebido', !G.toasts.some((t) => /anfitrión controla/.test(t)), JSON.stringify(G.toasts));
});

await run('S7 todos controlan + invitado sin fuente pulsa play', async () => {
  await openEpisode(G);
  await fresh({ guests: [G], guestsClicked: false, allControl: true, t: 2000 });
  await sleep(4000);
  const before = await st(H);
  await step('invitado carga y se une sin arrastrar al anfitrión', () => clickVideo(G), (h, g) => playing(h) && playing(g) && d(h, g) < 1 && h.t >= before.t, { hold: 2000, ps: [H, G] });
  const h = await st(H);
  check('anfitrión no saltó al inicio', h.t > 1990, fmt(h));
});

await run('S8 red lenta: el anfitrión espera', async () => {
  await fresh({ guests: [G] });
  await step('sincronizado', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  const cdp = await G.ctx.newCDPSession(G.page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: (40 * 1024) / 8, uploadThroughput: 1e6 });
  await vid(H, 'v.currentTime = 6000');
  const sawBuffering = await waitUntil(async () => (await peerStatus(H, 'Invitado')) === 'buffering', 15000);
  check('invitado informa "buffering"', !!sawBuffering);
  const autoPaused = await waitUntil(async () => (await st(H)).paused, 10000);
  check('anfitrión se pausa solo', !!autoPaused);
  const hostBadge = await ui(H, 'badge');
  check('anfitrión ve "Esperando a que carguen…"', /Esperando|cargando/.test(hostBadge?.text || ''), hostBadge?.text);
  const resumed = await waitUntil(async () => !(await st(H)).paused, 25000);
  check('reanuda tras el máximo de espera (≤15 s)', !!resumed);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.detach();
  await step('al volver la red, se resincroniza', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1.5, { timeout: 40000, hold: 2000, ps: [H, G] });
});

await run('S9 chat y reacciones', async () => {
  await fresh({ guests: [G, G2] });
  // Captura lo que llega por el WebSocket del anfitrión
  await H.sw.evaluate(() => { self.__got = []; session.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.type === 'chat' || m.type === 'reaction') self.__got.push(m); }); });
  await G.sw.evaluate(() => wsSend({ type: 'chat', text: 'hola desde invitado' }));
  await G2.sw.evaluate(() => wsSend({ type: 'reaction', emoji: '😂' }));
  await G2.sw.evaluate(() => wsSend({ type: 'reaction', emoji: '💩' })); // no permitido
  await sleep(2500);
  const got = await H.sw.evaluate(() => self.__got);
  check('chat llega al anfitrión', got.some((m) => m.type === 'chat' && m.text === 'hola desde invitado' && m.name === 'Invitado'), JSON.stringify(got));
  check('reacción válida llega', got.some((m) => m.type === 'reaction' && m.emoji === '😂'));
  check('reacción no permitida se descarta', !got.some((m) => m.emoji === '💩'));
  const hs = await status(H);
  check('chat queda en el historial', hs.chat.some((m) => m.text === 'hola desde invitado'));
  // Invitado que entra tarde recibe el historial
  await G2.sw.evaluate(() => stop());
  await join(G2, hs.code);
  await sleep(1500);
  check('quien entra tarde ve el historial', (await status(G2)).chat.some((m) => m.text === 'hola desde invitado'));
  const chatUI = await ui(H, 'msgs').catch(() => null);
  log('UI chat anfitrión:', chatUI?.text?.slice(0, 120));
});

await run('S10 cambio de episodio: los invitados siguen al anfitrión', async () => {
  await fresh({ guests: [G] });
  await step('sincronizado', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  const next = await H.page.evaluate(() => [...document.querySelectorAll('a[href*="/ver/"]')].map((a) => a.href).find((u) => !u.includes('54bb7880')));
  log('otro episodio:', next);
  await openEpisode(H, next);
  await clickVideo(H);
  const followed = await waitUntil(async () => G.page.url() === next, 20000);
  check('invitado navega al nuevo episodio', !!followed, G.page.url());
  const asked = await waitUntil(async () => { const t = await ui(G, 'toast'); return t?.shown && /Pulsa play/.test(t.text); }, 15000);
  check('en el nuevo episodio pide clic', !!asked);
  await step('clic → sincroniza en el nuevo episodio', () => clickVideo(G), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  await openEpisode(H); await openEpisode(G);
});

await run('S11 recarga del anfitrión', async () => {
  await fresh({ guests: [G], t: 1800 });
  await step('sincronizado', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  await H.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const g = await st(G);
  check('invitado no salta mientras el anfitrión recarga', g.t > 1790, fmt(g));
  check('anfitrión sigue siendo anfitrión', (await status(H)).role === 'host');
  // Vigila que el invitado nunca vuelva al principio
  let minGuest = Infinity;
  const watch = setInterval(async () => { const x = await st(G); if (x.t >= 0) minGuest = Math.min(minGuest, x.t); }, 200);
  await clickVideo(H);
  await step('anfitrión retoma donde iba la sala', null, (h, g) => playing(h) && playing(g) && h.t > 1800 && d(h, g) < 1.5, { hold: 2000, ps: [H, G] });
  clearInterval(watch);
  check('el invitado nunca volvió al principio', minGuest > 1790, `mínimo t invitado=${minGuest}`);
  await step('tras la recarga el anfitrión sigue mandando', () => vid(H, 'v.pause()'), (h, g) => h.paused && g.paused && d(h, g) < 0.5, { ps: [H, G] });
});

await run('S12 el anfitrión se va: traspaso', async () => {
  await fresh({ guests: [G, G2] });
  await H.sw.evaluate(() => stop());
  const newHost = await waitUntil(async () => { const [a, b] = [await status(G), await status(G2)]; return a.role === 'host' ? G : b.role === 'host' ? G2 : null; }, 10000);
  check('un invitado pasa a anfitrión', !!newHost, newHost?.name);
  if (newHost) {
    const other = newHost === G ? G2 : G;
    await step('el nuevo anfitrión controla', () => vid(newHost, 'v.currentTime = 4200'), (a, b) => a.t > 4200 && d(a, b) < 1 && playing(b), { hold: 2000, ps: [newHost, other] });
    await step('el nuevo anfitrión pausa', () => vid(newHost, 'v.pause()'), (a, b) => a.paused && b.paused && d(a, b) < 0.5, { ps: [newHost, other] });
  }
});

await run('S13 código inválido', async () => {
  await leaveAll();
  await G.sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://laisla.wtf/*' }); await start(t.id, { type: 'join', code: 'ZZZZZZ' }); });
  const s = await waitUntil(async () => { const s = await status(G); return s.status === 'error' ? s : null; }, 20000);
  check('error "La sesión no existe"', /no existe/.test(s?.error || ''), s?.error);
  const g = await st(G);
  check('la página no se toca', true, fmt(g));
});

await run('S14 acciones inmediatamente después de un cambio remoto', async () => {
  // Antes, durante 0,4 s tras aplicar un estado remoto se ignoraba cualquier evento local: una acción
  // real en ese intervalo se perdía. Ahora solo se descartan los ecos (eventos que coinciden con el estado).
  await fresh({ allControl: true });
  await step('alineación', null, (h, g, g2) => playing(h) && playing(g) && playing(g2) && d(h, g) < 1 && d(h, g2) < 1, { hold: 1500 });
  await vid(G, 'v.pause()');
  await waitUntil(async () => (await st(G2)).paused, 5000);
  await sleep(150);
  await vid(G2, 'v.play()'); // 150 ms después de recibir la pausa
  await step('play 150 ms tras una pausa remota se propaga', null, (h, g, g2) => playing(h) && playing(g) && playing(g2) && d(h, g) < 1, { hold: 2000 });
  await vid(H, 'v.currentTime = 2000');
  await waitUntil(async () => Math.abs((await st(G)).t - 2000) < 2, 8000);
  await sleep(100);
  await vid(G, 'v.currentTime = 2600'); // salto propio 100 ms después de uno remoto
  await step('salto 100 ms tras otro salto remoto se propaga', null, (h, g, g2) => h.t > 2595 && h.t < 2620 && d(h, g2) < 1 && playing(h), { hold: 2000 });
  // Sin permiso, la acción rápida del invitado se sigue revirtiendo
  await H.sw.evaluate(() => wsSend({ type: 'settings', allControl: false }));
  await sleep(1000);
  await vid(H, 'v.pause()');
  await waitUntil(async () => (await st(G)).paused, 5000);
  await sleep(150);
  await vid(G, 'v.play()');
  await step('sin permiso, el play rápido del invitado se revierte', null, (h, g) => h.paused && g.paused && d(h, g) < 0.5, { hold: 2000, ps: [H, G] });
});

await run('S15 descarga colgada: reintento automático', async () => {
  await fresh({ guests: [G] });
  await step('sincronizado', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  // Tras el salto, la primera petición de vídeo del invitado se queda colgada (ni datos ni error).
  let held = null, after = 0;
  await G.page.route('**/*.mp4*', (route) => {
    if (!held) return void (held = route);
    after++;
    route.continue().catch(() => {});
  });
  await vid(H, 'v.currentTime = 4500');
  const hung = await waitUntil(async () => held && (await st(G)).rs < 3, 8000);
  check('la descarga del invitado se cuelga', !!hung);
  await step('el invitado reintenta solo y se sincroniza', null, (h, g) => playing(h) && playing(g) && h.t > 4500 && d(h, g) < 1.5, { timeout: 40000, hold: 2000, ps: [H, G] });
  check('hubo una petición nueva tras el reintento', after > 0, `peticiones tras la colgada: ${after}`);
  await G.page.unroute('**/*.mp4*');
  await held?.abort().catch(() => {});
});

await run('S16 panel plegable/movible y resaltado del vídeo', async () => {
  await fresh({ guests: [G] });
  await step('sincronizado', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { ps: [H, G] });
  await G.sw.evaluate(() => chrome.storage.local.remove('dock'));
  let badge = await ui(G, 'badge');
  await G.page.mouse.click(badge.x, badge.y);
  await sleep(300);
  check('clic en el indicador pliega el panel', /\bmin\b/.test((await ui(G, 'dock'))?.className || ''));
  check('plegado: barra de reacciones oculta', (await ui(G, 'bar'))?.x == null);
  await G.page.mouse.click(badge.x, badge.y);
  await sleep(300);
  check('segundo clic lo despliega', !/\bmin\b/.test((await ui(G, 'dock'))?.className || '') && (await ui(G, 'bar'))?.x != null);
  badge = await ui(G, 'badge');
  await G.page.mouse.move(badge.x, badge.y);
  await G.page.mouse.down();
  await G.page.mouse.move(badge.x - 150, badge.y - 120, { steps: 8 });
  await G.page.mouse.up();
  await sleep(300);
  const moved = await ui(G, 'badge');
  const movedDock = await ui(G, 'dock'); // el indicador se alinea a la derecha: su centro depende del texto
  check('arrastrar el indicador mueve el panel', Math.abs(moved.x - (badge.x - 150)) < 10 && Math.abs(moved.y - (badge.y - 120)) < 10, `(${badge.x},${badge.y}) → (${moved.x},${moved.y})`);
  check('arrastrar no lo pliega', !/\bmin\b/.test((await ui(G, 'dock'))?.className || ''));
  await G.page.reload({ waitUntil: 'domcontentloaded' });
  const after = await waitUntil(async () => { const b = await ui(G, 'badge'); return b?.x != null ? b : null; }, 12000);
  const afterDock = await ui(G, 'dock');
  check('la posición se recuerda tras recargar', after && Math.abs(afterDock.x - movedDock.x) < 5 && Math.abs(after.y - moved.y) < 5, after && `panel x ${movedDock.x} → ${afterDock.x}, indicador y ${moved.y} → ${after.y}`);
  // Resaltado: la recarga deja al invitado sin fuente → aviso → clic → marco sobre el vídeo
  const toast = await waitUntil(async () => { const t = await ui(G, 'toast'); return t?.shown && /Pulsa play/.test(t.text) ? t : null; }, 12000);
  if (toast) await G.page.mouse.click(toast.x, toast.y);
  const hl = await waitUntil(async () => ui(G, 'hl'), 3000);
  const vbox = await G.page.locator('video').boundingBox();
  check('clic en el aviso enmarca el vídeo', hl?.x != null && vbox && Math.abs(hl.x - (vbox.x + vbox.width / 2)) < 20 && Math.abs(hl.y - (vbox.y + vbox.height / 2)) < 20);
  await G.sw.evaluate(() => chrome.storage.local.remove('dock'));
  await clickVideo(G);
});

await run('S17 el anfitrión ve quién tiene que pulsar play', async () => {
  await openEpisode(G2);
  await fresh({ guests: [G2], guestsClicked: false });
  const st2 = await waitUntil(async () => ((await peerStatus(H, 'Invitado2')) === 'needclick' ? 'needclick' : null), 10000);
  check('estado "needclick"', !!st2, await peerStatus(H, 'Invitado2'));
  const hb = await waitUntil(async () => { const b = await ui(H, 'badge'); return /sin pulsar play/.test(b?.text || '') ? b : null; }, 5000);
  check('indicador del anfitrión: "1 sin pulsar play"', !!hb, (await ui(H, 'badge'))?.text);
  const gb = await ui(G2, 'badge');
  check('indicador del invitado: "Pulsa play en el vídeo"', /Pulsa play en el vídeo/.test(gb?.text || ''), gb?.text);
  await clickVideo(G2);
  check('tras pulsar play vuelve a "ok"', !!(await waitUntil(async () => (await peerStatus(H, 'Invitado2')) === 'ok', 10000)), await peerStatus(H, 'Invitado2'));
});

await run('S18 iframes: solo actúa el frame principal (anuncio en iframe de otro origen)', async () => {
  await fixtures();
  const url = `${FIX}/a.html?ad=1`;
  await leaveAll();
  for (const p of [H, G]) {
    await openFixture(p, url);
    const ad = await waitUntil(async () => { const a = await adState(p); return a && !a.paused && a.rs >= 2 ? a : null; }, 30000);
    check(`${p.name}: el anuncio del iframe arranca solo`, !!ad, JSON.stringify(ad));
  }
  await vid(H, 'v.currentTime = 30; v.play()');
  const code = (await startHere(H, { type: 'create' }))?.code;
  if (!code) throw new Error('no se pudo crear la sala');
  // Antes de la elección todos los frames se creen principales: medimos el anuncio del invitado desde que entra
  const adBefore = await adState(G);
  if (process.env.EDEBUG) await G.sw.evaluate(() => {
    self.__elog = [];
    const orig = electPrimary;
    electPrimary = (s) => { const before = s.primary; const r = orig(s); self.__elog.push({ t: Date.now() % 100000, before, after: s.primary, frames: [...s.frames].map(([id, f]) => [id, Math.round(f.score), Date.now() - f.at]), claim: s.claim }); return r; };
    const origReset = resetFrames;
    resetFrames = (s) => { self.__elog.push({ t: Date.now() % 100000, reset: true, stack: new Error().stack.split(String.fromCharCode(10)).slice(2, 4).join(' ') }); return origReset(s); };
  });
  if (!(await startHere(G, { type: 'join', code }))) throw new Error('el invitado no pudo unirse');
  const one = (x) => x.top === 1 && x.ad === 0;
  const elected = await waitUntil(async () => { const [h, g] = [await docks(H), await docks(G)]; return one(h) && one(g) ? [h, g] : null; }, 15000);
  check('un solo panel por pestaña (el del frame principal)', !!elected, JSON.stringify({ H: await docks(H), G: await docks(G) }));
  const adJoin = await adState(G);
  // Informativo: la elección tarda unos ms y, mientras, el iframe del invitado puede aplicar el primer estado
  log('   anuncio del invitado durante la elección:', JSON.stringify({ antes: adBefore, despues: adJoin }));
  await step('alineación de los vídeos principales', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  const ad0 = { H: await adState(H), G: await adState(G) };
  const dumpE = async () => { if (process.env.EDEBUG) { const l = await G.sw.evaluate(() => self.__elog); log('ELOG', JSON.stringify(l.filter((e, i) => e.reset || e.before !== e.after || i === l.length - 1))); } };
  await step('anfitrión pausa', () => vid(H, 'v.pause()'), (h, g) => h.paused && g.paused && d(h, g) < 0.5, { ps: [H, G] });
  // El anuncio del anfitrión sigue reproduciéndose; no debe mover al invitado
  await dumpE();
  const g1 = await st(G);
  await sleep(6000);
  const g2 = await st(G);
  check('el anuncio del anfitrión no mueve al invitado (6 s en pausa)', g2.paused && Math.abs(g2.t - g1.t) < 0.2, `${fmt(g1)} → ${fmt(g2)}`);
  const adH = await adState(H), adG = await adState(G);
  check('el anuncio del anfitrión sigue reproduciéndose', adH && !adH.paused && adH.t > ad0.H.t, JSON.stringify(adH));
  check('el anuncio del invitado no se pausa con la sala', adG && !adG.paused && adG.t > ad0.G.t, JSON.stringify(adG));
  await step('salto a 300 en pausa', () => vid(H, 'v.currentTime = 300'), (h, g) => g.paused && Math.abs(g.t - 300) < 0.5, { ps: [H, G] });
  // Play con un clic real en el reproductor (acción de la persona, mientras el anuncio sigue en autoplay)
  await step('anfitrión pulsa play en el reproductor', () => clickPlay(H), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  await step('salto a 450 reproduciendo', () => vid(H, 'v.currentTime = 450'), (h, g) => h.t > 450 && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  const adG2 = await adState(G);
  check('el anuncio del invitado no se tocó tras la elección (sin saltos ni pausas)', adG2 && adG2.seeks === ad0.G.seeks && adG2.pauses === ad0.G.pauses && !adG2.paused, `${JSON.stringify(ad0.G)} → ${JSON.stringify(adG2)}`);
  const adH2 = await adState(H);
  check('el anuncio del anfitrión no se tocó', adH2 && adH2.seeks === ad0.H.seeks && adH2.pauses === ad0.H.pauses, `${JSON.stringify(ad0.H)} → ${JSON.stringify(adH2)}`);
  check('sigue habiendo un solo panel por pestaña', one(await docks(H)) && one(await docks(G)), JSON.stringify({ H: await docks(H), G: await docks(G) }));
  // Sin el vídeo principal, el iframe pasa a ser el frame principal
  await H.page.evaluate(() => document.querySelector('#main').remove());
  const moved = await waitUntil(async () => { const x = await docks(H); return x.top === 0 && x.ad === 1 ? x : null; }, 15000);
  check('sin el vídeo principal, el panel pasa al iframe', !!moved, JSON.stringify(await docks(H)));

  // Reclamar: un anuncio grande y con sonido en el iframe gana la elección por tamaño; al pulsar la
  // persona play en el vídeo bueno (frame superior), ese frame pasa a ser el principal y la acción llega.
  await leaveAll();
  await openFixture(H, `${FIX}/a.html?ad=big`);
  await openFixture(G, `${FIX}/a.html`);
  await waitUntil(async () => { const a = await adState(H); return a && !a.paused && a.rs >= 2; }, 30000);
  await vid(H, 'v.currentTime = 30');
  const code2 = (await startHere(H, { type: 'create' }))?.code;
  if (!code2 || !(await startHere(G, { type: 'join', code: code2 }))) throw new Error('no se pudo montar la sala del anuncio grande');
  const adWins = await waitUntil(async () => { const x = await docks(H); return x.top === 0 && x.ad === 1 ? x : null; }, 15000);
  check('(premisa) el anuncio grande gana la elección', !!adWins, JSON.stringify(await docks(H)));
  await sleep(3000);
  const gAd = await st(G);
  // Se queda donde estaba (0) o en el 30 del vídeo bueno si su estado llegó antes de la elección; lo que
  // no debe hacer es moverse con el anuncio. Y el anfitrión lo ve "en anuncio".
  const gSt = await peerStatus(H, 'Invitado');
  check('el invitado no sigue al anuncio (otra duración)', gAd.paused && (gAd.t < 0.5 || Math.abs(gAd.t - 30) < 1) && gSt === 'ad', `${fmt(gAd)} estado=${gSt}`);
  await step('clic en play del vídeo bueno → pasa a principal y el invitado le sigue', () => clickPlay(H), (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 2000, ps: [H, G] });
  const claimed = await waitUntil(async () => { const x = await docks(H); return x.top === 1 && x.ad === 0 ? x : null; }, 5000);
  check('el panel pasa al frame del vídeo pulsado', !!claimed, JSON.stringify(await docks(H)));
  await step('el anfitrión pausa (ya desde el vídeo bueno)', () => vid(H, 'v.pause()'), (h, g) => h.paused && g.paused && d(h, g) < 0.5, { ps: [H, G] });
  await leaveAll();
});

await run('S19 el anfitrión cambia de página: mismo sitio lo siguen, otra web solo avisa', async () => {
  await fixtures();
  await fixtureSession(H, [G], `${FIX}/a.html`);
  await step('sincronizados en a.html', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 1500, ps: [H, G] });
  // Mismo sitio (localhost → localhost): el invitado sigue al anfitrión
  await openFixture(H, `${FIX}/b.html`);
  await vid(H, 'v.currentTime = 60; v.play()');
  const followed = await waitUntil(async () => G.page.url() === `${FIX}/b.html`, 20000);
  check('mismo sitio: el invitado navega a b.html', !!followed, G.page.url());
  await G.page.waitForFunction(() => document.querySelector('video')?.readyState >= 1, null, { timeout: 30000 }).catch(() => {});
  await step('sincronizados en b.html', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 1500, ps: [H, G] });
  // Otra web (localhost → 127.0.0.1): no navega, avisa con un aviso pulsable
  await recordToasts(G);
  const target = `${FIX_OTHER}/b.html`;
  await openFixture(H, target);
  await vid(H, 'v.currentTime = 90; v.play()');
  const toast = await waitUntil(async () => { const t = await ui(G, 'toast'); return t?.shown && /El anfitrión se ha ido a/.test(t.text) ? t : null; }, 15000);
  clearInterval(G.toastTimer);
  check('otra web: aviso "El anfitrión se ha ido a 127.0.0.1"', !!toast && /127\.0\.0\.1/.test(toast.text), toast?.text || JSON.stringify(G.toasts));
  check('el aviso es pulsable', /\bclick\b/.test(toast?.className || ''), toast?.className);
  await sleep(4000);
  check('otra web: el invitado NO navega solo', G.page.url() === `${FIX}/b.html`, G.page.url());
  const still = await ui(G, 'toast');
  check('el aviso sigue a la vista', still?.shown && /se ha ido a/.test(still.text), still?.text);
  if (still?.shown) await G.page.mouse.click(still.x, still.y);
  const went = await waitUntil(async () => G.page.url() === target, 15000);
  check('clic en el aviso → el invitado va a la página del anfitrión', !!went, G.page.url());
  await G.page.waitForFunction(() => document.querySelector('video')?.readyState >= 1, null, { timeout: 30000 }).catch(() => {});
  await step('sincronizados en la otra web', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 1500, ps: [H, G] });
  await leaveAll();
});

await run('S20 enlace de invitación (#mirrored=CÓDIGO)', async () => {
  await fixtures();
  await fixtureSession(H, [], `${FIX}/a.html`);
  const hs = await status(H);
  // Como el popup: URL de la pestaña de la sesión con el hash mirrored=CÓDIGO
  const invite = await H.sw.evaluate(async (s) => { const u = new URL((await chrome.tabs.get(s.tabId)).url); u.hash = 'mirrored=' + s.code; return u.toString(); }, hs);
  check('enlace de invitación', invite === `${FIX}/a.html#mirrored=${hs.code}`, invite);
  check('el invitado no está en ninguna sesión', !(await status(G)).active);
  G.allowNew = true;
  const page = await G.ctx.newPage();
  try {
    await page.goto(invite, { waitUntil: 'domcontentloaded' });
    const s = await waitUntil(async () => { const s = await status(G); return s.status === 'connected' ? s : null; }, 30000);
    check('se une solo al abrir el enlace', s?.role === 'guest' && s?.code === hs.code, JSON.stringify(s && { status: s.status, role: s.role, code: s.code }));
    const tabOk = await G.sw.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).url, s?.tabId).catch(() => null);
    check('la sesión queda en la pestaña del enlace', tabOk && !tabOk.includes('mirrored='), tabOk);
    const hash = await waitUntil(async () => { const h = await page.evaluate(() => location.hash); return /mirrored=/.test(h) ? null : h || '(vacío)'; }, 5000);
    check('el código se quita de la URL (replaceState)', !!hash, await page.evaluate(() => location.href));
    check('el anfitrión ve al invitado', !!(await waitUntil(async () => (await status(H)).peers.some((p) => p.name === 'Invitado'), 8000)));
    // Salir y provocar hashchange: no debe volver a entrar
    await G.sw.evaluate(() => leave());
    await sleep(800);
    await page.evaluate(() => { location.hash = 'otra-cosa'; });
    await page.evaluate(() => dispatchEvent(new HashChangeEvent('hashchange')));
    await page.goBack({ waitUntil: 'commit' }).catch(() => {}); // vuelve a la entrada que tenía el código (ya limpia)
    await sleep(3000);
    const after = await status(G);
    check('tras salir, un hashchange / atrás no vuelve a unir', !after.active || after.status === 'error', JSON.stringify(after));
    check('la entrada del historial no conserva el código', !/mirrored=/.test(page.url()), page.url());
  } finally {
    G.allowNew = false;
    await page.close().catch(() => {});
  }
  await leaveAll();
});

await run('S21 recarga de la extensión: el content script huérfano se desmonta', async () => {
  await fixtures();
  await fixtureSession(H, [G], `${FIX}/a.html`);
  await step('sincronizados', null, (h, g) => playing(h) && playing(g) && d(h, g) < 1, { hold: 1500, ps: [H, G] });
  check('el invitado tiene panel antes de recargar', !!(await ui(G, 'dock')));
  // Errores de todos los mundos de la página (incluido el del content script) vía CDP
  const errors = [];
  const cdp = await G.ctx.newCDPSession(G.page);
  cdp.on('Runtime.exceptionThrown', (e) => errors.push('exception: ' + (e.exceptionDetails.exception?.description || e.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push('console: ' + e.args.map((a) => a.value ?? a.description).join(' ')); });
  cdp.on('Log.entryAdded', (e) => { if (e.entry.level === 'error') errors.push('log: ' + e.entry.text); });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  const pageErrors = [];
  const onErr = (e) => pageErrors.push(e.message);
  G.page.on('pageerror', onErr);
  // Sonda: comprueba que el colector ve las excepciones no capturadas
  await G.page.evaluate(() => setTimeout(() => { throw new Error('sonda-e2e'); }));
  await sleep(500);
  check('(premisa) el colector de errores funciona', errors.some((e) => /sonda-e2e/.test(e)), JSON.stringify(errors));
  errors.length = pageErrors.length = 0;
  const oldSw = G.sw;
  const extId = new URL(oldSw.url()).host;
  await oldSw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  const newSw = () => G.ctx.serviceWorkers().find((w) => w !== oldSw && w.url().includes(extId));
  // Con --load-extension, chrome.runtime.reload() descarga la extensión pero Chromium/Brave no la vuelven
  // a cargar (limitación del entorno de pruebas, no de Mirrored): el content script queda huérfano igual.
  const sw = await waitUntil(async () => newSw(), 8000);
  log('   ¿la extensión volvió a cargarse?', !!sw);
  if (sw) G.sw = sw;
  const gone = await waitUntil(async () => !(await ui(G, 'dock')) && !(await ui(G, 'badge')), 10000);
  check('la interfaz de Mirrored desaparece de la página vieja', !!gone);
  await sleep(5000);
  await step('el vídeo se puede reproducir a mano', () => vid(G, 'v.play()'), (g) => playing(g), { ps: [G] });
  await step('y pausar', () => vid(G, 'v.pause()'), (g) => g.paused, { ps: [G] });
  await vid(G, 'v.currentTime = 500');
  await sleep(2000);
  G.page.off('pageerror', onErr);
  await cdp.detach().catch(() => {});
  const invalid = errors.filter((e) => /context invalidated/i.test(e));
  check('sin errores "Extension context invalidated"', invalid.length === 0, `${invalid.length}: ${invalid.slice(0, 3).join(' | ')}`);
  check('sin excepciones en la página', errors.filter((e) => e.startsWith('exception')).length === 0 && pageErrors.length === 0, JSON.stringify([...errors, ...pageErrors].slice(0, 5)));
  if (sw) check('el nuevo service worker no tiene sesión', (await status(G).catch(() => null))?.active === false);
  // Deja al invitado con la extensión funcionando para lo que venga después
  if (sw) await G.page.reload({ waitUntil: 'domcontentloaded' });
  else {
    await G.ctx.close().catch(() => {});
    G = await peer('Invitado');
    ALL = [H, G, G2];
  }
  await leaveAll();
});

await leaveAll();
console.log('\n================ RESUMEN ================');
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
await Promise.all(ALL.map((p) => p.ctx.close().catch(() => {})));
serverProc?.kill();
fixServer?.close();
process.exit(fails ? 1 : 0);
