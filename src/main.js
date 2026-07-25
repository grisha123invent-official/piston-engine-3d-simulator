/**
 * Интегратор симулятора: сцена, цикл анимации, связь физики, 3D-модулей,
 * графиков и интерфейса.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { L } from './layout.js';
import { createEngine } from './physics.js';
import { buildMechanism } from './engine3d.js';
import { buildFluids } from './fluids3d.js';
import { createCharts } from './charts.js';

const $ = id => document.getElementById(id);

/* ═════════ показ ошибок вместо чёрного экрана ═════════ */
function fail(msg){
  const box = $('err');
  box.style.display = 'block';
  box.textContent = 'Ошибка: ' + msg;
  console.error(msg);
}
addEventListener('error', e => fail(e.message));
addEventListener('unhandledrejection', e => fail(e.reason?.message || e.reason));

/* ═════════ параметры из ссылки ═════════ */
const qs = new URLSearchParams(location.search);
const num = (k, def, lo, hi) => {
  const v = parseFloat(qs.get(k));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
};

const state = {
  theta: num('deg', 0, 0, 719.9),
  playing: !qs.has('pause'),
  cylinders: qs.get('cyl') === '4' ? 4 : 1,
  fuel: qs.get('fuel') === 'diesel' ? 'diesel' : 'petrol',
  slowIdx: 3,
  soundOn: false,
};
const SLOW = [1, 5, 20, 100, 400, 2000];

/* ═════════ физика ═════════ */
const engine = createEngine({
  rpm: num('rpm', 2400, 800, 6000),
  throttle: num('throttle', 1, 0.05, 1),
  eps: num('eps', 10, 8, 22),
  sparkAdvance_deg: num('adv', 18, 0, 45),
  octane: num('octane', 95, 80, 102),
  cylinders: state.cylinders,
  fuel: state.fuel,
});

/* ═════════ сцена ═════════ */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 90, 220);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 600);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
$('scene').appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', pointerEvents: 'none' });
$('labels').appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x223344, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(20, 34, 26); scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.45); fill.position.set(-22, 12, -18); scene.add(fill);
scene.add(new THREE.GridHelper(160, 48, 0x2a3038, 0x1c2128).translateY(L.GRID_Y));

function camPresets(){
  const k = state.cylinders === 4 ? 1.85 : 1;       // четвёрка длиннее — отодвигаем камеру
  return {
    side:  [52 * k, 16, 4 * k],
    iso:   [37 * k, 27, 43 * k],
    front: [3, 14, 60 * k],
    top:   [1, 68 * k, 12 * k],
  };
}
function setCam(name){
  const p = camPresets()[name] || camPresets().iso;
  camera.position.set(...p);
  controls.target.set(0, 10, 0);
}
setCam(qs.get('cam') || 'iso');

/* ═════════ 3D-модули ═════════ */
let mech = null, fluids = null;

function buildAll(){
  if (mech){ scene.remove(mech.group); mech.dispose?.(); }
  if (fluids){ scene.remove(fluids.group); fluids.dispose?.(); }

  mech = buildMechanism({ cylinders: state.cylinders, eps: engine.params.eps });
  scene.add(mech.group);

  fluids = buildFluids(mech.anchors, { cylinders: state.cylinders });
  scene.add(fluids.group);

  applyVisibility();
}

function applyVisibility(){
  mech?.setCutaway?.($('cutaway').checked);
  mech?.setLabels?.($('showLabels').checked);
  labelRenderer.domElement.style.display = $('showLabels').checked ? '' : 'none';
  fluids?.setVisible?.({
    gas: $('fGas').checked,
    fuel: $('fFuel').checked,
    exhaust: $('fExhaust').checked,
    oil: $('fOil').checked,
    coolant: $('fCoolant').checked,
  });
}

buildAll();

/* ═════════ графики ═════════ */
const charts = createCharts($('chartHost'));
charts.setEngine(engine);

const CHART_HINTS = {
  pv: 'Площадь замкнутой петли — работа за цикл. Пунктир — идеальный цикл Отто при той же степени сжатия: разница и есть потери на теплоотдачу, газообмен и реальное сгорание.',
  torque: 'Момент от одного цилиндра большую часть цикла отрицательный — вал крутит маховик. У рядной четвёрки рабочие ходы перекрываются, и суммарная кривая почти не проваливается.',
  kinematics: 'Из-за конечной длины шатуна поршень движется несимметрично: ускорение у ВМТ заметно больше, чем у НМТ. Инерционные силы растут пропорционально квадрату оборотов — отсюда предел по оборотам.',
  valves: 'Видна зона перекрытия клапанов у ВМТ и то, что сгорание (кривая Вибе) начинается ещё до ВМТ — за счёт опережения зажигания.',
  energy: 'В полезную работу превращается лишь около трети энергии топлива: остальное уносит выхлоп, забирает система охлаждения и съедает трение.',
};

