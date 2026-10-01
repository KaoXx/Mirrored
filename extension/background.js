// Mirrored — service worker. Mantiene el WebSocket con el servidor y hace de puente
// entre el servidor y los content scripts de la pestaña vinculada a la sesión.

const PROTOCOL = 2;
const DEFAULT_SERVER = 'wss://mirrored-server.onrender.com';
const DEFAULTS = { serverUrl: DEFAULT_SERVER, name: 'Invitado' };
const MAX_RETRIES = 12; // ~100 s en total: da tiempo a que un servidor gratuito "dormido" despierte

/** Sesión activa (solo una a la vez). */
let session = null;
// { ws, serverUrl, name, code, role, id, tabId, peers, lastState, seq, allControl, chat, status, error,
//   hostFrameId, hostFrameAt, retries, keepalive, closing, initial, clock, token }
// Cada start() recibe un número; si otro start()/stop() llega mientras espera, el antiguo se descarta
// (doble clic en Crear/Unirme, autojoin durante la reanudación…) y no quedan sockets huérfanos.
let startGen = 0;

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
    type: 'session', active: !!s?.code && s.status !== 'error', role: s?.role || null, code: s?.code || null,
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

// Guarda lo mínimo para poder reengancharse si Chrome/Brave reinicia el service worker. Antes de
// 'joined' (servidor arrancando en frío) guardamos la acción inicial para repetirla.
function persist() {
  const s = session;
  if (s?.code) {
    chrome.storage.session.set({
      resume: { code: s.code, tabId: s.tabId, role: s.role, allControl: s.allControl, ...(s.token && { token: s.token }) },
    });
  } else if (s?.initial) chrome.storage.session.set({ resume: { code: null, tabId: s.tabId, initial: s.initial } });
  else chrome.storage.session.remove('resume');
}

// ---------- Reloj del servidor ----------
// Estimamos la diferencia entre nuestro reloj y el del servidor con ping/pong (como NTP: nos quedamos
// con la muestra de menor ida y vuelta). Así cada estado viaja con el instante al que corresponde y
// quien lo recibe descuenta la latencia de los dos tramos (emisor→servidor→receptor).
function onPong(s, msg) {
  if (typeof msg.t !== 'number' || typeof msg.t0 !== 'number') return; // servidor antiguo
  const now = Date.now();
  const rtt = now - msg.t0;
  if (rtt < 0 || rtt > 10000) return;
  s.clock.push({ rtt, offset: msg.t + rtt / 2 - now });
  if (s.clock.length > 8) s.clock.shift();
}

function clockOffset(s) {
  if (!s.clock.length) return null;
  return s.clock.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
}

