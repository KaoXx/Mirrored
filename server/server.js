// Mirrored — servidor de sincronización (relay WebSocket).
// Salas identificadas por un código corto. El primero en entrar es el anfitrión.
// El servidor guarda el último estado de reproducción para que quien llegue tarde
// se ponga al día al instante, y numera las acciones (seq) para descartar latidos antiguos.
//
// Token de reconexión (opcional, compatible con clientes que no lo usan):
//  - `joined` incluye `token` (32 hex) propio de esa conexión en esa sala.
//  - Al reconectar, el cliente envía {type:'join', code, rejoin:true, wasHost, allControl, token}.
//    Si en la sala sigue la conexión antigua ("fantasma") con ese token, se retira sin ruido, se cierra
//    y la nueva ocupa su lugar (si era anfitriona, la nueva es anfitriona). El token se conserva.
//  - Tras reiniciarse el servidor los tokens se pierden: sigue valiendo `rejoin`+`wasHost` durante 60 s.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const PROTOCOL = 2; // súbelo cuando cambie el protocolo; las extensiones viejas verán "Actualiza la extensión"
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const REACTIONS = ['😂', '😱', '❤️', '👏', '🔥', '😮', '🙄', '💀'];
const STATUSES = ['ok', 'behind', 'ad', 'buffering', 'novideo', 'needclick'];
const MAX_MSGS_PER_10S = 60;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 20;
const MAX_FAILED_JOINS = Number(process.env.MAX_FAILED_JOINS) || 20; // por IP en FAIL_WINDOW
const FAIL_WINDOW = 10 * 60000;
const NO_ROOM = 'La sesión no existe (o ya terminó).';

// Último recurso: un fallo inesperado no debe tumbar el servidor (y a todas las salas con él).
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// Texto seguro a partir de datos del cliente (String() sobre objetos hostiles puede lanzar).
const str = (v, n) => (typeof v === 'string' ? v : '').trim().slice(0, n);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** @type {Map<string, any>} */
const rooms = new Map();
const conns = new Map(); // ip -> conexiones abiertas
const fails = new Map(); // ip -> { start, count, blockedUntil }

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  return first || req.socket.remoteAddress || '?';
}

function blocked(ip, now) {
  const f = fails.get(ip);
  return !!f && f.blockedUntil > now;
}

function failJoin(ip, now) {
  let f = fails.get(ip);
  if (!f || now - f.start > FAIL_WINDOW) fails.set(ip, (f = { start: now, count: 0, blockedUntil: 0 }));
  if (++f.count > MAX_FAILED_JOINS) f.blockedUntil = now + FAIL_WINDOW;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  for (const c of room.clients) if (c !== except) send(c, msg);
}

// Estado actual extrapolado: si está reproduciéndose, avanza el tiempo transcurrido.
// `sentAt` (hora del servidor) indica a qué instante corresponde `time`.
function currentState(room) {
  if (!room.state) return null;
  const s = { ...room.state };
  const now = Date.now();
  if (!s.paused) s.time += ((now - s.sentAt) / 1000) * (s.rate || 1);
  s.sentAt = now;
  return s;
}

function peers(room) {
  return {
    type: 'peers',
    peers: [...room.clients].map((c) => ({ id: c.id, name: c.name, host: c === room.host, status: c.report?.status || null, drift: c.report?.drift ?? null })),
  };
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  if (room.clients.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === ws) {
    // Si vuelve con su token en 30 s (p. ej. Chrome reinició el service worker), recupera el mando.
    if (ws.token) room.departedHost = { token: ws.token, until: Date.now() + 30000 };
    room.host = room.clients.values().next().value;
    send(room.host, { type: 'role', role: 'host' });
  }
  broadcast(room, peers(room));
}

function join(ws, room, name, token) {
  leave(ws);
  ws.name = str(name, 30) || 'Invitado';
  ws.room = room;
  ws.report = null;
  ws.token = token || crypto.randomBytes(16).toString('hex');
  room.clients.add(ws);
  if (!room.host) room.host = ws;
  const role = room.host === ws ? 'host' : 'guest';
  send(ws, {
    type: 'joined', code: room.code, role, id: ws.id, seq: room.seq, token: ws.token,
    allControl: room.allControl, state: currentState(room), chat: room.chat.slice(-30),
  });
  broadcast(room, peers(room));
}

