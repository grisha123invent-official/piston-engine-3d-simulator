/**
 * Интегратор симулятора: сцена, цикл анимации, связь физики, 3D-модулей,
 * графиков, звука и интерфейса.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { L, layoutSpec } from './layout.js?v=5';
import { getLang, setLang, onLangChange, t, applyDom } from './i18n.js?v=5';
import { STAGES_4, STAGES_2, NOTES, CHART_HINTS, STROKE_NAMES_4, STROKE_NAMES_2,
         TIMELINE_4, TIMELINE_2, UI } from './content.js?v=5';
import { createEngine } from './physics.js?v=5';
import { buildMechanism } from './engine3d.js?v=5';
import { buildFluids } from './fluids3d.js?v=5';
import { createCharts } from './charts.js?v=5';

const $ = id => document.getElementById(id);

/* ═════════ ошибки показываем, а не прячем ═════════ */
function fail(msg){
  const box = $('err');
  box.style.display = 'block';
  box.textContent = t({ ru: 'Ошибка: ', en: 'Error: ' }) + msg;
  console.error(msg);
}
/**
 * Показываем баннер только для ошибок, с которыми пользователь может что-то сделать.
 * Браузер отдаёт «Script error.» без файла и стека для чужого кода с другого домена
 * (three.js с CDN) — такой баннер ничего не объясняет, поэтому только пишем в консоль.
 */
addEventListener('error', e => {
  const opaque = !e.filename && (!e.message || /^script error/i.test(e.message));
  if (opaque){ console.warn('внешняя ошибка без подробностей:', e.message); return; }
  fail(e.message);
});
addEventListener('unhandledrejection', e => {
  const msg = e.reason?.message || String(e.reason ?? '');
  if (/^script error/i.test(msg) || !msg){ console.warn('внешний сбой:', e.reason); return; }
  fail(msg);
});

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
  layout: ['single', 'i4', 'boxer4', 'v8'].includes(qs.get('layout'))
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
  atkinson_deg: num('atkinson', 0, 0, 70),
  directInjection: qs.get('di') === '1',
  variableIntake: qs.get('varIntake') === '1',
  balanceShafts: qs.get('shafts') === '1',
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
  const boxer = state.layout === 'boxer4';
  const k = n === 8 ? 2.0 : boxer ? 1.9 : n === 4 ? 1.85 : 1;
  /* у оппозита цилиндры лежат по бокам от вала, поэтому смотрим ниже и чуть сверху */
  return boxer ? {
    side:  [10, 38, 76],
    iso:   [56, 30, 64],
    front: [4, 20, 96],
    top:   [1, 104, 10],
  } : {
    side:  [52 * k, 16, 4 * k],
    iso:   [37 * k, 27, 43 * k],
    front: [3, 14, 60 * k],
    top:   [1, 68 * k, 12 * k],
  };
}
let camName = qs.get('cam') || 'iso';
/** На узком или вертикальном экране двигатель не влезает — отодвигаем камеру. */
function fitFactor(){
  const aspect = innerWidth / innerHeight;
  if (aspect >= 1.4) return 1;
  return Math.min(1.6, 1 + (1.4 - aspect) * 0.62);
}
function setCam(name){
  camName = name || camName;
  const p = camPresets()[camName] || camPresets().iso;
  const k = fitFactor();
  camera.position.set(p[0] * k, p[1] * k, p[2] * k);
  /* на вертикальном экране снизу панели — поднимаем точку взгляда,
     чтобы двигатель встал в верхнюю половину кадра */
  const baseY = state.layout === 'boxer4' ? 3 : 10;
  controls.target.set(0, baseY + (k > 1.15 ? 7 : 0), 0);
}
setCam(qs.get('cam') || 'iso');

/* ═════════ 3D-модули ═════════ */
let mech = null, fluids = null;

/* на телефоне подписи деталей загораживают модель — по умолчанию выключаем */
if (innerWidth < 760 && !qs.has('labels')) $('showLabels').checked = false;

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
  mech.setIntakeLength?.(engine.metrics.intakeLenNow_mm ?? engine.params.intakeLen_mm, true);
  mech.setBalanceShafts?.(!!engine.params.balanceShafts);
  mech.setDirectInjection?.(!!engine.params.directInjection);
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


