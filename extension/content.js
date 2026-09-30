// Mirrored — content script. Se inyecta en todos los frames; el frame que tenga el vídeo
// principal es el que actúa. El anfitrión emite su estado; los invitados lo aplican.
// También dibuja la interfaz (chat, reacciones, estado) encima del vídeo.

(() => {
  if (window.__mirrored) return;
  window.__mirrored = true;

  const DRIFT_HEARTBEAT = 1.0; // s de desfase tolerado en latidos periódicos
  const DRIFT_ACTION = 0.4; // s de desfase tolerado tras play/pausa/salto
  const BUFFER_REPORT_AFTER = 2000; // ms cargando antes de pedir a los demás que esperen
  const MAX_WAIT = 15000; // ms máximos esperando a alguien que carga
  const REACTIONS = ['😂', '😱', '❤️', '👏', '🔥', '😮', '🙄', '💀'];

  let active = false;
  let role = null;
  let myId = null;
  let allControl = false;
  let peers = [];
  let video = null;
  let ignoreUntil = 0; // ignora eventos locales provocados por nosotros mismos
  let remote = null; // { state, at } último estado recibido de quien controla
  let heartbeat = null;
  let pendingClick = false;

  // Espera por carga
  let bufferSince = null; // invitado: desde cuándo está cargando
  let autoPaused = false; // anfitrión: pausa puesta por nosotros para esperar a alguien
  let autoAction = false; // el siguiente evento local lo provocamos nosotros al esperar/reanudar
  let waitStart = 0;
  let waitCooldownUntil = 0;
  let lastReport = { status: null, at: 0, drift: null };

  // ---------- Elegir el vídeo principal ----------
  function pickVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 200 * 100) continue;
      let score = area;
      if (v.readyState > 0) score *= 2;
      if (!v.paused) score *= 2;
      if (v.duration > 120) score *= 4; // el episodio pesa más que un anuncio corto
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  const EVENTS = ['play', 'pause', 'seeked', 'ratechange'];

  function attach(v) {
    if (v === video) return;
    if (video) EVENTS.forEach((e) => video.removeEventListener(e, onLocalEvent));
    video = v;
    if (video) {
      EVENTS.forEach((e) => video.addEventListener(e, onLocalEvent));
      if (active && remote && role !== 'host') applyRemote('attach');
      if (active && role === 'host') sendState('attach');
    }
    renderUI();
  }

  // Solo buscamos el vídeo mientras hay sesión: fuera de ella el script no hace nada en la página.
  setInterval(() => {
    if (!active) return;
    if (!video || !video.isConnected || video.getBoundingClientRect().width === 0) attach(pickVideo());
    else {
      // Si aparece un vídeo mejor (p. ej. tras un anuncio), cámbiate.
      const v = pickVideo();
      if (v && v !== video && !v.paused && video.paused) attach(v);
    }
  }, 1000);

  const canControl = () => role === 'host' || allControl;

  // ---------- Enviar estado ----------
  function sendState(reason) {
    if (!active || !canControl() || !video || video.readyState === 0) return;
    const state = { time: video.currentTime, paused: video.paused, rate: video.playbackRate, duration: video.duration, reason };
    // Nuestra propia acción pasa a ser la referencia (en modo "todos controlan").
    if (reason !== 'heartbeat' && role !== 'host') remote = { state: { ...remote?.state, ...state }, at: Date.now() };
    chrome.runtime.sendMessage({ type: 'local-state', state }).catch(() => {});
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
  function sameMedia(state) {
    const a = state.duration, b = video?.duration;
    if (!(a > 0 && b > 0 && isFinite(a) && isFinite(b))) return true; // directo o aún cargando
    return Math.abs(a - b) < 3;
  }

  function applyRemote(reason) {
    if (!video || !remote) return;
    if (role === 'host' && !allControl) return;
    const { state } = remote;
    if (!sameMedia(state)) return;
    // En pausa se nota cualquier diferencia, así que ajustamos más fino.
    const tolerance = state.paused ? 0.15 : reason === 'heartbeat' ? DRIFT_HEARTBEAT : DRIFT_ACTION;
    // Mientras el vídeo carga (tras un salto o por red lenta) no lo movemos por un simple latido:
    // cada salto reinicia la carga y nunca llegaría a reproducirse.
    const loading = video.seeking || video.readyState < 3;

    if (video.playbackRate !== state.rate) {
      expect('ratechange');
      video.playbackRate = state.rate;
    }
    const target = targetTime();
    if (Math.abs(video.currentTime - target) > tolerance && !(reason === 'heartbeat' && loading)) {
      expect('seeked');
      video.currentTime = target;
    }

    if (state.paused && !video.paused) {
      expect('pause');
      video.pause();
    }
    if (!state.paused && video.paused) {
      expect('play');
      video.play().catch((err) => {
        // Solo NotAllowedError es un bloqueo de autoplay. Un AbortError (el play se canceló por un salto
        // o una pausa mientras cargaba) es normal en vídeos lentos y no debe congelar la sincronización.
        if (err?.name !== 'NotAllowedError') return;
        pendingClick = true;
        toast('Haz clic aquí para sincronizarte', () => {
          pendingClick = false;
          applyRemote('click');
        });
      });
    }
  }

  // Eventos que vamos a provocar nosotros al aplicar un estado remoto: el siguiente de cada tipo
  // se descarta, llegue cuando llegue (en vídeos lentos, un 'seeked' puede tardar segundos).
  const expected = {};
  function expect(type) {
    expected[type] = Date.now() + 20000;
    ignoreUntil = Date.now() + 400; // margen corto para eventos colaterales del reproductor
  }
  function wasExpected(type) {
    if (expected[type] && Date.now() < expected[type]) {
      expected[type] = 0;
      return true;
    }
    return false;
  }

  // ---------- Eventos locales ----------
  function onLocalEvent(e) {
    if (!active || !video) return;
    if (role === 'host' && autoAction) {
      autoAction = false;
      return sendState('auto');
    }
    if (wasExpected(e.type) || Date.now() < ignoreUntil) return;
    if (role === 'host') {
      if (autoPaused) autoPaused = false; // el anfitrión toma el control manualmente
      return sendState(e.type);
    }
    if (!remote || !sameMedia(remote.state)) return;
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
    if (!sameMedia(remote.state)) return { status: 'ad', drift: null };
    if (bufferSince && Date.now() - bufferSince > BUFFER_REPORT_AFTER) return { status: 'buffering', drift: null };
    const drift = video.currentTime - targetTime();
    return { status: Math.abs(drift) > 1.5 ? 'behind' : 'ok', drift };
  }

  setInterval(() => {
    if (!active || !video) return;
    const now = Date.now();

    // Invitado: ¿está cargando mientras los demás reproducen?
    if (role !== 'host' && remote && sameMedia(remote.state)) {
      const starving = video.readyState < 3;
      if (!starving) bufferSince = null;
      else if (!bufferSince && !remote.state.paused && now > ignoreUntil) bufferSince = now;
    } else bufferSince = null;

    // Anfitrión: pausa a todos mientras alguien carga (con un máximo).
    if (role === 'host') {
      const loading = peers.filter((p) => !p.host && p.status === 'buffering');
      if (loading.length && !video.paused && !autoPaused && now > waitCooldownUntil) {
        autoPaused = true;
        autoAction = true;
        waitStart = now;
        video.pause();
        toast(`Esperando a ${loading.map((p) => p.name).join(', ')}…`);
      } else if (autoPaused && (!loading.length || now - waitStart > MAX_WAIT)) {
        if (loading.length) waitCooldownUntil = now + 30000;
        autoPaused = false;
        if (video.paused) {
          autoAction = true;
          video.play().catch(() => {});
        }
        toast(loading.length ? 'Seguimos sin esperar más' : 'Todos listos ▶');
      }
    }

    // Informa de mi estado al resto (al cambiar, o cada 4 s).
    const st = myStatus();
    const changed = st.status !== lastReport.status || Math.abs((st.drift || 0) - (lastReport.drift || 0)) >= 1;
    if (changed || now - lastReport.at > 4000) {
      lastReport = { ...st, at: now };
      chrome.runtime.sendMessage({ type: 'report', status: st.status, drift: st.drift }).catch(() => {});
    }
    renderBadge(st);
  }, 500);

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
    .badge { padding: 4px 10px; font-size: 12px; border-radius: 999px; opacity: .9; }
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
          <div class="badge"><span class="dot"></span><span class="btext"></span></div>
          <div class="bar"></div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const els = { host, root: $('.root'), toast: $('.toast'), bubbles: $('.bubbles'), panel: $('.panel'), msgs: $('.msgs'),
      input: $('input'), badge: $('.badge'), btext: $('.btext'), bar: $('.bar') };
    for (const emoji of REACTIONS) {
      const b = document.createElement('button');
      b.textContent = emoji;
      b.title = 'Reaccionar';
      b.onclick = () => chrome.runtime.sendMessage({ type: 'reaction', emoji }).catch(() => {});
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

  function mountPoint() {
    const fs = document.fullscreenElement;
    // Si lo que está a pantalla completa es el propio <video>, no se puede dibujar encima.
    return fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
  }

  function renderUI() {
    const show = active && !!video;
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
    if (!ui || panelOpen || m.id === myId) return;
    unread++;
    renderUnread();
    const b = msgEl(m, 'bubble');
    ui.bubbles.append(b);
    setTimeout(() => b.remove(), 6000);
  }

  function onReaction(r) {
    if (!ui) return;
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
      text = autoPaused ? 'Esperando a que carguen…' : loading ? `${loading} cargando` : behind ? `${behind} desincronizado` : 'Anfitrión';
      if (autoPaused || loading || behind) cls = 'warn';
    } else if (st.status === 'ad') {
      text = 'En anuncio (se sincroniza al acabar)';
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

  let toastTimer = null;
  function toast(text, onClick) {
    if (!ui) return;
    ui.toast.textContent = '⟳ Mirrored · ' + text;
    ui.toast.className = 'toast show' + (onClick ? ' click' : '');
    ui.toast.onclick = onClick
      ? () => {
          ui.toast.className = 'toast';
          onClick();
        }
      : null;
    clearTimeout(toastTimer);
    if (!onClick) toastTimer = setTimeout(() => (ui.toast.className = 'toast'), 2500);
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
        if (e.key === 'Enter') {
          const text = ui.input.value.trim();
          if (text) chrome.runtime.sendMessage({ type: 'chat', text }).catch(() => {});
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
    active = !!info.active;
    role = info.role || null;
    myId = info.id ?? myId;
    allControl = !!info.allControl;
    if (info.peers) peers = info.peers;
    clearInterval(heartbeat);
    if (active && (!video || !video.isConnected)) attach(pickVideo());
    renderUI();
    if (!active) {
      remote = null;
      chatLog = [];
      autoPaused = false;
      return;
    }
    if (role === 'host') {
      startHeartbeat();
      if (!wasActive || prevRole !== 'host') sendState('join');
      if (prevRole && prevRole !== 'host') toast('Ahora eres el anfitrión');
    } else if (!wasActive) {
      toast(`Conectado a la sesión ${info.code}`);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'session':
        setSession(msg);
        break;
      case 'remote-state':
        if (!active) return;
        remote = { state: msg.state, at: Date.now() };
        if (msg.state.reason === 'auto' && msg.state.paused && role !== 'host') toast('Pausa automática: alguien está cargando');
        if (!pendingClick) applyRemote(msg.state.reason);
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
  });

  function hello() {
    chrome.runtime
      .sendMessage({ type: 'hello' })
      .then((info) => {
        if (!info) return;
        if (info.chat) chatLog = info.chat;
        setSession(info);
        renderChat();
        if (info.state && role !== 'host') {
          remote = { state: info.state, at: Date.now() };
          applyRemote('hello');
        }
      })
      .catch(() => {});
  }

  // ---------- Enlace de invitación (#mirrored=CODIGO) ----------
  function checkInvite() {
    if (window !== window.top) return;
    const m = location.hash.match(/mirrored=([A-Z0-9]{6})/i);
    if (m) chrome.runtime.sendMessage({ type: 'autojoin', code: m[1].toUpperCase() }).catch(() => {});
  }

  window.addEventListener('hashchange', checkInvite);
  hello();
  checkInvite();
})();
