// Mirrored — content script. Se inyecta en todos los frames; cada frame con vídeo se presenta al
// service worker y solo el frame principal (el del vídeo que se está viendo) actúa. El anfitrión
// emite su estado; los invitados lo aplican. También dibuja la interfaz (chat, reacciones, estado).

(() => {
  if (window.__mirrored) return;
  window.__mirrored = true;

  const DRIFT_HEARTBEAT = 1.0; // s de desfase tolerado en latidos periódicos
  const DRIFT_ACTION = 0.4; // s de desfase tolerado tras play/pausa/salto
  const BUFFER_REPORT_AFTER = 2000; // ms cargando antes de pedir a los demás que esperen
  const MAX_WAIT = 15000; // ms máximos esperando a alguien que carga
  const GIVE_UP_COOLDOWN = 30000; // ms sin volver a esperar a alguien tras rendirse con él
  const STALL_AFTER = 8000; // ms sin datos ni poder reproducir antes de reintentar la descarga
  const SWITCH_AFTER = 3000; // ms que otro vídeo debe ser claramente mejor antes de cambiarnos a él
  const RESUME_TTL = 120000; // ms que el anfitrión recién recargado espera a volver a su vídeo
  const REACTIONS = ['😂', '😱', '❤️', '👏', '🔥', '😮', '🙄', '💀'];
  const isTop = window === window.top;

  let active = false;
  let primary = true; // lo decide el service worker; por defecto sí (compatibilidad con versiones sin elección)
  let dead = false; // la extensión se ha recargado: este script ya no puede hablar con ella
  let role = null;
  let myId = null;
  let allControl = false;
  let peers = [];
  let video = null;
  let ignoreUntil = 0; // justo tras aplicar un estado remoto: la carga que sigue no cuenta como "cargando"
  let remote = null; // { state, at } último estado recibido de quien controla
  let heartbeat = null;
  let loops = []; // intervalos que solo corren con sesión activa
  let pendingClick = false; // autoplay bloqueado: esperamos un clic (o que la persona pulse play)
  let needsSource = false; // el reproductor aún no ha cargado el vídeo: hace falta que el usuario pulse play
  let sourceGraceUntil = 0; // tras cargar la fuente, el reproductor mueve el vídeo por su cuenta un momento
  let graceUntilReady = false; // ...y suele repetir su play() cuando llegan los datos: el margen dura hasta entonces
  let resumeFrom = null; // anfitrión que recarga la página: estado de la sala del que continuar
  let challenger = null; // { v, since }: otro vídeo del frame que puntúa claramente más que el actual
  let cand = { score: -1, at: 0 }; // última candidatura enviada al service worker

  // Espera por carga
  let bufferSince = null; // invitado: desde cuándo está cargando
  let autoPaused = false; // anfitrión: pausa puesta por nosotros para esperar a alguien
  let autoAction = false; // el siguiente evento local lo provocamos nosotros al esperar/reanudar
  let waitStart = 0;
  const giveUpUntil = {}; // anfitrión: id → hasta cuándo no volver a esperar a quien ya se esperó sin éxito
  let lastReport = { status: null, at: 0, drift: null };

  // Descarga atascada
  let stallSince = null; // desde cuándo el vídeo quiere reproducirse y no puede
  let lastProgressAt = 0; // último evento 'progress' (llegan datos)

  const acting = () => active && primary;

  // ---------- Hablar con la extensión ----------
  // Si la extensión se recarga o actualiza, este script queda huérfano y cualquier llamada a chrome.*
  // lanza "Extension context invalidated" (a veces de forma síncrona): en ese caso nos desmontamos.
  function guard(fn) {
    if (dead) return Promise.resolve();
    try {
      if (!chrome.runtime?.id) throw new Error('Extension context invalidated');
      return Promise.resolve(fn()).catch((err) => {
        if (/context invalidated/i.test(err?.message || '')) teardown();
      });
    } catch {
      teardown();
      return Promise.resolve();
    }
  }
  const send = (msg) => guard(() => chrome.runtime.sendMessage(msg));

  function teardown() {
    if (dead) return;
    dead = true;
    active = false;
    stopLoops();
    clearInterval(heartbeat);
    attach(null); // quita los listeners del vídeo y la interfaz
    ui?.host.remove();
  }

  function startLoops() {
    if (loops.length) return;
    loops = [setInterval(pickLoop, 1000), setInterval(syncLoop, 500)];
  }
  function stopLoops() {
    loops.forEach(clearInterval);
    loops = [];
  }

  // ---------- Elegir el vídeo principal ----------
  function scoreOf(v) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 200 * 100) return 0;
    let score = area;
    if (v.readyState > 0) score *= 2;
    if (!v.paused) score *= 2;
    if (v.duration > 120) score *= 4; // el episodio pesa más que un anuncio corto
    // Anuncios y vistas previas suelen ir silenciados y dentro de iframes; el reproductor principal, no.
    if (v.muted) score *= 0.5;
    if (window === window.top) score *= 3;
    return score;
  }

  function pickVideo() {
    let best = { v: null, score: 0 };
    for (const v of document.querySelectorAll('video')) {
      const score = scoreOf(v);
      if (score > best.score) best = { v, score };
    }
    return best;
  }

  // Candidatura del frame: al adjuntar, si cambia más de un 20 % y cada ~3 s (el service worker
  // olvida los frames que callan). Con ella elige el frame principal.
  function reportCandidate(score, force) {
    if (!active) return;
    const now = Date.now();
    if (force || Math.abs(score - cand.score) > 0.2 * Math.max(cand.score, 1) || now - cand.at >= 2900) {
      cand = { score, at: now };
      send({ type: 'candidate', score });
    }
  }

  const EVENTS = ['play', 'pause', 'seeked', 'ratechange'];
  const onProgress = () => (lastProgressAt = Date.now());

  function attach(v) {
    if (v === video) return;
    if (video) {
      EVENTS.forEach((e) => video.removeEventListener(e, onLocalEvent));
      video.removeEventListener('progress', onProgress);
    }
    video = v;
    stallSince = null;
    challenger = null;
    for (const k in expected) expected[k] = null; // lo que esperábamos del vídeo anterior no vale para este
    if (video) {
      EVENTS.forEach((e) => video.addEventListener(e, onLocalEvent));
      video.addEventListener('progress', onProgress);
      reportCandidate(scoreOf(video), true);
      if (acting() && remote && role !== 'host') applyRemote('attach');
      if (acting() && role === 'host') sendState('attach');
    }
    renderUI();
  }

  const usable = (v) => v?.isConnected && v.getBoundingClientRect().width > 0;

  // Buscamos el vídeo (y nos presentamos) solo mientras hay sesión.
  function pickLoop() {
    if (!active) return;
    const now = Date.now();
    const best = pickVideo();
    if (!usable(video)) attach(best.v);
    else if (best.v && best.v !== video && video.readyState === 0 && noSource(video)) attach(best.v);
    else if (best.v && best.v !== video) {
      // Otro vídeo mejor (p. ej. tras un anuncio): solo si lo es con claridad y durante un rato, para no
      // saltar a previsualizaciones o tráilers. Nunca dejamos el vídeo que coincide con la sala por uno que no.
      const keep = remote && mediaMatch(remote.state) === true && mediaMatch(remote.state, best.v) !== true;
      if (keep || best.score <= scoreOf(video) * 1.5) challenger = null;
      else if (challenger?.v !== best.v) challenger = { v: best.v, since: now };
      else if (now - challenger.since >= SWITCH_AFTER) attach(best.v);
    } else challenger = null;
    reportCandidate(best.score);
    // Una web (p. ej. React al re-renderizar la pantalla completa) puede habernos quitado del DOM.
    renderUI();
  }

  const canControl = () => role === 'host' || allControl;

  // ---------- Enviar estado ----------
  function sendState(reason) {
    if (!acting() || !canControl() || !video || video.readyState === 0) return;
    // Anfitrión recién recargado: hasta que toque el reproductor, su vídeo (en 0) no es la referencia.
    if (resumeFrom && !EVENTS.includes(reason)) return;
    const at = Date.now();
    const state = { time: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration, reason, at };
    // Nuestra propia acción pasa a ser la referencia: así sus ecos (eventos colaterales) coinciden con ella.
    if (reason !== 'heartbeat') remote = { state: { ...remote?.state, ...state }, at };
    send({ type: 'local-state', state });
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => sendState('heartbeat'), 2000);
  }

  // ---------- Aplicar estado remoto ----------
  function targetTime() {
    const { state, at } = remote;
    return state.paused ? state.time : state.time + ((Date.now() - at) / 1000) * (state.rate || 1);
  }

  // Si las duraciones no coinciden, uno de los dos está viendo otro vídeo (normalmente un anuncio):
  // no tocamos nada y la sincronización vuelve sola cuando ambos estén en el episodio.
  // mediaMatch: true/false, o null mientras nuestro vídeo aún no sabe su duración.
  function mediaMatch(state, v = video) {
    const a = state.duration, b = v?.duration;
    if (!(b > 0)) return null;
    if (!(a > 0 && isFinite(a) && isFinite(b))) return true; // directo
    return Math.abs(a - b) < 3;
  }
  const sameMedia = (state) => mediaMatch(state) !== false;

  // Con readyState 0 cambiar currentTime no dispara 'seeked': no lo esperamos o se tragaría uno de la persona.
  function seekTo(t) {
    if (video.readyState > 0) expect('seeked', t);
    else ignoreUntil = Date.now() + 400;
    video.currentTime = t;
  }

  function applyRemote(reason) {
    if (!primary || !video || !remote) return;
    if (role === 'host' && !allControl) return;
    const { state } = remote;
    if (!sameMedia(state)) return;
    // En pausa se nota cualquier diferencia, así que ajustamos más fino.
    const tolerance = state.paused ? 0.15 : reason === 'heartbeat' ? DRIFT_HEARTBEAT : DRIFT_ACTION;
    // Mientras el vídeo carga (tras un salto o por red lenta) no lo movemos por un simple latido:
    // cada salto reinicia la carga y nunca llegaría a reproducirse.
    const loading = video.seeking || video.readyState < 3;

    const rate = Number(state.rate);
    if (isFinite(rate) && rate > 0) {
      const r = Math.min(Math.max(rate, 0.0625), 16); // fuera de este rango el navegador lanza una excepción
      if (Math.abs(video.playbackRate - r) > 0.001) {
        expect('ratechange');
        video.playbackRate = r;
      }
    }
    const target = targetTime();
    if (Math.abs(video.currentTime - target) > tolerance && !(reason === 'heartbeat' && loading)) seekTo(target);

    if (state.paused && !video.paused) {
      expect('pause');
      video.pause();
    }
    if (state.paused && pendingClick) {
      pendingClick = false; // ya no hace falta reproducir
      hideToast('click');
    }
    if (!state.paused && noSource(video)) return askForSource();
    // Con el autoplay bloqueado no insistimos: pausa, salto y velocidad sí se aplican, el play espera al clic.
    if (!state.paused && video.paused && !pendingClick) {
      expect('play');
      video.play().catch((err) => {
        expected.play = null; // el 'play' no llegará: que no se trague el siguiente de la persona
        // Solo NotAllowedError es un bloqueo de autoplay. Un AbortError (el play se canceló por un salto
        // o una pausa mientras cargaba) es normal en vídeos lentos y no debe congelar la sincronización.
        if (err?.name !== 'NotAllowedError') return;
        pendingClick = true;
        askForClick();
      });
    }
  }

  function askForClick() {
    toast('Haz clic aquí para sincronizarte', () => {
      pendingClick = false;
      applyRemote('click');
    }, 'click');
  }

  // Algunos reproductores no ponen la fuente al <video> hasta que el usuario pulsa su botón de play.
  // Un play() sobre un vídeo sin fuente ni falla ni avanza: se queda "reproduciendo" en vacío.
  const noSource = (v) => !v.currentSrc && v.networkState === HTMLMediaElement.NETWORK_EMPTY;

  function askForSource() {
    // Se repite en cada estado remoto mientras el aviso no esté a la vista (p. ej. si llegó antes que la UI).
    if (needsSource && toastShown('source')) return;
    needsSource = true;
    // Un clic sintético no sirve (los reproductores lo ignoran o hacen play sin fuente): solo llevamos
    // al usuario hasta el vídeo. Cuando aparezca la fuente, el bucle principal resincroniza.
    toast('Pulsa play en el vídeo para sincronizarte', highlightVideo, 'source');
  }

  // ---------- Ecos: eventos que provocamos nosotros ----------
  // Un evento local es eco (no una acción de la persona) si es el que acabamos de provocar o si deja el
  // vídeo tal como lo pide el estado de referencia. Así no hace falta ignorar a ciegas un intervalo de
  // tiempo, y una acción real justo después de un cambio remoto no se pierde.
  const expected = {}; // tipo → { until, time? }: el siguiente evento de ese tipo es nuestro
  function expect(type, time) {
    // En vídeos lentos, un 'seeked' puede tardar segundos en llegar.
    expected[type] = { until: Date.now() + 20000, time };
    ignoreUntil = Date.now() + 400; // solo para no confundir el salto recién pedido con una carga lenta
  }
  function wasExpected(type) {
    const e = expected[type];
    if (!e || Date.now() > e.until) return false;
    expected[type] = null;
    // Un salto nuestro que se fusionó con otro no debe tragarse un salto posterior de la persona.
    return e.time == null || Math.abs(video.currentTime - e.time) < 1.5;
  }
  function matchesRemote() {
    if (!remote || (role === 'host' && !allControl) || !sameMedia(remote.state)) return false;
    const s = remote.state;
    return video.paused === s.paused && Math.abs(video.playbackRate - (s.rate || 1)) < 0.01 && Math.abs(video.currentTime - targetTime()) < DRIFT_ACTION;
  }
  const isEcho = (type) => wasExpected(type) || matchesRemote();

  // Olvida todo lo relativo a la sincronización en curso (fin de sesión o cambio de papel).
  function resetSyncState() {
    for (const k in expected) expected[k] = null;
    for (const id in giveUpUntil) delete giveUpUntil[id];
    bufferSince = stallSince = resumeFrom = null;
    sourceGraceUntil = 0;
    graceUntilReady = autoAction = autoPaused = needsSource = pendingClick = false;
    lastReport = { status: null, at: 0, drift: null };
    hideToast('click');
    hideToast('source');
    hideToast('moved');
  }

  // Anfitrión recién recargado: en su primera reproducción seguimos donde iba la sala, no desde el
  // principio. Devuelve true si aún hay que esperar (sin fuente, sin duración o viendo otra cosa,
  // p. ej. un anuncio): mientras, no emitimos para no mandar a todos al segundo 0 del anuncio.
  function holdForResume() {
    if (!resumeFrom) return false;
    const { state, at, until } = resumeFrom;
    if (Date.now() > until || (isTop && !samePage(state.url, location.href))) {
      resumeFrom = null; // ya no es la misma página (navegación interna) o no volvió a tiempo
      return false;
    }
    if (noSource(video) || mediaMatch(state) !== true) return true;
    resumeFrom = null;
    const t = state.paused ? state.time : state.time + ((Date.now() - at) / 1000) * (state.rate || 1);
    if (Math.abs(video.currentTime - t) > 1) seekTo(t);
    return false;
  }

  // ---------- Eventos locales ----------
  // Última interacción real de la persona en ESTE frame (clic o tecla). Los eventos del vídeo siempre son
  // isTrusted y navigator.userActivation no distingue bien entre frames: un anuncio en autoplay podría
  // pasar por acción de la persona.
  let lastInputAt = 0;
  for (const t of ['pointerdown', 'keydown']) addEventListener(t, (e) => e.isTrusted && (lastInputAt = Date.now()), true);

  function onLocalEvent(e) {
    // La persona ha tocado este vídeo pero otro frame es el principal: lo reclamamos. La acción se
    // transmite en cuanto el service worker nos confirme (setPrimary envía el estado).
    if (active && !primary && video && Date.now() - lastInputAt < 2000) {
      send({ type: 'candidate', score: scoreOf(video), claim: true });
      return;
    }
    if (!acting() || !video) return;
    if (role === 'host' && autoAction) {
      autoAction = false;
      return sendState('auto');
    }
    if (isEcho(e.type)) return;
    if (role === 'host') {
      if (autoPaused) autoPaused = false; // el anfitrión toma el control manualmente
      for (const id in giveUpUntil) delete giveUpUntil[id]; // acción nueva: vuelve a merecer la pena esperar
      if (holdForResume()) return;
      return sendState(e.type);
    }
    if (!remote || !sameMedia(remote.state)) return;
    if (needsSource) return; // el usuario acaba de pulsar play para cargar el vídeo: el bucle lo resincroniza
    if (Date.now() < sourceGraceUntil || graceUntilReady) return void setTimeout(() => applyRemote('resnap'), 300);
    if (allControl) return sendState(e.type);
    // El invitado ha tocado el reproductor: vuelve a la posición del anfitrión.
    const drifted = Math.abs(video.currentTime - targetTime()) > DRIFT_ACTION || video.paused !== remote.state.paused;
    if (drifted) {
      toast('El anfitrión controla la reproducción');
      setTimeout(() => applyRemote('resnap'), 300);
    }
  }

  // ---------- Bucle: carga, espera y estado ----------
  function myStatus() {
    if (!video) return { status: 'novideo', drift: null };
    if (role === 'host' || !remote) return { status: 'ok', drift: 0 };
    if (noSource(video)) return { status: 'needclick', drift: null };
    if (!sameMedia(remote.state)) return { status: 'ad', drift: null };
    if (bufferSince && Date.now() - bufferSince > BUFFER_REPORT_AFTER) return { status: 'buffering', drift: null };
    const drift = video.currentTime - targetTime();
    return { status: Math.abs(drift) > 1.5 ? 'behind' : 'ok', drift };
  }

  function syncLoop() {
    if (!acting()) return;
    const now = Date.now();

    if (video) {
      // Autoplay bloqueado: si la persona le ha dado al play del reproductor, ya no hace falta el clic.
      if (pendingClick && !video.paused) {
        pendingClick = false;
        hideToast('click');
      } else if (pendingClick && !toastShown()) askForClick(); // otro aviso lo tapó: vuelve a pedirlo

      // Anfitrión recién recargado cuyo reproductor arrancó solo (sin 'play' que veamos).
      if (role === 'host' && resumeFrom && !video.paused && video.readyState > 0 && !holdForResume()) sendState('resume');

      // El reproductor ya ha cargado el vídeo: nos ponemos en el punto de quien controla.
      if (needsSource && !noSource(video)) {
        needsSource = false;
        sourceGraceUntil = now + 4000;
        graceUntilReady = true;
        hideToast('source');
        applyRemote('source');
      }
      if (graceUntilReady && video.readyState >= 3) {
        graceUntilReady = false;
        sourceGraceUntil = Math.max(sourceGraceUntil, now + 1500);
      } else if (graceUntilReady && now > sourceGraceUntil + 20000) graceUntilReady = false;

      // Invitado: ¿está cargando mientras los demás reproducen?
      if (role !== 'host' && remote && sameMedia(remote.state)) {
        const starving = video.readyState < 3;
        if (!starving) bufferSince = null;
        else if (!bufferSince && !remote.state.paused && now > ignoreUntil) bufferSince = now;
      } else bufferSince = null;

      // Descarga atascada: el vídeo debería avanzar, no puede y hace rato que no llegan datos (a veces una
      // conexión se queda colgada). Un salto obliga al navegador a abrir una petición nueva. Si llegan datos
      // aunque sea despacio (red lenta), no se toca: cada salto reiniciaría la carga.
      // Un invitado que ya estaba cargando cuenta aunque el anfitrión se haya pausado para esperarle.
      const wantsToPlay = role === 'host' ? !video.paused : !!remote && (!remote.state.paused || !!bufferSince) && sameMedia(remote.state);
      if (wantsToPlay && !noSource(video) && video.readyState < 3) {
        if (!stallSince) stallSince = now;
        else if (now - stallSince > STALL_AFTER && now - lastProgressAt > STALL_AFTER) {
          stallSince = now;
          // +1 s: saltar al mismo punto reutiliza la petición colgada; un poco más allá obliga a abrir otra.
          // El invitado corrige ese segundo con el siguiente estado; el anfitrión lo emite para que le sigan.
          seekTo((role === 'host' ? video.currentTime : targetTime()) + 1);
          if (role === 'host') sendState('nudge');
        }
      } else stallSince = null;

      // Anfitrión: pausa a todos mientras alguien carga (con un máximo).
      if (role === 'host') {
        const loading = peers.filter((p) => !p.host && p.status === 'buffering' && !(giveUpUntil[p.id] > now));
        if (loading.length && !video.paused && !autoPaused) {
          autoPaused = true;
          autoAction = true;
          waitStart = now;
          video.pause();
          toast(`Esperando a ${loading.map((p) => p.name).join(', ')}…`);
        } else if (autoPaused && (!loading.length || now - waitStart > MAX_WAIT)) {
          // Con quien no llegó a tiempo no volvemos a esperar un rato (salvo que el anfitrión haga algo nuevo).
          for (const p of loading) giveUpUntil[p.id] = now + GIVE_UP_COOLDOWN;
          autoPaused = false;
          if (video.paused) {
            autoAction = true;
            // Si el play falla no llegará ningún evento: que no se quede marcado el siguiente de la persona.
            video.play().catch(() => (autoAction = false));
          }
          toast(loading.length ? 'Seguimos sin esperar más' : 'Todos listos ▶');
        }
      }
    }

    // Informa de mi estado al resto (al cambiar, o cada 4 s).
    const st = myStatus();
    const changed = st.status !== lastReport.status || Math.abs((st.drift || 0) - (lastReport.drift || 0)) >= 1;
    // Un iframe sin vídeo (antes de la primera elección todos se creen principales) no informa: si no,
    // el anfitrión vería a esta persona "sin vídeo" un instante.
    if ((changed || now - lastReport.at > 4000) && (video || window === window.top)) {
      lastReport = { ...st, at: now };
      send({ type: 'report', status: st.status, drift: st.drift });
    }
    renderBadge(st);
  }

  // ---------- Interfaz (shadow DOM, aislada de los estilos de la web) ----------
  let ui = null;
  let chatLog = [];
  let panelOpen = false;
  let unread = 0;

  const CSS = `
    :host { all: initial; }
    .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff; }
    .toast { position: absolute; top: 16px; right: 16px; max-width: 320px; padding: 10px 14px; border-radius: 10px;
      background: rgba(20,20,28,.92); box-shadow: 0 4px 20px rgba(0,0,0,.4); display: none; }
    .toast.show { display: block; } .toast.click { pointer-events: auto; cursor: pointer; outline: 2px solid #7d70ff; }
    .dock { position: absolute; right: 16px; bottom: 72px; width: 300px; display: flex; flex-direction: column;
      align-items: flex-end; gap: 6px; }
    .bar, .panel, .bubble, .badge { pointer-events: auto; background: rgba(20,20,28,.85); backdrop-filter: blur(6px);
      border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.35); }
    .badge { padding: 4px 10px; font-size: 12px; border-radius: 999px; opacity: .9; cursor: grab; user-select: none;
      touch-action: none; }
    .badge.dragging { cursor: grabbing; }
    .badge .fold { margin-left: 6px; opacity: .6; }
    .dock.min .bar, .dock.min .panel, .dock.min .bubbles { display: none; }
    .hl { position: absolute; border: 3px solid #7d70ff; border-radius: 10px; box-shadow: 0 0 0 4px rgba(125,112,255,.35);
      animation: hl .8s ease-in-out 3; }
    @keyframes hl { 0%,100% { opacity: 0 } 50% { opacity: 1 } }
    .badge .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #3ecf8e; }
    .badge.warn .dot { background: #f5b83d; } .badge.bad .dot { background: #ff5d5d; }
    .bar { display: flex; gap: 2px; padding: 4px; opacity: .55; transition: opacity .2s; }
    .dock:hover .bar, .bar.open { opacity: 1; }
    button { all: unset; cursor: pointer; padding: 4px 6px; border-radius: 8px; font-size: 18px; line-height: 1; }
    button:hover { background: rgba(255,255,255,.12); }
    .chatbtn { font-size: 16px; position: relative; }
    .unread { position: absolute; top: -4px; right: -4px; background: #7d70ff; border-radius: 999px; font-size: 10px;
      padding: 1px 5px; }
    .panel { width: 100%; display: none; flex-direction: column; overflow: hidden; }
    .panel.open { display: flex; }
    .msgs { max-height: 260px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .msg b { color: #b3abff; font-weight: 600; margin-right: 6px; }
    .msg.me b { color: #7ee2b8; }
    .empty { color: #aaa; font-size: 12px; }
    input { all: unset; border-top: 1px solid rgba(255,255,255,.12); padding: 10px 12px; color: #fff; }
    .bubble { padding: 6px 10px; max-width: 100%; animation: fade 6s forwards; }
    .bubble b { color: #b3abff; margin-right: 6px; }
    @keyframes fade { 0%,80% { opacity: 1 } 100% { opacity: 0 } }
    .float { position: absolute; bottom: 90px; font-size: 38px; animation: up 2.6s ease-out forwards; text-align: center; }
    .float small { display: block; font-size: 11px; background: rgba(20,20,28,.8); border-radius: 6px; padding: 1px 6px; }
    @keyframes up { 0% { transform: translateY(0) scale(.6); opacity: 0 } 15% { opacity: 1; transform: translateY(-20px) scale(1) }
      100% { transform: translateY(-260px) scale(1.1); opacity: 0 } }
  `;

  function buildUI() {
    const host = document.createElement('mirrored-ui');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="root">
        <div class="toast"></div>
        <div class="dock">
          <div class="bubbles"></div>
          <div class="panel"><div class="msgs"></div><input maxlength="300" placeholder="Escribe un mensaje…"></div>
          <div class="bar"></div>
          <div class="badge"><span class="dot"></span><span class="btext"></span><span class="fold"></span></div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const els = { host, root: $('.root'), toast: $('.toast'), bubbles: $('.bubbles'), panel: $('.panel'), msgs: $('.msgs'),
      input: $('input'), badge: $('.badge'), btext: $('.btext'), bar: $('.bar'), dock: $('.dock'), fold: $('.fold') };
    // A pantalla completa la interfaz vive dentro del contenedor del reproductor, que usa clic/doble clic
    // para pausar o maximizar: lo que pase sobre nuestros controles no debe llegarle. Solo cortamos la
    // propagación (no el comportamiento por defecto): el scroll del chat y el arrastre siguen funcionando.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu']) {
      els.root.addEventListener(type, (e) => e.stopPropagation());
    }
    els.badge.title = 'Clic: plegar o desplegar · Arrastra para mover';
    els.badge.addEventListener('pointerdown', (e) => dragDock(els, e));
    placeDock(els);
    guard(() => chrome.storage.local.get('dock')).then((res) => {
      if (res?.dock) Object.assign(dockPos, res.dock);
      placeDock(els);
    });
    for (const emoji of REACTIONS) {
      const b = document.createElement('button');
      b.textContent = emoji;
      b.title = 'Reaccionar';
      b.onclick = () => send({ type: 'reaction', emoji });
      els.bar.append(b);
    }
    const chatBtn = document.createElement('button');
    chatBtn.className = 'chatbtn';
    chatBtn.title = 'Chat';
    chatBtn.textContent = '💬';
    chatBtn.onclick = () => setPanel(!panelOpen);
    els.chatBtn = chatBtn;
    els.bar.append(chatBtn);
    return els;
  }

  // Panel movible (arrastrando el indicador) y plegable (clic en él). Se recuerda entre páginas.
  // dockPos guarda lo que eligió la persona; al dibujar se ajusta a la ventana sin tocarlo (si no, un
  // iframe pequeño guardaría una posición recortada para todas las páginas).
  const dockPos = { right: 16, bottom: 72, min: false };
  const DOCK_W = 300;
  const fitDock = (right, bottom) => ({
    right: Math.min(Math.max(right, 0), Math.max(innerWidth - DOCK_W, 0)),
    bottom: Math.min(Math.max(bottom, 0), Math.max(innerHeight - 40, 0)),
  });

  function placeDock(els) {
    const { right, bottom } = fitDock(dockPos.right, dockPos.bottom);
    els.dock.style.right = right + 'px';
    els.dock.style.bottom = bottom + 'px';
    els.dock.classList.toggle('min', dockPos.min);
    els.fold.textContent = dockPos.min ? '▸' : '▾';
  }

  function dragDock(els, e) {
    if (e.button !== 0) return;
    const shown = fitDock(dockPos.right, dockPos.bottom); // arrastramos desde donde se ve
    const start = { x: e.clientX, y: e.clientY, ...shown };
    let moved = false;
    els.badge.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      els.badge.classList.add('dragging');
      Object.assign(dockPos, fitDock(start.right - dx, start.bottom - dy));
      placeDock(els);
    };
    const up = () => {
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) els.badge.removeEventListener(t, up);
      els.badge.removeEventListener('pointermove', move);
      els.badge.classList.remove('dragging');
      if (!moved) dockPos.min = !dockPos.min;
      placeDock(els);
      guard(() => chrome.storage.local.set({ dock: dockPos }));
    };
    els.badge.addEventListener('pointermove', move);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) els.badge.addEventListener(t, up);
  }

  addEventListener('resize', () => ui && placeDock(ui));

  // Lleva la vista al vídeo y lo enmarca un momento, para que se vea dónde pulsar.
  function highlightVideo() {
    if (!video) return;
    video.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      if (!ui || !video) return;
      const r = video.getBoundingClientRect();
      const hl = Object.assign(document.createElement('div'), { className: 'hl' });
      Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      ui.root.append(hl);
      setTimeout(() => hl.remove(), 2500);
    }, 600);
  }

  function mountPoint() {
    const fs = document.fullscreenElement;
    // Si lo que está a pantalla completa es el propio <video>, no se puede dibujar encima.
    return fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
  }

  function renderUI() {
    const show = acting() && !!video;
    if (!show) {
      ui?.host.remove();
      return;
    }
    if (!ui) {
      ui = buildUI();
      renderChat();
    }
    const parent = mountPoint();
    if (ui.host.parentNode !== parent) parent.appendChild(ui.host);
  }

  document.addEventListener('fullscreenchange', renderUI, true);

  function setPanel(open) {
    panelOpen = open;
    if (!ui) return;
    ui.panel.classList.toggle('open', open);
    ui.bar.classList.toggle('open', open);
    if (open) {
      unread = 0;
      ui.bubbles.replaceChildren();
      ui.input.focus();
      ui.msgs.scrollTop = ui.msgs.scrollHeight;
    }
    renderUnread();
  }

  function renderUnread() {
    if (!ui) return;
    ui.chatBtn.replaceChildren('💬');
    if (unread) ui.chatBtn.append(Object.assign(document.createElement('span'), { className: 'unread', textContent: unread }));
  }

  function msgEl(m, cls) {
    const el = document.createElement('div');
    el.className = cls + (m.id === myId ? ' me' : '');
    const b = document.createElement('b');
    b.textContent = m.id === myId ? 'Tú' : m.name;
    el.append(b, document.createTextNode(m.text));
    return el;
  }

  function renderChat() {
    if (!ui) return;
    ui.msgs.replaceChildren(
      ...(chatLog.length ? chatLog.map((m) => msgEl(m, 'msg')) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Aún no hay mensajes.' })])
    );
    ui.msgs.scrollTop = ui.msgs.scrollHeight;
  }

  function onChat(m) {
    chatLog.push(m);
    if (chatLog.length > 100) chatLog.shift();
    renderChat();
    if (!ui || !primary || panelOpen || m.id === myId) return;
    unread++;
    renderUnread();
    const b = msgEl(m, 'bubble');
    ui.bubbles.append(b);
    setTimeout(() => b.remove(), 6000);
  }

  function onReaction(r) {
    if (!ui || !primary) return;
    const el = document.createElement('div');
    el.className = 'float';
    // Suben a la izquierda del panel de chat para no taparlo (en reproductores estrechos, por encima).
    const wide = innerWidth > 720;
    el.style.right = (wide ? 330 + Math.random() * 180 : 20 + Math.random() * (innerWidth * 0.5)) + 'px';
    el.textContent = r.emoji;
    el.append(Object.assign(document.createElement('small'), { textContent: r.id === myId ? 'Tú' : r.name }));
    ui.root.append(el);
    setTimeout(() => el.remove(), 2700);
  }

  function renderBadge(st) {
    if (!ui) return;
    let text, cls = '';
    const n = peers.length;
    const who = n ? ` · ${n} ${n === 1 ? 'persona' : 'personas'}` : '';
    if (role === 'host') {
      const loading = peers.filter((p) => !p.host && p.status === 'buffering').length;
      const behind = peers.filter((p) => !p.host && p.status === 'behind').length;
      const click = peers.filter((p) => !p.host && p.status === 'needclick').length;
      text = autoPaused ? 'Esperando a que carguen…' : loading ? `${loading} cargando` : behind ? `${behind} desincronizado` : click ? `${click} sin pulsar play` : 'Anfitrión';
      if (autoPaused || loading || behind || click) cls = 'warn';
    } else if (st.status === 'ad') {
      text = 'En anuncio (se sincroniza al acabar)';
      cls = 'warn';
    } else if (st.status === 'needclick') {
      text = 'Pulsa play en el vídeo';
      cls = 'warn';
    } else if (st.status === 'novideo') {
      text = 'Buscando el vídeo…';
      cls = 'warn';
    } else if (st.status === 'buffering') {
      text = 'Cargando…';
      cls = 'warn';
    } else if (st.status === 'behind') {
      const d = st.drift;
      text = `${d < 0 ? 'Vas ' + Math.abs(d).toFixed(1) + ' s por detrás' : 'Vas ' + d.toFixed(1) + ' s por delante'}`;
      cls = 'bad';
    } else text = allControl ? 'Sincronizado · todos controlan' : 'Sincronizado';
    ui.btext.textContent = text + who;
    ui.badge.className = 'badge ' + cls;
  }

  // Avisos. Los que se pulsan llevan un tipo ('click', 'source', 'moved') para poder quitarlos
  // solo a ellos, sin borrar otro aviso que los haya sustituido.
  let toastTimer = null;
  let toastKind = null;
  const toastShown = (kind) => !!ui?.toast.classList.contains('show') && (!kind || toastKind === kind);
  // Aviso pulsable tapado por uno temporal: vuelve cuando el temporal se va (si no, se perdería).
  let sticky = null;
  function hideToast(kind) {
    if (!ui) return;
    if (!kind || sticky?.kind === kind) sticky = null;
    if (kind && toastKind !== kind) return;
    ui.toast.className = 'toast';
    ui.toast.onclick = null;
    toastKind = null;
  }
  function toast(text, onClick, kind = null) {
    if (!ui || !primary) return;
    if (onClick) sticky = { text, onClick, kind };
    ui.toast.textContent = '⟳ Mirrored · ' + text;
    ui.toast.className = 'toast show' + (onClick ? ' click' : '');
    toastKind = kind;
    ui.toast.onclick = onClick
      ? () => {
          hideToast();
          onClick();
        }
      : null;
    clearTimeout(toastTimer);
    if (!onClick) {
      toastTimer = setTimeout(() => {
        if (sticky) toast(sticky.text, sticky.onClick, sticky.kind);
        else hideToast();
      }, 2500);
    }
  }

  // Aísla el teclado: los reproductores escuchan teclas (espacio, F, flechas) en fase de captura.
  // Como este script corre en document_start, este listener va antes que los de la web.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (!ui || !e.composedPath().includes(ui.host)) return;
        e.stopImmediatePropagation();
        if (type !== 'keydown') return;
        if (e.key === 'Escape') setPanel(false);
        // Con un IME (japonés, chino…) Enter confirma la composición, no envía.
        if (e.key === 'Enter' && !e.isComposing && e.composedPath().includes(ui.input)) {
          const text = ui.input.value.trim();
          if (text) send({ type: 'chat', text });
          ui.input.value = '';
        }
      },
      true
    );
  }

  // ---------- Mensajes del service worker ----------
  function setSession(info) {
    const wasActive = active;
    const prevRole = role;
    active = !!info.active && !dead;
    role = info.role || null;
    myId = info.id ?? myId;
    allControl = !!info.allControl;
    if (info.peers) peers = info.peers;
    if (typeof info.primary === 'boolean') primary = info.primary;
    clearInterval(heartbeat);
    if (!active) {
      stopLoops();
      resetSyncState();
      remote = null;
      chatLog = [];
      primary = true; // la próxima sesión vuelve a elegir frame
      cand = { score: -1, at: 0 };
      renderUI();
      return;
    }
    if (prevRole && role !== prevRole) resetSyncState(); // anfitrión ↔ invitado: lo pendiente era del otro papel
    startLoops();
    if (!video || !video.isConnected) attach(pickVideo().v);
    else if (!wasActive) reportCandidate(scoreOf(video), true);
    renderUI();
    if (role === 'host') {
      startHeartbeat();
      if (!wasActive || prevRole !== 'host') sendState('join');
      if (prevRole && prevRole !== 'host') toast('Ahora eres el anfitrión');
    } else if (!wasActive) {
      toast(`Conectado a la sesión ${info.code}`);
    }
  }

  // El service worker decide qué frame actúa. Los demás siguen escuchando (por si pasan a serlo),
  // pero no tocan el vídeo, no emiten y no muestran nada.
  function setPrimary(value) {
    if (value === primary) return;
    primary = value;
    if (!active) return;
    if (!primary) {
      pendingClick = needsSource = graceUntilReady = false;
      bufferSince = stallSince = null;
      renderUI();
      return;
    }
    lastReport = { status: null, at: 0, drift: null }; // informa enseguida
    if (!video || !video.isConnected) attach(pickVideo().v);
    renderUI();
    if (role === 'host') sendState('primary');
    else applyRemote('primary');
  }

  function samePage(a, b) {
    try {
      const x = new URL(a), y = new URL(b);
      return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search;
    } catch {
      return false;
    }
  }

  function onHostMoved(url) {
    if (!acting() || !/^https?:\/\//i.test(url || '')) return;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {}
    toast(`El anfitrión se ha ido a ${host} — pulsa para ir`, () => {
      // Desde un iframe navegamos la pestaña entera (el clic cuenta como gesto del usuario).
      try {
        (isTop ? window : window.top).location.href = url;
      } catch {
        location.href = url;
      }
    }, 'moved');
  }

  guard(() =>
    chrome.runtime.onMessage.addListener((msg) => {
      if (dead) return;
      switch (msg.type) {
        case 'session':
          setSession(msg);
          break;
        case 'primary':
          setPrimary(!!msg.primary);
          break;
        case 'remote-state':
          if (!active) return;
          // localAt: instante (en nuestro reloj) al que corresponde state.time, ya descontada la latencia.
          // Los frames no principales también lo guardan, por si pasan a serlo.
          remote = { state: msg.state, at: msg.state.localAt ?? Date.now() };
          if (msg.state.reason === 'auto' && msg.state.paused && role !== 'host') toast('Pausa automática: alguien está cargando');
          applyRemote(msg.state.reason);
          break;
        case 'host-moved':
          onHostMoved(msg.url);
          break;
        case 'peers':
          peers = msg.peers;
          break;
        case 'chat':
          onChat(msg);
          break;
        case 'reaction':
          onReaction(msg);
          break;
      }
    })
  );

  function hello() {
    send({ type: 'hello' }).then((info) => {
      if (!info || dead) return;
      if (info.chat) chatLog = info.chat;
      // Anfitrión que recarga: antes de setSession, para que 'attach'/'join' no emitan su vídeo en 0.
      // En el frame superior comprobamos que sea la misma página (como el service worker); en un iframe no
      // sabemos la URL de la pestaña, así que nos fiamos de que la duración coincida (holdForResume).
      if (info.active && info.state && info.role === 'host' && (!isTop || samePage(info.state.url, location.href))) {
        resumeFrom = { state: info.state, at: info.state.localAt ?? Date.now(), until: Date.now() + RESUME_TTL };
      }
      setSession(info);
      renderChat();
      // Puede que ya haya llegado un estado más nuevo que el que traía la respuesta.
      if (active && info.state && role !== 'host' && (!remote || (info.state.seq ?? 0) >= (remote.state.seq ?? 0))) {
        remote = { state: info.state, at: info.state.localAt ?? Date.now() };
        applyRemote('hello');
      }
    });
  }

  // ---------- Enlace de invitación (#mirrored=CODIGO) ----------
  function checkInvite() {
    if (!isTop) return;
    const m = location.hash.match(/mirrored=([A-Z0-9]{6})/i);
    if (!m) return;
    send({ type: 'autojoin', code: m[1].toUpperCase() });
    // Quitamos el código de la URL: si se queda, cualquier hashchange posterior volvería a meternos en
    // una sesión que la persona acaba de dejar.
    const rest = location.hash.replace(/[#&]?mirrored=[A-Z0-9]{6}/i, '').replace(/^#?&?/, '');
    try {
      history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    } catch {}
  }

  window.addEventListener('hashchange', checkInvite);
  hello();
  checkInvite();
})();
