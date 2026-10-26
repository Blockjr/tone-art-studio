/* Tone Art Studio remote controller.
 *
 * Plain DOM, no build step: the bridge serves this file and the app streams a
 * session snapshot ten times a second. Every control sends a command back and
 * lets the next snapshot confirm it, so the tablet and the studio can never
 * disagree about a fader for long.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const dbFromGain = (gain) => (gain <= 0.001 ? null : 20 * Math.log10(gain));
  const formatDb = (gain) => {
    const db = dbFromGain(gain);
    return db === null ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  };
  const formatPan = (pan) => {
    if (Math.abs(pan) < 0.02) return 'C';
    return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
  };

  const state = {
    connected: false,
    desktop: false,
    playing: false,
    loop: false,
    recording: false,
    recordingStarting: false,
    recordingTrackId: null,
    countingIn: false,
    countInRemaining: 0,
    recordHintText: '',
    recordHintUntil: 0,
    bpm: 124,
    beatsPerBar: 4,
    position: 0,
    length: 32,
    loopStart: 0,
    loopEnd: 32,
    selectedTrackId: '',
    masterVolume: 1,
    tracks: [],
    returns: [],
    clips: [],
  };

  const rows = new Map();
  const returnRows = new Map();
  let socket = null;
  let reconnectTimer = 0;
  let latency = null;
  let pingTimer = 0;
  let seeking = false;
  let recordHintTimer = 0;

  const perf = { a: 0, b: 0, dragging: false, trackId: '', points: [], lastPoint: 0, lastSent: 0 };
  let songDragging = false;

  // ------------------------------------------------------------- connection
  // The bridge can be this page's own origin (the normal case), a Wi-Fi address
  // typed on the tablet, or a public tunnel. The address and token persist, so
  // an installed remote reconnects by itself on the next launch.
  const TOKEN_KEY = 'toneart.remote.token';
  const BRIDGE_KEY = 'toneart.remote.bridge';
  const params = new URLSearchParams(location.search);
  const safeStore = {
    read(key) {
      try {
        return localStorage.getItem(key) ?? '';
      } catch {
        return '';
      }
    },
    write(key, value) {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        /* private mode still works for this session */
      }
    },
  };

  function bridgeKind(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) return 'local';
    if (host.endsWith('.local') || !host.includes('.')) return 'lan';
    const octets = host.split('.').map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      if (octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)) return 'lan';
      if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 'lan';
      if (octets[0] === 169 && octets[1] === 254) return 'lan';
    }
    return 'internet';
  }

  function parseBridge(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname) return null;
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    return {
      http: `${secure ? 'https' : 'http'}://${url.host}`,
      ws: `${secure ? 'wss' : 'ws'}://${url.host}/ws`,
      kind: bridgeKind(url.hostname),
    };
  }

  function withToken(target) {
    if (!token) return target;
    const url = new URL(target);
    url.searchParams.set('token', token);
    return url.toString();
  }

  function samePageBridge() {
    return parseBridge(`${location.protocol === 'https:' ? 'https' : 'http'}://${location.host}`);
  }

  function resolveBridge() {
    return bridgeOverride ? parseBridge(bridgeOverride) : samePageBridge();
  }

  function reconnectDelay(attempt) {
    const base = Math.min(8000, 600 * Math.pow(1.7, Math.max(0, attempt - 1)));
    return Math.round(base * (0.85 + Math.random() * 0.3));
  }

  function displayLink(url) {
    return url.replace(/([?&]token=)[^&]*/, '$1…');
  }

  let token = (params.get('token') ?? '').trim() || safeStore.read(TOKEN_KEY);
  if (params.get('token')) safeStore.write(TOKEN_KEY, token);
  let bridgeOverride = (params.get('bridge') ?? '').trim() || safeStore.read(BRIDGE_KEY);
  if (params.get('bridge')) safeStore.write(BRIDGE_KEY, bridgeOverride);
  let reconnectAttempts = 0;
  let socketWasAuthorized = false;
  let installPrompt = null;

  const buzz = (pattern) => {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        /* ignore */
      }
    }
  };

  // ------------------------------------------------------------------ socket

  function setStatus(kind, text) {
    const pill = $('status-pill');
    pill.classList.toggle('is-online', kind === 'online');
    pill.classList.toggle('is-waiting', kind === 'waiting');
    $('status').textContent = text;
  }

  function send(command) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'command', ...command }));
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const link = resolveBridge();
    if (!link) {
      setStatus('waiting', 'choose a bridge');
      openConnect();
      return;
    }

    const url = withToken(`${link.ws}?role=tablet`);
    $('link').textContent = displayLink(url);
    setLinkKind(link.kind);
    updateNetwork();
    setStatus('waiting', 'connecting…');
    socketWasAuthorized = false;

    try {
      socket = new WebSocket(url);
    } catch {
      socket = null;
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      state.connected = true;
      reconnectAttempts = 0;
      socketWasAuthorized = true;
      setStatus('waiting', 'waiting for studio');
      sendPing();
      clearInterval(pingTimer);
      pingTimer = setInterval(sendPing, 3000);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'state') applyState(message);
      else if (message.type === 'pong') {
        if (typeof message.at === 'number') {
          latency = Math.max(0, Date.now() - message.at);
          $('latency').textContent = `${latency} ms`;
        }
      } else if (message.type === 'desktop') {
        state.desktop = Boolean(message.online);
        if (!state.desktop) setStatus('waiting', 'studio offline');
      } else if (message.type === 'hello') {
        state.desktop = Boolean(message.desktopOnline);
        if (state.desktop) setStatus('online', 'live');
      }
    });

    socket.addEventListener('close', (event) => {
      state.connected = false;
      state.desktop = false;
      clearInterval(pingTimer);
      $('latency').textContent = '';
      if (event.code === 4401) {
        setStatus('waiting', 'bridge token needed');
        openConnect();
        return;
      }
      if (event.code === 4403) {
        setStatus('waiting', 'bridge blocked this page');
        return;
      }
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (!socketWasAuthorized) setStatus('waiting', 'connection error');
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (navigator.onLine === false) {
      updateNetwork();
      setStatus('waiting', 'offline');
      return;
    }
    reconnectAttempts += 1;
    const delay = reconnectDelay(reconnectAttempts);
    setStatus('waiting', `reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function sendPing() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  }

  // ------------------------------------------------------------- formatting

  function formatBars(beat) {
    const safe = Math.max(0, beat);
    const bar = Math.floor(safe / state.beatsPerBar) + 1;
    const beatInBar = Math.floor(safe % state.beatsPerBar) + 1;
    const sixteenth = Math.floor((safe % 1) * 4) + 1;
    return `${bar}.${beatInBar}.${sixteenth}`;
  }

  // ----------------------------------------------------------------- tracks

  function buildTrack(track) {
    const root = document.createElement('article');
    root.className = 'track';
    root.dataset.id = track.id;
    root.style.setProperty('--accent', track.color);
    root.innerHTML = `
      <button class="track-head" data-action="select" type="button">
        <span class="swatch"></span>
        <span class="names"><strong></strong><em></em></span>
        <span class="track-db">−∞ dB</span>
      </button>
      <div class="track-body">
        <div class="meter" aria-hidden="true"><i class="fill"></i><span class="peak-hold"></span></div>
        <div class="fader-wrap">
          <input class="fader" type="range" min="0" max="1.4" step="0.01" aria-label="Volume" />
        </div>
        <div class="pills">
          ${track.kind === 'audio' ? '<button class="pill arm" data-action="arm" type="button" aria-pressed="false" title="Arm for recording">●</button>' : ''}
          <button class="pill mute" data-action="mute" type="button" aria-pressed="false">M</button>
          <button class="pill solo" data-action="solo" type="button" aria-pressed="false">S</button>
        </div>
      </div>
      <div class="track-extra">
        <div class="pan">
          <div class="knob" role="slider" tabindex="0" aria-label="Pan" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="0"></div>
          <span class="pan-label">C</span>
        </div>
        <button class="sends-toggle" type="button" aria-expanded="false">Sends</button>
      </div>
      <div class="sends" hidden></div>
    `;

    const parts = {
      root,
      name: root.querySelector('.names strong'),
      type: root.querySelector('.names em'),
      db: root.querySelector('.track-db'),
      fill: root.querySelector('.meter .fill'),
      peakHold: root.querySelector('.meter .peak-hold'),
      heldPeak: 0,
      fader: root.querySelector('.fader'),
      arm: root.querySelector('.arm'),
      mute: root.querySelector('.mute'),
      solo: root.querySelector('.solo'),
      knob: root.querySelector('.knob'),
      panLabel: root.querySelector('.pan-label'),
      sendsToggle: root.querySelector('.sends-toggle'),
      sends: root.querySelector('.sends'),
      sendRows: [],
      pan: track.pan,
    };

    root.querySelector('.swatch').style.background = track.color;
    parts.name.textContent = track.name;
    parts.type.textContent = track.kind === 'midi' ? 'MIDI' : 'AUDIO';

    parts.fader.addEventListener('input', () => {
      parts.db.textContent = formatDb(Number(parts.fader.value));
      send({ kind: 'volume', trackId: track.id, value: Number(parts.fader.value) });
    });
    parts.fader.addEventListener('change', () => buzz(4));

    parts.mute.addEventListener('click', () => {
      buzz(8);
      send({ kind: 'mute', trackId: track.id });
    });
    parts.solo.addEventListener('click', () => {
      buzz(8);
      send({ kind: 'solo', trackId: track.id });
    });
    parts.arm?.addEventListener('click', () => {
      if (!state.connected || !state.desktop) {
        showRecordHint(state.connected ? 'STUDIO OFFLINE' : 'OFFLINE');
        return;
      }
      const next = parts.arm.getAttribute('aria-pressed') !== 'true';
      // Confirm the arm immediately; the next snapshot is the authority.
      parts.arm.classList.toggle('is-on', next);
      parts.arm.setAttribute('aria-pressed', String(next));
      parts.root.classList.toggle('is-armed', next);
      buzz(next ? [12, 26, 12] : 10);
      send({ kind: 'arm', trackId: track.id, armed: next });
    });

    root.querySelector('.track-head').addEventListener('click', () => {
      buzz(5);
      send({ kind: 'select', trackId: track.id });
    });

    parts.sendsToggle.addEventListener('click', () => {
      const open = parts.sendsToggle.getAttribute('aria-expanded') === 'true';
      parts.sendsToggle.setAttribute('aria-expanded', String(!open));
      parts.sends.hidden = open;
    });

    bindPan(parts, track.id);
    return parts;
  }

  function bindPan(parts, trackId) {
    let drag = null;
    let lastSent = 0;

    const apply = (pan, force) => {
      parts.pan = pan;
      parts.knob.style.setProperty('--pan', String(pan));
      parts.knob.setAttribute('aria-valuenow', String(Math.round(pan * 100)));
      parts.panLabel.textContent = formatPan(pan);
      const now = performance.now();
      if (force || now - lastSent > 45) {
        lastSent = now;
        send({ kind: 'pan', trackId, value: pan });
      }
    };

    parts.knob.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      parts.knob.setPointerCapture(event.pointerId);
      drag = { y: event.clientY, pan: parts.pan };
      buzz(4);
    });
    parts.knob.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const next = clamp(drag.pan + (drag.y - event.clientY) / 70, -1, 1);
      apply(Math.round(next * 100) / 100, false);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      send({ kind: 'pan', trackId, value: parts.pan });
    };
    parts.knob.addEventListener('pointerup', end);
    parts.knob.addEventListener('pointercancel', end);

    parts.knob.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.2 : 0.05;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') apply(clamp(parts.pan - step, -1, 1), true);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') apply(clamp(parts.pan + step, -1, 1), true);
      else if (event.key === 'Home') apply(0, true);
      else return;
      event.preventDefault();
    });
  }

  function renderTracks(tracks) {
    const container = $('tracks');
    const ids = tracks.map((track) => track.id).join(',');

    if (container.dataset.ids !== ids) {
      container.replaceChildren();
      rows.clear();
      for (const track of tracks) {
        const parts = buildTrack(track);
        rows.set(track.id, parts);
        container.appendChild(parts.root);
      }
      container.dataset.ids = ids;
    }

    $('track-count').textContent = `${tracks.length} channels`;

    for (const track of tracks) {
      const parts = rows.get(track.id);
      if (!parts) continue;

      parts.name.textContent = track.name;
      parts.root.classList.toggle('is-selected', track.id === state.selectedTrackId);
      if (document.activeElement !== parts.fader) {
        parts.fader.value = String(track.volume);
        parts.db.textContent = formatDb(track.volume);
      }
      parts.mute.classList.toggle('is-on', track.mute);
      parts.mute.setAttribute('aria-pressed', String(track.mute));
      parts.solo.classList.toggle('is-on', track.solo);
      parts.solo.setAttribute('aria-pressed', String(track.solo));
      parts.root.classList.toggle('is-armed', Boolean(track.armed));
      parts.root.classList.toggle('is-recording', track.id === state.recordingTrackId);
      if (parts.arm) {
        parts.arm.classList.toggle('is-on', Boolean(track.armed));
        parts.arm.setAttribute('aria-pressed', String(Boolean(track.armed)));
        parts.arm.title = track.armed ? 'Disarm recording' : 'Arm for recording';
      }
      parts.fill.style.height = `${clamp(track.peak * 100, 0, 100).toFixed(1)}%`;
      parts.heldPeak = Math.max(track.peak, (parts.heldPeak || 0) - 0.012);
      parts.peakHold.style.bottom = `${clamp(parts.heldPeak * 100, 0, 100).toFixed(1)}%`;
      parts.peakHold.style.opacity = parts.heldPeak > 0.02 ? '0.65' : '0';

      if (document.activeElement !== parts.knob) {
        parts.pan = track.pan;
        parts.knob.style.setProperty('--pan', String(track.pan));
        parts.knob.setAttribute('aria-valuenow', String(Math.round(track.pan * 100)));
        parts.panLabel.textContent = formatPan(track.pan);
      }

      syncSends(parts, track);
    }
  }

  function syncSends(parts, track) {
    if (!parts.sends.childElementCount) {
      track.sends.forEach((value, index) => {
        const row = document.createElement('div');
        row.className = 'send-row';
        const label = document.createElement('span');
        label.textContent = 'ABCD'[index] ?? String(index + 1);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.01';
        slider.value = String(value);
        slider.setAttribute('aria-label', `Send ${'ABCD'[index] ?? index + 1} level`);
        const pre = document.createElement('button');
        pre.className = 'pre-toggle';
        pre.type = 'button';
        pre.textContent = 'PRE';
        pre.title = 'Pre-fader send';

        slider.addEventListener('input', () =>
          send({ kind: 'send', trackId: track.id, index, value: Number(slider.value) }),
        );
        pre.addEventListener('click', () => {
          const next = !pre.classList.contains('is-on');
          pre.classList.toggle('is-on', next);
          send({ kind: 'sendMode', trackId: track.id, index, pre: next });
        });

        row.append(label, slider, pre);
        parts.sends.appendChild(row);
        parts.sendRows.push({ slider, pre });
      });
    }

    track.sends.forEach((value, index) => {
      const refs = parts.sendRows[index];
      if (!refs) return;
      if (document.activeElement !== refs.slider) refs.slider.value = String(value);
      refs.pre.classList.toggle('is-on', Boolean(track.preSends[index]));
    });
  }

  // ---------------------------------------------------------------- returns

  function buildReturn(bus) {
    const root = document.createElement('article');
    root.className = 'return-card';
    root.dataset.id = bus.id;
    root.style.setProperty('--accent', bus.color);
    root.innerHTML = `
      <span class="return-label"></span>
      <div class="names"><strong></strong></div>
      <div class="meter" aria-hidden="true"><i class="fill"></i><span class="peak-hold"></span></div>
      <input class="fader" type="range" min="0" max="1.4" step="0.01" aria-label="Return volume" />
      <button class="pill mute" type="button" aria-pressed="false">M</button>
    `;

    const parts = {
      root,
      label: root.querySelector('.return-label'),
      name: root.querySelector('.names strong'),
      fill: root.querySelector('.meter .fill'),
      peakHold: root.querySelector('.meter .peak-hold'),
      heldPeak: 0,
      fader: root.querySelector('.fader'),
      mute: root.querySelector('.mute'),
    };

    parts.label.textContent = bus.label;
    parts.name.textContent = bus.name;

    parts.fader.addEventListener('input', () =>
      send({ kind: 'returnLevel', returnId: bus.id, value: Number(parts.fader.value) }),
    );
    parts.mute.addEventListener('click', () => {
      buzz(8);
      send({ kind: 'returnMute', returnId: bus.id });
    });

    return parts;
  }

  function renderReturns(returns) {
    const container = $('returns');
    const ids = returns.map((bus) => bus.id).join(',');

    if (container.dataset.ids !== ids) {
      container.replaceChildren();
      returnRows.clear();
      for (const bus of returns) {
        const parts = buildReturn(bus);
        returnRows.set(bus.id, parts);
        container.appendChild(parts.root);
      }
      container.dataset.ids = ids;
    }

    for (const bus of returns) {
      const parts = returnRows.get(bus.id);
      if (!parts) continue;
      parts.name.textContent = bus.name;
      if (document.activeElement !== parts.fader) parts.fader.value = String(bus.volume);
      parts.fill.style.height = `${clamp(bus.peak * 100, 0, 100).toFixed(1)}%`;
      parts.heldPeak = Math.max(bus.peak, (parts.heldPeak || 0) - 0.012);
      parts.peakHold.style.bottom = `${clamp(parts.heldPeak * 100, 0, 100).toFixed(1)}%`;
      parts.peakHold.style.opacity = parts.heldPeak > 0.02 ? '0.65' : '0';
      parts.mute.classList.toggle('is-on', bus.mute);
      parts.mute.setAttribute('aria-pressed', String(bus.mute));
      parts.root.classList.toggle('is-muted', bus.mute);
    }
  }


  // ----------------------------------------------------------- arrangement

  const trackColor = (id) => state.tracks.find((track) => track.id === id)?.color || '#f43f5e';

  let songKey = '';

  function renderSong() {
    const host = $('song-rows');
    const length = Math.max(1, state.length);
    const tracks = state.tracks.slice(0, 8);
    const clips = state.clips || [];
    const key = `${length}|${tracks.map((t) => `${t.id}:${t.name}`).join(',')}|${clips
      .map((c) => `${c.id}:${c.trackId}:${c.start}:${c.length}`)
      .join(',')}`;

    if (key !== songKey) {
      songKey = key;
      host.replaceChildren();
      const rowByTrack = new Map();
      for (const track of tracks) {
        const row = document.createElement('div');
        row.className = 'song-row';
        row.dataset.trackId = track.id;
        row.style.setProperty('--clip', track.color);
        host.appendChild(row);
        rowByTrack.set(track.id, row);
      }

      for (const clip of clips) {
        const row = rowByTrack.get(clip.trackId);
        if (!row) continue;
        const block = document.createElement('div');
        block.className = 'song-clip';
        block.style.left = `${clamp((clip.start / length) * 100, 0, 100)}%`;
        block.style.width = `${clamp((clip.length / length) * 100, 0.4, 100)}%`;
        block.style.setProperty('--clip', trackColor(clip.trackId));
        block.title = clip.name;
        const label = document.createElement('span');
        label.textContent = clip.name;
        block.appendChild(label);
        row.appendChild(block);
      }

      if (!tracks.length) {
        const empty = document.createElement('div');
        empty.className = 'song-empty';
        empty.textContent = 'No tracks yet';
        host.appendChild(empty);
      }

      const barStep = (state.beatsPerBar / length) * 100;
      $('song-map').style.setProperty('--bar-step', `${Math.max(1.5, Math.min(40, barStep)).toFixed(2)}%`);
    }

    $('song-start').textContent = '1.1';
    $('song-end').textContent = formatBars(state.length);
    updateSongPlay();
  }

  function updateSongPlay() {
    const pct = clamp((state.position / state.length) * 100, 0, 100);
    $('song-play').style.left = `${pct}%`;

    const band = $('song-loop');
    const looped = state.loop && state.loopEnd > state.loopStart;
    band.style.opacity = looped ? '1' : '0';
    if (looped) {
      const left = clamp((state.loopStart / state.length) * 100, 0, 100);
      const right = clamp((state.loopEnd / state.length) * 100, 0, 100);
      band.style.left = `${left}%`;
      band.style.width = `${Math.max(0.5, right - left)}%`;
    }
  }

  let lastSeekSent = 0;
  let lastSongTrack = '';
  let pendingSongTarget = null;

  function songSeek(event, force) {
    const map = $('song-map');
    const rect = map.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const beat = Math.round(x * state.length * 4) / 4;
    const row = Math.max(0, Math.floor((event.clientY - rect.top - 8) / 22));
    const track = state.tracks[Math.min(row, state.tracks.length - 1)];
    const hit = (state.clips || []).find(
      (clip) => clip.trackId === track?.id && beat >= clip.start && beat <= clip.start + clip.length,
    );
    const target = hit ? hit.start : beat;

    if (track && track.id !== lastSongTrack) {
      lastSongTrack = track.id;
      send({ kind: 'select', trackId: track.id });
    }
    pendingSongTarget = target;
    const now = performance.now();
    if (force || now - lastSeekSent > 55) {
      lastSeekSent = now;
      pendingSongTarget = null;
      send({ kind: 'seek', beat: target });
    }
    updateSeekVisual(target);
    updateSongPlay();
  }

  const songMap = $('song-map');
  songMap.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    songMap.setPointerCapture(event.pointerId);
    songDragging = true;
    lastSongTrack = '';
    songSeek(event, true);
    buzz(3);
  });
  songMap.addEventListener('pointermove', (event) => {
    if (songDragging) songSeek(event, false);
  });
  const endSongDrag = () => {
    if (!songDragging) return;
    songDragging = false;
    if (pendingSongTarget !== null) {
      send({ kind: 'seek', beat: pendingSongTarget });
      pendingSongTarget = null;
    }
  };
  songMap.addEventListener('keydown', (event) => {
    const beat = clamp(state.position + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0), 0, state.length);
    if (event.key === 'Home') {
      send({ kind: 'seek', beat: 0 });
      event.preventDefault();
    } else if (beat !== state.position) {
      send({ kind: 'seek', beat });
      updateSeekVisual(beat);
      updateSongPlay();
      event.preventDefault();
    }
  });
  songMap.addEventListener('pointerup', endSongDrag);
  songMap.addEventListener('pointercancel', endSongDrag);

  // ----------------------------------------------------------- performance

  function selectedTrack() {
    return state.tracks.find((track) => track.id === state.selectedTrackId) || state.tracks[0] || null;
  }

  function paintPerf() {
    const a = clamp(perf.a, 0, 1);
    const b = clamp(perf.b, 0, 1);
    $('perf-dot').style.left = `${a * 100}%`;
    $('perf-dot').style.top = `${(1 - b) * 100}%`;
    document.querySelector('.perf-cross.v').style.left = `${a * 100}%`;
    document.querySelector('.perf-cross.h').style.top = `${(1 - b) * 100}%`;
    $('perf-a').textContent = `${Math.round(a * 100)}%`;
    $('perf-b').textContent = `${Math.round(b * 100)}%`;
  }

  function sentPerf(force) {
    const track = state.tracks.find((entry) => entry.id === perf.trackId);
    if (!track) return;
    const now = performance.now();
    if (!force && now - perf.lastSent < 40) return;
    perf.lastSent = now;
    send({ kind: 'send', trackId: track.id, index: 0, value: perf.a });
    send({ kind: 'send', trackId: track.id, index: 1, value: perf.b });
  }

  function pushTrail() {
    const now = performance.now();
    if (now - perf.lastPoint < 55) return;
    perf.lastPoint = now;
    perf.points.push(`${(perf.a * 100).toFixed(1)},${((1 - perf.b) * 100).toFixed(1)}`);
    if (perf.points.length > 20) perf.points.shift();
    $('perf-trail').setAttribute('points', perf.points.join(' '));
  }

  function readPerf(event) {
    const pad = $('perf-pad');
    const rect = pad.getBoundingClientRect();
    perf.a = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    perf.b = clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1);
    paintPerf();
    pushTrail();
    sentPerf(false);
  }

  function resetPerf() {
    perf.a = 0;
    perf.b = 0;
    perf.points = [];
    $('perf-trail').setAttribute('points', '');
    paintPerf();
    sentPerf(true);
    buzz(8);
  }

  const perfPad = $('perf-pad');
  let lastPerfTap = 0;

  perfPad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const track = selectedTrack();
    if (!track) return;
    perfPad.setPointerCapture(event.pointerId);
    perf.trackId = track.id;

    const now = performance.now();
    if (now - lastPerfTap < 280 && !perf.dragging) {
      lastPerfTap = 0;
      resetPerf();
      return;
    }
    lastPerfTap = now;

    perf.dragging = true;
    perf.points = [];
    perfPad.classList.add('is-dragging');
    readPerf(event);
    buzz(4);
  });
  perfPad.addEventListener('pointermove', (event) => {
    if (perf.dragging) readPerf(event);
  });
  const endPerf = () => {
    if (!perf.dragging) return;
    perf.dragging = false;
    perfPad.classList.remove('is-dragging');
    sentPerf(true);
  };
  perfPad.addEventListener('pointerup', endPerf);
  perfPad.addEventListener('pointercancel', endPerf);
  $('perf-reset').addEventListener('click', resetPerf);

  perfPad.addEventListener('keydown', (event) => {
    const track = selectedTrack();
    if (!track) return;
    perf.trackId = track.id;
    const step = event.shiftKey ? 0.1 : 0.04;
    if (event.key === 'ArrowLeft') perf.a = clamp(perf.a - step, 0, 1);
    else if (event.key === 'ArrowRight') perf.a = clamp(perf.a + step, 0, 1);
    else if (event.key === 'ArrowDown') perf.b = clamp(perf.b - step, 0, 1);
    else if (event.key === 'ArrowUp') perf.b = clamp(perf.b + step, 0, 1);
    else if (event.key === 'Home') {
      perf.a = 0;
      perf.b = 0;
    } else return;
    event.preventDefault();
    paintPerf();
    sentPerf(true);
  });

  function updatePerfFromState() {
    const track = selectedTrack();
    $('perf-track').textContent = track ? track.name : 'No channel';
    $('perf-name-a').textContent = (state.returns[0]?.name || 'Reverb').toUpperCase();
    $('perf-name-b').textContent = (state.returns[1]?.name || 'Delay').toUpperCase();
    $('perf-axis-x').textContent = `${(state.returns[0]?.name || 'Reverb').toUpperCase()} →`;
    $('perf-axis-y').textContent = `↑ ${(state.returns[1]?.name || 'Delay').toUpperCase()}`;

    if (!track || perf.dragging) return;
    perf.a = track.sends[0] ?? 0;
    perf.b = track.sends[1] ?? 0;
    perf.trackId = track.id;
    paintPerf();
  }

  function paintMasterPeak(peak) {
    const held = Math.max(peak, (paintMasterPeak.last || 0) - 0.012);
    paintMasterPeak.last = held;
    $('master-peak-hold').style.bottom = `${clamp(held * 100, 0, 100).toFixed(1)}%`;
    $('master-peak-hold').style.opacity = held > 0.02 ? '0.65' : '0';
    $('master-db').classList.toggle('is-hot', peak > 0.96);
  }

  // ------------------------------------------------------------------ state

  function showRecordHint(text, ms = 2400) {
    state.recordHintText = text;
    state.recordHintUntil = Date.now() + ms;
    renderRecordState();
    clearTimeout(recordHintTimer);
    recordHintTimer = setTimeout(() => {
      state.recordHintText = '';
      state.recordHintUntil = 0;
      renderRecordState();
    }, ms + 20);
  }

  function renderRecordState() {
    const badge = $('record-state');
    const pad = $('record');
    const hinting = Date.now() < state.recordHintUntil;
    const armed = state.tracks.some((track) => track.kind === 'audio' && track.armed);

    let text = '';
    let kind = '';
    if (hinting) {
      text = state.recordHintText;
      kind = 'is-hint';
    } else if (state.recording) {
      text = 'REC';
      kind = 'is-rec';
    } else if (state.countingIn) {
      text = `COUNT ${state.countInRemaining || ''}`.trim();
      kind = 'is-counting';
    } else if (state.recordingStarting) {
      text = 'ARMING';
      kind = 'is-arming';
    }

    badge.hidden = !text;
    badge.textContent = text;
    badge.className = `record-state${kind ? ` ${kind}` : ''}`;

    pad.classList.toggle('is-on', state.recording);
    pad.classList.toggle('is-counting', state.countingIn || (state.recordingStarting && !state.recording));
    pad.classList.toggle('has-arm', armed);
    pad.setAttribute('aria-pressed', String(state.recording));
    pad.setAttribute('aria-label', state.recording ? 'Stop recording' : 'Record');
    pad.title = state.recording
      ? 'Stop recording and keep the take'
      : armed
        ? 'Record onto the armed audio track'
        : 'Arm an audio track first';
  }

  function applyState(message) {
    const wasStarting = state.recordingStarting || state.countingIn;
    state.playing = Boolean(message.playing);
    state.loop = Boolean(message.loop);
    state.recording = Boolean(message.recording);
    state.recordingStarting = Boolean(message.recordingStarting);
    state.recordingTrackId = message.recordingTrackId ?? null;
    state.countingIn = Boolean(message.countingIn);
    state.countInRemaining = Number(message.countInRemaining) || 0;
    state.bpm = message.bpm;
    state.beatsPerBar = message.beatsPerBar || 4;
    state.position = message.position;
    state.length = Math.max(1, message.length || 1);
    state.loopStart = message.loopStart ?? 0;
    state.loopEnd = message.loopEnd ?? state.length;
    state.selectedTrackId = message.selectedTrackId ?? '';
    state.masterVolume = message.masterVolume;
    state.tracks = Array.isArray(message.tracks) ? message.tracks : [];
    state.returns = Array.isArray(message.returns) ? message.returns : [];
    state.clips = Array.isArray(message.clips) ? message.clips : [];
    state.desktop = true;

    $('project-name').textContent = message.projectName || 'Session';
    $('project-meta').textContent = `${message.tracks?.length ?? 0} tracks · ${state.beatsPerBar}/4 · ${state.bpm} BPM`;
    $('position').textContent = formatBars(state.position);
    $('bpm').textContent = String(state.bpm);
    $('play').classList.toggle('is-on', state.playing);
    $('play').setAttribute('aria-pressed', String(state.playing));
    $('play-icon').setAttribute('d', state.playing ? 'M7 5h4v14H7zM14 5h4v14h-4z' : 'M8 5v14l11-7z');
    $('loop').classList.toggle('is-on', state.loop);
    $('loop').setAttribute('aria-pressed', String(state.loop));

    const seek = $('seek');
    seek.max = String(Math.ceil(state.length));
    if (!seeking) {
      seek.value = String(state.position);
      updateSeekVisual(state.position);
    }
    $('seek-total').textContent = formatBars(state.length);
    updateLoopBand();

    const pct = clamp((state.position / state.length) * 100, 0, 100);
    $('loop-band').style.opacity = state.loop ? '1' : '0';
    document.documentElement.style.setProperty('--song-pct', `${pct}%`);

    if (document.activeElement !== $('master')) $('master').value = String(state.masterVolume);
    $('master-gain').textContent = formatDb(state.masterVolume);
    $('master-fill').style.height = `${clamp(message.masterPeak * 100, 0, 100).toFixed(1)}%`;
    const peak = formatDb(message.masterPeak);
    $('master-db').textContent = peak === '−∞ dB' ? '−∞ PEAK' : `${peak} PEAK`;
    renderChain(message.masterChain ?? []);

    renderTracks(state.tracks);
    renderReturns(state.returns);
    renderSong();
    updatePerfFromState();
    renderRecordState();
    if (wasStarting && !state.recording && !state.recordingStarting && !state.countingIn) {
      showRecordHint('NOT STARTED', 3000);
    }
    paintMasterPeak(message.masterPeak || 0);
    setStatus('online', 'live');
  }

  function updateSeekVisual(beat) {
    const pct = clamp((beat / state.length) * 100, 0, 100);
    $('seek-fill').style.width = `${pct}%`;
    $('seek-head').style.left = `calc(${pct}% - 1px)`;
  }

  function updateLoopBand() {
    const band = $('loop-band');
    if (!state.loop || state.loopEnd <= state.loopStart) {
      band.style.width = '0';
      return;
    }
    const left = clamp((state.loopStart / state.length) * 100, 0, 100);
    const right = clamp((state.loopEnd / state.length) * 100, 0, 100);
    band.style.left = `${left}%`;
    band.style.width = `${Math.max(0.5, right - left)}%`;
  }

  function renderChain(chain) {
    const host = $('master-chain');
    const key = chain.join(',');
    if (host.dataset.key === key) return;
    host.dataset.key = key;
    host.replaceChildren();
    for (const device of chain) {
      const chip = document.createElement('span');
      chip.className = 'chain-chip';
      chip.textContent = device;
      host.appendChild(chip);
    }
  }

  // --------------------------------------------------------------- controls

  $('play').addEventListener('click', () => {
    buzz(10);
    if (state.recording) {
      send({ kind: 'record', action: 'stop' });
      return;
    }
    send({ kind: 'transport', action: 'toggle' });
  });
  $('stop').addEventListener('click', () => {
    buzz(10);
    if (state.recording) send({ kind: 'record', action: 'stop' });
    send({ kind: 'transport', action: 'stop' });
  });
  $('record').addEventListener('click', () => {
    if (!state.connected || !state.desktop) {
      showRecordHint(state.connected ? 'STUDIO OFFLINE' : 'OFFLINE');
      return;
    }
    if (state.recordingStarting || state.countingIn) {
      showRecordHint('STARTING');
      return;
    }
    if (state.recording) {
      buzz(14);
      send({ kind: 'record', action: 'stop' });
      return;
    }
    if (!state.tracks.some((track) => track.kind === 'audio' && track.armed)) {
      buzz([20, 40, 20]);
      showRecordHint('ARM A TRACK');
      return;
    }
    buzz(14);
    send({ kind: 'record', action: 'start' });
  });
  $('rewind').addEventListener('click', () => {
    buzz(8);
    send({ kind: 'seek', beat: 0 });
  });
  $('loop').addEventListener('click', () => {
    buzz(6);
    state.loop = !state.loop;
    $('loop').classList.toggle('is-on', state.loop);
    $('loop').setAttribute('aria-pressed', String(state.loop));
    $('loop-band').style.opacity = state.loop ? '1' : '0';
    updateLoopBand();
    send({ kind: 'loop', value: state.loop });
  });

  $('seek').addEventListener('pointerdown', () => {
    seeking = true;
  });
  const finishSeek = () => {
    seeking = false;
  };
  $('seek').addEventListener('pointerup', finishSeek);
  $('seek').addEventListener('pointercancel', finishSeek);
  $('seek').addEventListener('input', (event) => {
    const beat = Number(event.target.value);
    updateSeekVisual(beat);
    send({ kind: 'seek', beat });
  });

  $('master').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    $('master-gain').textContent = formatDb(value);
    send({ kind: 'master', value });
  });

  // Hold a tempo button to keep nudging, like a console encoder.
  const bindTempo = (button, delta) => {
    let timer = 0;
    const step = () => {
      state.bpm = clamp(state.bpm + delta, 40, 260);
      $('bpm').textContent = String(state.bpm);
      send({ kind: 'tempo', value: state.bpm });
    };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      step();
      buzz(4);
      timer = window.setInterval(step, 130);
      const stop = () => {
        window.clearInterval(timer);
        button.removeEventListener('pointerup', stop);
        button.removeEventListener('pointercancel', stop);
      };
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
    });
  };
  bindTempo($('tempo-down'), -1);
  bindTempo($('tempo-up'), 1);

  // Four taps set the tempo, like the TAP button on a hardware sequencer.
  const taps = [];
  function tapTempo() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2200) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();

    const button = $('tap');
    button.classList.add('is-hot');
    window.setTimeout(() => button.classList.remove('is-hot'), 90);
    buzz(5);

    if (taps.length < 2) return;
    let total = 0;
    for (let i = 1; i < taps.length; i++) total += taps[i] - taps[i - 1];
    const bpm = Math.round(clamp(60000 / (total / (taps.length - 1)), 40, 260));
    state.bpm = bpm;
    $('bpm').textContent = String(bpm);
    send({ kind: 'tempo', value: bpm });
  }
  $('tap').addEventListener('click', tapTempo);

  // Keep the tablet awake while it is being used as a console.
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void keepAwake();
  });

  window.addEventListener('keydown', (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') return;
    if (event.code === 'Space') {
      event.preventDefault();
      send({ kind: 'transport', action: 'toggle' });
    } else if (event.key === 'Home') {
      send({ kind: 'seek', beat: 0 });
    } else if (event.key.toLowerCase() === 'l') {
      send({ kind: 'loop', value: !state.loop });
    } else if (event.key.toLowerCase() === 't') {
      tapTempo();
    }
  });

  document.addEventListener('pointerdown', () => void keepAwake(), { once: true });

  // ----------------------------------------------------------- connection UI
  function setLinkKind(kind) {
    const label = kind === 'local' ? 'LOCAL' : kind === 'lan' ? 'LAN' : 'WEB';
    $('connect-kind').textContent = label;
    $('net-mode').textContent =
      kind === 'local'
        ? 'Local session · no network needed'
        : kind === 'lan'
          ? 'Wi-Fi session · no internet needed'
          : 'Internet session · keep the token private';
  }

  function updateNetwork() {
    const offline = navigator.onLine === false;
    $('offline-banner').hidden = !offline;
    if (offline) $('connect-kind').textContent = 'OFFLINE';
  }

  function openConnect() {
    const link = resolveBridge();
    $('connect-address').value = bridgeOverride || (link ? link.http : '');
    $('connect-token').value = token;
    $('connect-note').textContent = link
      ? `Currently using ${link.http} (${link.kind === 'internet' ? 'internet' : link.kind}).`
      : 'Enter the address printed by the bridge.';
    const dialog = $('connect-dialog');
    dialog.hidden = false;
    document.body.classList.add('is-connected-sheet');
    window.setTimeout(() => $('connect-address').focus(), 40);
  }

  function closeConnect() {
    const dialog = $('connect-dialog');
    dialog.hidden = true;
    document.body.classList.remove('is-connected-sheet');
  }

  $('connect-btn').addEventListener('click', openConnect);
  $('link').addEventListener('click', openConnect);
  $('connect-close').addEventListener('click', closeConnect);
  $('connect-dialog').addEventListener('pointerdown', (event) => {
    if (event.target === $('connect-dialog')) closeConnect();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('connect-dialog').hidden) closeConnect();
  });

  $('connect-same').addEventListener('click', () => {
    bridgeOverride = '';
    safeStore.write(BRIDGE_KEY, '');
    const page = samePageBridge();
    $('connect-address').value = page ? page.http : '';
    $('connect-note').textContent = "Using this page's own address.";
  });

  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const link = parseBridge($('connect-address').value);
    if (!link) {
      $('connect-note').textContent = 'That address does not look like a bridge address.';
      return;
    }
    token = $('connect-token').value.trim();
    safeStore.write(TOKEN_KEY, token);
    const page = samePageBridge();
    bridgeOverride = page && page.http === link.http ? '' : link.http;
    safeStore.write(BRIDGE_KEY, bridgeOverride);
    closeConnect();
    reconnectAttempts = 0;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
    connect();
  });

  // Keep the controller usable when the network flaps or the tablet sleeps.
  window.addEventListener('online', () => {
    updateNetwork();
    if (!state.connected) {
      reconnectAttempts = 0;
      connect();
    }
  });
  window.addEventListener('offline', () => {
    updateNetwork();
    setStatus('waiting', 'offline');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.connected) {
      reconnectAttempts = 0;
      connect();
    }
  });

  // --------------------------------------------------------------- app shell
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('install-app').hidden = false;
  });
  $('install-app').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } catch {
      /* ignore */
    }
    installPrompt = null;
    $('install-app').hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('install-app').hidden = true;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {
        /* plain-HTTP LAN pages cannot register a worker; the bridge still works */
      });
    });
  }

  updateNetwork();
  setStatus('waiting', 'connecting…');
  connect();
})();
