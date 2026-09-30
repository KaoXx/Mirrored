// Mirrored — service worker. Mantiene el WebSocket con el servidor y hace de puente
// entre el servidor y los content scripts de la pestaña vinculada a la sesión.

const PROTOCOL = 2;
const DEFAULT_SERVER = 'wss://mirrored-server.onrender.com';
const DEFAULTS = { serverUrl: DEFAULT_SERVER, name: 'Invitado' };
const MAX_RETRIES = 12; // ~100 s en total: da tiempo a que un servidor gratuito "dormido" despierte

/** Sesión activa (solo una a la vez). */
let session = null;
// { ws, serverUrl, name, code, role, id, tabId, peers, lastState, seq, allControl, chat, status, error,
//   hostFrameId, hostFrameAt, retries, keepalive, closing, initial }

async function settings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  // La 0.1/0.2 guardaba localhost por defecto: lo tratamos como "sin configurar".
  const serverUrl = !s.serverUrl || s.serverUrl === 'ws://localhost:8787' ? DEFAULT_SERVER : s.serverUrl;
  return { serverUrl, name: s.name || DEFAULTS.name };
}

function toTab(msg) {
  if (session?.tabId != null) chrome.tabs.sendMessage(session.tabId, msg).catch(() => {});
}

function wsSend(msg) {
  if (session?.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
}

function sessionInfo() {
  const s = session;
  return {
    type: 'session', active: !!s?.code, role: s?.role || null, code: s?.code || null,
    id: s?.id ?? null, allControl: !!s?.allControl, peers: s?.peers || [],
  };
}

function status() {
  if (!session) return { active: false };
  const s = session;
  return {
    active: true, status: s.status, error: s.error, code: s.code, role: s.role, id: s.id,
    peers: s.peers, allControl: s.allControl, tabId: s.tabId, retries: s.retries,
    hostUrl: s.lastState?.url || null, serverUrl: s.serverUrl, chat: s.chat.slice(-20),
  };
}

// Guarda lo mínimo para poder reengancharse si Chrome/Brave reinicia el service worker.
function persist() {
  const s = session;
  if (s?.code) chrome.storage.session.set({ resume: { code: s.code, tabId: s.tabId, role: s.role, allControl: s.allControl } });
  else chrome.storage.session.remove('resume');
}

function connect() {
  const s = session;
  s.status = s.retries ? 'reconnecting' : 'connecting';
  let ws;
  try {
    ws = new WebSocket(s.serverUrl);
  } catch (e) {
    s.status = 'error';
    s.error = 'URL del servidor no válida.';
    return;
  }
  s.ws = ws;

  ws.onopen = () => {
    s.retries = 0;
    s.error = null;
    // Si ya estábamos en una sala (reconexión), volvemos a ella; si no, la acción inicial.
    const action = s.code
      ? { type: 'join', code: s.code, rejoin: true, wasHost: s.role === 'host', allControl: s.allControl }
      : s.initial;
    ws.send(JSON.stringify({ ...action, name: s.name, v: PROTOCOL }));
    clearInterval(s.keepalive);
    // Mensajes cada <30 s mantienen vivo el service worker (Chrome 116+).
    let ticks = 0;
    s.keepalive = setInterval(() => {
      wsSend({ type: 'ping' });
      // Petición HTTP cada ~10 min: algunos hostings gratuitos solo cuentan HTTP como actividad.
      if (++ticks % 30 === 0) fetch(s.serverUrl.replace(/^ws/, 'http') + '/health').catch(() => {});
    }, 20000);
  };

  ws.onmessage = (ev) => {
    if (session !== s) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'joined':
        s.status = 'connected';
        s.code = msg.code;
        s.role = msg.role;
        s.id = msg.id;
        s.seq = msg.seq;
        s.allControl = msg.allControl;
        if (msg.chat?.length && !s.chat.length) s.chat = msg.chat;
        persist();
        toTab(sessionInfo());
        if (msg.state) {
          s.lastState = msg.state;
          if (s.role === 'guest') {
            toTab({ type: 'remote-state', state: msg.state });
            maybeNavigateGuest(msg.state.url);
          }
        }
        break;
      case 'role':
        s.role = msg.role;
        persist();
        s.hostFrameId = null;
        toTab(sessionInfo());
        break;
      case 'peers':
        s.peers = msg.peers;
        toTab({ type: 'peers', peers: msg.peers });
        break;
      case 'settings':
        s.allControl = msg.allControl;
        persist();
        toTab(sessionInfo());
        break;
      case 'ack':
        s.seq = msg.seq;
        break;
      case 'state': {
        const prevUrl = s.lastState?.url;
        s.lastState = msg.state;
        s.seq = msg.state.seq;
        toTab({ type: 'remote-state', state: msg.state });
        if (msg.state.fromHost) followHost(prevUrl, msg.state.url);
        break;
      }
      case 'chat':
        s.chat.push(msg);
        if (s.chat.length > 100) s.chat.shift();
        toTab(msg);
        break;
      case 'reaction':
        toTab(msg);
        break;
      case 'error':
        s.error = msg.message;
        s.status = 'error';
        s.closing = true;
        ws.close();
        chrome.storage.session.remove('resume');
        toTab({ type: 'session', active: false });
        break;
    }
  };

  ws.onclose = () => {
    clearInterval(s.keepalive);
    if (session !== s || s.closing) return;
    if (s.retries < MAX_RETRIES) {
      s.retries++;
      s.status = s.code ? 'reconnecting' : 'connecting';
      setTimeout(() => session === s && connect(), Math.min(2000 * s.retries, 10000));
    } else {
      s.status = 'error';
      s.error = s.error || 'No se pudo conectar con el servidor.';
      toTab({ type: 'session', active: false });
      chrome.storage.session.remove('resume');
    }
  };
}

