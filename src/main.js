// Visuals — webcam-driven live visualiser with tight audio sync.
// Pipeline: camera -> scene shader (per-pixel effects) -> feedback/trails
// (ping-pong) -> display. Audio analysis drives the effects so they lock to
// the music: separate frequency bands plus snappy beat/onset detection.

const $ = (s, r = document) => r.querySelector(s);

// ---------------------------------------------------------------------------
// Effect rack — fixed, ordered, toggleable. Each effect reads a default band
// plus a beat impulse, so different effects react to different parts of the mix.
// ---------------------------------------------------------------------------
const effects = [
  { id: 'fb',       key: '1', name: 'Feedback / trails', band: 'bass', on: true,  amount: 0.72, react: 0.6 },
  { id: 'kaleido',  key: '2', name: 'Kaleidoscope',      band: 'mid',  on: false, amount: 0.4,  react: 0.5 },
  { id: 'displace', key: '3', name: 'Displace',          band: 'bass', on: false, amount: 0.4,  react: 0.7 },
  { id: 'rgb',      key: '4', name: 'RGB split',         band: 'high', on: true,  amount: 0.4,  react: 0.7 },
  { id: 'poster',   key: '5', name: 'Posterize',         band: 'mid',  on: false, amount: 0.45, react: 0.5 },
  { id: 'pixel',    key: '6', name: 'Pixelate',          band: 'beat', on: false, amount: 0.4,  react: 0.6 },
  { id: 'hue',      key: '7', name: 'Hue cycle',         band: 'mid',  on: true,  amount: 0.3,  react: 0.5 },
];
const fxById = Object.fromEntries(effects.map(e => [e.id, e]));
const uniName = { fb: 'uFb', kaleido: 'uKaleido', displace: 'uDisplace', rgb: 'uRgb', poster: 'uPoster', pixel: 'uPixel', hue: 'uHue' };

// audio control state
const audioCfg = { sens: 1.4, decay: 0.18, gain: 1.0 };

// ---------------------------------------------------------------------------
// WebGL
// ---------------------------------------------------------------------------
const canvas = $('#gl');
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
if (!gl) alert('WebGL2 not supported in this browser.');

const VERT = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime, uMirror;
uniform float uBass, uMid, uHigh, uLevel, uBeat;
uniform vec3 uKaleido, uDisplace, uRgb, uPoster, uPixel, uHue; // x=on y=amount z=react

vec3 hueRot(vec3 c, float a){
  const mat3 toY = mat3(0.299,0.596,0.211, 0.587,-0.274,-0.523, 0.114,-0.322,0.312);
  const mat3 toR = mat3(1.0,1.0,1.0, 0.956,-0.272,-1.107, 0.621,-0.647,1.705);
  vec3 y = toY * c; float ca = cos(a), sa = sin(a);
  y = vec3(y.x, y.y*ca - y.z*sa, y.y*sa + y.z*ca);
  return toR * y;
}

