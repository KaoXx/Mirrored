# Mirrored — ver vídeos juntos

Extensión para Chrome/Brave + un pequeño servidor de sincronización. Cada persona abre la **misma página
del vídeo en su propio navegador** (con su cuenta, sus anuncios, su DRM) y la extensión mantiene
sincronizados play, pausa, saltos y velocidad. El anfitrión manda; los invitados le siguen.

Pensada para cualquier web que use un `<video>` HTML5 (Mediaset Infinity, YouTube, RTVE, Atresplayer…),
incluso si el reproductor está dentro de un iframe. Netflix no: su reproductor da error si se cambia
la posición del vídeo desde fuera.

```
extension/   → la extensión (se carga "sin empaquetar")
server/      → servidor WebSocket que reenvía el estado entre los participantes
```

## 1. El servidor

### En Render (recomendado, gratis)

1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. En [render.com](https://render.com) → **New → Blueprint** → elige el repositorio. Render lee
   `render.yaml` y crea el servicio `mirrored-server` (plan gratuito, Frankfurt).
3. Cuando termine tendrás una URL tipo `https://mirrored-server-xxxx.onrender.com`.
   Comprueba `…/health`. En la extensión se usa como `wss://mirrored-server-xxxx.onrender.com`.

El plan gratuito se duerme tras 15 min sin uso. La extensión lo despierta al abrir el popup y
reintenta durante ~1 min y medio, así que la primera conexión del día puede tardar un poco.

### En tu PC (para pruebas)

```bash
cd server
npm install
npm start          # escucha en el puerto 8787 (cámbialo con PORT=xxxx)
```

Para que entren amigos desde fuera: `cloudflared tunnel --url http://localhost:8787` y usa
`wss://…trycloudflare.com` (la URL cambia cada vez).

### En la Orange Pi / Docker

```bash
docker build -t mirrored-server server/
docker run -d --name mirrored --restart unless-stopped -p 8787:8787 mirrored-server
```
y publícalo con un túnel de Cloudflare con nombre (necesita dominio) o un proxy inverso con HTTPS.

## 2. Instalar la extensión (tú y cada invitado)

Cuando esté aprobada en la Chrome Web Store, basta con instalarla desde allí (sirve también para Brave).
Mientras tanto, o para desarrollo:

1. Abre `chrome://extensions` (o `brave://extensions`).
2. Activa **Modo desarrollador**.
3. **Cargar descomprimida** → elige la carpeta `extension/`.
4. Ya viene configurada con el servidor `wss://mirrored-server.onrender.com`. Solo si usas otro,
   cámbialo en el icono de Mirrored → **Servidor**.

Al actualizar la extensión, cada uno debe pulsar el botón ↻ de Mirrored en `brave://extensions`.
Si alguien tiene una versión incompatible con el servidor, verá "Actualiza la extensión".

## 3. Ver algo juntos

**Anfitrión**
1. Abre la página del vídeo (p. ej. el episodio en mediasetinfinity.es).
2. Icono de Mirrored → escribe tu nombre → **Crear sesión en esta pestaña**.
3. **Copiar enlace de invitación** y mándalo por WhatsApp.

**Invitados**
- Abren el enlace (lleva `#mirrored=CÓDIGO` al final) con la extensión instalada y se unen solos.
- O abren la misma página, pulsan el icono y escriben el código.
- Si el navegador bloquea la reproducción automática, sale un aviso arriba a la derecha:
  un clic y se sincroniza.

### Qué hace durante la sesión

- **Anfitrión al mando:** si un invitado pausa o salta, vuelve a donde está el anfitrión.
  Marca **Todos pueden pausar y saltar** (al crear o durante la sesión) para que controle cualquiera.
- **Chat y reacciones** abajo a la derecha del vídeo (también en pantalla completa). 💬 abre el chat;
  Enter envía, Esc cierra. Mientras escribes, las teclas no llegan al reproductor.
- **Estado de cada uno:** en el vídeo ves si estás sincronizado, cargando, en un anuncio o cuántos
  segundos vas por detrás. En el popup ves lo mismo de cada participante.
- **Espera a quien carga:** si un invitado lleva más de 2 s cargando, se pausa a todos hasta que
  esté listo (máximo 15 s; después se sigue y se le pone al día).
- **Siguiente episodio:** si el anfitrión cambia de vídeo, los invitados que estaban en el anterior
  van detrás automáticamente.
- Si el anfitrión se va, el siguiente participante pasa a ser anfitrión. Si se corta la conexión,
  se reconecta sola a la misma sala.

## Limitaciones

- **Cada persona necesita acceso al contenido.** Mediaset Infinity solo funciona desde España
  (o con VPN), y si el vídeo pide cuenta, cada uno necesita la suya. La extensión no retransmite el vídeo.
- **Anuncios:** cada uno puede ver anuncios distintos. Si anfitrión e invitado están en vídeos de
  distinta duración (uno en un anuncio), la extensión no toca nada. Al volver ambos al episodio se
  resincroniza sola (latido cada 2 s, tolera 1 s de desfase).
- Reproductores que meten el `<video>` en shadow DOM cerrado no se detectan (es raro).
- Si un reproductor pone a pantalla completa el propio `<video>` (y no su contenedor), el chat y
  las reacciones no se ven en pantalla completa; la sincronización sigue funcionando.

## Si Mediaset no se ve en Brave

Suele ser una de estas cosas, no la extensión:
0. **VPN o IP de centro de datos:** si sale "Vuelve a intentarlo después de desconectar la VPN",
   Mediaset ha detectado una VPN (OpenVPN, WireGuard, Brave VPN…). Desconéctala.
1. **Widevine desactivado:** `brave://settings/extensions` → activa *Widevine* y reinicia Brave.
2. **Shields:** pulsa el león en mediasetinfinity.es → desactiva Shields para ese sitio.

## Privacidad

Ver [PRIVACY.md](PRIVACY.md).

## Publicar en la Chrome Web Store

Textos de la ficha, gráficos y paquete en [store/](store/) (ver `store/ficha.md`).
El ZIP se genera con `extension/` en la raíz y rutas con `/`.
