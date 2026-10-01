// Pruebas del servidor de sincronización (sin navegador): robustez ante mensajes hostiles,
// relay de estado, validación, token de reconexión y límite de joins fallidos por IP.
// Uso: node tests/server.mjs  (lanza server/server.js en PORT=8798)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server', 'server.js'));
const WebSocket = require('ws');
const PORT = 8798;
const URL_ = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  return ok;
};

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), MAX_CONN_PER_IP: '15' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (d) => (srvOut += d));
srv.stderr.on('data', (d) => (srvOut += d));
let exited = false;
srv.on('exit', () => (exited = true));

// Cliente con cola de mensajes recibidos
function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const c = { ws, msgs: [], closed: false, closeCode: null };
    ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
    ws.on('close', (code) => ((c.closed = true), (c.closeCode = code)));
    ws.on('error', () => {});
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', () => reject(new Error('unexpected-response')));
    c.send = (m) => ws.readyState === 1 && ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    // Espera un mensaje que cumpla `pred` (posterior a `from`)
    c.wait = async (pred, ms = 2000, from = 0) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = c.msgs.slice(from).find(pred);
        if (m) return m;
        await sleep(20);
      }
      return null;
    };
    c.close = () => ws.terminate();
  });
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function alive(label) {
  const h = await health();
  let created = false;
  try {
    const c = await client();
    c.send({ type: 'create', v: 2, name: 'Sonda' });
    created = !!(await c.wait((m) => m.type === 'joined'));
    c.close();
  } catch {}
  check(`vivo tras ${label}`, !exited && h && created);
}