function handle(ws, msg, now) {
  const room = ws.room;
  switch (msg.type) {
    case 'create':
    case 'join': {
      if (msg.v !== PROTOCOL) return send(ws, { type: 'error', message: 'Actualiza la extensión Mirrored: tu versión no es compatible con el servidor.' });
      if (msg.type === 'create') {
        const r = { code: newCode(), clients: new Set(), host: null, state: null, seq: 0, allControl: !!msg.allControl, chat: [] };
        rooms.set(r.code, r);
        join(ws, r, msg.name);
        return;
      }
      // Una IP bloqueada puede seguir volviendo a salas que existen (reconexiones), no probar códigos.
      if (blocked(ws.ip, now) && !(msg.rejoin && rooms.has(str(msg.code, 16).toUpperCase()))) {
        return send(ws, { type: 'error', message: NO_ROOM });
      }
      const code = str(msg.code, 16).toUpperCase();
      if (!CODE_RE.test(code)) {
        failJoin(ws.ip, now);
        return send(ws, { type: 'error', message: NO_ROOM });
      }
      let r = rooms.get(code);
      // Tras reiniciarse el servidor (redespliegue, Render dormido…) las salas se pierden:
      // quien vuelve a una sala en la que ya estaba la recrea con el mismo código.
      // Cuenta como intento fallido para que `rejoin` no sirva para sondear códigos sin límite.
      if (!r && msg.rejoin) {
        failJoin(ws.ip, now);
        r = { code, clients: new Set(), host: null, state: null, seq: 0, allControl: !!msg.allControl, chat: [], restoredAt: now };
        rooms.set(code, r);
      }
      if (!r) {
        failJoin(ws.ip, now);
        return send(ws, { type: 'error', message: NO_ROOM });
      }
      // Reconexión con token: la conexión antigua (fantasma) se retira sin reelegir anfitrión.
      const token = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? msg.token : null;
      const ghost = token && [...r.clients].find((c) => c !== ws && c.token === token);
      if (ghost) {
        r.clients.delete(ghost);
        ghost.room = null;
        if (r.host === ghost) r.host = null; // join() hará anfitriona a la nueva conexión
        ghost.terminate();
        join(ws, r, msg.name, token);
        return;
      }
      // El anfitrión que se fue hace menos de 30 s vuelve con su token: recupera el mando.
      const back = token && r.departedHost?.token === token && now < r.departedHost.until;
      if (back) r.departedHost = null;
      // Durante el primer minuto tras recrearla, el anfitrión original recupera el mando.
      const reclaim = (back || (msg.rejoin && msg.wasHost && r.restoredAt && now - r.restoredAt < 60000)) && r.host && r.host !== ws;
      const prevHost = r.host;
      join(ws, r, msg.name, back ? token : undefined);
      if (reclaim) {
        r.host = ws;
        send(prevHost, { type: 'role', role: 'guest' });
        send(ws, { type: 'role', role: 'host' });
        broadcast(r, peers(r));
      }
      return;
    }
    case 'state': {
      const st = msg.state;
      if (!room || !st || typeof st !== 'object') return;
      const { url, time, paused, rate, duration, reason, seq, sentAt } = st;
      const heartbeat = reason === 'heartbeat';
      const isHost = room.host === ws;
      if (!isHost && (heartbeat || !room.allControl)) return;
      // Hasta 1e10 s: los directos DASH usan como tiempo los segundos desde 1970 (~1,7e9).
      if (num(time) === null || time < 0 || time > 1e10) return;
      // Un latido basado en un estado anterior a la última acción llegaría con datos viejos: se descarta.
      if (heartbeat && seq !== room.seq) return;
      if (!heartbeat) room.seq++;
      const u = str(url, 2000);
      const d = num(duration);
      room.state = {
        url: /^https?:\/\//i.test(u) ? u : '', time, paused: !!paused,
        rate: num(rate) === null ? 1 : Math.min(16, Math.max(0.0625, rate)),
        duration: d !== null && d > 0 ? d : null, reason: str(reason, 20), seq: room.seq, by: ws.name, fromHost: isHost,
        // Instante (reloj del servidor) al que corresponde `time`, estimado por el cliente. Si no viene o
        // no es creíble (reloj mal sincronizado), usamos la llegada.
        sentAt: num(sentAt) !== null && Math.abs(now - sentAt) < 5000 ? Math.min(sentAt, now) : now,
      };
      if (!heartbeat) send(ws, { type: 'ack', seq: room.seq });
      broadcast(room, { type: 'state', state: room.state }, ws);
      return;
    }
    case 'settings': {
      if (!room || room.host !== ws) return;
      room.allControl = !!msg.allControl;
      broadcast(room, { type: 'settings', allControl: room.allControl });
      return;
    }
    case 'chat': {
      const text = str(msg.text, 300);
      if (!room || !text) return;
      const m = { type: 'chat', id: ws.id, name: ws.name, text, at: now };
      room.chat.push(m);
      if (room.chat.length > 100) room.chat.shift();
      broadcast(room, m);
      return;
    }
    case 'reaction': {
      if (!room || !REACTIONS.includes(msg.emoji)) return;
      broadcast(room, { type: 'reaction', id: ws.id, name: ws.name, emoji: msg.emoji });
      return;
    }
    case 'report': {
      if (!room || !STATUSES.includes(msg.status)) return;
      const d = num(msg.drift);
      const drift = d === null ? null : Math.round(Math.max(-1e5, Math.min(1e5, d)) * 10) / 10;
      const prev = ws.report;
      ws.report = { status: msg.status, drift };
      // Solo avisa a los demás si el cambio es visible.
      if (!prev || prev.status !== msg.status || Math.abs((prev.drift || 0) - (drift || 0)) >= 1) broadcast(room, peers(room));
      return;
    }
    case 'leave':
      leave(ws);
      return;
    case 'ping':
      // Con la hora del servidor: el cliente estima la diferencia de relojes (tipo NTP).
      send(ws, { type: 'pong', t0: num(msg.t0), t: Date.now() });
      return;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, protocol: PROTOCOL }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Mirrored sync server funcionando.\n');
});
server.on('error', (e) => console.error('server error', e));

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('error', (e) => console.error('wss error', e));
let nextId = 1;

