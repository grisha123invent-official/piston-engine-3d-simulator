/**
 * Интегратор симулятора: сцена, цикл анимации, связь физики, 3D-модулей,
 * графиков, звука и интерфейса.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { L, layoutSpec } from './layout.js';
import { createEngine } from './physics.js';
import { buildMechanism } from './engine3d.js';
import { buildFluids } from './fluids3d.js';
import { createCharts } from './charts.js';

const $ = id => document.getElementById(id);

/* ═════════ ошибки показываем, а не прячем ═════════ */
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
const LAYOUT_BY_CYL = { 1: 'single', 4: 'i4', 8: 'v8' };

const state = {
  theta: num('deg', 0, 0, 719.9),
  playing: !qs.has('pause'),
  layout: ['single', 'i4', 'v8'].includes(qs.get('layout'))
    ? qs.get('layout')
    : (LAYOUT_BY_CYL[qs.get('cyl')] || 'single'),
  twoStroke: qs.get('stroke') === '2',
  fuel: qs.get('fuel') === 'diesel' ? 'diesel' : 'petrol',
  slowIdx: 3,
  soundOn: false,
  volume: 0.5,
};
const SLOW = [1, 5, 20, 100, 400, 2000];
const cylCount = () => layoutSpec(state.layout).cylinders;
const cycleDeg = () => engine.params.cycleDeg || (state.twoStroke ? 360 : 720);

/* ═════════ физика ═════════ */
const engine = createEngine({
  rpm: num('rpm', 2400, 800, 6000),
  throttle: num('throttle', 1, 0.05, 1),
  eps: num('eps', 10, 8, 22),
  sparkAdvance_deg: num('adv', 18, 0, 45),
  octane: num('octane', 95, 80, 102),
  boost_bar: num('boost', 0, 0, 1.5),
  turbo: qs.get('turbo') === '1',
  intercooler: qs.get('intercooler') !== '0',
  intakeLen_mm: num('intakeLen', 350, 150, 900),
  layout: state.layout,
  cylinders: cylCount(),
  stroke2: state.twoStroke,
  fuel: state.fuel,
});

/* ═════════ сцена ═════════ */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080a0e);
scene.fog = new THREE.Fog(0x080a0e, 95, 240);

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

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1b2430, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(20, 34, 26); scene.add(key);
const fill = new THREE.DirectionalLight(0x7fd8d6, 0.4); fill.position.set(-22, 12, -18); scene.add(fill);
scene.add(new THREE.GridHelper(170, 50, 0x1e2733, 0x141c25).translateY(L.GRID_Y));

function camPresets(){
  const n = cylCount();
  const k = n === 8 ? 2.0 : n === 4 ? 1.85 : 1;
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

  mech = buildMechanism({
    cylinders: cylCount(), layout: state.layout,
    eps: engine.params.eps, twoStroke: state.twoStroke,
  });
  mech.setLayout?.(state.layout);
  mech.setTwoStroke?.(state.twoStroke);
  mech.setTurbo?.(!!engine.params.turbo || engine.params.boost_bar > 0);
  mech.setIntakeLength?.(engine.params.intakeLen_mm);
  scene.add(mech.group);

  fluids = buildFluids(mech.anchors, { cylinders: cylCount(), eps: engine.params.eps });
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
  pv: 'Площадь замкнутой петли — работа за цикл. Пунктир — идеальный цикл при той же степени сжатия: разница и есть потери на теплоотдачу, газообмен и реальное сгорание.',
  torque: 'Момент от одного цилиндра большую часть цикла отрицательный — вал крутит маховик. У многоцилиндрового рабочие ходы перекрываются, и суммарная кривая почти не проваливается.',
  kinematics: 'Из-за конечной длины шатуна ускорение поршня у ВМТ заметно больше, чем у НМТ. Инерционные силы растут как квадрат оборотов — отсюда предел по оборотам.',
  valves: 'Видна зона перекрытия клапанов у ВМТ и то, что сгорание начинается ещё до ВМТ — за счёт опережения зажигания.',
  energy: 'В полезную работу превращается лишь около трети энергии топлива: остальное уносит выхлоп, забирает охлаждение и съедает трение.',
  sweep: 'Внешняя скоростная характеристика. Двигай длину впускного тракта — резонансный горб наполнения, а с ним и пик момента, поедет по оборотам.',
  balance: 'Неуравновешенные силы инерции. У одноцилиндрового велик первый порядок, у рядной четвёрки он погашен, но остаётся второй, у V8 с крестообразным валом уравновешены оба.',
};