void main(){
  float asp = uRes.x / uRes.y;
  vec2 uv = vUv;
  if(uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec2 c = (uv - 0.5) * vec2(asp, 1.0);

  if(uKaleido.x > 0.5){
    float seg = mix(3.0, 14.0, uKaleido.y);
    float a = atan(c.y, c.x);
    float r = length(c);
    a += uTime * 0.1 + uMid * uKaleido.z * 3.1416;
    float k = 6.2831853 / seg;
    a = abs(mod(a, k) - k * 0.5);
    c = vec2(cos(a), sin(a)) * r;
  }
  vec2 suv = c / vec2(asp, 1.0) + 0.5;

  if(uDisplace.x > 0.5){
    float amt = uDisplace.y * 0.06 * (1.0 + uBass * uDisplace.z * 4.0 + uBeat * uDisplace.z * 2.5);
    suv += amt * vec2(sin(suv.y * 16.0 + uTime * 2.0), cos(suv.x * 16.0 + uTime * 1.7));
  }
  if(uPixel.x > 0.5){
    float px = mix(200.0, 18.0, uPixel.y);
    px *= 1.0 - clamp(uBeat * uPixel.z, 0.0, 0.85);
    px = max(px, 6.0);
    suv = (floor(suv * px) + 0.5) / px;
  }

  vec3 col;
  if(uRgb.x > 0.5){
    float s = uRgb.y * 0.018 * (1.0 + uHigh * uRgb.z * 3.0 + uBeat * uRgb.z * 5.0);
    col.r = texture(uTex, suv + vec2(s, 0.0)).r;
    col.g = texture(uTex, suv).g;
    col.b = texture(uTex, suv - vec2(s, 0.0)).b;
  } else {
    col = texture(uTex, suv).rgb;
  }

  if(uHue.x > 0.5){
    float a = uTime * uHue.y * 1.5 + uMid * uHue.z * 6.2831853;
    col = hueRot(col, a);
  }
  if(uPoster.x > 0.5){
    float lv = mix(12.0, 3.0, uPoster.y);
    lv = max(2.0, lv - floor(uBeat * uPoster.z * 4.0));
    col = floor(col * lv) / lv;
  }
  o = vec4(col, 1.0);
}`;

const FB_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uPrev;
uniform float uBass, uBeat;
uniform vec3 uFb; // x=on y=decay z=react
void main(){
  vec3 scene = texture(uScene, vUv).rgb;
  if(uFb.x < 0.5){ o = vec4(scene, 1.0); return; }
  float decay = mix(0.55, 0.965, uFb.y);
  vec2 c = vUv - 0.5;
  float zoom = 1.0 + (0.008 + uBass * uFb.z * 0.03 + uBeat * uFb.z * 0.07);
  float ang = uBass * uFb.z * 0.02 - 0.004;
  float ca = cos(ang), sa = sin(ang);
  c = mat2(ca, -sa, sa, ca) * c / zoom;
  vec3 prev = texture(uPrev, c + 0.5).rgb * decay;
  o = vec4(max(scene, prev), 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uBright;
void main(){ o = vec4(texture(uTex, vUv).rgb * uBright, 1.0); }`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  p._loc = {};
  p.u = (n) => (p._loc[n] ??= gl.getUniformLocation(p, n));
  return p;
}
const progScene = program(SCENE_FS);
const progFb = program(FB_FS);
const progBlit = program(BLIT_FS);
const vao = gl.createVertexArray(); // empty; verts generated in shader

function makeFBO(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fbo, tex, w, h };
}
let sceneFBO, fbA, fbB;
function allocFBOs(w, h) {
  [sceneFBO, fbA, fbB] = [makeFBO(w, h), makeFBO(w, h), makeFBO(w, h)];
}

// camera texture
const camTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, camTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === canvas.width && h === canvas.height && sceneFBO) return;
  canvas.width = w; canvas.height = h;
  allocFBOs(w, h);
}
window.addEventListener('resize', resize);

function drawQuad() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); }

// ---------------------------------------------------------------------------
// Media: camera + audio, with device pickers (works with any input device —
// a booth feed / line-in / audio interface picks up exactly like a mic).
// ---------------------------------------------------------------------------
const video = document.createElement('video');
video.autoplay = true; video.muted = true; video.playsInline = true;
let audioCtx, analyser, freq, srcNode;

