// Genera los vídeos locales de las páginas de prueba (S18–S21): main.webm (10 min) y short.webm (8 s).
// Con vídeos locales las pruebas no dependen de archive.org, que limita las descargas simultáneas.
// Uso: node tests/fixtures/make-videos.mjs  (usa el Chromium y el ffmpeg que instala Playwright).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const pwDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ms-playwright');
const ffDir = readdirSync(pwDir).find((d) => d.startsWith('ffmpeg-'));
if (!ffDir) throw new Error('No encuentro el ffmpeg de Playwright: ejecuta `npx playwright install ffmpeg`');
const FFMPEG = path.join(pwDir, ffDir, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
async function frame(bg, text) {
  await page.setContent(`<body style="margin:0;background:${bg};color:#fff;font:bold 40px system-ui;display:grid;place-items:center;height:180px">${text}</body>`);
  return page.screenshot({ type: 'jpeg', quality: 70 });
}

// Imagen fija repetida a 2 fps, con un fotograma clave cada 5 s (para que se pueda saltar sin que pese mucho).
function encode(out, jpeg, seconds) {
  return new Promise((resolve, reject) => {
    // El ffmpeg de Playwright es mínimo: entrada solo por image2pipe, con el códec explícito y `pipe:0`.
    const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '2', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-c:v', 'libvpx', '-b:v', '8k', '-g', '10', path.join(DIR, out)]);
    ff.on('error', reject);
    ff.on('close', (code) => (code ? reject(new Error(`ffmpeg salió con ${code}`)) : resolve()));
    for (let i = 0; i < seconds * 2; i++) ff.stdin.write(jpeg);
    ff.stdin.end();
  });
}

await encode('main.webm', await frame('#1d3557', 'EPISODIO'), 600);
await encode('short.webm', await frame('#e63946', 'ANUNCIO'), 8);
await browser.close();
console.log('main.webm y short.webm generados en', DIR);