/* ═════════ звук (модуль подгружается по требованию) ═════════ */
let sound = null, soundLoading = false;
async function ensureSound(){
  if (sound || soundLoading) return sound;
  soundLoading = true;
  try {
    const mod = await import('./sound.js');
    sound = mod.createEngineSound();
    sound.setVolume?.(state.volume);
    sound.setEnabled?.(true);
  } catch (e){
    console.warn('модуль звука недоступен:', e);
  }
  soundLoading = false;
  return sound;
}

/* ═════════ формирование кадра ═════════ */
function phaseOf(i){
  const spec = layoutSpec(state.layout);
  return spec.cyl[i]?.phase ?? 0;
}

function buildFrame(rpmNow){
  const cyl = [];
  const spec = layoutSpec(state.layout);
  const C = cycleDeg();
  const m = engine.metrics;
  let total = 0;

  for (let i = 0; i < spec.cylinders; i++){
    const d = (state.theta + phaseOf(i)) % C;
    const s = engine.sample(d);
    total += s.torque_Nm ?? 0;
    cyl.push({
      deg: d,
      stroke: Math.floor(d / 180) % (C === 360 ? 2 : 4),
      pistonFrac: s.pistonFrac,
      p_bar: s.p_bar, T_K: s.T_K, xb: s.xb,
      liftIn: s.liftIn, liftEx: s.liftEx,
      sparkNow: s.xb > 0 && s.xb < 0.05,
      torque_Nm: s.torque_Nm ?? 0,
      bankTilt: spec.cyl[i]?.tilt ?? 0,
    });
  }

  const knockDeg = m.knock?.deg;
  const knockNow = !!(m.knock?.happens) && Number.isFinite(knockDeg) && cyl.some(c => {
    const dd = Math.abs(((c.deg - knockDeg + C * 1.5) % C) - C / 2);
    return dd > C / 2 - 14;
  });

  return {
    deg: state.theta,
    crankDeg: state.theta % 360,
    rpm: rpmNow,
    fuelMode: engine.params.fuel,
    cylinders: spec.cylinders,
    layout: state.layout,
    twoStroke: state.twoStroke,
    cycleDeg: C,
    boostNow_bar: m.boostNow_bar ?? engine.params.boost_bar ?? 0,
    chargeT_K: m.chargeT_K ?? 320,
    intercooler: !!engine.params.intercooler,
    turbo: !!engine.params.turbo,
    crankcaseFrac: cyl[0]?.pistonFrac ?? 0,
    knockNow,
    totalTorque_Nm: cylCount() > 1
      ? (engine.sample(state.theta).torqueTotal_Nm ?? total)
      : total,
    cyl,
  };
}

/* ═════════ круговой указатель угла ═════════ */
const STROKES_4 = [
  { name: 'ВПУСК', color: '#4a9eff' },
  { name: 'СЖАТИЕ', color: '#b26bff' },
  { name: 'РАБОЧИЙ ХОД', color: '#ff8a3c' },
  { name: 'ВЫПУСК', color: '#8b98a8' },
];
const STROKES_2 = [
  { name: 'РАБОЧИЙ ХОД И ПРОДУВКА', color: '#ff8a3c' },
  { name: 'СЖАТИЕ И НАПОЛНЕНИЕ КАРТЕРА', color: '#b26bff' },
];
const strokes = () => state.twoStroke ? STROKES_2 : STROKES_4;