/* ═════════ звук (модуль подгружается по требованию) ═════════ */
let sound = null, soundLoading = false;
async function ensureSound(){
  if (sound || soundLoading) return sound;
  soundLoading = true;
  try {
    const mod = await import('./sound.js?v=5');
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
    balanceShafts: !!engine.params.balanceShafts,
    directInjection: !!engine.params.directInjection,
    variableIntake: !!engine.params.variableIntake,
    atkinson_deg: engine.params.atkinson_deg ?? 0,
    intakeLenNow_mm: m.intakeLenNow_mm ?? engine.params.intakeLen_mm,
    intakeMode: m.intakeMode ?? 'fixed',
    crankcaseFrac: cyl[0]?.pistonFrac ?? 0,
    knockNow,
    totalTorque_Nm: cylCount() > 1
      ? (engine.sample(state.theta).torqueTotal_Nm ?? total)
      : total,
    cyl,
  };
}

/* ═════════ круговой указатель угла ═════════ */
const strokes = () => state.twoStroke ? STROKE_NAMES_2 : STROKE_NAMES_4;

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
  $('strokeBadge').textContent = `${idx + 1} · ${t(st)}`;
  $('strokeBadge').style.color = st.color;
  $('dialAngle').textContent = state.theta.toFixed(0) + '°';
  $('dialNeedle').setAttribute('transform', `rotate(${(state.theta / C * 360).toFixed(1)})`);
  $('angleReadout').textContent = C === 360
    ? t(UI.cycle360)
    : `${state.theta.toFixed(0)}° ${t(UI.cycleOf)} ${state.theta < 360 ? 1 : 2}`;
  if (state.playing){ $('scrub').value = state.theta; syncRange($('scrub')); $('scrubVal').textContent = state.theta.toFixed(0) + '°'; }
  $('tlMarker').style.left = `calc(${(state.theta / C * 100).toFixed(2)}% - 1px)`;

  const c0 = frame.cyl[0];
  $('fP').textContent = c0.p_bar.toFixed(1) + ' ' + t(UI.units.bar);
  $('fT').textContent = Math.round(c0.T_K - 273) + ' °C';
  $('fX').textContent = Math.round(c0.xb * 100) + ' %';
  $('fM').textContent = frame.totalTorque_Nm.toFixed(0) + ' ' + t(UI.units.nm);
  $('fRpm').textContent = Math.round(rpmNow);
  $('fBoost').textContent = frame.boostNow_bar > 0.01
    ? '+' + frame.boostNow_bar.toFixed(2) + ' ' + t(UI.units.bar)
    : t(UI.none);
  $('hRpm').textContent = Math.round(rpmNow);

  if (idx !== lastStroke){
    lastStroke = idx;
    for (let i = 0; i < 4; i++) $('st' + i)?.classList.toggle('active', i === idx);
    scrollStageIntoView(idx);
  }

  const now = performance.now();
  if (now - lastChart > 60){ lastChart = now; charts.update(frame); }
  if (now - lastMetrics > 250){ lastMetrics = now; updateMetrics(rpmNow); syncChartHint(); }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

/**
 * Подкручивает карточку такта внутри своей панели.
 * Штатный scrollIntoView прокрутил бы весь документ, когда шторка спрятана за экраном,
 * поэтому двигаем только содержимое панели.
 */
function scrollStageIntoView(idx){
  const pane = $('tabBody'), card = $('st' + idx);
  if (!pane || !card) return;
  if (innerWidth <= 1200 && !$('right').classList.contains('open')) return;
  const dy = card.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  if (Math.abs(dy) < 4) return;
  pane.scrollTo({ top: pane.scrollTop + dy - 8, behavior: 'smooth' });
}

/* ═════════ показатели ═════════ */
const fmt = (v, d = 1, unit = '') =>
  Number.isFinite(v) ? v.toFixed(d) + (unit ? ' ' + unit : '') : '—';
const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + ' %' : '—';

