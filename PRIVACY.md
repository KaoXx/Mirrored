# Política de privacidad de Mirrored

_Última actualización: 30 de septiembre de 2026_

Mirrored es una extensión de navegador que sincroniza la reproducción de un vídeo entre varias personas
que lo están viendo cada una en su propio navegador. Esta política explica qué datos maneja y para qué.

## Qué datos se envían al servidor de sincronización

Mientras participas en una sesión, la extensión envía al servidor de Mirrored
(`mirrored-server.onrender.com`, o el servidor que tú configures):

- **El nombre que escribes** en la extensión, para que los demás participantes sepan quién eres.
- **La dirección (URL) de la página del vídeo** del anfitrión y, si está activado «Todos pueden pausar y
  saltar», la de cualquier participante que pause o salte, para que los demás puedan abrir la misma página.
  Antes de enviarla se eliminan el fragmento `#mirrored=…` y los parámetros que suelen llevar credenciales
  (`token`, `access_token`, `id_token`, `auth_token`).
- **El estado del reproductor:** posición, pausa/reproducción, velocidad y duración del vídeo, y si
  estás sincronizado, cargando, viendo un anuncio o tienes que pulsar play.
- **Los mensajes de chat y las reacciones** que envías en la sesión.

Además, al abrir la ventana de la extensión se hace una petición a `/health` del servidor para comprobar si
está despierto. No incluye ningún dato tuyo (solo llega, como en cualquier conexión, tu dirección IP).

## Cómo se guardan

- Todo se guarda **solo en la memoria del servidor** y únicamente mientras la sesión existe
  (el chat conserva como mucho los últimos 100 mensajes). Cuando sale el último participante, la sesión
  y todos sus datos se borran. **Nada se escribe en disco** ni se guarda en bases de datos.
- Los datos solo se envían a los demás participantes de tu sesión, que conocen su código.
- **No se venden ni se comparten con terceros**, no se usan para publicidad ni para crear perfiles, y
  no se usan para ningún fin distinto de la sincronización.
- La conexión con el servidor por defecto está cifrada (WSS/HTTPS); si configuras otro servidor, depende de él.
- Como cualquier servidor de internet, el de Mirrored y su proveedor de alojamiento (Render) reciben la
  dirección IP desde la que te conectas y pueden conservarla en sus registros técnicos.

## Qué se guarda en tu navegador

La extensión guarda localmente, con el almacenamiento de extensiones del navegador:
tu nombre, la dirección del servidor, la posición del panel de chat y, durante una sesión, su código y un
identificador de reconexión para poder volver a entrar si se corta la conexión.
Nada de esto sale de tu navegador salvo en los casos descritos arriba.

## Lo que la extensión no hace

- No lee ni envía el contenido de las páginas que visitas, tus contraseñas, formularios ni cookies.
- De tu navegación, solo se envía la URL de la pestaña en la que has iniciado o te has unido a una sesión,
  y solo mientras esa sesión está activa. Las demás pestañas y páginas no se envían nunca.
- No retransmite ni copia el vídeo: cada persona lo reproduce desde la web original.

## Contacto

Para cualquier duda sobre privacidad, abre una incidencia en https://github.com/KaoXx/Mirrored/issues