function arcPath(a0, a1, r = 31){
  const p = a => [38 + r * Math.cos(a * Math.PI / 180), 38 + r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function drawDial(){
  const s = strokes();
  const step = 360 / s.length;
  $('dialArcs').innerHTML = s.map((st, i) => {
    const a0 = i * step + 1.2, a1 = (i + 1) * step - 1.2;
    return `<path d="${arcPath(a0, a1)}" stroke="${st.color}" opacity=".8"/>`;
  }).join('');
}

/* ═════════ цикл анимации ═════════ */
let lastTime = performance.now();
const deltaTime = () => {
  const t = performance.now();
  const d = (t - lastTime) / 1000;
  lastTime = t;
  return d;
};
let rpmNow = engine.params.rpm;
let lastChart = 0, lastMetrics = 0, lastStroke = -1;
const STILL = qs.get('still') === '1';

function animate(){
  if (!STILL) requestAnimationFrame(animate);
  const dt = Math.min(deltaTime(), 0.05);
  const C = cycleDeg();

  if (state.playing){
    const dtSim = dt / SLOW[state.slowIdx];
    engine.stepTurbo?.(dtSim);
    let advanced = false;
    if (typeof engine.stepDynamics === 'function'){
      const r = engine.stepDynamics(dtSim);
      if (r && Number.isFinite(r.rpmInstant)) rpmNow = r.rpmInstant;
      if (r && Number.isFinite(r.deg)){ state.theta = r.deg % C; advanced = true; }
    }
    if (!advanced) state.theta = (state.theta + 6 * rpmNow * dtSim) % C;
  }

  const frame = buildFrame(rpmNow);
  mech.update(frame);
  fluids.update(frame, dt);
  if (state.soundOn && sound) sound.update(frame, dt, {
    slowFactor: SLOW[state.slowIdx], cylinders: frame.cylinders, cycleDeg: C,
    throttle: engine.params.throttle, boost: frame.boostNow_bar,
  });

  /* ── шапка и указатель ── */
  const s = strokes();
  const idx = Math.min(s.length - 1, Math.floor(state.theta / (C / s.length)));
  const st = s[idx];
  $('strokeBadge').textContent = `${idx + 1} · ${st.name}`;
  $('strokeBadge').style.color = st.color;
  $('dialAngle').textContent = state.theta.toFixed(0) + '°';
  $('dialNeedle').setAttribute('transform', `rotate(${(state.theta / C * 360).toFixed(1)})`);
  $('angleReadout').textContent = C === 360
    ? `цикл 360° · один оборот`
    : `${state.theta.toFixed(0)}° из 720° · оборот ${state.theta < 360 ? 1 : 2}`;
  if (state.playing){ $('scrub').value = state.theta; syncRange($('scrub')); $('scrubVal').textContent = state.theta.toFixed(0) + '°'; }
  $('tlMarker').style.left = `calc(${(state.theta / C * 100).toFixed(2)}% - 1px)`;

  const c0 = frame.cyl[0];
  $('fP').textContent = c0.p_bar.toFixed(1) + ' бар';
  $('fT').textContent = Math.round(c0.T_K - 273) + ' °C';
  $('fX').textContent = Math.round(c0.xb * 100) + ' %';
  $('fM').textContent = frame.totalTorque_Nm.toFixed(0) + ' Н·м';
  $('fRpm').textContent = Math.round(rpmNow);
  $('fBoost').textContent = frame.boostNow_bar > 0.01 ? '+' + frame.boostNow_bar.toFixed(2) + ' бар' : 'нет';
  $('hRpm').textContent = Math.round(rpmNow);

  if (idx !== lastStroke){
    lastStroke = idx;
    for (let i = 0; i < 4; i++) $('st' + i)?.classList.toggle('active', i === idx);
    $('st' + idx)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  const neg = m.brakePower_kW < 0;
  $('mPower').textContent = neg
    ? fmt(m.brakePower_kW, 1, 'кВт') + ' — торможение'
    : fmt(m.brakePower_kW, 1, 'кВт') +
      (Number.isFinite(m.brakePower_kW) ? ` (${(m.brakePower_kW * 1.36).toFixed(0)} л.с.)` : '');
  $('mPower').style.color = neg ? 'var(--amber)' : '';
  $('mPowerInd').textContent = fmt(m.indPower_kW, 1, 'кВт');
  $('mTorque').textContent = fmt(m.brakeTorque_Nm, 0, 'Н·м');
  $('mDispl').textContent = fmt(g.Vd_cm3 * cylCount() / 1000, 2, 'л');
  const b = m.boostNow_bar ?? engine.params.boost_bar ?? 0;
  $('mBoost').textContent = b > 0.01
    ? '+' + b.toFixed(2) + ' бар' + (engine.params.intercooler ? ', интеркулер' : ', без охлаждения')
    : 'атмосферный';
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
  $('mBalance').textContent = m.balance
    ? `${Math.round(m.balance.primary_N)} / ${Math.round(m.balance.secondary_N)} Н`
    : '—';

  $('hPower').textContent = Number.isFinite(m.brakePower_kW) ? m.brakePower_kW.toFixed(1) : '—';
  $('hTorque').textContent = Number.isFinite(m.brakeTorque_Nm) ? Math.round(m.brakeTorque_Nm) : '—';

  const k = m.knock || {};
  $('mKnock').textContent = k.happens ? `есть, с ${(k.deg ?? 0).toFixed(0)}°` : 'нет';
  $('mKnock').style.color = k.happens ? 'var(--red)' : 'var(--green)';

  const banner = $('knockBanner');
  banner.classList.toggle('show', !!k.happens);
  if (k.happens){
    banner.innerHTML = `<b>Детонация.</b> Несгоревшая смесь самовоспламеняется от сжатия
      (критерий Ливенгуда–Ву ≥ 1). Уменьши степень сжатия, наддув или опережение зажигания,
      либо возьми топливо с бо́льшим октановым числом.`;
  }
}

/* ═════════ пересчёт ═════════ */
function recompute(patch, rebuild3d = false){
  engine.setParams(patch);
  if (rebuild3d) buildAll();
  else {
    if (patch.eps !== undefined){
      mech.setCompression?.(patch.eps);
      fluids.setAnchors?.(mech.anchors);
    }
    if (patch.intakeLen_mm !== undefined) mech.setIntakeLength?.(patch.intakeLen_mm);
    if (patch.boost_bar !== undefined || patch.turbo !== undefined){
      mech.setTurbo?.(!!engine.params.turbo || engine.params.boost_bar > 0);
      fluids.setAnchors?.(mech.anchors);
    }
  }
  charts.setEngine(engine);
  charts.invalidate?.();
  updateMetrics(rpmNow);
}

/* ═════════ интерфейс ═════════ */
function syncRange(el){
  const min = +el.min, max = +el.max;
  el.style.setProperty('--fill', ((+el.value - min) / (max - min) * 100).toFixed(1) + '%');
}
document.querySelectorAll('input[type=range]').forEach(el => {
  syncRange(el);
  el.addEventListener('input', () => syncRange(el));
});

$('playBtn').textContent = state.playing ? '⏸ ПАУЗА' : '▶ ПУСК';
$('playBtn').onclick = () => {
  state.playing = !state.playing;
  $('playBtn').textContent = state.playing ? '⏸ ПАУЗА' : '▶ ПУСК';
};
const setTheta = v => {
  const C = cycleDeg();
  state.theta = (v + C) % C;
  $('scrub').value = state.theta; syncRange($('scrub'));
  $('scrubVal').textContent = state.theta.toFixed(0) + '°';
};
$('scrub').oninput = e => setTheta(+e.target.value);
$('stepF').onclick = () => setTheta(state.theta + 15);
$('stepB').onclick = () => setTheta(state.theta - 15);
$('nextStroke').onclick = () => {
  const n = strokes().length, step = cycleDeg() / n;
  setTheta((Math.floor(state.theta / step) + 1) % n * step);
};
$('prevStroke').onclick = () => {
  const n = strokes().length, step = cycleDeg() / n;
  setTheta((Math.floor(state.theta / step) + n - 1) % n * step);
};
$('tlTrack').addEventListener('pointerdown', ev => {
  const r = $('tlTrack').getBoundingClientRect();
  setTheta((ev.clientX - r.left) / r.width * cycleDeg());
});

/* ползунки режима */
const bind = (id, valId, fmtFn, patchFn) => {
  $(id).oninput = e => {
    const v = +e.target.value;
    if (valId) $(valId).textContent = fmtFn ? fmtFn(v) : v;
    recompute(patchFn(v));
  };
};
bind('rpm', 'rpmVal', v => v, v => { rpmNow = v; updateSlowHint(); return { rpm: v }; });
bind('throttle', 'thrVal', v => v, v => ({ throttle: v / 100 }));
bind('eps', 'epsVal', v => v.toFixed(1), v => ({ eps: v }));
bind('advance', 'advVal', v => v, v => ({ sparkAdvance_deg: v }));
bind('octane', 'octVal', v => v, v => ({ octane: v }));
bind('intakeLen', 'intakeLenVal', v => v, v => ({ intakeLen_mm: v }));
bind('boost', 'boostVal', v => v.toFixed(1), v => {
  $('boostNote').textContent = v > 0.01
    ? `Наддув +${v.toFixed(2)} бар: в цилиндр входит больше воздуха, значит и топлива. Следи за детонацией.`
    : 'Атмосферный впуск. Наддув поднимает мощность, но приближает детонацию — интеркулер снимает часть риска.';
  return { boost_bar: v };
});
$('turbo').onchange = e => recompute({ turbo: e.target.checked });
$('intercooler').onchange = e => recompute({ intercooler: e.target.checked });

$('slowmo').oninput = e => { state.slowIdx = +e.target.value; updateSlowHint(); };
function updateSlowHint(){
  const f = SLOW[state.slowIdx];
  $('slowVal').textContent = '×' + f;
  const rps = engine.params.rpm / 60;
  const cycleMs = (state.twoStroke ? 60000 : 120000) / engine.params.rpm;
  $('slowHint').textContent = f === 1
    ? `реальная скорость: ${rps.toFixed(1)} оборота в секунду, цикл ${cycleMs.toFixed(0)} мс`
    : `замедлено в ${f} раз · в реальности цикл длится ${cycleMs.toFixed(0)} мс`;
}
updateSlowHint();

/* компоновка, топливо, такты */
function setLayout(name){
  state.layout = name;
  document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x.dataset.layout === name));
  if (name !== 'single' && state.twoStroke) setTwoStroke(false, true);
  recompute({ layout: name, cylinders: cylCount() }, true);
  setCam('iso');
  document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x.dataset.cam === 'iso'));
  updateLayoutNote();
}
function setFuel(name){
  state.fuel = name;
  document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x.dataset.fuel === name));
  const eps = name === 'diesel' ? 18 : 10;
  setSlider('eps', eps, 'epsVal', v => v.toFixed(1));
  $('advance').disabled = name === 'diesel';
  $('octane').disabled = name === 'diesel';
  recompute({ fuel: name, eps });
  mech.setCompression?.(eps);
  fluids.setAnchors?.(mech.anchors);
  updateLayoutNote();
}
function setTwoStroke(on, silent){
  state.twoStroke = on;
  document.querySelector('[data-cycle="2t"]').classList.toggle('on', on);
  if (on){
    state.layout = 'single';
    document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x.dataset.layout === 'single'));
  }
  $('scrub').max = on ? 360 : 720;
  if (state.theta >= (on ? 360 : 720)) state.theta = 0;
  applyCycleUi();
  if (!silent) recompute({ stroke2: on, layout: state.layout, cylinders: cylCount() }, true);
  updateLayoutNote();
}
function updateLayoutNote(){
  const spec = layoutSpec(state.layout);
  const bits = [state.twoStroke ? 'Двухтактный' : 'Четырёхтактный', spec.name.toLowerCase(),
    state.fuel === 'diesel' ? 'дизель' : 'бензин',
    (engine.params.boost_bar > 0.01 || engine.params.turbo) ? 'с наддувом' : 'атмосферный'];
  $('layoutNote').textContent = bits.join(', ') + '.';
}