async function startMedia(videoId, audioId) {
  if (window._stream) window._stream.getTracks().forEach(t => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoId ? { deviceId: { exact: videoId } } : true,
    audio: audioId
      ? { deviceId: { exact: audioId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  window._stream = stream;
  video.srcObject = new MediaStream(stream.getVideoTracks());
  await video.play().catch(() => {});

  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  if (srcNode) srcNode.disconnect();
  srcNode = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  analyser ??= Object.assign(audioCtx.createAnalyser(), { fftSize: 1024, smoothingTimeConstant: 0 });
  srcNode.connect(analyser);
  freq = new Uint8Array(analyser.frequencyBinCount);
  await populateDevices();
}

async function populateDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind) => {
    const cur = sel.value;
    sel.innerHTML = '';
    devs.filter(d => d.kind === kind).forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `${kind} ${i + 1}`;
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  };
  fill($('#videoInput'), 'videoinput');
  fill($('#audioInput'), 'audioinput');
}

// ---------------------------------------------------------------------------
// Audio analysis — the part that makes it feel in sync.
//   * Three frequency bands (bass / mid / high) each with a fast-attack,
//     tunable-release envelope so hits land instantly and don't smear.
//   * Beat detection: instantaneous bass energy vs. its running average, with
//     a refractory window — fires a decaying impulse `beat` used for "hits".
// ---------------------------------------------------------------------------
const env = { bass: 0, mid: 0, high: 0, level: 0, beat: 0 };
const hist = new Array(43).fill(0); let hi = 0;
let lastBeat = 0;

function bandAvg(loHz, hiHz) {
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const a = Math.max(1, Math.floor(loHz / binHz));
  const b = Math.min(freq.length - 1, Math.ceil(hiHz / binHz));
  let s = 0; for (let i = a; i <= b; i++) s += freq[i];
  return s / ((b - a + 1) * 255);
}

function analyse(now) {
  if (!analyser) return;
  analyser.getByteFrequencyData(freq);
  // raw bands, slightly contrasted so quiet noise doesn't drive the visuals
  const bass = Math.pow(bandAvg(20, 160), 1.4);
  const mid = Math.pow(bandAvg(160, 2000), 1.3);
  const high = Math.pow(bandAvg(2000, 8000), 1.2);
  const level = Math.pow(bandAvg(20, 12000), 1.3);

  // fast attack, exponential release tied to the beat-decay control
  const rel = Math.exp(-1 / (audioCfg.decay * 60));
  const g = audioCfg.gain;
  env.bass = Math.max(bass * g, env.bass * rel);
  env.mid = Math.max(mid * g, env.mid * rel);
  env.high = Math.max(high * g, env.high * rel);
  env.level = Math.max(level * g, env.level * rel);

  // beat: compare instantaneous bass to recent average
  const avg = hist.reduce((p, c) => p + c, 0) / hist.length;
  hist[hi] = bass; hi = (hi + 1) % hist.length;
  if (bass > avg * audioCfg.sens && bass > 0.06 && now - lastBeat > 110) {
    lastBeat = now;
    env.beat = 1;
    beatDot.style.background = '#b388ff';
    beatDot.style.boxShadow = '0 0 10px #b388ff';
  } else {
    env.beat *= Math.exp(-1 / (audioCfg.decay * 60));
    if (env.beat < 0.04) { beatDot.style.background = '#2a2f36'; beatDot.style.boxShadow = 'none'; }
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let bright = 1, brightTarget = 1, frozen = false, t0 = performance.now();

function effVec(e) { return [e.on ? 1 : 0, e.amount, e.react]; }

function frame(now) {
  requestAnimationFrame(frame);
  resize();
  analyse(now);
  if (frozen) { return; }

  // upload camera
  if (video.readyState >= 2) {
    gl.bindTexture(gl.TEXTURE_2D, camTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }
  const time = (now - t0) / 1000;

  // --- scene pass ---
  gl.useProgram(progScene);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO.fbo);
  gl.viewport(0, 0, sceneFBO.w, sceneFBO.h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, camTex);
  gl.uniform1i(progScene.u('uTex'), 0);
  gl.uniform2f(progScene.u('uRes'), sceneFBO.w, sceneFBO.h);
  gl.uniform1f(progScene.u('uTime'), time);
  gl.uniform1f(progScene.u('uMirror'), 0);
  gl.uniform1f(progScene.u('uBass'), env.bass);
  gl.uniform1f(progScene.u('uMid'), env.mid);
  gl.uniform1f(progScene.u('uHigh'), env.high);
  gl.uniform1f(progScene.u('uLevel'), env.level);
  gl.uniform1f(progScene.u('uBeat'), env.beat);
  for (const id of ['kaleido', 'displace', 'rgb', 'poster', 'pixel', 'hue']) {
    gl.uniform3fv(progScene.u(uniName[id]), effVec(fxById[id]));
  }
  drawQuad();

  // --- feedback / trails pass (ping-pong) ---
  gl.useProgram(progFb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbB.fbo);
  gl.viewport(0, 0, fbB.w, fbB.h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneFBO.tex);
  gl.uniform1i(progFb.u('uScene'), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fbA.tex);
  gl.uniform1i(progFb.u('uPrev'), 1);
  gl.uniform1f(progFb.u('uBass'), env.bass);
  gl.uniform1f(progFb.u('uBeat'), env.beat);
  gl.uniform3fv(progFb.u('uFb'), effVec(fxById.fb));
  drawQuad();
  [fbA, fbB] = [fbB, fbA]; // swap so fbA holds latest

  // --- display ---
  bright += (brightTarget - bright) * 0.18;
  gl.useProgram(progBlit);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fbA.tex);
  gl.uniform1i(progBlit.u('uTex'), 0);
  gl.uniform1f(progBlit.u('uBright'), bright);
  drawQuad();

  // mirror to pop-out output window (for projector / window-capture)
  if (outWin && !outWin.closed && outCtx) {
    outCtx.drawImage(canvas, 0, 0, outCanvas.width, outCanvas.height);
  }
  drawMeters();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const beatDot = $('#beatdot');
const meterBars = { b: $('#meters .b > i'), m: $('#meters .m > i'), h: $('#meters .h > i'), l: $('#meters .l > i') };
function drawMeters() {
  meterBars.b.style.height = Math.min(100, env.bass * 100) + '%';
  meterBars.m.style.height = Math.min(100, env.mid * 100) + '%';
  meterBars.h.style.height = Math.min(100, env.high * 100) + '%';
  meterBars.l.style.height = Math.min(100, env.level * 100) + '%';
}

function buildEffectUI() {
  const root = $('#effects'); root.innerHTML = '';
  for (const e of effects) {
    const card = document.createElement('div'); card.className = 'grp';
    card.innerHTML = `
      <div class="head">
        <span class="toggle ${e.on ? 'on' : ''}" data-tog></span>
        <span class="name">${e.key}· ${e.name}</span>
        <span class="pill ${e.band}">${e.band}</span>
      </div>
      <label class="row">amount <input type="range" min="0" max="1" step="0.01" data-amount value="${e.amount}"><span class="v">${e.amount.toFixed(2)}</span></label>
      <label class="row">react <input type="range" min="0" max="1" step="0.01" data-react value="${e.react}"><span class="v">${e.react.toFixed(2)}</span></label>`;
    card.querySelector('[data-tog]').onclick = (ev) => { e.on = !e.on; ev.target.classList.toggle('on', e.on); };
    const bind = (sel, prop) => {
      const inp = card.querySelector(sel); const v = inp.nextElementSibling;
      inp.oninput = () => { e[prop] = +inp.value; v.textContent = (+inp.value).toFixed(2); };
    };
    bind('[data-amount]', 'amount'); bind('[data-react]', 'react');
    root.appendChild(card);
  }
}

function bindAudioControls() {
  const map = [['#a_sens', 'sens'], ['#a_decay', 'decay'], ['#a_gain', 'gain']];
  for (const [sel, key] of map) {
    const inp = $(sel); const v = inp.nextElementSibling;
    const upd = () => { audioCfg[key] = +inp.value; v.textContent = (+inp.value).toFixed(2); };
    inp.oninput = upd; upd();
  }
  $('#videoInput').onchange = () => startMedia($('#videoInput').value, $('#audioInput').value);
  $('#audioInput').onchange = () => startMedia($('#videoInput').value, $('#audioInput').value);
}

// Built-in "looks" — one tap configures the whole rack. This is the
// beginner path: you don't need to understand a single slider to get a good,
// music-synced result, and ← → flick between them live.
const looks = {
  Chill:   { fb: [1, 0.85, 0.4], rgb: [0, 0.4, 0.6], hue: [1, 0.15, 0.4], kaleido: [0], displace: [0], poster: [0], pixel: [0], audio: { sens: 1.5, decay: 0.3, gain: 0.9 } },
  Pulse:   { fb: [1, 0.7, 0.75], rgb: [1, 0.5, 0.8], displace: [1, 0.35, 0.7], hue: [1, 0.25, 0.5], kaleido: [0], poster: [0], pixel: [0], audio: { sens: 1.35, decay: 0.16, gain: 1.1 } },
  Kaleido: { fb: [1, 0.78, 0.6], kaleido: [1, 0.5, 0.6], hue: [1, 0.3, 0.5], rgb: [1, 0.3, 0.6], displace: [0], poster: [0], pixel: [0], audio: { sens: 1.4, decay: 0.2, gain: 1 } },
  Strobe:  { fb: [0], rgb: [1, 0.7, 0.9], poster: [1, 0.6, 0.7], pixel: [1, 0.5, 0.8], hue: [1, 0.4, 0.6], kaleido: [0], displace: [0], audio: { sens: 1.25, decay: 0.1, gain: 1.2 } },
  Trippy:  { fb: [1, 0.9, 0.7], kaleido: [1, 0.6, 0.6], displace: [1, 0.5, 0.7], hue: [1, 0.45, 0.6], rgb: [1, 0.4, 0.7], poster: [0], pixel: [0], audio: { sens: 1.4, decay: 0.22, gain: 1.05 } },
};
const lookNames = Object.keys(looks);
let curLook = -1;
function applyLook(name) {
  const L = looks[name]; if (!L) return;
  for (const e of effects) {
    const v = L[e.id];
    if (v) { e.on = v[0] > 0.5; if (v.length > 1) { e.amount = v[1]; e.react = v[2]; } }
    else e.on = false;
  }
  if (L.audio) Object.assign(audioCfg, L.audio);
  curLook = lookNames.indexOf(name);
  buildEffectUI(); bindAudioControls();
  document.querySelectorAll('#looks button').forEach(b => b.classList.toggle('active', b.textContent === name));
}
function cycleLook(dir) {
  curLook = (curLook + dir + lookNames.length) % lookNames.length;
  applyLook(lookNames[curLook]);
}
function buildLooks() {
  const root = $('#looks'); root.innerHTML = '';
  for (const name of lookNames) {
    const b = document.createElement('button'); b.textContent = name;
    b.onclick = () => applyLook(name);
    root.appendChild(b);
  }
}

// presets
const PKEY = 'visuals.presets';
function snapshot() {
  return { effects: effects.map(({ id, on, amount, react }) => ({ id, on, amount, react })), audio: { ...audioCfg } };
}
function applySnapshot(s) {
  for (const se of s.effects || []) Object.assign(fxById[se.id] || {}, se);
  Object.assign(audioCfg, s.audio || {});
  buildEffectUI(); bindAudioControls();
}
function loadPresets() { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch { return {}; } }
function refreshPresetList() {
  const sel = $('#presetSel'); const p = loadPresets();
  sel.innerHTML = '<option value="">— preset —</option>' + Object.keys(p).map(n => `<option>${n}</option>`).join('');
}
function bindShow() {
  $('#savePreset').onclick = () => {
    const name = prompt('Preset name:'); if (!name) return;
    const p = loadPresets(); p[name] = snapshot();
    localStorage.setItem(PKEY, JSON.stringify(p)); refreshPresetList(); $('#presetSel').value = name;
  };
  $('#presetSel').onchange = (e) => { const p = loadPresets(); if (p[e.target.value]) applySnapshot(p[e.target.value]); };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'visuals-preset.json'; a.click();
  };
  $('#importBtn').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; f.text().then(t => applySnapshot(JSON.parse(t))); };
    inp.click();
  };
  $('#blackoutBtn').onclick = toggleBlackout;
  $('#fsBtn').onclick = () => document.documentElement.requestFullscreen?.();
  $('#outBtn').onclick = popOutput;
}