/* ═════════ звук ═════════ */
let audio = null;
function boom(strength, rpm){
  if (!state.soundOn) return;
  try{
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const osc = audio.createOscillator(), g = audio.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55 + rpm / 40, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.25, 0.05 + strength * 0.2), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(audio.destination);
    osc.start(t); osc.stop(t + 0.25);
  } catch { /* звук не критичен */ }
}

/* ═════════ формирование кадра ═════════ */
const firedThisCycle = new Set();

function phaseOf(i){
  return state.cylinders === 1 ? 0 : L.CYL_PHASE[i];
}

function buildFrame(rpmNow){
  const cyl = [];
  const sparkDeg = 360 - (engine.params.fuel === 'diesel' ? 5 : engine.params.sparkAdvance_deg);
  let total = 0;

  for (let i = 0; i < state.cylinders; i++){
    const d = (state.theta + phaseOf(i)) % 720;
    const s = engine.sample(d);
    const sparkNow = Math.abs(((d - sparkDeg + 900) % 720) - 180) > 174;   // ±6° около искры
    total += s.torque_Nm ?? 0;
    cyl.push({
      deg: d,
      stroke: Math.floor(d / 180),
      pistonFrac: s.pistonFrac,
      p_bar: s.p_bar, T_K: s.T_K, xb: s.xb,
      liftIn: s.liftIn, liftEx: s.liftEx,
      sparkNow,
      torque_Nm: s.torque_Nm ?? 0,
    });

    // звук: один хлопок на цилиндр за цикл, в начале сгорания
    const kf = i + ':' + Math.floor(d / 360);
    if (s.xb > 0.15 && s.xb < 0.5 && !firedThisCycle.has(kf)){
      firedThisCycle.add(kf);
      if (firedThisCycle.size > 32) firedThisCycle.clear();
      boom(Math.min(1, s.p_bar / 60), rpmNow);
    }
  }

  const m = engine.metrics;
  const knockNow = !!(m.knock?.happens) && cyl.some(c => {
    const kd = m.knock.deg ?? 365;
    return Math.abs(((c.deg - kd + 900) % 720) - 180) > 168;
  });

  return {
    deg: state.theta,
    crankDeg: state.theta % 360,
    rpm: rpmNow,
    fuelMode: engine.params.fuel,
    cylinders: state.cylinders,
    knockNow,
    totalTorque_Nm: state.cylinders === 4 ? (engine.sample(state.theta).torqueTotal_Nm ?? total) : total,
    cyl,
  };
}

/* ═════════ цикл анимации ═════════ */
const clock = new THREE.Clock();
const STROKES = [
  { name: 'ВПУСК', color: '#3b82f6' },
  { name: 'СЖАТИЕ', color: '#a855f7' },
  { name: 'РАБОЧИЙ ХОД', color: '#f97316' },
  { name: 'ВЫПУСК', color: '#9ca3af' },
];
let rpmNow = engine.params.rpm;
let lastChart = 0, lastMetrics = 0, lastStroke = -1;