/** Перестройка шкалы и карточек тактов под 2- или 4-тактный цикл. */
const STAGES_4_HTML = Array.from({ length: 4 }, (_, i) => $('st' + i)?.outerHTML).join('');
function applyCycleUi(){
  const track = $('tlTrack'), names = $('tlNames');
  if (state.twoStroke){
    track.innerHTML = `<div style="flex:1;background:var(--power)"></div>
      <div style="flex:1;background:var(--compress)"></div><div id="tlMarker"></div>`;
    names.innerHTML = `<span>Рабочий ход · выпуск · продувка</span><span>Сжатие · наполнение картера</span>`;
    $('pane-stages').querySelectorAll('.stage').forEach(el => el.remove());
    $('pane-stages').insertAdjacentHTML('afterbegin', `
      <div class="stage" id="st0" style="--sc:var(--power)">
        <h3 style="color:var(--power)">1 · РАБОЧИЙ ХОД, ВЫПУСК И ПРОДУВКА — 0…180°</h3>
        <p>После вспышки у ВМТ газы толкают поршень вниз. Примерно на 104° поршень своей юбкой
        <b>открывает выпускное окно</b> — давление падает, начинается свободный выпуск. Ещё через
        18° открываются <b>продувочные окна</b>, и свежая смесь, сжатая в кривошипной камере,
        врывается в цилиндр, разворачивается по петле и выталкивает остатки выхлопа.</p>
        <small>Часть свежей смеси уходит прямо в выпуск — короткое замыкание продувки.
        Отсюда высокая литровая мощность, но плохая экономичность и грязный выхлоп.</small>
      </div>
      <div class="stage" id="st1" style="--sc:var(--compress)">
        <h3 style="color:var(--compress)">2 · СЖАТИЕ И НАПОЛНЕНИЕ КАРТЕРА — 180…360°</h3>
        <p>Поршень идёт вверх, закрывает продувочные и выпускное окна и сжимает смесь.
        Одновременно под поршнем <b>растёт разрежение в кривошипной камере</b>, и она
        наполняется свежей смесью через впускное окно. У ВМТ — искра, и цикл повторяется.</p>
        <small>Рабочий ход происходит каждый оборот, а не через один: клапанов, распредвалов
        и цепи здесь нет вообще.</small>
      </div>`);
  } else {
    track.innerHTML = `<div style="flex:1;background:var(--intake)"></div>
      <div style="flex:1;background:var(--compress)"></div>
      <div style="flex:1;background:var(--power)"></div>
      <div style="flex:1;background:var(--exhaust)"></div><div id="tlMarker"></div>`;
    names.innerHTML = `<span>Впуск</span><span>Сжатие</span><span>Рабочий ход</span><span>Выпуск</span>`;
    $('pane-stages').querySelectorAll('.stage').forEach(el => el.remove());
    $('pane-stages').insertAdjacentHTML('afterbegin', STAGES_4_HTML);
  }
  lastStroke = -1;
  drawDial();
}