async function start(tabId, initial, resume) {
  stop();
  const { serverUrl, name } = await settings();
  session = {
    serverUrl, name, tabId, initial, code: resume?.code || null, role: resume?.role || null, id: null, peers: [], lastState: null,
    seq: 0, allControl: !!resume?.allControl, chat: [], status: 'connecting', error: null, hostFrameId: null, hostFrameAt: 0, retries: 0,
  };
  connect();
}

function stop() {
  if (!session) return;
  const s = session;
  session = null;
  s.closing = true;
  clearInterval(s.keepalive);
  try {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'leave' }));
    s.ws?.close();
  } catch {}
  chrome.storage.session.remove('resume');
  chrome.tabs.sendMessage(s.tabId, { type: 'session', active: false }).catch(() => {});
}

function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin + x.pathname === y.origin + y.pathname;
  } catch {
    return false;
  }
}

// Si el invitado está en una pestaña vacía (nueva pestaña, etc.), le llevamos a la página del anfitrión.
async function maybeNavigateGuest(url) {
  if (!session || session.role !== 'guest' || !/^https?:/.test(url || '')) return;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (tab && !/^https?:/.test(tab.url || '')) chrome.tabs.update(session.tabId, { url });
}

// Siguiente episodio: si quien controla cambia de vídeo y yo estaba en el anterior, le sigo.
async function followHost(prevUrl, url) {
  if (!session || !prevUrl || !/^https?:/.test(url || '') || samePage(prevUrl, url)) return;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (tab && samePage(tab.url, prevUrl)) chrome.tabs.update(session.tabId, { url });
}

function stripInvite(url) {
  try {
    const u = new URL(url);
    if (/mirrored=/.test(u.hash)) u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  const fromSessionTab = session && tabId === session.tabId;
  switch (msg.type) {
    // --- desde content scripts ---
    case 'hello':
      if (fromSessionTab) {
        reply({ ...sessionInfo(), state: session.lastState, chat: session.chat.slice(-30) });
      } else reply({ type: 'session', active: false });
      return;
    case 'local-state': {
      if (!fromSessionTab || !session.role) return;
      const heartbeat = msg.state.reason === 'heartbeat';
      if (session.role !== 'host' && (heartbeat || !session.allControl)) return;
      // Si varios frames tienen vídeo (p. ej. anuncios), nos quedamos con el primero que habló
      // salvo que lleve más de 5 s callado.
      const now = Date.now();
      if (session.hostFrameId != null && session.hostFrameId !== sender.frameId && now - session.hostFrameAt < 5000) return;
      session.hostFrameId = sender.frameId;
      session.hostFrameAt = now;
      const state = { ...msg.state, url: stripInvite(sender.tab.url), seq: session.seq };
      session.lastState = state;
      wsSend({ type: 'state', state });
      return;
    }
    case 'chat':
    case 'reaction':
    case 'report':
      if (fromSessionTab) wsSend(msg);
      return;
    case 'autojoin':
      if (session && session.code === msg.code) {
        session.tabId = tabId;
        persist();
        toTab(sessionInfo());
        if (session.lastState) toTab({ type: 'remote-state', state: session.lastState });
        return;
      }
      start(tabId, { type: 'join', code: msg.code });
      return;

    // --- desde el popup ---
    case 'status':
      reply(status());
      return;
    case 'create':
      start(msg.tabId, { type: 'create', allControl: !!msg.allControl }).then(() => reply({ ok: true }));
      return true;
    case 'join':
      start(msg.tabId, { type: 'join', code: String(msg.code).trim().toUpperCase() }).then(() => reply({ ok: true }));
      return true;
    case 'set-all-control':
      if (session?.role === 'host') wsSend({ type: 'settings', allControl: !!msg.allControl });
      return;
    case 'leave':
      stop();
      reply({ ok: true });
      return;
    case 'go-to-host':
      if (session?.lastState?.url) chrome.tabs.update(session.tabId, { url: session.lastState.url, active: true });
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) stop();
});

// Cuando la pestaña navega a otra página, los content scripts nuevos piden estado con 'hello';
// esto cubre los que ya estaban cargados.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (session?.tabId !== tabId) return;
  if (info.url) session.hostFrameId = null; // página nueva: el vídeo estará en otro frame
  if (info.status === 'complete') toTab(sessionInfo());
});

// Si el service worker se reinició en mitad de una sesión, vuelve a entrar en la sala.
chrome.storage.session.get('resume').then(({ resume }) => {
  if (!resume || session) return;
  chrome.tabs
    .get(resume.tabId)
    .then(() => start(resume.tabId, { type: 'join', code: resume.code }, resume))
    .catch(() => chrome.storage.session.remove('resume'));
});
