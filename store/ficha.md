# Ficha para la Chrome Web Store — Mirrored 0.5.0

Copia cada bloque en el campo del panel de desarrollador que indica el título.
Paquete a subir: `store/mirrored-0.5.0.zip`.

---

## Pestaña «Ficha de Play Store» / «Store listing»

### Nombre (sale del manifest, no se edita aquí)
```
Mirrored: vídeo sincronizado en grupo
```

### Resumen (sale del manifest, 130/132 caracteres)
```
Reproduce vídeos en perfecta sincronía con otras personas, cada una desde su navegador. Con chat, reacciones y control compartido.
```

### Descripción
```
Mirrored os permite ver el mismo vídeo a la vez aunque estéis en casas distintas. Cada persona lo reproduce en su propio navegador, desde la web original y con su propia cuenta, y Mirrored mantiene a todos en el mismo segundo.

CÓMO FUNCIONA
1. Abre el vídeo en la web donde lo veas normalmente.
2. Pulsa el icono de Mirrored y crea una sesión.
3. Copia el enlace de invitación y compártelo. Quien lo abra con la extensión instalada entra automáticamente (también puede unirse escribiendo el código de 6 letras).

QUÉ INCLUYE
• Sincronización de play, pausa, saltos y velocidad para todos los participantes.
• Chat y reacciones encima del vídeo, también en pantalla completa. Mientras escribes, las teclas no llegan al reproductor.
• Estado de cada persona: sincronizada, cargando, viendo un anuncio, pendiente de pulsar play o cuántos segundos va por detrás.
• Panel plegable y movible, para que no tape la web.
• Espera automática: si alguien se queda cargando, se pausa a todos hasta que esté listo.
• Siguiente episodio: cuando el anfitrión cambia de vídeo, los invitados le siguen.
• Modo «todos controlan», para que cualquiera pueda pausar o saltar.
• Reconexión automática si se corta la conexión.

BUENO SABER
• Mirrored no retransmite ni copia el vídeo: cada persona necesita poder verlo por su cuenta en esa web (su suscripción, su región, etc.).
• Funciona con la mayoría de webs que usan el reproductor de vídeo HTML5 estándar. Algunos reproductores no permiten que se controle la posición desde fuera; en esos casos la sincronización puede fallar.
• Los anuncios de cada persona pueden ser distintos: mientras alguien ve un anuncio, Mirrored no le mueve, y lo sincroniza al terminar.

PRIVACIDAD
Mientras estás en una sesión se envían al servidor de sincronización tu nombre, la dirección de la página del vídeo, el estado del reproductor, los mensajes de chat y las reacciones, y solo para compartirlos con los participantes de esa sesión. Nada se guarda en disco y todo se borra al acabar la sesión (el proveedor de alojamiento puede registrar tu dirección IP, como cualquier servidor web). No hay publicidad ni seguimiento. Si lo prefieres, puedes usar tu propio servidor (apartado «Servidor» de la extensión).

Código fuente: https://github.com/KaoXx/Mirrored

Vídeo de ejemplo en las capturas: Big Buck Bunny © Blender Foundation (CC BY 3.0).
```

### Categoría
`Estilo de vida → Entretenimiento` (Lifestyle → Entertainment)

### Idioma
`Español`

### Recursos gráficos (carpeta `store/`)
| Campo | Fichero |
|---|---|
| Icono de la tienda (128×128) | `extension/icons/icon128.png` |
| Capturas de pantalla (1280×800) | `captura-1-sincronia.png`, `captura-2-chat.png`, `captura-3-invitar.png` (en ese orden) |
| Mosaico promocional pequeño (440×280) | `promo-pequena-440x280.png` |
| Mosaico de marquesina (1400×560, opcional) | `promo-marquesina-1400x560.png` |
| Vídeo promocional de YouTube | vacío |

### Sitio web oficial
Déjalo vacío (requiere verificar un dominio en Search Console).

### URL de la página principal
```
https://github.com/KaoXx/Mirrored
```

### URL de asistencia
```
https://github.com/KaoXx/Mirrored/issues
```

### Contenido para adultos
`No`

---