document.querySelectorAll('[data-layout]').forEach(b => b.onclick = () => setLayout(b.dataset.layout));
document.querySelectorAll('[data-fuel]').forEach(b => b.onclick = () => setFuel(b.dataset.fuel));
document.querySelector('[data-cycle="2t"]').onclick = () => setTwoStroke(!state.twoStroke);
document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x === b));
  setCam(b.dataset.cam);
});

['cutaway', 'showLabels', 'fGas', 'fFuel', 'fExhaust', 'fOil', 'fCoolant']
  .forEach(id => $(id).onchange = applyVisibility);

$('sound').onchange = async e => {
  state.soundOn = e.target.checked;
  $('volCtl').style.display = state.soundOn ? '' : 'none';
  if (state.soundOn) await ensureSound();
  else sound?.setEnabled?.(false);
  if (state.soundOn) sound?.setEnabled?.(true);
};
$('volume').oninput = e => {
  state.volume = +e.target.value / 100;
  $('volVal').textContent = e.target.value;
  sound?.setVolume?.(state.volume);
};

/* ═════════ быстрые режимы ═════════ */
function setSlider(id, value, valId, fmtFn){
  const el = $(id);
  el.value = value; syncRange(el);
  if (valId) $(valId).textContent = fmtFn ? fmtFn(value) : value;
}
const PRESETS = {
  idle:  { layout: 'single', fuel: 'petrol', two: false, rpm: 900,  throttle: 25, eps: 10, adv: 16, boost: 0,   turbo: false, slow: 3 },
  city:  { layout: 'i4',     fuel: 'petrol', two: false, rpm: 2000, throttle: 35, eps: 10, adv: 22, boost: 0,   turbo: false, slow: 3 },
  wot:   { layout: 'i4',     fuel: 'petrol', two: false, rpm: 5000, throttle: 100, eps: 10, adv: 20, boost: 0,  turbo: false, slow: 4 },
  turbo: { layout: 'i4',     fuel: 'petrol', two: false, rpm: 3500, throttle: 100, eps: 9, adv: 12, boost: 0.9, turbo: true, octane: 98, slow: 4 },
  knock: { layout: 'single', fuel: 'petrol', two: false, rpm: 2400, throttle: 100, eps: 14, adv: 35, boost: 0,  turbo: false, octane: 92, slow: 3 },
  diesel:{ layout: 'i4',     fuel: 'diesel', two: false, rpm: 2500, throttle: 100, eps: 18, adv: 18, boost: 0.7, turbo: true, slow: 3 },
  two:   { layout: 'single', fuel: 'petrol', two: true,  rpm: 3000, throttle: 100, eps: 9,  adv: 18, boost: 0,  turbo: false, slow: 3 },
  v8:    { layout: 'v8',     fuel: 'petrol', two: false, rpm: 3600, throttle: 100, eps: 10.5, adv: 22, boost: 0, turbo: false, slow: 4 },
};
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
  const p = PRESETS[b.dataset.preset];
  if (!p) return;
  state.twoStroke = p.two;
  state.layout = p.layout;
  state.fuel = p.fuel;
  document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x.dataset.layout === p.layout));
  document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x.dataset.fuel === p.fuel));
  document.querySelector('[data-cycle="2t"]').classList.toggle('on', p.two);
  setSlider('rpm', p.rpm, 'rpmVal');
  setSlider('throttle', p.throttle, 'thrVal');
  setSlider('eps', p.eps, 'epsVal', v => (+v).toFixed(1));
  setSlider('advance', p.adv, 'advVal');
  setSlider('boost', p.boost, 'boostVal', v => (+v).toFixed(1));
  if (p.octane !== undefined) setSlider('octane', p.octane, 'octVal');
  $('turbo').checked = p.turbo;
  $('advance').disabled = p.fuel === 'diesel';
  $('octane').disabled = p.fuel === 'diesel';
  state.slowIdx = p.slow; setSlider('slowmo', p.slow);
  rpmNow = p.rpm;
  $('scrub').max = p.two ? 360 : 720;
  if (state.theta >= (p.two ? 360 : 720)) state.theta = 0;
  applyCycleUi();
  recompute({
    layout: p.layout, cylinders: cylCount(), stroke2: p.two, fuel: p.fuel,
    rpm: p.rpm, throttle: p.throttle / 100, eps: p.eps, sparkAdvance_deg: p.adv,
    boost_bar: p.boost, turbo: p.turbo,
    ...(p.octane !== undefined ? { octane: p.octane } : {}),
  }, true);
  setCam('iso');
  document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x.dataset.cam === 'iso'));
  updateSlowHint(); updateLayoutNote();
});

