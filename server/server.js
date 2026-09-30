// Mirrored — servidor de sincronización (relay WebSocket).
// Salas identificadas por un código corto. El primero en entrar es el anfitrión.
// El servidor guarda el último estado de reproducción para que quien llegue tarde
// se ponga al día al instante, y numera las acciones (seq) para descartar latidos antiguos.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const PROTOCOL = 2; // súbelo cuando cambie el protocolo; las extensiones viejas verán "Actualiza la extensión"
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REACTIONS = ['😂', '😱', '❤️', '👏', '🔥', '😮', '🙄', '💀'];
const STATUSES = ['ok', 'behind', 'ad', 'buffering', 'novideo'];
const MAX_MSGS_PER_10S = 60;

/** @type {Map<string, any>} */
const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  for (const c of room.clients) if (c !== except) send(c, msg);
}

// Estado actual extrapolado: si está reproduciéndose, avanza el tiempo transcurrido.
function currentState(room) {
  if (!room.state) return null;
  const s = { ...room.state };
  if (!s.paused) s.time += ((Date.now() - room.stateAt) / 1000) * (s.rate || 1);
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
    room.host = room.clients.values().next().value;
    send(room.host, { type: 'role', role: 'host' });
  }
  broadcast(room, peers(room));
}

function join(ws, room, name) {
  leave(ws);
  ws.name = String(name || 'Invitado').trim().slice(0, 30) || 'Invitado';
  ws.room = room;
  ws.report = null;
  room.clients.add(ws);
  if (!room.host) room.host = ws;
  const role = room.host === ws ? 'host' : 'guest';
  send(ws, {
    type: 'joined', code: room.code, role, id: ws.id, seq: room.seq,
    allControl: room.allControl, state: currentState(room), chat: room.chat.slice(-30),
  });
  broadcast(room, peers(room));
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

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
let nextId = 1;

wss.on('connection', (ws) => {
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
    const room = ws.room;
    switch (msg.type) {
      case 'create':
      case 'join': {
        if (msg.v !== PROTOCOL) return send(ws, { type: 'error', message: 'Actualiza la extensión Mirrored: tu versión no es compatible con el servidor.' });
        if (msg.type === 'create') {
          const r = { code: newCode(), clients: new Set(), host: null, state: null, stateAt: 0, seq: 0, allControl: !!msg.allControl, chat: [] };
          rooms.set(r.code, r);
          join(ws, r, msg.name);
        } else {
          const code = String(msg.code || '').toUpperCase();
          let r = rooms.get(code);
          // Tras reiniciarse el servidor (redespliegue, Render dormido…) las salas se pierden:
          // quien vuelve a una sala en la que ya estaba la recrea con el mismo código.
          if (!r && msg.rejoin && /^[A-Z0-9]{6}$/.test(code)) {
            r = { code, clients: new Set(), host: null, state: null, stateAt: 0, seq: 0, allControl: !!msg.allControl, chat: [], restoredAt: now };
            rooms.set(code, r);
          }
          if (!r) return send(ws, { type: 'error', message: 'La sesión no existe (o ya terminó).' });
          // Durante el primer minuto tras recrearla, el anfitrión original recupera el mando.
          const reclaim = msg.rejoin && msg.wasHost && r.restoredAt && now - r.restoredAt < 60000 && r.host && r.host !== ws;
          const prevHost = r.host;
          join(ws, r, msg.name);
          if (reclaim) {
            r.host = ws;
            send(prevHost, { type: 'role', role: 'guest' });
            send(ws, { type: 'role', role: 'host' });
            broadcast(r, peers(r));
          }
        }
        break;
      }
      case 'state': {
        if (!room || !msg.state) return;
        const { url, time, paused, rate, duration, reason, seq } = msg.state;
        const heartbeat = reason === 'heartbeat';
        const isHost = room.host === ws;
        if (!isHost && (heartbeat || !room.allControl)) return;
        if (typeof time !== 'number' || !isFinite(time)) return;
        // Un latido basado en un estado anterior a la última acción llegaría con datos viejos: se descarta.
        if (heartbeat && seq !== room.seq) return;
        if (!heartbeat) room.seq++;
        room.state = {
          url: String(url || '').slice(0, 2000), time, paused: !!paused, rate: Number(rate) || 1,
          duration: Number(duration) || null, reason: String(reason || '').slice(0, 20), seq: room.seq, by: ws.name, fromHost: isHost,
        };
        room.stateAt = now;
        if (!heartbeat) send(ws, { type: 'ack', seq: room.seq });
        broadcast(room, { type: 'state', state: room.state }, ws);
        break;
      }
      case 'settings': {
        if (!room || room.host !== ws) return;
        room.allControl = !!msg.allControl;
        broadcast(room, { type: 'settings', allControl: room.allControl });
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 300);
        if (!room || !text) return;
        const m = { type: 'chat', id: ws.id, name: ws.name, text, at: now };
        room.chat.push(m);
        if (room.chat.length > 100) room.chat.shift();
        broadcast(room, m);
        break;
      }
      case 'reaction': {
        if (!room || !REACTIONS.includes(msg.emoji)) return;
        broadcast(room, { type: 'reaction', id: ws.id, name: ws.name, emoji: msg.emoji });
        break;
      }
      case 'report': {
        if (!room || !STATUSES.includes(msg.status)) return;
        const drift = typeof msg.drift === 'number' && isFinite(msg.drift) ? Math.round(msg.drift * 10) / 10 : null;
        const prev = ws.report;
        ws.report = { status: msg.status, drift };
        // Solo avisa a los demás si el cambio es visible.
        if (!prev || prev.status !== msg.status || Math.abs((prev.drift || 0) - (drift || 0)) >= 1) broadcast(room, peers(room));
        break;
      }
      case 'leave':
        leave(ws);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => leave(ws));
});

// Cierra conexiones muertas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Mirrored server escuchando en :${PORT}`));