## Pestaña «Prácticas de privacidad» / «Privacy»

### Descripción del propósito único (Single purpose)
```
Mirrored tiene un único propósito: sincronizar la reproducción de un vídeo HTML5 entre varias personas que lo están viendo a la vez en sus propios navegadores, con un chat y reacciones para la sesión.
```

### Justificación del permiso `storage`
```
Se usa para guardar localmente el nombre que el usuario elige, la dirección del servidor de sincronización, la posición del panel de chat y, durante una sesión activa, su código y un identificador de reconexión, para poder reconectarse si el navegador reinicia la extensión.
```

### Justificación del permiso de host (`<all_urls>`, host_permissions y content script)
```
Mirrored sincroniza vídeos en cualquier web de vídeo y no es posible saber de antemano cuáles (el usuario elige la web). El content script se inyecta en todas las páginas y sus iframes porque muchos reproductores van dentro de un iframe de otro dominio, y porque los invitados se unen abriendo un enlace de invitación (#mirrored=CÓDIGO) que el script debe detectar al cargar la página sin que el usuario pulse nada; activeTab no cubre ninguno de estos dos casos. El script solo busca el elemento <video>, lee y ajusta su posición, pausa y velocidad, y muestra el chat encima. No lee ni modifica otro contenido de la página. La URL de la pestaña solo se usa durante una sesión activa, para compartir con sus participantes la página del vídeo. Fuera de una sesión, el script no envía nada a ningún servidor.
```

### ¿Usas código remoto?
`No, no uso código remoto.`

### Uso de datos: marca estas casillas
- [x] **Información personal identificable** — el nombre para mostrar que escribe el usuario.
- [x] **Comunicaciones personales** — los mensajes de chat de la sesión.
- [x] **Historial web** — la URL de la página del vídeo durante una sesión.
- [x] **Actividad del usuario** — las acciones de reproducción (play, pausa, saltos) que se comparten con la sesión.
- [x] **Ubicación** — el servidor y su proveedor de alojamiento ven la dirección IP (Google la cuenta como ubicación).
- [ ] El resto (salud, finanzas, autenticación, contenido del sitio web): **sin marcar**.

Y las tres certificaciones:
- [x] No vendo ni transfiero los datos de los usuarios a terceros, salvo en los casos de uso aprobados.
- [x] No uso ni transfiero los datos de los usuarios para fines no relacionados con el propósito único del elemento.
- [x] No uso ni transfiero los datos de los usuarios para determinar la solvencia económica ni para conceder préstamos.

### URL de la política de privacidad
```
https://github.com/KaoXx/Mirrored/blob/main/PRIVACY.md
```

---

## Pestaña «Distribución»

- **Visibilidad:** `Público` (o `No listado` si solo quieres que la instale quien tenga el enlace; la revisión es la misma).
- **Regiones:** `Todas las regiones`.
- **Pago:** gratuito.

## Cuenta: declaración de comerciante (UE)

Si el panel te pide la declaración de comerciante, marca **«No soy comerciante»** siempre que no cobres nada
ni la publiques como empresa o autónomo.

---

## Instrucciones de prueba para el revisor (campo «Test instructions»)

```
No hace falta cuenta ni credenciales.

1. Instala la extensión en dos perfiles de Chrome distintos (o en dos ordenadores).
2. En el perfil A, abre cualquier página con un vídeo HTML5, por ejemplo https://www.w3schools.com/html/html5_video.asp, pulsa el icono de Mirrored, escribe un nombre y pulsa «Crear sesión en esta pestaña».
   Nota: el servidor de sincronización está en un plan gratuito que se duerme tras un rato sin uso; la ventana de la extensión muestra «Despertando el servidor…» y, en menos de un minuto, «Servidor listo».
3. Pulsa «Copiar enlace de invitación» y abre ese enlace en el perfil B. Se unirá automáticamente (o pulsa el icono y escribe el código de 6 letras).
4. En el perfil A, reproduce, pausa o salta en el vídeo: el vídeo del perfil B hace lo mismo.
5. Abajo a la derecha del vídeo aparecen el chat (💬) y las reacciones.
```
