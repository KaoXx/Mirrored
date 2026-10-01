const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'wss://mirrored-server.onrender.com';
const DEFAULTS = { serverUrl: DEFAULT_SERVER, name: '' };
const STATUS = {
  connecting: 'Conectando… (si el servidor estaba dormido puede tardar hasta 1 min)',
  reconnecting: 'Reconectando…',
  connected: 'Conectado',
  error: 'Error',
};

let currentTab = null;
let hostUrl = null;

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await chrome.storage.local.get(DEFAULTS);
  if (s.serverUrl === 'ws://localhost:8787') s.serverUrl = DEFAULT_SERVER; // valor por defecto antiguo
  $('server').value = s.serverUrl;
  $('name').value = s.name;
  wakeServer(s.serverUrl);
  refresh();
  setInterval(refresh, 1000);
}

// Los servidores gratuitos (Render) se duermen: los despertamos en cuanto se abre el popup y
// mostramos cuándo están listos, para que nadie cree una sesión creyendo que no funciona.
let wakeTimer = null;
let wakeGen = 0; // si cambia la URL, el sondeo anterior (quizá esperando un fetch) se descarta
function wakeServer(url) {
  clearTimeout(wakeTimer);
  const gen = ++wakeGen;
  const started = Date.now();
  const show = (cls, text) => {
    $('serverState').className = 'muted ' + cls;
    $('serverText').textContent = text;
  };
  const check = async () => {
    let ok = false;
    try {
      const r = await fetch(url.replace(/^ws/, 'http') + '/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      ok = r.ok && (await r.json()).ok === true;
    } catch {}
    if (gen !== wakeGen) return;
    if (ok) return show('ready', 'Servidor listo');
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs > 120) return show('down', 'El servidor no responde. Revisa la URL en «Servidor».');
    show('', `Despertando el servidor… (${secs} s, puede tardar hasta 1 min)`);
    wakeTimer = setTimeout(check, 3000);
  };
  check();
}

async function saveSettings() {
  await chrome.storage.local.set({
    serverUrl: $('server').value.trim() || DEFAULTS.serverUrl,
    name: $('name').value.trim(),
  });
}

let sessionError = ''; // solo borramos #error si lo puso refresh (no los avisos de los botones)
async function refresh() {
  const st = (await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null)) || { active: false };
  const live = st.active && st.status !== 'error';
  $('idle').classList.toggle('hidden', live);
  $('live').classList.toggle('hidden', !live);
  const err = st.active && st.status === 'error' ? st.error || 'Error de conexión.' : '';
  if (err || sessionError) $('error').textContent = err;
  sessionError = err;
  if (!live) return;

  const role = st.role === 'host' ? 'Eres el anfitrión' : st.role === 'guest' ? 'Eres invitado' : '';
  $('status').textContent = [STATUS[st.status], role].filter(Boolean).join(' · ');
  $('liveCode').textContent = st.code || '······';
  $('hostTools').classList.toggle('hidden', st.role !== 'host');
  hostUrl = st.hostUrl;
  const onOtherPage = st.role === 'guest' && hostUrl && currentTab && !samePage(currentTab.url, hostUrl);
  $('guestTools').classList.toggle('hidden', !onOtherPage);
  $('allControl').checked = !!st.allControl;
  $('names').replaceChildren(...(st.peers || []).map(peerItem));
}

const PEER_STATUS = {
  ok: ['sincronizado', 'st-ok'],
  behind: [null, 'st-bad'],
  ad: ['en un anuncio', 'st-warn'],
  buffering: ['cargando…', 'st-warn'],
  novideo: ['sin vídeo', 'st-warn'],
  needclick: ['tiene que pulsar play', 'st-warn'],
};

function peerItem(p) {
  const li = document.createElement('li');
  li.textContent = p.name + (p.host ? ' (anfitrión)' : '');
  const [label, cls] = PEER_STATUS[p.status] || [];
  if (p.status && !p.host) {
    const behind = p.status === 'behind';
    const text = !behind ? label
      : Number.isFinite(p.drift) ? `${Math.abs(p.drift).toFixed(0)} s ${p.drift < 0 ? 'por detrás' : 'por delante'}` : 'desincronizado';
    li.append(' · ', Object.assign(document.createElement('span'), { textContent: text, className: cls }));
  }
  return li;
}

function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    // Con parámetros: en muchas webs el vídeo va en la query (YouTube ?v=, otras ?e=…).
    return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search;
  } catch {
    return false;
  }
}

// Evita dobles clics: desactiva Crear/Unirme mientras la petición está en curso.
async function busy(fn) {
  $('create').disabled = $('join').disabled = true;
  try {
    await fn();
  } finally {
    $('create').disabled = $('join').disabled = false;
  }
  refresh();
}

$('create').onclick = () => {
  if (!/^https?:/.test(currentTab?.url || '')) {
    $('error').textContent = 'Abre primero la página del vídeo en esta pestaña.';
    return;
  }
  $('error').textContent = '';
  busy(async () => {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: 'create', tabId: currentTab.id, allControl: $('allControlNew').checked });
  });
};

$('join').onclick = () => {
  if ($('join').disabled) return; // Enter en el campo del código
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    $('error').textContent = 'El código tiene 6 caracteres.';
    return;
  }
  $('error').textContent = '';
  busy(async () => {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: 'join', tabId: currentTab.id, code });
  });
};

$('code').addEventListener('keydown', (e) => e.key === 'Enter' && $('join').click());

$('leave').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'leave' });
  refresh();
};

$('allControl').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-all-control', allControl: e.target.checked });

$('goHost').onclick = () => chrome.runtime.sendMessage({ type: 'go-to-host' });

$('copyLink').onclick = async () => {
  let st, u;
  try {
    st = await chrome.runtime.sendMessage({ type: 'status' });
    const tab = await chrome.tabs.get(st.tabId);
    u = new URL(tab.url);
    if (!/^https?:$/.test(u.protocol) || !st.code) throw new Error();
  } catch {
    $('error').textContent = 'No se puede crear el enlace: la pestaña de la sesión no está en una página web.';
    return;
  }
  u.hash = 'mirrored=' + st.code;
  try {
    await navigator.clipboard.writeText(`${u}\n(o únete con el código ${st.code})`);
  } catch {
    // Si el portapapeles no está disponible, mostramos el enlace para copiarlo a mano.
    $('linkFallback').textContent = u.toString();
    return;
  }
  $('copyLink').textContent = '¡Copiado!';
  setTimeout(() => ($('copyLink').textContent = 'Copiar enlace de invitación'), 1500);
};

$('server').addEventListener('change', async () => {
  await saveSettings();
  wakeServer($('server').value.trim() || DEFAULTS.serverUrl);
});
$('name').addEventListener('change', saveSettings);

init();