function updateMetrics(rpmInst){
  const m = engine.metrics, g = engine.geometry;
  const U = UI.units;
  const neg = m.brakePower_kW < 0;
  $('mPower').textContent = neg
    ? fmt(m.brakePower_kW, 1, t(U.kw)) + ' ' + t(UI.braking)
    : fmt(m.brakePower_kW, 1, t(U.kw)) +
      (Number.isFinite(m.brakePower_kW) ? ` (${(m.brakePower_kW * 1.36).toFixed(0)} ${t(UI.hp)})` : '');
  $('mPower').style.color = neg ? 'var(--amber)' : '';
  $('mPowerInd').textContent = fmt(m.indPower_kW, 1, t(U.kw));
  $('mTorque').textContent = fmt(m.brakeTorque_Nm, 0, t(U.nm));
  $('mDispl').textContent = fmt(g.Vd_cm3 * cylCount() / 1000, 2, t(U.litre));
  const b = m.boostNow_bar ?? engine.params.boost_bar ?? 0;
  $('mBoost').textContent = b > 0.01
    ? '+' + b.toFixed(2) + ' ' + t(U.bar) + t(engine.params.intercooler ? UI.withIC : UI.withoutIC)
    : t(UI.boostNone);
  $('mPmax').textContent = fmt(m.pmax_bar, 1, t(U.bar)) +
    (Number.isFinite(m.pmax_deg) ? ` ${t(U.at)} ${m.pmax_deg.toFixed(0)}°` : '');
  $('mTmax').textContent = fmt(m.Tmax_K - 273, 0, '°C');
  $('mImep').textContent = fmt(m.imep_bar, 2, t(U.bar));
  $('mWork').textContent = fmt(m.workPerCycle_J, 0, t(U.joule));
  $('mVolEff').textContent = pct(m.volEff);
  $('mRatios').textContent = Number.isFinite(m.effCompressionRatio)
    ? `${m.effCompressionRatio.toFixed(1)} / ${(m.expansionRatio ?? engine.params.eps).toFixed(1)}`
    : '—';
  $('mCooling').textContent = m.chargeCooling_K > 0.05
    ? '−' + m.chargeCooling_K.toFixed(1) + ' K'
    : t(UI.none);
  $('mEffClosed').textContent = pct(m.effClosedCycle);
  $('mEffInd').textContent = pct(m.effIndicated);
  $('mEffBrake').textContent = pct(m.effBrake);
  $('mEffOtto').textContent = pct(m.effOtto);
  $('mBsfc').textContent = fmt(m.bsfc_g_kWh, 0, t(U.gkwh));
  $('mPistonSpeed').textContent = fmt(m.meanPistonSpeed_ms, 1, t(U.ms));
  $('mFluct').textContent = Number.isFinite(m.speedFluctuation) ? m.speedFluctuation.toFixed(3) : '—';
  $('mBalance').textContent = m.balance
    ? `${Math.round(m.balance.primary_N)} / ${Math.round(m.balance.secondary_N)} ${t({ ru: 'Н', en: 'N' })}`
    : '—';

  $('hPower').textContent = Number.isFinite(m.brakePower_kW) ? m.brakePower_kW.toFixed(1) : '—';
  $('hTorque').textContent = Number.isFinite(m.brakeTorque_Nm) ? Math.round(m.brakeTorque_Nm) : '—';

  const k = m.knock || {};
  $('mKnock').textContent = k.happens
    ? `${t(UI.knockYes)} ${(k.deg ?? 0).toFixed(0)}°`
    : t(UI.knockNo);
  $('mKnock').style.color = k.happens ? 'var(--red)' : 'var(--green)';

  const banner = $('knockBanner');
  banner.classList.toggle('show', !!k.happens);
  if (k.happens) banner.innerHTML = `<b>${t(UI.knockTitle)}</b> ${t(UI.knockBody)}`;
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
    if (patch.intakeLen_mm !== undefined || patch.variableIntake !== undefined || patch.rpm !== undefined)
      mech.setIntakeLength?.(engine.metrics.intakeLenNow_mm ?? engine.params.intakeLen_mm);
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

const ICON_PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
const ICON_PLAY = '<path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z"/>';
/** Кнопка пуска: подпись и иконка по текущему состоянию. */
function syncPlayBtn(){
  $('playLabel').textContent = t(state.playing ? UI.pause : UI.play);
  $('playIcon').innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
}
syncPlayBtn();
$('playBtn').onclick = () => { state.playing = !state.playing; syncPlayBtn(); };
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
/** Подсказка под ползунком наддува. */
function boostNote(v){
  return v > 0.01
    ? t({
        ru: `Наддув +${v.toFixed(2)} бар: в цилиндр входит больше воздуха, значит и топлива. Следи за детонацией.`,
        en: `Boost +${v.toFixed(2)} bar: more air in the cylinder means more fuel. Watch out for knock.`,
      })
    : t({
        ru: 'Атмосферный впуск. Наддув поднимает мощность, но приближает детонацию — интеркулер снимает часть риска.',
        en: 'Naturally aspirated. Boost raises power but brings knock closer — an intercooler takes part of that risk away.',
      });
}
bind('boost', 'boostVal', v => v.toFixed(1), v => {
  $('boostNote').textContent = boostNote(v);
  return { boost_bar: v };
});
bind('atkinson', 'atkVal', v => v, v => ({ atkinson_deg: v }));
$('turbo').onchange = e => recompute({ turbo: e.target.checked });
$('intercooler').onchange = e => recompute({ intercooler: e.target.checked });
$('directInjection').onchange = e => {
  recompute({ directInjection: e.target.checked });
  mech.setDirectInjection?.(e.target.checked);
  fluids.setAnchors?.(mech.anchors);
};
$('variableIntake').onchange = e => {
  recompute({ variableIntake: e.target.checked });
  $('intakeLen').disabled = e.target.checked;
};
$('balanceShafts').onchange = e => {
  recompute({ balanceShafts: e.target.checked });
  mech.setBalanceShafts?.(e.target.checked);
};

$('slowmo').oninput = e => { state.slowIdx = +e.target.value; updateSlowHint(); };
function updateSlowHint(){
  const f = SLOW[state.slowIdx];
  $('slowVal').textContent = '×' + f;
  const cycleMs = (state.twoStroke ? 60000 : 120000) / engine.params.rpm;
  const ms = cycleMs.toFixed(0) + ' ' + t(UI.units.ms_);
  $('slowHint').textContent = f === 1
    ? `${t(UI.realtime)}: ${t(UI.cycleLasts)} ${ms}`
    : `${t(UI.slowed)} ${f} ${t(UI.times)} · ${t(UI.cycleLasts)} ${ms}`;
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
const LAYOUT_NAMES = {
  single: { ru: 'одноцилиндровый', en: 'single cylinder' },
  i4: { ru: 'рядная четвёрка', en: 'inline-four' },
  boxer4: { ru: 'оппозитная четвёрка', en: 'flat-four' },
  v8: { ru: 'V8 с развалом 90°', en: 'V8 at 90°' },
};
function updateLayoutNote(){
  const bits = [
    t(state.twoStroke ? UI.twoStroke : UI.fourStroke),
    t(LAYOUT_NAMES[state.layout] || LAYOUT_NAMES.single),
    t(state.fuel === 'diesel' ? UI.diesel : UI.petrol),
    t((engine.params.boost_bar > 0.01 || engine.params.turbo) ? UI.boosted : UI.naturally),
  ];
  $('layoutNote').textContent = bits.join(', ') + '.';
}

/** Карточка такта из описания в content.js. */
function stageCard(st, i){
  return `<div class="stage" id="st${i}" style="--sc:${st.color}">
    <h3 style="color:${st.color}">${t(st.title)}</h3>
    <p>${t(st.body)}</p>
    <small>${t(st.note)}</small>
  </div>`;
}

/** Перестройка шкалы и карточек тактов под 2- или 4-тактный цикл и текущий язык. */
function applyCycleUi(){
  const track = $('tlTrack'), names = $('tlNames');
  const stages = state.twoStroke ? STAGES_2 : STAGES_4;
  const tl = state.twoStroke ? TIMELINE_2 : TIMELINE_4;

  track.innerHTML = stages.map(s => `<div style="flex:1;background:${s.color}"></div>`).join('')
    + '<div id="tlMarker"></div>';
  names.innerHTML = tl.map(n => `<span>${t(n)}</span>`).join('');
  $('pane-stages').innerHTML = stages.map(stageCard).join('')
    + `<div class="note">${t(NOTES.colors)}</div><div class="note">${t(NOTES.knock)}</div>`;

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
  boxer: { layout: 'boxer4', fuel: 'petrol', two: false, rpm: 3200, throttle: 100, eps: 10.5, adv: 20, boost: 0, turbo: false, slow: 4 },
  atkinson: { layout: 'i4',  fuel: 'petrol', two: false, rpm: 2000, throttle: 50, eps: 14, adv: 20, boost: 0,
              turbo: false, octane: 95, slow: 3, atkinson: 40, di: true },
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
  setSlider('atkinson', p.atkinson ?? 0, 'atkVal');
  $('directInjection').checked = !!p.di;
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
    atkinson_deg: p.atkinson ?? 0, directInjection: !!p.di,
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
  if (a !== hintShown){ hintShown = a; $('chartHint').textContent = t(CHART_HINTS[a]) || ''; }
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('on'));
  $('pane-' + b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'charts') charts.resize?.();
});
/* ═════════ шторки на узких экранах ═════════ */
function openSheet(which){
  const left = $('left'), right = $('right');
  const target = which === 'left' ? left : right;
  const other = which === 'left' ? right : left;
  other.classList.remove('open');
  const open = target.classList.toggle('open');
  document.body.classList.toggle('sheet-open', left.classList.contains('open') || right.classList.contains('open'));
  $('panelToggleLabel').textContent = t(right.classList.contains('open') ? UI.panelClose : UI.panelOpen);
  if (open && which === 'right') charts.resize?.();
  return open;
}
$('panelToggle').onclick = () => openSheet('right');
$('menuToggle').onclick = () => openSheet('left');
/* тап по сцене закрывает открытую шторку */
$('scene').addEventListener('pointerdown', () => {
  if (innerWidth > 1200) return;
  $('left').classList.remove('open');
  $('right').classList.remove('open');
  document.body.classList.remove('sheet-open');
  $('panelToggleLabel').textContent = t(UI.panelOpen);
});