function toggleBlackout() {
  brightTarget = brightTarget > 0.5 ? 0 : 1;
  $('#blackoutBtn').classList.toggle('active', brightTarget < 0.5);
}

// pop-out clean output window — fullscreen this on the projector, or
// window-capture it into OBS / Resolume / NDI tools. This is how it slots
// into a standard DJ/VJ rig without replacing anything.
let outWin, outCanvas, outCtx;
function popOutput() {
  if (outWin && !outWin.closed) { outWin.focus(); return; }
  outWin = window.open('', 'visuals-out', 'width=1280,height=720');
  outWin.document.write('<title>Visuals — output</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}canvas{width:100%;height:100%;display:block}</style><canvas></canvas>');
  outWin.document.close();
  outCanvas = outWin.document.querySelector('canvas');
  outCanvas.width = 1280; outCanvas.height = 720;
  outCtx = outCanvas.getContext('2d');
  outWin.addEventListener('dblclick', () => outWin.document.documentElement.requestFullscreen?.());
}

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const fx = effects.find(f => f.key === e.key);
  if (fx) { fx.on = !fx.on; buildEffectUI(); return; }
  switch (e.key.toLowerCase()) {
    case 'h': $('#panel').classList.toggle('hidden'); break;
    case 'b': toggleBlackout(); break;
    case 'f': document.documentElement.requestFullscreen?.(); break;
    case 'o': popOutput(); break;
    case ' ': frozen = !frozen; e.preventDefault(); break;
    case 'arrowright': cycleLook(1); e.preventDefault(); break;
    case 'arrowleft': cycleLook(-1); e.preventDefault(); break;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildLooks(); buildEffectUI(); bindAudioControls(); bindShow(); refreshPresetList();
resize();
requestAnimationFrame(frame);

$('#startBtn').onclick = async () => {
  try {
    await startMedia();
    $('#start').style.display = 'none';
  } catch (err) {
    $('#start .sub').textContent = 'Could not access camera/mic: ' + err.message;
  }
};
