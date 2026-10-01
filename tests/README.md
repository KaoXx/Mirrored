# Pruebas end-to-end

`tests/e2e.mjs` abre tres navegadores (Anfitrion, Invitado, Invitado2) con la extensión de `extension/` cargada, entra en un episodio real de https://laisla.wtf y maneja las sesiones desde el service worker de la extensión. Imprime `PASS`/`FAIL` por comprobación y un resumen; sale con código 1 si algo falla.

## Preparación

```sh
npm install
npx playwright install chromium
```

## Ejecutar

```sh
npm test              # servidor por defecto de la extensión (Render)
npm run test:local    # levanta server/server.js en :8799 y conecta a ws://localhost:8799
```

Variables de entorno:

- `ONLY=S3,S5`: solo esos escenarios.
- `SERVER=local`: igual que `npm run test:local`.
- `BROWSER=brave`: usa Brave instalado (o `BROWSER_PATH=<ruta al ejecutable>`). Por defecto, el Chromium de Playwright.
- `HEADFUL=1`: muestra las ventanas.
- `DEBUG=1`: vuelca los logs `[MR]` de las páginas y la salida del servidor local.
- `EXT=<carpeta>`: otra extensión desempaquetada. `PROF=<carpeta>`: dónde van los perfiles.

Los perfiles y capturas se guardan en `<tmp>/mirrored-e2e/` y se borran al empezar, nunca dentro del repo.

Ejemplo en PowerShell: `$env:ONLY='S9,S13'; npm run test:local`.

## Escenarios

- **S1** Sincronía básica con 3 personas: pausa, saltos, velocidad, invitado sin permiso, toques rápidos y deriva a 30 s.
- **S2** "Todos controlan": los invitados saltan, pausan y cambian velocidad; al desactivarlo dejan de mandar.
- **S3** Invitado entra sin haber pulsado play con el anfitrión reproduciendo: no hace play en vacío, estado `novideo`/`needclick`, aviso "Pulsa play".
- **S4** Igual con el anfitrión en pausa: no pide clic hasta que el anfitrión da play.
- **S5** Recarga del invitado y clic en el aviso de Mirrored: lleva al vídeo y el aviso vuelve mientras falte la fuente.
- **S6** Recarga del invitado y clic en el reproductor: sincroniza sin avisos indebidos.
- **S7** "Todos controlan" + invitado sin fuente que pulsa play: no arrastra al anfitrión al inicio.
- **S8** Red lenta: el invitado informa `buffering`, el anfitrión espera (máx. 15 s) y luego se resincronizan.
- **S9** Chat y reacciones: entrega, reacciones no permitidas descartadas e historial para quien entra tarde.
- **S10** Cambio de episodio: los invitados siguen al anfitrión y sincronizan en el nuevo.
- **S11** Recarga del anfitrión: el invitado no salta y el anfitrión retoma donde iba la sala.
- **S12** El anfitrión se va: un invitado pasa a anfitrión y controla.
- **S13** Código de sala inválido: error "La sesión no existe" sin tocar la página.
- **S14** Acciones inmediatamente después de un cambio remoto (150 ms): se propagan si hay permiso y se revierten si no.
- **S15** Descarga colgada (la petición del vídeo no responde ni falla): el invitado reintenta solo y se sincroniza.
- **S16** Panel: clic en el indicador lo pliega, arrastrarlo lo mueve, la posición se recuerda; el aviso enmarca el vídeo.
- **S17** Estado `needclick`: el anfitrión ve "1 sin pulsar play" y el invitado "Pulsa play en el vídeo".
- **S18** Iframes: con un "anuncio" en autoplay dentro de un iframe de otro origen, solo el frame principal muestra el panel y sincroniza; el anuncio ni mueve al invitado ni es controlado. Sin el vídeo principal, el panel pasa al iframe; y si un anuncio grande gana la elección, pulsar play en el vídeo bueno lo reclama.
- **S19** El anfitrión cambia de página: dentro del mismo sitio el invitado le sigue solo; si se va a otra web (localhost → 127.0.0.1) el invitado no navega, ve el aviso pulsable "El anfitrión se ha ido a…" y al pulsarlo va allí.
- **S20** Enlace de invitación `#mirrored=CÓDIGO`: al abrirlo se une solo como invitado, el código desaparece de la URL y, tras salir, un `hashchange` o volver atrás no le vuelve a unir.
- **S21** Recarga de la extensión con sesión activa: el content script huérfano quita su interfaz, no lanza errores "Extension context invalidated" y el vídeo sigue funcionando a mano.

S18–S21 usan páginas propias (`tests/fixtures/`) que la prueba sirve en `http://localhost:8801` y `http://127.0.0.1:8801` (dos orígenes distintos), con vídeos locales (`main.webm`, `short.webm`; se regeneran con `node tests/fixtures/make-videos.mjs`). Con `--load-extension`, `chrome.runtime.reload()` descarga la extensión sin volver a cargarla, así que S21 relanza después el navegador del invitado.

## Avisos

S1–S17 dependen de que laisla.wtf y archive.org (de donde sale su mp4) estén accesibles; S18–S21 solo necesitan el puerto 8801 libre. Con la red inestable pueden salir fallos esporádicos de buffering o de sincronía; si un escenario falla suelto, repítelo con `ONLY=` antes de darlo por roto.

## Empaquetar para la tienda

`npm run zip` genera `store/mirrored-<versión>.zip` con el contenido de `extension/` en la raíz.