const STILL = qs.get('still') === '1';   // один кадр и стоп — для скриншотов
function animate(){
  if (!STILL) requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state.playing){
    const dtSim = dt / SLOW[state.slowIdx];
    let advanced = false;
    if (typeof engine.stepDynamics === 'function'){
      const r = engine.stepDynamics(dtSim);
      if (r && Number.isFinite(r.rpmInstant)) rpmNow = r.rpmInstant;
      if (r && Number.isFinite(r.deg)){ state.theta = r.deg; advanced = true; }
    }
    if (!advanced) state.theta = (state.theta + 6 * rpmNow * dtSim) % 720;   // 6·об/мин = град/с
  }

  const frame = buildFrame(rpmNow);

  mech.update(frame);
  fluids.update(frame, dt);

  /* ── интерфейс ── */
  const st = STROKES[Math.floor(state.theta / 180)];
  const badge = $('strokeBadge');
  badge.textContent = `Такт ${Math.floor(state.theta / 180) + 1}: ${st.name}`;
  badge.style.background = st.color + '22';
  badge.style.color = st.color;
  $('angleReadout').textContent =
    `угол коленвала: ${state.theta.toFixed(0)}° / 720° · оборот ${state.theta < 360 ? 1 : 2}`;
  if (state.playing){ $('scrub').value = state.theta; $('scrubVal').textContent = state.theta.toFixed(0) + '°'; }
  $('tlMarker').style.left = `calc(${(state.theta / 720 * 100).toFixed(2)}% - 1px)`;

  const c0 = frame.cyl[0];
  $('fP').textContent = c0.p_bar.toFixed(1) + ' бар';
  $('fT').textContent = Math.round(c0.T_K - 273) + ' °C';
  $('fX').textContent = Math.round(c0.xb * 100) + ' %';
  $('fM').textContent = frame.totalTorque_Nm.toFixed(0) + ' Н·м';
  $('fRpm').textContent = Math.round(rpmNow) + ' об/мин';

  const stroke = Math.floor(state.theta / 180);
  if (stroke !== lastStroke){
    lastStroke = stroke;
    for (let i = 0; i < 4; i++) $('st' + i).classList.toggle('active', i === stroke);
    $('st' + stroke).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const now = performance.now();
  if (now - lastChart > 60){ lastChart = now; charts.update(frame); }
  if (now - lastMetrics > 250){ lastMetrics = now; updateMetrics(rpmNow); syncChartHint(); }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

/* ═════════ показатели ═════════ */
const fmt = (v, d = 1, unit = '') =>
  Number.isFinite(v) ? v.toFixed(d) + (unit ? ' ' + unit : '') : '—';
const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + ' %' : '—';

function updateMetrics(rpmInst){
  const m = engine.metrics, g = engine.geometry;
  $('mPower').textContent = fmt(m.brakePower_kW, 1, 'кВт') +
    (Number.isFinite(m.brakePower_kW) ? ` (${(m.brakePower_kW * 1.36).toFixed(0)} л.с.)` : '');
  $('mPowerInd').textContent = fmt(m.indPower_kW, 1, 'кВт');
  $('mTorque').textContent = fmt(m.brakeTorque_Nm, 0, 'Н·м');
  $('mDispl').textContent = fmt(g.Vd_cm3 * state.cylinders / 1000, 2, 'л');
  $('mPmax').textContent = fmt(m.pmax_bar, 1, 'бар') +
    (Number.isFinite(m.pmax_deg) ? ` при ${m.pmax_deg.toFixed(0)}°` : '');
  $('mTmax').textContent = fmt(m.Tmax_K - 273, 0, '°C');
  $('mImep').textContent = fmt(m.imep_bar, 2, 'бар');
  $('mWork').textContent = fmt(m.workPerCycle_J, 0, 'Дж');
  $('mVolEff').textContent = pct(m.volEff);
  $('mEffInd').textContent = pct(m.effIndicated);
  $('mEffBrake').textContent = pct(m.effBrake);
  $('mEffOtto').textContent = pct(m.effOtto);
  $('mBsfc').textContent = fmt(m.bsfc_g_kWh, 0, 'г/(кВт·ч)');
  $('mPistonSpeed').textContent = fmt(m.meanPistonSpeed_ms, 1, 'м/с');
  $('mFluct').textContent = Number.isFinite(m.speedFluctuation) ? m.speedFluctuation.toFixed(3) : '—';
  $('mRpmNow').textContent = Math.round(rpmInst) + ' об/мин';

  const k = m.knock || {};
  $('mKnock').textContent = k.happens
    ? `есть, с ${(k.deg ?? 0).toFixed(0)}°`
    : 'нет';
  $('mKnock').style.color = k.happens ? 'var(--bad)' : 'var(--ok)';

  const banner = $('knockBanner');
  banner.classList.toggle('show', !!k.happens);
  if (k.happens){
    banner.innerHTML = `⚠️ <b>Детонация!</b> Несгоревшая смесь самовоспламеняется от сжатия
      (критерий Ливенгуда–Ву ≥ 1). Уменьши степень сжатия или опережение зажигания,
      либо возьми топливо с бо́льшим октановым числом.`;
  }
}

/* ═════════ пересчёт при смене параметров ═════════ */
function recompute(patch, rebuild3d = false){
  engine.setParams(patch);
  if (rebuild3d) buildAll();
  else if (patch.eps !== undefined){
    mech.setCompression?.(patch.eps);
    fluids.setAnchors?.(mech.anchors);
  }
  charts.setEngine(engine);
  charts.invalidate?.();      // перерисовать статичный слой кривых
  updateMetrics(rpmNow);
}

/* ═════════ интерфейс ═════════ */
$('playBtn').textContent = state.playing ? '⏸ Пауза' : '▶ Пуск';
$('playBtn').onclick = () => {
  state.playing = !state.playing;
  $('playBtn').textContent = state.playing ? '⏸ Пауза' : '▶ Пуск';
};
const setTheta = v => {
  state.theta = (v + 720) % 720;
  $('scrub').value = state.theta;
  $('scrubVal').textContent = state.theta.toFixed(0) + '°';
};
$('scrub').oninput = e => setTheta(+e.target.value);
$('stepF').onclick = () => setTheta(state.theta + 15);
$('stepB').onclick = () => setTheta(state.theta - 15);
$('nextStroke').onclick = () => setTheta((Math.floor(state.theta / 180) + 1) % 4 * 180);
$('prevStroke').onclick = () => setTheta((Math.floor(state.theta / 180) + 3) % 4 * 180);
$('tlTrack').addEventListener('pointerdown', ev => {
  const r = $('tlTrack').getBoundingClientRect();
  setTheta((ev.clientX - r.left) / r.width * 720);
});

$('rpm').oninput = e => {
  const v = +e.target.value; $('rpmVal').textContent = v;
  rpmNow = v; recompute({ rpm: v });
  updateSlowHint();
};
$('throttle').oninput = e => {
  const v = +e.target.value; $('thrVal').textContent = v + ' %';
  recompute({ throttle: v / 100 });
};
$('eps').oninput = e => {
  const v = +e.target.value; $('epsVal').textContent = v.toFixed(1);
  recompute({ eps: v });
};
$('advance').oninput = e => {
  const v = +e.target.value; $('advVal').textContent = v;
  recompute({ sparkAdvance_deg: v });
};
$('octane').oninput = e => {
  const v = +e.target.value; $('octVal').textContent = v;
  recompute({ octane: v });
};
$('slowmo').oninput = e => { state.slowIdx = +e.target.value; updateSlowHint(); };

function updateSlowHint(){
  const f = SLOW[state.slowIdx];
  $('slowVal').textContent = '×' + f;
  const rps = engine.params.rpm / 60;
  $('slowHint').textContent = f === 1
    ? `реальная скорость: ${rps.toFixed(1)} оборота в секунду`
    : `показ замедлен в ${f} раз (в реальности ${rps.toFixed(1)} об/с)`;
}
updateSlowHint();

document.querySelectorAll('[data-fuel]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x === b));
  const fuel = b.dataset.fuel;
  state.fuel = fuel;
  const eps = fuel === 'diesel' ? 18 : 10;
  $('eps').value = eps; $('epsVal').textContent = eps.toFixed(1);
  $('advance').disabled = fuel === 'diesel';
  $('octane').disabled = fuel === 'diesel';
  recompute({ fuel, eps });
  mech.setCompression?.(eps);
  fluids.setAnchors?.(mech.anchors);
});

