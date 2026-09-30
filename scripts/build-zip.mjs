// Empaqueta extension/ en store/mirrored-<versión>.zip para subirlo a la Chrome Web Store.
// El contenido de extension/ va en la raíz del zip (manifest.json en la raíz, como exige la tienda).
// Sin dependencias: escritor ZIP mínimo con zlib (deflate) + CRC32.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'store');

// Basura que nunca debe acabar en el paquete
const IGNORE = [/^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^\.git/, /~$/, /\.swp$/, /^\._/];

const { version } = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
if (!version) throw new Error('manifest.json no tiene "version"');

function listFiles(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORE.some((re) => re.test(name))) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// Fecha/hora en formato MS-DOS
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const files = listFiles(EXT);
if (!files.some((f) => f.rel === 'manifest.json')) throw new Error('falta manifest.json en extension/');

const locals = [];
const centrals = [];
let offset = 0;
for (const { full, rel } of files) {
  const data = readFileSync(full);
  const name = Buffer.from(rel, 'utf8');
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const { time, date } = dosTime(statSync(full).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // versión necesaria
  local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // versión que lo creó
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // extra, comentario, disco, atributos internos/externos = 0
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `mirrored-${version}.zip`);
const zip = Buffer.concat([...locals, ...centrals, end]);
writeFileSync(out, zip);
console.log(`${path.relative(ROOT, out)}  (${files.length} archivos, ${(zip.length / 1024).toFixed(1)} KB)`);
for (const f of files) console.log('  ' + f.rel);