wss.on('connection', (ws, req) => {
  // Tramas inválidas, mensajes > maxPayload, ECONNRESET…: se cierra esa conexión y listo.
  ws.on('error', () => ws.terminate());
  const ip = clientIp(req);
  const open = conns.get(ip) || 0;
  if (open >= MAX_CONN_PER_IP) return ws.close(1008, 'Demasiadas conexiones');
  conns.set(ip, open + 1);
  ws.ip = ip;
  ws.id = nextId++;
  ws.isAlive = true;
  ws.budget = { start: Date.now(), count: 0 };
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    // Límite simple de mensajes por conexión.
    const now = Date.now();
    if (now - ws.budget.start > 10000) ws.budget = { start: now, count: 0 };
    if (++ws.budget.count > MAX_MSGS_PER_10S) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    try {
      handle(ws, msg, now);
    } catch (e) {
      console.error('Error procesando mensaje', e);
    }
  });

  ws.on('close', () => {
    const n = (conns.get(ip) || 1) - 1;
    if (n > 0) conns.set(ip, n);
    else conns.delete(ip);
    try {
      leave(ws);
    } catch (e) {
      console.error('Error al salir', e);
    }
  });
});

// Cierra conexiones muertas y limpia los contadores por IP caducados.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
  const now = Date.now();
  for (const [ip, f] of fails) if (f.blockedUntil <= now && now - f.start > FAIL_WINDOW) fails.delete(ip);
}, 30000);

server.listen(PORT, () => console.log(`Mirrored server escuchando en :${PORT}`));