// Estado recibido → añade `localAt`: instante (en nuestro reloj) al que corresponde su `time`.
function withLocalAt(s, state) {
  const offset = clockOffset(s);
  const now = Date.now();
  const localAt = typeof state.sentAt === 'number' && offset != null ? Math.min(state.sentAt - offset, now) : now;
  return { ...state, localAt: Math.max(localAt, now - 10000) };
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
    // `token` demuestra que somos el mismo participante (los servidores antiguos lo ignoran).
    const action = s.code
      ? { type: 'join', code: s.code, rejoin: true, wasHost: s.role === 'host', allControl: s.allControl, ...(s.token && { token: s.token }) }
      : s.initial;
    ws.send(JSON.stringify({ ...action, name: s.name, v: PROTOCOL }));
    // Ráfaga inicial de pings para tener pronto una buena estimación del reloj.
    s.clock = [];
    for (let i = 0; i < 5; i++) setTimeout(() => wsSend({ type: 'ping', t0: Date.now() }), 200 + i * 400);
    clearInterval(s.keepalive);
    // Mensajes cada <30 s mantienen vivo el service worker (Chrome 116+).
    let ticks = 0;
    s.keepalive = setInterval(() => {
      wsSend({ type: 'ping', t0: Date.now() });
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
        if (typeof msg.token === 'string') s.token = msg.token;
        if (msg.chat?.length && !s.chat.length) s.chat = msg.chat;
        persist();
        toTab(sessionInfo());
        if (msg.state) {
          s.lastState = withLocalAt(s, msg.state);
          if (s.role === 'guest') {
            toTab({ type: 'remote-state', state: s.lastState });
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
        s.lastState = withLocalAt(s, msg.state);
        s.seq = msg.state.seq;
        toTab({ type: 'remote-state', state: s.lastState });
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
      case 'pong':
        onPong(s, msg);
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
  const gen = ++startGen;
  stop();
  const { serverUrl, name } = await settings();
  if (gen !== startGen) return; // otro start()/leave() llegó mientras esperábamos
  session = {
    serverUrl, name, tabId, initial, code: resume?.code || null, role: resume?.role || null, id: null, peers: [], lastState: null,
    seq: 0, allControl: !!resume?.allControl, chat: [], status: 'connecting', error: null, hostFrameId: null, hostFrameAt: 0, retries: 0, clock: [],
    token: resume?.token || null, frames: new Map(), primary: null,
  };
  persist();
  connect();
}

// Como stop(), pero cancela también un start() que esté pendiente.
function leave() {
  startGen++;
  stop();
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

// ---------- Frame principal ----------
// Cada frame de la pestaña con vídeo se presenta con 'candidate' (score ≥ 0; 0 = sin vídeo útil).
// Solo el principal (mayor score; empate → frameId menor) actúa. Histéresis: solo cambiamos si el
// nuevo supera 1,5× al actual o el actual ha desaparecido / caducado (10 s) / tiene score 0.
function resetFrames(s) {
  s.frames = new Map();
  s.primary = null;
  s.claim = null;
  s.hostFrameId = null;
}

function tellFrame(s, frameId) {
  chrome.tabs.sendMessage(s.tabId, { type: 'primary', primary: frameId === s.primary }, { frameId }).catch(() => {});
}

// Devuelve true si ha avisado a todos los frames (cambio de principal).
function electPrimary(s) {
  const now = Date.now();
  for (const [id, f] of s.frames) if (now - f.at > 10000) s.frames.delete(id);
  let best = null;
  for (const [id, f] of s.frames) if (!best || f.score > best.score || (f.score === best.score && id < best.id)) best = { id, score: f.score };
  const cur = s.frames.get(s.primary);
  // Un frame donde la persona acaba de tocar el vídeo manda durante 30 s aunque otro (un anuncio con
  // autoplay, por ejemplo) puntúe más.
  const claimed = s.claim && now < s.claim.until && s.frames.has(s.claim.frameId) ? s.claim.frameId : null;
  const next = claimed != null ? claimed : !best ? null : !cur || cur.score <= 0 || best.score > 1.5 * cur.score ? best.id : s.primary;
  if (next === s.primary) return false;
  s.primary = next;
  for (const id of s.frames.keys()) tellFrame(s, id);
  return true;
}

const isWeb = (url) => /^https?:\/\//i.test(url || '');

// Mismo sitio: mismo hostname o que compartan dominio registrable (www.foo.com ↔ player.foo.com).
// Aproximación práctica sin lista de sufijos: dos últimas etiquetas, o tres si es un ccTLD de
// segundo nivel (foo.co.uk, foo.com.br). Las IPs tienen que coincidir exactamente.
const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'gob', 'edu', 'ac', 'or', 'ne']);
function sameSite(a, b) {
  try {
    const x = new URL(a).hostname, y = new URL(b).hostname;
    if (x === y) return true;
    if (/^[\d.]+$/.test(x) || /^[\d.]+$/.test(y) || /[[:]/.test(x + y)) return false;
    const base = (h) => {
      const l = h.split('.');
      const n = l.length > 2 && l.at(-1).length === 2 && SLD.has(l.at(-2)) ? 3 : 2;
      return l.slice(-n).join('.');
    };
    return x.includes('.') && base(x) === base(y);
  } catch {
    return false;
  }
}

function samePage(a, b) {
  try {
    // Limpias las dos: la URL guardada en el estado ya pasó por cleanUrl.
    const x = new URL(cleanUrl(a)), y = new URL(cleanUrl(b));
    // Con parámetros: en muchas webs el vídeo va en la query (YouTube ?v=, otras ?e=…).
    return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search;
  } catch {
    return false;
  }
}

// Si el invitado está en una pestaña vacía (nueva pestaña, etc.), le llevamos a la página del anfitrión.
async function maybeNavigateGuest(url) {
  if (!session || session.role !== 'guest' || !isWeb(url)) return;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (tab && !/^https?:/.test(tab.url || '')) chrome.tabs.update(session.tabId, { url });
}

// Siguiente episodio: si quien controla cambia de vídeo y yo estaba en el anterior, le sigo — solo
// dentro del mismo sitio. Si se va a otra web, avisamos (aviso en la página) en vez de navegar.
async function followHost(prevUrl, url) {
  if (!session || !prevUrl || !isWeb(url) || samePage(prevUrl, url)) return;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (!tab || !samePage(tab.url, prevUrl)) return;
  if (sameSite(prevUrl, url)) chrome.tabs.update(session.tabId, { url });
  else toTab({ type: 'host-moved', url });
}

// La URL de la pestaña viaja con cada estado. Conservamos query y hash (el vídeo suele ir en la query,
// ?v=…, y hay webs que enrutan con el hash), pero quitamos:
//  - la invitación (#mirrored=…) y cualquier hash con access_token= / id_token= (OAuth implícito);
//  - SOLO los parámetros cuyo nombre sea exactamente access_token, id_token, auth_token o token.
//    Otros (key, sig, session…) no se tocan: pueden hacer falta para abrir el mismo vídeo.
const SECRET_PARAMS = ['access_token', 'id_token', 'auth_token', 'token'];
function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (/mirrored=|access_token=|id_token=/.test(u.hash)) u.hash = '';
    // Solo reescribimos la query si hay algo que quitar (así no se recodifica).
    if (SECRET_PARAMS.some((k) => u.searchParams.has(k))) SECRET_PARAMS.forEach((k) => u.searchParams.delete(k));
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
        // El frame superior solo saluda al cargar un documento nuevo (p. ej. al recargar): los frameId de
        // los iframes cambian, así que la elección anterior ya no vale.
        if (sender.frameId === 0) resetFrames(session);
        // Sin candidatos aún, todos se creen principales; la elección lo corrige enseguida.
        const primary = session.primary == null || session.primary === sender.frameId;
        reply({ ...sessionInfo(), primary, state: session.lastState, chat: session.chat.slice(-30) });
      } else reply({ type: 'session', active: false });
      return;
    case 'candidate': {
      if (!fromSessionTab || typeof msg.score !== 'number') return;
      const isNew = !session.frames.has(sender.frameId);
      session.frames.set(sender.frameId, { score: Math.max(0, msg.score) || 0, at: Date.now() });
      if (msg.claim) session.claim = { frameId: sender.frameId, until: Date.now() + 30000 };
      // Un frame nuevo que no recibió el aviso general necesita saber si es el principal.
      if (!electPrimary(session) && isNew) tellFrame(session, sender.frameId);
      return;
    }
    case 'local-state': {
      if (!fromSessionTab || !session.role) return;
      if (session.primary != null && sender.frameId !== session.primary) return; // solo actúa el frame principal
      const heartbeat = msg.state.reason === 'heartbeat';
      if (session.role !== 'host' && (heartbeat || !session.allControl)) return;
      const now = Date.now();
      // Respaldo para content scripts sin elección de frame: los latidos solo cuentan desde el frame
      // que habló el último (salvo que lleve más de 5 s callado); una acción real siempre se queda el
      // turno, para que un iframe con autoplay no bloquee al reproductor principal.
      if (session.primary == null) {
        if (heartbeat && session.hostFrameId != null && session.hostFrameId !== sender.frameId && now - session.hostFrameAt < 5000) return;
        session.hostFrameId = sender.frameId;
        session.hostFrameAt = now;
      }
      // `at`: instante (reloj local) en que el content script leyó el vídeo.
      const at = typeof msg.state.at === 'number' ? msg.state.at : now;
      const offset = clockOffset(session);
      const { at: _, ...rest } = msg.state;
      const state = { ...rest, url: cleanUrl(sender.tab.url), seq: session.seq, ...(offset != null && { sentAt: at + offset }) };
      session.lastState = { ...state, localAt: at }; // permite al anfitrión retomar si recarga la página
      wsSend({ type: 'state', state });
      return;
    }
    case 'report':
      if (fromSessionTab && (session.primary == null || sender.frameId === session.primary)) wsSend(msg);
      return;
    case 'chat':
    case 'reaction':
      if (fromSessionTab) wsSend(msg);
      return;
    case 'autojoin':
      if (session && session.code === msg.code && session.status !== 'error') {
        if (session.tabId !== tabId) {
          // La sesión se muda de pestaña: la anterior deja de mostrar la interfaz.
          chrome.tabs.sendMessage(session.tabId, { type: 'session', active: false }).catch(() => {});
          resetFrames(session);
        }
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
      leave();
      reply({ ok: true });
      return;
    case 'go-to-host':
      if (isWeb(session?.lastState?.url)) chrome.tabs.update(session.tabId, { url: session.lastState.url, active: true });
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) leave();
});

// Cuando la pestaña navega a otra página, los content scripts nuevos piden estado con 'hello';
// esto cubre los que ya estaban cargados.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (session?.tabId !== tabId) return;
  if (info.url) resetFrames(session); // página nueva: frames nuevos, nueva elección
  if (info.status === 'complete') toTab(sessionInfo());
});

// Si el service worker se reinició en mitad de una sesión, vuelve a entrar en la sala (o repite la
// acción inicial si murió antes de recibir 'joined').
chrome.storage.session.get('resume').then(({ resume }) => {
  if (!resume || session) return;
  const gen = startGen;
  chrome.tabs
    .get(resume.tabId)
    .then(() => {
      if (session || gen !== startGen) return; // entretanto se empezó otra sesión
      if (resume.code) start(resume.tabId, { type: 'join', code: resume.code }, resume);
      else if (resume.initial) start(resume.tabId, resume.initial);
      else chrome.storage.session.remove('resume');
    })
    .catch(() => chrome.storage.session.remove('resume'));
});