/* ═════════ вкладки и графики ═════════ */
let hintShown = '';
function syncChartHint(){
  const a = charts.getActive?.() || 'pv';
  if (a !== hintShown){ hintShown = a; $('chartHint').textContent = CHART_HINTS[a] || ''; }
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('on'));
  $('pane-' + b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'charts') charts.resize?.();
});
$('panelToggle').onclick = () => {
  const open = $('right').classList.toggle('open');
  $('panelToggle').textContent = open ? 'Свернуть' : 'Теория и графики';
  if (open) charts.resize?.();
};

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

if (qs.get('ui') === '0')
  ['left', 'right', 'timeline', 'panelToggle'].forEach(id => $(id).style.display = 'none');

/* ═════════ старт ═════════ */
setSlider('rpm', engine.params.rpm, 'rpmVal');
setSlider('throttle', Math.round(engine.params.throttle * 100), 'thrVal');
setSlider('eps', engine.params.eps, 'epsVal', v => (+v).toFixed(1));
setSlider('advance', engine.params.sparkAdvance_deg, 'advVal');
setSlider('octane', engine.params.octane, 'octVal');
setSlider('boost', engine.params.boost_bar ?? 0, 'boostVal', v => (+v).toFixed(1));
setSlider('intakeLen', engine.params.intakeLen_mm ?? 350, 'intakeLenVal');
$('turbo').checked = !!engine.params.turbo;
$('intercooler').checked = engine.params.intercooler !== false;
document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x.dataset.layout === state.layout));
document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x.dataset.fuel === state.fuel));
applyCycleUi();
updateLayoutNote();
setTheta(state.theta);
updateMetrics(rpmNow);
syncChartHint();
animate();