async function main() {
  for (let i = 0; i < 50 && !(await health()); i++) await sleep(100);
  if (!check('arranca y /health 200', await health())) return;

  // ---------- 1. mensajes hostiles ----------
  const evil = { toString: 1, valueOf: 1 };
  const host = await client();
  host.send({ type: 'create', v: 2, name: 'Ana' });
  const j = await host.wait((m) => m.type === 'joined');
  check('create → joined con token', !!j && j.role === 'host' && /^[0-9a-f]{32}$/.test(j.token || ''));
  const code = j?.code;

  const bad = await client();
  for (const m of ['null', '123', '"x"', '[]', 'true', '{"type":null}']) bad.send(m);
  bad.send({ type: 'create', v: 2, name: evil });
  bad.send({ type: 'join', v: 2, code: evil, name: evil });
  bad.send({ type: 'join', v: 2, code, name: evil, rejoin: evil, token: evil });
  bad.send({ type: 'chat', text: evil });
  bad.send({ type: 'reaction', emoji: evil });
  bad.send({ type: 'report', status: 'ok', drift: evil });
  bad.send({ type: 'ping', t0: evil });
  await sleep(200);
  await alive('null/123/"x"/[]/objetos con toString');

  // Estado hostil desde un anfitrión
  host.send({ type: 'state', state: { url: evil, time: 1, reason: evil, rate: evil, duration: evil, sentAt: evil } });
  host.send({ type: 'state', state: null });
  host.send({ type: 'state', state: 'x' });
  host.send({ type: 'settings', allControl: evil });
  await sleep(200);
  await alive('state con url/reason hostiles');

  // Trama > 16 KB
  const big = await client();
  big.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(20 * 1024) }));
  await sleep(300);
  check('trama de 20 KB cierra esa conexión', big.closed, `code=${big.closeCode}`);
  await alive('trama de 20 KB');

  // Trama inválida en bruto tras el handshake
  await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    s.once('data', () => {
      s.write(Buffer.from([0x83, 0x05, 1, 2, 3, 4, 5])); // opcode reservado, sin máscara
      setTimeout(() => (s.destroy(), resolve()), 300);
    });
    s.on('error', () => resolve());
    setTimeout(resolve, 2000);
  });
  await alive('trama inválida en bruto');
  // Reset abrupto (ECONNRESET)
  await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    s.once('data', () => (s.resetAndDestroy(), setTimeout(resolve, 200)));
    s.on('error', () => resolve());
  });
  await alive('reset de conexión');
  bad.close();

  // ---------- 2. relay y validación de estado ----------
  const guest = await client();
  guest.send({ type: 'join', v: 2, code: code.toLowerCase(), name: 'Beto' });
  const gj = await guest.wait((m) => m.type === 'joined');
  check('join (código en minúsculas) → guest', !!gj && gj.role === 'guest' && /^[0-9a-f]{32}$/.test(gj.token || '') && gj.token !== j.token);

  let from = guest.msgs.length;
  host.send({ type: 'state', state: { url: 'https://ej.com/v', time: 42, paused: false, rate: 1, duration: 100, reason: 'play' } });
  let st = await guest.wait((m) => m.type === 'state', 2000, from);
  check('relay de state', !!st && st.state.time === 42 && st.state.url === 'https://ej.com/v' && st.state.duration === 100);
  check('ack al emisor', !!(await host.wait((m) => m.type === 'ack')));

  from = guest.msgs.length;
  host.send({ type: 'state', state: { url: 'https://ej.com/v', time: -5, reason: 'seek' } });
  host.send({ type: 'state', state: { url: 'https://ej.com/v', time: 1e11, reason: 'seek' } });
  host.send({ type: 'state', state: { url: 'https://ej.com/v', time: '10', reason: 'seek' } });
  await sleep(300);
  check('time fuera de rango descartado', !guest.msgs.slice(from).some((m) => m.type === 'state'));

  from = guest.msgs.length;
  host.send({ type: 'state', state: { url: 'javascript:alert(1)', time: 5, rate: 100, duration: -1, reason: 'x'.repeat(50) } });
  st = await guest.wait((m) => m.type === 'state', 2000, from);
  check('rate limitado a 16', st?.state.rate === 16, `rate=${st?.state.rate}`);
  check('url no http vaciada', st?.state.url === '', `url=${st?.state.url}`);
  check('duration inválida → null', st?.state.duration === null);
  check('reason recortado a 20', st?.state.reason.length === 20);
  from = guest.msgs.length;
  host.send({ type: 'state', state: { url: 'data:text/html,hi', time: 5, rate: 0.001, reason: 'rate' } });
  st = await guest.wait((m) => m.type === 'state', 2000, from);
  check('rate mínimo 0.0625 y data: vaciada', st?.state.rate === 0.0625 && st?.state.url === '');
  from = guest.msgs.length;
  host.send({ type: 'state', state: { url: 'https://ej.com/v', time: 5, reason: 'pause', paused: true } });
  st = await guest.wait((m) => m.type === 'state', 2000, from);
  check('rate ausente → 1', st?.state.rate === 1);

  // report con drift enorme
  from = host.msgs.length;
  guest.send({ type: 'report', status: 'behind', drift: 1e300 });
  const pr = await host.wait((m) => m.type === 'peers' && m.peers.some((p) => p.status === 'behind'), 2000, from);
  check('drift limitado a 1e5', pr?.peers.find((p) => p.name === 'Beto')?.drift === 1e5);

  // ping/pong
  host.send({ type: 'ping', t0: 123 });
  const pong = await host.wait((m) => m.type === 'pong');
  check('pong con t y t0', !!pong && pong.t0 === 123 && typeof pong.t === 'number');

  // ---------- 3. token de reconexión ----------
  const host2 = await client();
  from = guest.msgs.length;
  host2.send({ type: 'join', v: 2, code, name: 'Ana', rejoin: true, wasHost: true, token: j.token });
  const h2j = await host2.wait((m) => m.type === 'joined');
  check('rejoin con token → host', h2j?.role === 'host' && h2j?.token === j.token, `role=${h2j?.role}`);
  await sleep(300);
  check('socket antiguo cerrado', host.closed);
  const lastPeers = guest.msgs.slice(from).filter((m) => m.type === 'peers').pop();
  const names = lastPeers?.peers.map((p) => p.name) || [];
  check(
    'guest ve un solo anfitrión y sin nombre duplicado',
    !!lastPeers && lastPeers.peers.filter((p) => p.host).length === 1 && lastPeers.peers.find((p) => p.host).name === 'Ana' && names.length === 2 && new Set(names).size === 2,
    JSON.stringify(lastPeers?.peers),
  );
  check('guest no recibe role host', !guest.msgs.slice(from).some((m) => m.type === 'role'));
  from = guest.msgs.length;
  host2.send({ type: 'state', state: { url: 'https://ej.com/v', time: 7, reason: 'seek' } });
  check('el nuevo host controla', (await guest.wait((m) => m.type === 'state', 2000, from))?.state.time === 7);
  // Un token ajeno (del guest) no roba nada si se usa desde otro socket... salvo que sea el suyo: token inválido → guest normal
  const other = await client();
  other.send({ type: 'join', v: 2, code, name: 'Otro', token: 'f'.repeat(32) });
  check('token desconocido → guest', (await other.wait((m) => m.type === 'joined'))?.role === 'guest');
  other.close();

  // El anfitrión se va del todo (sin fantasma) y vuelve con su token en < 30 s: recupera el mando
  host2.close();
  const gRole = await guest.wait((m) => m.type === 'role' && m.role === 'host', 2000);
  check('al irse el anfitrión, el guest pasa a host', !!gRole);
  const host3 = await client();
  host3.send({ type: 'join', v: 2, code, name: 'Ana', rejoin: true, wasHost: true, token: j.token });
  const h3j = await host3.wait((m) => m.type === 'joined');
  await sleep(300);
  const gBack = guest.msgs.filter((m) => m.type === 'role').pop();
  check('vuelve con token → recupera el mando', (h3j?.role === 'host' || host3.msgs.some((m) => m.type === 'role' && m.role === 'host')) && gBack?.role === 'guest', `joined=${h3j?.role} guestRole=${gBack?.role}`);
  host3.close();

  // Compat: recreación tras reinicio (sala inexistente + rejoin + wasHost)
  const r1 = await client();
  r1.send({ type: 'join', v: 2, code: 'ZZZ222', name: 'G', rejoin: true });
  const r2 = await client();
  r2.send({ type: 'join', v: 2, code: 'ZZZ222', name: 'H', rejoin: true, wasHost: true });
  const r2role = await r2.wait((m) => m.type === 'role' && m.role === 'host');
  check('rejoin recrea sala y wasHost recupera el mando', !!(await r1.wait((m) => m.type === 'joined')) && !!r2role);
  const r3 = await client();
  r3.send({ type: 'join', v: 2, code: 'ZZZ12O', name: 'X', rejoin: true });
  check('rejoin con código inválido rechazado', (await r3.wait((m) => m.type === 'error' || m.type === 'joined'))?.type === 'error');
  for (const c of [r1, r2, r3, guest, host2]) c.close();
  await sleep(200);

  // ---------- 4. límite de conexiones por IP (MAX_CONN_PER_IP=15) ----------
  const many = [];
  for (let i = 0; i < 16; i++) many.push(await client().catch(() => null));
  await sleep(300);
  const rejected = many.filter((c) => c && c.closed && c.closeCode === 1008).length;
  check('conexiones por IP limitadas', rejected === 1, `rechazadas=${rejected}`);
  many.forEach((c) => c?.close());
  await sleep(300);

  // ---------- 5. joins fallidos por IP (por defecto 20 en 10 min) ----------
  const h = await client();
  h.send({ type: 'create', v: 2, name: 'H' });
  const valid = (await h.wait((m) => m.type === 'joined')).code;
  const atk = await client();
  // Ya hubo 1 intento fallido (r3) y 1 recreación (ZZZ222) en esta ejecución: con 21 más se supera el límite
  for (let i = 0; i < 21; i++) {
    atk.send({ type: 'join', v: 2, code: 'AAAA' + CODE2(i), name: 'x' });
    await sleep(5);
  }
  await sleep(300);
  const atk2 = await client();
  atk2.send({ type: 'join', v: 2, code: valid, name: 'x' });
  const res = await atk2.wait((m) => m.type === 'error' || m.type === 'joined');
  check('tras 21 fallos, IP bloqueada incluso con código válido', res?.type === 'error', res?.type);
  h.close(); atk.close(); atk2.close();

  await alive('todas las pruebas');
}

function CODE2(i) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return cs[Math.floor(i / 32) % 32] + cs[i % 32];
}

try {
  await main();
} catch (e) {
  check('excepción en la prueba', false, e.stack);
}
srv.kill();
if (failed) console.log('\nSalida del servidor:\n' + srvOut);
console.log(failed ? `\n${failed} FALLO(S)` : '\nTodo OK');
process.exit(failed ? 1 : 0);