/* ═════════ переключение языка ═════════ */
function syncLangButtons(){
  document.querySelectorAll('[data-lang]').forEach(b =>
    b.classList.toggle('on', b.dataset.lang === getLang()));
}
document.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => setLang(b.dataset.lang));
onLangChange(() => {
  applyDom(document);
  syncLangButtons();
  applyCycleUi();                       // карточки тактов и шкала
  syncPlayBtn();
  $('panelToggleLabel').textContent = t($('right').classList.contains('open') ? UI.panelClose : UI.panelOpen);
  $('boostNote').textContent = boostNote(engine.params.boost_bar ?? 0);
  updateSlowHint();
  updateLayoutNote();
  updateMetrics(rpmNow);
  hintShown = '';                       // подсказка под графиком перечитается
  syncChartHint();
});
syncLangButtons();

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
let lastFit = fitFactor();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  charts.resize?.();
  /* заметно изменились пропорции экрана — переставляем камеру под них */
  const f = fitFactor();
  if (Math.abs(f - lastFit) > 0.12){ lastFit = f; setCam(); }
});

if (qs.get('ui') === '0')
  ['left', 'right', 'timeline', 'panelToggle', 'menuToggle']
    .forEach(id => $(id).style.display = 'none');

/* ═════════ старт ═════════ */
setSlider('rpm', engine.params.rpm, 'rpmVal');
setSlider('throttle', Math.round(engine.params.throttle * 100), 'thrVal');
setSlider('eps', engine.params.eps, 'epsVal', v => (+v).toFixed(1));
setSlider('advance', engine.params.sparkAdvance_deg, 'advVal');
setSlider('octane', engine.params.octane, 'octVal');
setSlider('boost', engine.params.boost_bar ?? 0, 'boostVal', v => (+v).toFixed(1));
setSlider('intakeLen', engine.params.intakeLen_mm ?? 350, 'intakeLenVal');
setSlider('atkinson', engine.params.atkinson_deg ?? 0, 'atkVal');
$('turbo').checked = !!engine.params.turbo;
$('intercooler').checked = engine.params.intercooler !== false;
$('directInjection').checked = !!engine.params.directInjection;
$('variableIntake').checked = !!engine.params.variableIntake;
$('balanceShafts').checked = !!engine.params.balanceShafts;
$('intakeLen').disabled = !!engine.params.variableIntake;
document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x.dataset.layout === state.layout));
document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('on', x.dataset.fuel === state.fuel));
applyDom(document);
applyCycleUi();
updateLayoutNote();
$('boostNote').textContent = boostNote(engine.params.boost_bar ?? 0);
setTheta(state.theta);
updateMetrics(rpmNow);
syncChartHint();
animate();