document.querySelectorAll('[data-cyl]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-cyl]').forEach(x => x.classList.toggle('on', x === b));
  state.cylinders = +b.dataset.cyl;
  recompute({ cylinders: state.cylinders }, true);
  setCam('iso');
  document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x.dataset.cam === 'iso'));
});

document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x === b));
  setCam(b.dataset.cam);
});

['cutaway', 'showLabels', 'fGas', 'fFuel', 'fExhaust', 'fOil', 'fCoolant']
  .forEach(id => $(id).onchange = applyVisibility);
$('sound').onchange = e => { state.soundOn = e.target.checked; };

document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('on'));
  $('pane-' + b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'charts') charts.resize?.();
});

/* вкладки графиков рисует сам модуль charts — подсказку под ними обновляем по его состоянию */
let hintShown = '';
function syncChartHint(){
  const a = charts.getActive?.() || 'pv';
  if (a !== hintShown){ hintShown = a; $('chartHint').textContent = CHART_HINTS[a] || ''; }
}
syncChartHint();

$('btnCSV').onclick = () => {
  const csv = engine.toCSV?.();
  if (!csv) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `engine-cycle-${engine.params.fuel}-eps${engine.params.eps}-${engine.params.rpm}rpm.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT') return;
  if (ev.code === 'Space'){ ev.preventDefault(); $('playBtn').click(); }
  if (ev.code === 'ArrowRight') setTheta(state.theta + (ev.shiftKey ? 45 : 5));
  if (ev.code === 'ArrowLeft')  setTheta(state.theta - (ev.shiftKey ? 45 : 5));
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  charts.resize?.();
});

/* режим «только 3D» и один кадр — для скриншотов и встраивания */
if (qs.get('ui') === '0') ['left', 'right', 'timeline'].forEach(id => $(id).style.display = 'none');

/* синхронизируем стартовые значения полей с параметрами движка */
$('rpm').value = engine.params.rpm; $('rpmVal').textContent = engine.params.rpm;
$('throttle').value = engine.params.throttle * 100; $('thrVal').textContent = Math.round(engine.params.throttle * 100) + ' %';
$('eps').value = engine.params.eps; $('epsVal').textContent = engine.params.eps.toFixed(1);
$('advance').value = engine.params.sparkAdvance_deg; $('advVal').textContent = engine.params.sparkAdvance_deg;
$('octane').value = engine.params.octane; $('octVal').textContent = engine.params.octane;
if (state.cylinders === 4){
  document.querySelectorAll('[data-cyl]').forEach(x => x.classList.toggle('on', +x.dataset.cyl === 4));
}
if (state.fuel === 'diesel'){
  document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x.dataset.fuel === 'diesel'));
}
setTheta(state.theta);
updateMetrics(rpmNow);
animate();
