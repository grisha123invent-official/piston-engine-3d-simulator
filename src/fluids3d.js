/**
 * src/fluids3d.js — визуализация всех рабочих тел двигателя.
 *
 * Независимо включаемые подсистемы (setVisible):
 *   1. gas       — газ в цилиндре: объём между днищем поршня и головкой;
 *   2. fuel      — впрыск топлива (порт-форсунка или прямой впрыск дизеля);
 *   3. exhaust   — выхлопной дым в выпускной канал;
 *   4. flame     — фронт пламени по xb + вспышка и ударная волна детонации;
 *   5. oil       — замкнутый масляный контур;
 *   6. coolant   — рубашка охлаждения и петля к радиатору;
 *   7. boost     — наддув: компрессор → интеркулер → впускной ресивер;      (вторая волна)
 *   8. turbine   — выхлопные газы, раскручивающие турбину;                  (вторая волна)
 *   9. scavenge  — двухтактная продувка и смесь в кривошипной камере.       (вторая волна)
 *
 * Наклонные ряды (V8) поддержаны сквозным образом: якоря механизма уже отдают
 * точки в системе механизма, а собственная геометрия модуля строится через
 * bVec(x, y, z, tilt) — тот же поворот ряда, что и в engine3d.js.
 *
 * Никаких текстур и внешних ресурсов: только процедурная геометрия и материалы.
 * Модуль не создаёт ни света, ни камеры, ни рендерера — отдаёт готовую THREE.Group.
 * Суммарный бюджет частиц — 2820 (см. BUDGET ниже, потолок по контракту ~3000).
 */

import * as THREE from 'three';
import { L, PIN_Y_TDC, layoutSpec } from './layout.js';

/* ─────────────────────────── константы ─────────────────────────── */

/** Размеры пулов частиц. Сумма = 2820 (< 3000 по контракту второй волны). */
const BUDGET = {
  fuel: 300,      // впрыск топлива
  exhaust: 320,   // выхлопной дым
  oil: 480,       // масляный контур
  coolant: 560,   // рубашка охлаждения + петля к радиатору
  boost: 420,     // наддув: компрессор → интеркулер → ресивер → патрубки
  turbine: 260,   // струя выхлопа на турбину
  scavenge: 480,  // двухтактная продувка (петля + короткое замыкание + вытеснение)
};

/** Палитра — та же тёмная техно-эстетика, что и в сцене. */
const COL = {
  mix: new THREE.Color(0x4ea0ff),      // свежая смесь
  comp: new THREE.Color(0xb06bff),     // сжатие
  fire: new THREE.Color(0xff8a2a),     // горение
  white: new THREE.Color(0xfff2d0),    // пик температуры / вспышка
  exh: new THREE.Color(0x9aa2ad),      // отработавшие газы
  petrol: new THREE.Color(0xffd970),   // бензин
  diesel: new THREE.Color(0xdfe6ee),   // дизтопливо (белёсый факел)
  smokeHot: new THREE.Color(0xffb070),
  smokeCold: new THREE.Color(0x7d858f),
  oil: new THREE.Color(0xe8a33d),
  oilDark: new THREE.Color(0x9c6a1e),
  coolCold: new THREE.Color(0x2f7fe0),
  coolHot: new THREE.Color(0xef4444),
  /* ── вторая волна ── */
  chargeCold: new THREE.Color(0x74d0ff),   // заряд после интеркулера
  chargeWarm: new THREE.Color(0xffc27a),   // подогретый заряд
  chargeHot: new THREE.Color(0xff6a3a),    // горячий воздух сразу за компрессором
  fresh: new THREE.Color(0x6fd0ff),        // свежая смесь в продувке
  shortCut: new THREE.Color(0xc8f6ff),     // короткое замыкание продувки (бросается в глаза)
  burnt: new THREE.Color(0x8d939c),        // вытесняемый выхлоп
};

const HIDE = -9999;           // «мёртвая» частица уезжает под сцену
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const WALL_BOT_Y = 6.0;       // низ гильзы (совпадает с engine3d.js)

/* ─────────────────────────── мелкие утилиты ─────────────────────────── */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Число или запасное значение — защита от NaN/undefined из внешних данных. */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (s) => (Math.random() - 0.5) * s;
/** Экспоненциальное сглаживание к цели за характерное время tau. */
const approach = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

/** Vector3 из произвольного «похожего на точку» объекта. */
function vec3(src, dx, dy, dz) {
  const o = src || {};
  return new THREE.Vector3(num(o.x, dx), num(o.y, dy), num(o.z, dz));
}

/** Точка похожа на вектор и вся конечна? */
function isVec(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
/** Клон точки, если она корректна, иначе запасной вариант. */
function vecOr(v, def) {
  return isVec(v) ? new THREE.Vector3(v.x, v.y, v.z) : def;
}

/* Поворот ряда: те же формулы, что bankXY/bankVec в engine3d.js.
   Локальная ось ряда «вверх» = (sin tilt, cos tilt, 0). */
function bXY(x, y, tilt) {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return { x: x * c + y * s, y: -x * s + y * c };
}
/** Точка ряда (x, y вдоль оси ряда, z вдоль вала) в системе механизма. */
function bVec(x, y, z, tilt) {
  const p = bXY(x, y, tilt);
  return new THREE.Vector3(p.x, p.y, z);
}

/** Цвет заряда по его температуре: холодный голубой → горячий оранжевый. */
function chargeColor(out, T) {
  const k = clamp((num(T, 320) - 295) / 175, 0, 1);
  out.copy(COL.chargeCold).lerp(COL.chargeWarm, Math.min(k * 1.7, 1));
  if (k > 0.55) out.lerp(COL.chargeHot, (k - 0.55) / 0.45);
  return out;
}

/**
 * Температура за компрессором по адиабате с КПД η_к ≈ 0,72 —
 * нужна, чтобы показать, насколько интеркулер сбивает нагрев.
 */
function compressorT(T0, boost_bar) {
  const r = clamp(1 + num(boost_bar, 0), 1, 4);
  const rise = (Math.pow(r, 0.2857) - 1) / 0.72;
  return clamp(num(T0, 300) * (1 + rise), 250, 900);
}

/* ─────────────────────────── якоря ─────────────────────────── */

/**
 * Приводит anchors из engine3d.js к полному виду: недостающие поля берём из
 * layout.js, чтобы модуль работал и в одиночку (например, в тестах).
 * Все возвращаемые точки — в системе координат механизма (наклон ряда уже учтён).
 */
function normalizeAnchors(anchors, opts) {
  const a = anchors || {};
  const eps = num(opts.eps, 10);
  const deckY = num(a.deckY, L.deckY(eps));
  const twoStroke = !!a.twoStroke;

  /* ── цилиндры ── */
  let src = Array.isArray(a.cylinders) && a.cylinders.length ? a.cylinders : null;
  if (!src) {
    const name = a.layout
      || (num(opts.cylinders, 1) === 8 ? 'v8' : num(opts.cylinders, 1) === 4 ? 'i4' : 'single');
    src = layoutSpec(name).cyl.map((c) => ({ z: c.z, bankTilt: c.tilt }));
  }
  const tiltList = Array.isArray(a.bankTilt) ? a.bankTilt : null;

  const cylinders = src.map((c, i) => {
    const o = c || {};
    const t = num(o.bankTilt, num(o.tilt, tiltList ? num(tiltList[i], 0) : 0));
    const z = num(o.z, 0);
    const sx = num(o.mirror, 1) < 0 ? -1 : 1;
    /* точка из старого (одноуровневого) набора якорей, перенесённая на свой z */
    const legacy = (v) => (isVec(v) ? new THREE.Vector3(v.x, v.y, z) : null);
    return {
      index: i, x: 0, z, tilt: t, mirror: sx,
      axis: isVec(o.axis) ? new THREE.Vector3(o.axis.x, o.axis.y, o.axis.z)
                          : new THREE.Vector3(Math.sin(t), Math.cos(t), 0),
      crownY: o.crownY,
      crownPos: typeof o.crownPos === 'function' ? o.crownPos : null,
      intakePortEnd: vecOr(o.intakePortEnd,
        legacy(a.intakePortEnd) || bVec(sx * -8.9, deckY + 2.6, z, t)),
      exhaustPortEnd: vecOr(o.exhaustPortEnd,
        legacy(a.exhaustPortEnd) || bVec(sx * 8.9, deckY + 2.6, z, t)),
      injectorTip: vecOr(o.injectorTip,
        legacy(a.injectorTip) || bVec(sx * -6.9, deckY + 2.7, z, t)),
      dieselTip: vecOr(o.dieselInjectorTip,
        legacy(a.dieselInjectorTip) || bVec(0, deckY - 0.4, z, t)),
      sparkTip: vecOr(o.sparkTip, legacy(a.sparkTip) || bVec(0, deckY - 0.8, z, t)),
      valveInSeat: vecOr(o.valveInSeat, bVec(sx * L.VALVE_X_IN, deckY, z, t)),
      valveExSeat: vecOr(o.valveExSeat, bVec(sx * L.VALVE_X_EX, deckY, z, t)),
      deckPos: vecOr(o.deckPos, bVec(0, deckY, z, t)),
    };
  });

  const zs = cylinders.map((c) => c.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const zMid = (zMin + zMax) / 2;

  const intakePortEnd = vecOr(a.intakePortEnd, cylinders[0].intakePortEnd.clone());
  const exhaustPortEnd = vecOr(a.exhaustPortEnd, cylinders[0].exhaustPortEnd.clone());
  const injectorTip = vecOr(a.injectorTip, cylinders[0].injectorTip.clone());
  const sparkTip = vecOr(a.sparkTip, cylinders[0].sparkTip.clone());
  const crankCenter = vec3(a.crankCenter, 0, 0, 0);

  /* ── рубашка охлаждения ── */
  const jr = L.BORE_R + L.JACKET_GAP;
  const jb = a.jacketBox || {};
  const jmin = vec3(jb.min, -jr - 0.9, deckY - L.STROKE_U - 4.2, zMin - jr - 0.9);
  const jmax = vec3(jb.max, jr + 0.9, deckY, zMax + jr + 0.9);
  if (jmax.y - jmin.y < 2) jmin.y = jmax.y - L.STROKE_U - 4.2;   // страховка от вырожденной коробки

  /* ── окна двухтактного ── */
  const port = (p, kind, k) => {
    const o = p || {};
    const ci = clamp(Math.round(num(o.cyl, 0)), 0, cylinders.length - 1);
    const c = cylinders[ci];
    const theta = num(o.theta, kind === 'exhaust' ? Math.PI / 2 : (k === 0 ? 3.578 : 5.847));
    const t = num(o.bankTilt, c.tilt);
    const dx = Math.sin(theta), dz = Math.cos(theta);
    const topDefault = PIN_Y_TDC + L.PISTON_TOP_OFF
      - (kind === 'exhaust' ? L.PORT_EXH_TOP : L.PORT_TR_TOP) * L.STROKE_U;
    const botDefault = PIN_Y_TDC + L.PISTON_TOP_OFF
      - (kind === 'exhaust' ? L.PORT_EXH_BOT : L.PORT_TR_BOT) * L.STROKE_U;
    const topY = num(o.topY, topDefault);
    const botY = num(o.botY, botDefault);
    const mid = (topY + botY) / 2;
    return {
      index: k, kind, cyl: ci, tilt: t, theta, dx, dz, z: c.z, topY, botY, mid,
      pos: vecOr(o.pos, bVec(dx * (L.BORE_R + 0.2), mid, c.z + dz * (L.BORE_R + 0.2), t)),
      inner: vecOr(o.inner, bVec(dx * (L.BORE_R - 0.4), mid, c.z + dz * (L.BORE_R - 0.4), t)),
      dir: vecOr(o.dir, bVec(dx, 0, dz, t).normalize()),
      openFrac: typeof o.openFrac === 'function' ? o.openFrac : null,
    };
  };
  const portsExhaust = (Array.isArray(a.portsExhaust) ? a.portsExhaust : [])
    .map((p, k) => port(p, 'exhaust', k));
  const portsTransfer = (Array.isArray(a.portsTransfer) ? a.portsTransfer : [])
    .map((p, k) => port(p, 'transfer', k));

  /* ── кривошипная камера ── */
  const ccSrc = a.crankcase || a.crankcaseBox || null;
  let crankcase = null;
  if (ccSrc && isVec(ccSrc.min) && isVec(ccSrc.max)) {
    const mn = vec3(ccSrc.min, -6.4, -5.8, zMin - 4.5);
    const mx = vec3(ccSrc.max, 6.4, 7.0, zMax + 4.5);
    crankcase = {
      min: mn, max: mx,
      center: vecOr(ccSrc.center, new THREE.Vector3().addVectors(mn, mx).multiplyScalar(0.5)),
      topY: num(ccSrc.topY, mx.y),
      sealed: ccSrc.sealed !== undefined ? !!ccSrc.sealed : twoStroke,
    };
  } else if (twoStroke) {
    const mn = new THREE.Vector3(-6.4, -5.8, zMid - 4.5);
    const mx = new THREE.Vector3(6.4, 7.0, zMid + 4.5);
    crankcase = { min: mn, max: mx,
      center: new THREE.Vector3().addVectors(mn, mx).multiplyScalar(0.5),
      topY: mx.y, sealed: true };
  }

  /* ── наддув ── */
  const turboCenter = vecOr(a.turboCenter, new THREE.Vector3(...L.TURBO_POS));
  const turboInlet = vecOr(a.turboInlet, turboCenter.clone().add(new THREE.Vector3(0, 2.2, 1.5)));
  const turboOutlet = vecOr(a.turboOutlet, turboCenter.clone().add(new THREE.Vector3(0, 2.2, -1.5)));
  const icb = a.intercoolerBox || null;
  const intercooler = icb
    ? {
        center: vecOr(icb.center, new THREE.Vector3(...L.INTERCOOLER_POS)),
        in: vecOr(icb.in, new THREE.Vector3(...L.INTERCOOLER_POS).add(new THREE.Vector3(5.2, 0, 0))),
        out: vecOr(icb.out, new THREE.Vector3(...L.INTERCOOLER_POS).add(new THREE.Vector3(-5.2, 0, 0))),
        enabled: icb.enabled !== false,
      }
    : {
        center: new THREE.Vector3(...L.INTERCOOLER_POS),
        in: new THREE.Vector3(...L.INTERCOOLER_POS).add(new THREE.Vector3(5.2, 0, 0)),
        out: new THREE.Vector3(...L.INTERCOOLER_POS).add(new THREE.Vector3(-5.2, 0, 0)),
        enabled: true,
      };
  const plenum = vecOr(a.plenum, new THREE.Vector3(0, deckY + 9.5, zMid));

  return {
    eps, deckY, cylinders, count: cylinders.length, zMin, zMax, zMid,
    layout: a.layout || (cylinders.length === 8 ? 'v8' : cylinders.length === 4 ? 'i4' : 'single'),
    twoStroke, cycleDeg: num(a.cycleDeg, twoStroke ? 360 : 720),
    intakePortEnd, exhaustPortEnd, injectorTip, sparkTip, crankCenter,
    jacket: { min: jmin, max: jmax },
    portsExhaust, portsTransfer, crankcase,
    turboCenter, turboInlet, turboOutlet, intercooler, plenum,
    turboOn: a.turbo !== undefined ? !!a.turbo : true,
  };
}

/** Высота днища поршня цилиндра i (вдоль оси своего ряда). */
function crownOf(A, i, frame) {
  const c = A.cylinders[i];
  if (typeof c.crownY === 'function') {
    const v = c.crownY(frame);
    if (Number.isFinite(v)) return v;
  } else if (Number.isFinite(c.crownY)) {
    return c.crownY;
  }
  const cf = (frame && frame.cyl && frame.cyl[i]) || null;
  const frac = clamp(num(cf && cf.pistonFrac, 0), 0, 1);
  return PIN_Y_TDC - frac * L.STROKE_U + L.PISTON_TOP_OFF;
}

/** Доля открытия окна: сначала спрашиваем механизм, иначе берём подъём из кадра. */
function portOpen(rec, frame, fallback) {
  if (rec && typeof rec.openFrac === 'function') {
    const v = rec.openFrac(frame);
    if (Number.isFinite(v)) return clamp(v, 0, 1);
  }
  return clamp(num(fallback, 0), 0, 1);
}

/* ─────────────────────────── пути потока ─────────────────────────── */

/**
 * Путь: сглаживаем ломаную сплайном и раскладываем в Float32Array.
 * Готовая выборка нужна, чтобы в кадре двигать сотни частиц без аллокаций.
 * closed = false — односторонний тракт (наддув, продувка): частица,
 * дойдя до конца, рождается заново в начале, кромки гасим прозрачностью.
 */
function makePath(points, segs = 160, closed = true) {
  const pts = [];
  for (const p of points || []) {
    if (!isVec(p)) continue;
    const prev = pts[pts.length - 1];
    if (prev && prev.distanceToSquared(p) < 1e-6) continue;
    pts.push(p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z));
  }
  if (pts.length === 0) pts.push(new THREE.Vector3());
  while (pts.length < 3) {                       // CatmullRom требует минимум три точки
    const last = pts[pts.length - 1];
    pts.push(last.clone().add(new THREE.Vector3(0.4, 0.4, 0)));
  }
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', 0.3);
  const arr = new Float32Array((segs + 1) * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, v);
    arr[i * 3] = num(v.x, 0); arr[i * 3 + 1] = num(v.y, 0); arr[i * 3 + 2] = num(v.z, 0);
  }
  return { arr, segs, curve, open: !closed };
}

/** Точка пути по параметру u (зацикленному). */
function pathPoint(p, u, out) {
  let t = u - Math.floor(u);
  if (!Number.isFinite(t)) t = 0;
  const f = t * p.segs;
  let i = Math.floor(f);
  if (i >= p.segs) i = p.segs - 1;
  if (i < 0) i = 0;
  const k = f - i;
  const i0 = i * 3, i1 = i0 + 3;
  out.x = lerp(p.arr[i0], p.arr[i1], k);
  out.y = lerp(p.arr[i0 + 1], p.arr[i1 + 1], k);
  out.z = lerp(p.arr[i0 + 2], p.arr[i1 + 2], k);
  return out;
}

/** Ближайший к точке параметр u вдоль пути (нужен, чтобы найти интеркулер на трассе). */
function pathU(p, target) {
  let best = 0, bd = Infinity;
  for (let i = 0; i <= p.segs; i++) {
    const i3 = i * 3;
    const dx = p.arr[i3] - target.x, dy = p.arr[i3 + 1] - target.y, dz = p.arr[i3 + 2] - target.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best / p.segs;
}

/** Прозрачность у кромок одностороннего тракта — чтобы перерождение не било по глазам. */
function edgeFade(p, u) {
  if (!p.open) return 1;
  return clamp(Math.min(u / 0.07, (1 - u) / 0.1), 0, 1);
}

const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Единичная касательная пути в точке u. */
function pathTangent(p, u, out) {
  pathPoint(p, u, _pa);
  pathPoint(p, Math.min(u + 0.01, 0.999), _pb);
  out.subVectors(_pb, _pa);
  if (out.lengthSq() < 1e-9) out.set(0, 1, 0);
  return out.normalize();
}

/* ─────────────────────────── пулы частиц ─────────────────────────── */

/** Общая часть: THREE.Points с позициями и цветами (яркость = «время жизни»). */
function makePoints(n, size, blending, opacity) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pos[i * 3 + 1] = HIDE;
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size, vertexColors: true, transparent: true, opacity,
    depthWrite: false, blending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { pts, geo, mat, pos, col, n };
}

/** Пул «свободных» частиц (топливо, дым): скорость + затухание. */
function makeSpray(n, size, opacity) {
  const s = makePoints(n, size, THREE.AdditiveBlending, opacity);
  s.vx = new Float32Array(n); s.vy = new Float32Array(n); s.vz = new Float32Array(n);
  s.life = new Float32Array(n); s.rate = new Float32Array(n);
  s.cr = new Float32Array(n); s.cg = new Float32Array(n); s.cb = new Float32Array(n);
  s.next = 0;
  return s;
}

/** Рождение частиц струи. */
function spawn(s, count, ox, oy, oz, vx, vy, vz, spread, fade, color, jitter) {
  if (!s || !Number.isFinite(ox + oy + oz + vx + vy + vz)) return;
  for (let k = 0; k < count; k++) {
    const i = s.next; s.next = (s.next + 1) % s.n;
    const i3 = i * 3;
    s.pos[i3] = ox + rnd(jitter);
    s.pos[i3 + 1] = oy + rnd(jitter);
    s.pos[i3 + 2] = oz + rnd(jitter);
    s.vx[i] = vx + rnd(spread); s.vy[i] = vy + rnd(spread); s.vz[i] = vz + rnd(spread);
    s.life[i] = 1;
    s.rate[i] = fade * (0.8 + Math.random() * 0.4);
    s.cr[i] = color.r; s.cg[i] = color.g; s.cb[i] = color.b;
  }
}

/** Интегрирование струи: гравитация + вязкое торможение. */
function stepSpray(s, dt, gravity, drag) {
  const k = Math.exp(-drag * dt);
  for (let i = 0; i < s.n; i++) {
    const i3 = i * 3;
    if (s.life[i] <= 0) { s.col[i3] = s.col[i3 + 1] = s.col[i3 + 2] = 0; continue; }
    s.life[i] -= dt * s.rate[i];
    if (s.life[i] <= 0) {
      s.life[i] = 0; s.pos[i3 + 1] = HIDE;
      s.col[i3] = s.col[i3 + 1] = s.col[i3 + 2] = 0;
      continue;
    }
    s.vy[i] += gravity * dt;
    s.vx[i] *= k; s.vy[i] *= k; s.vz[i] *= k;
    s.pos[i3] += s.vx[i] * dt;
    s.pos[i3 + 1] += s.vy[i] * dt;
    s.pos[i3 + 2] += s.vz[i] * dt;
    const a = s.life[i];
    s.col[i3] = s.cr[i] * a; s.col[i3 + 1] = s.cg[i] * a; s.col[i3 + 2] = s.cb[i] * a;
  }
  s.geo.attributes.position.needsUpdate = true;
  s.geo.attributes.color.needsUpdate = true;
}

/** Пул «текущих по контуру» частиц (масло, антифриз, наддув): параметр u вдоль пути. */
function makeFlow(n, size, opacity, blending) {
  const s = makePoints(n, size, blending || THREE.AdditiveBlending, opacity);
  s.u = new Float32Array(n);
  s.path = new Int16Array(n);
  s.spd = new Float32Array(n);
  s.jx = new Float32Array(n); s.jy = new Float32Array(n); s.jz = new Float32Array(n);
  s.a = new Float32Array(n);                                  // яркость (пульсация потока)
  s.cr = new Float32Array(n); s.cg = new Float32Array(n); s.cb = new Float32Array(n);
  return s;
}

/** Разложить частицы пула равномерно по списку путей. */
function assignFlow(s, paths, jitter) {
  const np = Math.max(paths.length, 1);
  for (let i = 0; i < s.n; i++) {
    s.path[i] = i % np;
    s.u[i] = Math.random();
    s.spd[i] = 0.75 + Math.random() * 0.5;
    s.jx[i] = rnd(jitter); s.jy[i] = rnd(jitter); s.jz[i] = rnd(jitter);
    s.a[i] = 1;
  }
}

/** То же, но с весами: часть частиц уходит в «короткое замыкание», часть — в петлю. */
function assignFlowWeighted(s, paths, weights, jitter) {
  const np = Math.max(paths.length, 1);
  let sum = 0;
  for (let k = 0; k < np; k++) sum += Math.max(0, num(weights[k], 1));
  if (sum <= 0) return assignFlow(s, paths, jitter);
  let i = 0;
  for (let k = 0; k < np && i < s.n; k++) {
    const share = k === np - 1 ? s.n - i
      : Math.min(s.n - i, Math.round((s.n * Math.max(0, num(weights[k], 1))) / sum));
    for (let j = 0; j < share && i < s.n; j++, i++) {
      s.path[i] = k;
      s.u[i] = Math.random();
      s.spd[i] = 0.75 + Math.random() * 0.5;
      s.jx[i] = rnd(jitter); s.jy[i] = rnd(jitter); s.jz[i] = rnd(jitter);
      s.a[i] = 1;
    }
  }
  for (; i < s.n; i++) { s.path[i] = np - 1; s.u[i] = Math.random(); s.spd[i] = 1; s.a[i] = 1; }
}

/* ═══════════════════════════ основной класс ═══════════════════════════ */

class Fluids {
  constructor(anchors, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'fluids';
    this.opts = Object.assign({ cylinders: 1, eps: 10 }, opts || {});
    this.vis = {
      gas: true, fuel: true, oil: true, coolant: true, exhaust: true, flame: true,
      boost: true, turbine: true, scavenge: true,
    };
    this.time = 0;
    this._disposables = new Set();
    this._tmp = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._col = new THREE.Color();
    this._colA = new THREE.Color();
    this._colB = new THREE.Color();
    this._build(anchors);
  }

  /* ───────────────── сборка ───────────────── */

  _reg(x) { if (x) this._disposables.add(x); return x; }

  _build(anchors) {
    const A = normalizeAnchors(anchors, this.opts);
    this.A = A;
    this.n = A.count;

    this.gGas = new THREE.Group();
    this.gFlame = new THREE.Group();
    this.gFuel = new THREE.Group();
    this.gExh = new THREE.Group();
    this.gOil = new THREE.Group();
    this.gCool = new THREE.Group();
    this.gBoost = new THREE.Group();
    this.gTurb = new THREE.Group();
    this.gScav = new THREE.Group();
    this.gGas.name = 'gas'; this.gFlame.name = 'flame'; this.gFuel.name = 'fuel';
    this.gExh.name = 'exhaust'; this.gOil.name = 'oil'; this.gCool.name = 'coolant';
    this.gBoost.name = 'boost'; this.gTurb.name = 'turbine'; this.gScav.name = 'scavenge';
    this.group.add(this.gGas, this.gFlame, this.gFuel, this.gExh, this.gOil, this.gCool,
                   this.gBoost, this.gTurb, this.gScav);

    this._buildGas(A);
    this._buildFlame(A);
    this._buildFuel(A);
    this._buildExhaust(A);
    this._buildOil(A);
    this._buildCoolant(A);
    this._buildBoost(A);
    this._buildTurbine(A);
    this._buildScavenge(A);

    // состояние по цилиндрам
    this.knockT = new Float32Array(this.n);
    this.fuelAcc = new Float32Array(this.n);
    this.exhAcc = new Float32Array(this.n);
    this.turbI = new Float32Array(this.n);      // сглаженная интенсивность на турбину
    this.turbT = new Float32Array(this.n).fill(700);
    this.scavGate = 0; this.exhGate = 0;        // сглаженные доли открытия окон
    this._applyVisible();
  }

  /** 1. Газ в цилиндре — объём от днища поршня до головки, вдоль оси своего ряда. */
  _buildGas(A) {
    const geo = this._reg(new THREE.CylinderGeometry(L.BORE_R - 0.15, L.BORE_R - 0.15, 1, 32));
    this.gasMesh = [];
    this.gasMat = [];
    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const mat = this._reg(new THREE.MeshBasicMaterial({
        color: COL.mix.clone(), transparent: true, opacity: 0, depthWrite: false,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.rotation.z = -c.tilt;                       // ось объёма совпадает с осью цилиндра
      m.position.copy(c.axis).multiplyScalar(A.deckY - 1);
      m.position.z = c.z;
      m.renderOrder = 2;
      this.gGas.add(m);
      this.gasMesh.push(m); this.gasMat.push(mat);
    }
  }

  /** 4. Пламя (свечение по xb) и детонация (вспышка + ударная волна). */
  _buildFlame(A) {
    const sph = this._reg(new THREE.SphereGeometry(1, 16, 12));
    const ring = this._reg(new THREE.TorusGeometry(1, 0.055, 8, 40));
    this.flame = [];
    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const mk = (color, op) => {
        const mat = this._reg(new THREE.MeshBasicMaterial({
          color: color.clone(), transparent: true, opacity: op,
          depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        const m = new THREE.Mesh(sph, mat);
        m.visible = false; m.renderOrder = 3;
        this.gFlame.add(m);
        return m;
      };
      const front = mk(COL.fire, 0);       // фронт пламени
      const core = mk(COL.white, 0);       // ядро (яркая зона по температуре)
      const flash = mk(COL.white, 0);      // вспышка детонации

      const rings = [];
      for (let k = 0; k < 2; k++) {
        const mat = this._reg(new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xfff4d8), transparent: true, opacity: 0,
          depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
        const m = new THREE.Mesh(ring, mat);
        /* кольцо ударной волны лежит поперёк оси цилиндра (у V8 — наклонно) */
        m.rotation.set(-Math.PI / 2, 0, 0);
        m.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -c.tilt);
        m.visible = false; m.renderOrder = 4;
        this.gFlame.add(m);
        rings.push(m);
      }
      this.flame.push({ front, core, flash, rings, axis: c.axis, z: c.z, tilt: c.tilt });
    }
  }

  /** 2. Впрыск топлива. */
  _buildFuel(A) {
    this.fuel = makeSpray(BUDGET.fuel, 0.28, 0.95);
    this._reg(this.fuel.geo); this._reg(this.fuel.mat);
    this.gFuel.add(this.fuel.pts);
  }

  /** 3. Выхлопные газы. */
  _buildExhaust(A) {
    this.exh = makeSpray(BUDGET.exhaust, 0.52, 0.8);
    this._reg(this.exh.geo); this._reg(this.exh.mat);
    this.gExh.add(this.exh.pts);
  }

  /** 5. Масляный контур: насос → канал → коренная → шатунная шейка → стенка → поддон. */
  _buildOil(A) {
    const paths = [];
    const tubeMat = this._reg(new THREE.MeshBasicMaterial({
      color: 0x7a5418, transparent: true, opacity: 0.28,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const sumpY = L.SUMP_Y;
    const cc = A.crankCenter;

    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const z = c.z, t = c.tilt;
      const pts = [
        new THREE.Vector3(0, sumpY + 0.35, z),                          // маслоприёмник в поддоне
        new THREE.Vector3(-3.2, sumpY + 0.9, z),                        // насос
        new THREE.Vector3(-5.2, -3.2, z),                               // магистраль в блоке
        new THREE.Vector3(cc.x - 1.9, cc.y + 0.3, z),                   // коренная шейка
        bVec(0.4, L.CRANK_R * 0.9, z, t),                               // шатунная шейка ряда
        bVec(-L.BORE_R * 0.55, 9.4, z, t),                              // разбрызгивание вверх
        bVec(-L.BORE_R * 0.9, 13.8, z, t),                              // масло на стенке цилиндра
        bVec(L.BORE_R * 0.9, 12.2, z, t),                               // снимается кольцом
        bVec(L.BORE_R * 0.9 + 0.6, 3.0, z, t),                          // стекание вдоль ряда
        new THREE.Vector3(3.2, sumpY + 0.5, z),                         // возврат в поддон
      ];
      const p = makePath(pts, 180);
      paths.push(p);
      const tube = new THREE.Mesh(
        this._reg(new THREE.TubeGeometry(p.curve, 90, 0.1, 5, true)), tubeMat,
      );
      tube.renderOrder = 1;
      this.gOil.add(tube);
    }
    this.oilPaths = paths;

    this.oil = makeFlow(BUDGET.oil, 0.3, 0.95);
    this._reg(this.oil.geo); this._reg(this.oil.mat);
    assignFlow(this.oil, paths, 0.5);
    this.gOil.add(this.oil.pts);

    // стрелки направления потока
    this.oilArrows = this._makeArrows(this.gOil, paths, 4, 0xffc061, 0.22, 0.62);

    // уровень масла в поддоне
    const half = Math.max(3.2, (A.zMax - A.zMin) / 2 + 3.2);
    const sumpGeo = this._reg(new THREE.BoxGeometry(11, 0.35, half * 2));
    const sumpMat = this._reg(new THREE.MeshBasicMaterial({
      color: 0x8a5a18, transparent: true, opacity: 0.45, depthWrite: false,
    }));
    const sump = new THREE.Mesh(sumpGeo, sumpMat);
    sump.position.set(0, sumpY, (A.zMin + A.zMax) / 2);
    this.gOil.add(sump);
    this.sumpMat = sumpMat;
  }

  /** 6. Рубашка охлаждения: спираль вокруг каждого цилиндра + контур к радиатору. */
  _buildCoolant(A) {
    const R = L.BORE_R + L.JACKET_GAP * 0.75;
    const yBot = WALL_BOT_Y + 0.6;                 // низ гильзы в системе ряда
    const yTop = A.deckY - 0.4;
    const paths = [];

    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const z = c.z, t = c.tilt;
      const pts = [];
      const turns = 1.5, steps = 18;
      for (let k = 0; k <= steps; k++) {         // подъём по спирали вокруг гильзы
        const s = k / steps;
        const ang = s * TAU * turns;
        pts.push(bVec(Math.cos(ang) * R, lerp(yBot, yTop, s), z + Math.sin(ang) * R * 0.85, t));
      }
      // возврат вниз по внешней стороне блока (замыкание контура рубашки)
      pts.push(bVec(R + 1.1, yTop - 1.0, z + R * 0.4, t));
      pts.push(bVec(R + 1.4, lerp(yBot, yTop, 0.5), z, t));
      pts.push(bVec(R + 1.1, yBot + 0.4, z - R * 0.4, t));
      paths.push(makePath(pts, 200));

      // полупрозрачная оболочка рубашки
      const shell = new THREE.Mesh(
        this._reg(new THREE.CylinderGeometry(R + 0.35, R + 0.35, yTop - yBot, 24, 1, true)),
        this._reg(new THREE.MeshBasicMaterial({
          color: 0x2f7fe0, transparent: true, opacity: 0.07,
          depthWrite: false, side: THREE.DoubleSide,
        })),
      );
      shell.rotation.z = -t;
      shell.position.copy(c.axis).multiplyScalar((yBot + yTop) / 2);
      shell.position.z = z;
      this.gCool.add(shell);
    }

    // главный контур: выход из головки → радиатор → насос → низ рубашки
    const topY = A.jacket.max.y, jy = A.jacket.min.y;
    const zF = A.zMax + 3.0, zB = A.zMin - 3.0;
    const main = makePath([
      new THREE.Vector3(2.2, topY + 0.9, zF),
      new THREE.Vector3(1.2, topY + 1.9, zF + 5),
      new THREE.Vector3(0.0, topY - 1.0, zF + 10),     // верхний бачок радиатора
      new THREE.Vector3(0.0, jy + 1.0, zF + 10),       // нижний бачок радиатора
      new THREE.Vector3(-2.0, jy - 0.5, zF + 5),
      new THREE.Vector3(-3.2, jy - 1.4, zB - 1),       // насос
      new THREE.Vector3(-3.6, topY - 6.0, zB - 1),     // подъём по стенке блока
      new THREE.Vector3(-2.6, topY + 0.7, zB),
      new THREE.Vector3(0.0, topY + 1.1, (zB + zF) / 2),
    ], 220);
    this.coolMainIndex = paths.length;
    paths.push(main);
    const mainTube = new THREE.Mesh(
      this._reg(new THREE.TubeGeometry(main.curve, 110, 0.13, 5, true)),
      this._reg(new THREE.MeshBasicMaterial({
        color: 0x2a5a9a, transparent: true, opacity: 0.3,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })),
    );
    this.gCool.add(mainTube);

    this.coolPaths = paths;
    this.coolYBot = yBot; this.coolYTop = yTop;

    this.cool = makeFlow(BUDGET.coolant, 0.26, 0.9);
    this._reg(this.cool.geo); this._reg(this.cool.mat);
    assignFlow(this.cool, paths, 0.28);
    this.gCool.add(this.cool.pts);

    this.coolArrows = this._makeArrows(this.gCool, paths, 4, 0x9fd0ff, 0.2, 0.56);
  }

  /**
   * 7. Наддув: компрессор → (интеркулер) → впускной ресивер → патрубки цилиндров.
   * Тракт односторонний, поэтому пути открытые: частица гаснет у конца и
   * рождается в начале. Точка интеркулера на трассе запоминается — по ней
   * переключается цвет с «горячего» на «охлаждённый».
   */
  _buildBoost(A) {
    const paths = [];
    const out = A.turboOutlet.clone();
    const ic = A.intercooler;
    /* у двухтактного роль впускного ресивера играет кривошипная камера */
    const charge = (A.twoStroke && A.crankcase)
      ? A.crankcase.center.clone().setX(A.crankcase.min.x - 1.2)
      : A.plenum.clone();

    const mainPts = [out, out.clone().add(new THREE.Vector3(0, 2.0, -0.6))];
    if (ic && ic.enabled) {
      mainPts.push(ic.in.clone().add(new THREE.Vector3(1.0, 0, 0)));
      mainPts.push(ic.in.clone());
      mainPts.push(ic.center.clone());
      mainPts.push(ic.out.clone());
      mainPts.push(ic.out.clone().add(new THREE.Vector3(-1.2, 0.4, 0)));
    }
    mainPts.push(charge.clone().add(new THREE.Vector3(0, -1.6, 0)));
    mainPts.push(charge.clone());
    const main = makePath(mainPts, 200, false);
    /* где на трассе стоит интеркулер (для смены цвета заряда) */
    main.icU = (ic && ic.enabled) ? pathU(main, ic.out) : 0;
    paths.push(main);
    this.boostMain = main;

    /* раздача из ресивера по цилиндрам — у V8 наглядно видно оба ряда */
    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const end = c.intakePortEnd.clone();
      const mid = charge.clone().lerp(end, 0.55).add(new THREE.Vector3(0, 0.8, 0));
      const p = makePath([charge.clone(), mid, end.clone().add(new THREE.Vector3(0, 0.6, 0)), end],
                         90, false);
      p.icU = 0;
      paths.push(p);
    }
    this.boostPaths = paths;

    this.boost = makeFlow(BUDGET.boost, 0.3, 0.9);
    this._reg(this.boost.geo); this._reg(this.boost.mat);
    /* половина частиц — на магистраль от компрессора, половина — на раздачу */
    const w = paths.map((p, k) => (k === 0 ? Math.max(2, A.count) : 1));
    assignFlowWeighted(this.boost, paths, w, 0.3);
    this.gBoost.add(this.boost.pts);

    this.boostArrows = this._makeArrows(this.gBoost, [main], 5, 0x9fd0ff, 0.26, 0.7);
  }

  /**
   * 8. Струя выхлопа на турбину: из выпускного канала (или выпускного окна
   * у двухтактного) в горячую улитку и по спирали вокруг колеса турбины.
   * Каждая частица «заряжается» яркостью в момент перерождения — так видны
   * отдельные импульсы от каждого цилиндра.
   */
  _buildTurbine(A) {
    const paths = [];
    const inlet = A.turboInlet.clone();
    const cen = A.turboCenter.clone();
    const spiral = [];
    const r0 = 2.6, r1 = 1.35;
    for (let k = 0; k <= 14; k++) {                 // полтора витка вокруг колеса
      const s = k / 14;
      const ang = Math.atan2(inlet.y - cen.y, inlet.x - cen.x) + s * TAU * 1.5;
      const r = lerp(r0, r1, s);
      spiral.push(new THREE.Vector3(cen.x + Math.cos(ang) * r,
                                    cen.y + Math.sin(ang) * r,
                                    lerp(inlet.z, cen.z + 1.5, s)));
    }
    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const src = (A.twoStroke && A.portsExhaust[0])
        ? A.portsExhaust[0].pos.clone()
        : c.exhaustPortEnd.clone();
      const mid = src.clone().lerp(inlet, 0.55).add(new THREE.Vector3(0.6, -0.8, 0));
      const pts = [src, mid, inlet.clone(), ...spiral.map((p) => p.clone())];
      paths.push(makePath(pts, 150, false));
    }
    this.turbPaths = paths;

    this.turb = makeFlow(BUDGET.turbine, 0.34, 0.85);
    this._reg(this.turb.geo); this._reg(this.turb.mat);
    assignFlow(this.turb, paths, 0.28);
    this.gTurb.add(this.turb.pts);
  }

  /**
   * 9. Двухтактная продувка. Три семейства путей:
   *   loop  — свежая смесь из картера через продувочное окно вверх, петлевой
   *           разворот по Шнюрле под головкой и вниз в выпускное окно;
   *   short — короткое замыкание: часть смеси уходит из продувочного окна
   *           прямо в выпускное, не сделав работы;
   *   burnt — вытесняемые отработавшие газы из камеры в выпускное окно.
   * Плюс полупрозрачный объём смеси в кривошипной камере (сжимается по crankcaseFrac).
   */
  _buildScavenge(A) {
    this.scavPaths = [];
    this.scavRole = [];
    this.scav = null;
    this.ccMesh = null;
    if (!A.twoStroke || !A.portsExhaust.length || !A.portsTransfer.length) return;

    const ex = A.portsExhaust[0];
    const c = A.cylinders[ex.cyl] || A.cylinders[0];
    const z = c.z, t = c.tilt;
    const deck = A.deckY;
    const ccC = A.crankcase ? A.crankcase.center.clone() : new THREE.Vector3(0, 0, z);
    const exOut = ex.pos.clone().addScaledVector(ex.dir, 5.5).add(new THREE.Vector3(0, 1.0, 0));

    const paths = [], roles = [], weights = [];
    for (const tr of A.portsTransfer) {
      const R = L.BORE_R + 1.45;
      const ductBot = bVec(tr.dx * R, WALL_BOT_Y - 2.6, tr.z + tr.dz * R, t);
      /* петлевая продувка: вверх по своей стенке, разворот у головки, вниз к выпуску */
      const loop = [
        ccC.clone(),
        ccC.clone().lerp(ductBot, 0.7),
        ductBot,
        tr.pos.clone(),
        tr.inner.clone(),
        bVec(tr.dx * L.BORE_R * 0.72, lerp(tr.mid, deck, 0.45), tr.z + tr.dz * L.BORE_R * 0.72, t),
        bVec(tr.dx * L.BORE_R * 0.34, deck - 1.5, tr.z + tr.dz * L.BORE_R * 0.34, t),
        bVec(0, deck - 0.9, tr.z, t),                                   // разворот под головкой
        bVec(ex.dx * L.BORE_R * 0.5, deck - 2.2, ex.z + ex.dz * L.BORE_R * 0.5, t),
        bVec(ex.dx * L.BORE_R * 0.8, lerp(deck, ex.mid, 0.75), ex.z + ex.dz * L.BORE_R * 0.8, t),
        ex.inner.clone(),
        ex.pos.clone(),
        exOut.clone(),
      ];
      paths.push(makePath(loop, 220, false)); roles.push(0); weights.push(3.0);

      /* короткое замыкание: из продувочного окна поперёк — сразу в выпускное */
      const short = [
        tr.inner.clone(),
        bVec(tr.dx * L.BORE_R * 0.45, tr.mid + 0.6, tr.z + tr.dz * L.BORE_R * 0.45, t),
        bVec(ex.dx * L.BORE_R * 0.4, ex.mid + 0.4, ex.z + ex.dz * L.BORE_R * 0.4, t),
        ex.inner.clone(),
        ex.pos.clone(),
        exOut.clone(),
      ];
      paths.push(makePath(short, 120, false)); roles.push(1); weights.push(1.1);
    }

    /* вытеснение выхлопа из камеры */
    const burnt = [
      bVec(0, lerp(deck, ex.topY, 0.35), z, t),
      bVec(ex.dx * L.BORE_R * 0.45, lerp(deck, ex.mid, 0.7), ex.z + ex.dz * L.BORE_R * 0.45, t),
      ex.inner.clone(),
      ex.pos.clone(),
      exOut.clone(),
    ];
    paths.push(makePath(burnt, 130, false)); roles.push(2); weights.push(2.2);

    this.scavPaths = paths;
    this.scavRole = roles;
    this.scav = makeFlow(BUDGET.scavenge, 0.32, 0.9);
    this._reg(this.scav.geo); this._reg(this.scav.mat);
    assignFlowWeighted(this.scav, paths, weights, 0.26);
    this.gScav.add(this.scav.pts);

    /* объём смеси в кривошипной камере */
    if (A.crankcase) {
      const R = Math.max(1.6, (A.crankcase.max.x - A.crankcase.min.x) / 2 - 0.45);
      const len = Math.max(2.0, (A.crankcase.max.z - A.crankcase.min.z) - 0.9);
      const geo = this._reg(new THREE.CylinderGeometry(1, 1, 1, 26, 1));
      const mat = this._reg(new THREE.MeshBasicMaterial({
        color: COL.fresh.clone(), transparent: true, opacity: 0.14, depthWrite: false,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = Math.PI / 2;                 // ось камеры — вдоль коленвала
      m.position.copy(A.crankcase.center);
      m.renderOrder = 2;
      this.gScav.add(m);
      this.ccMesh = m; this.ccMat = mat; this.ccR = R; this.ccLen = len;
    }
  }

  /** Анимированные стрелки-конусы вдоль путей. */
  _makeArrows(parent, paths, perPath, color, r, h) {
    const geo = this._reg(new THREE.ConeGeometry(r, h, 8));
    const mat = this._reg(new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const list = [];
    for (let p = 0; p < paths.length; p++) {
      for (let k = 0; k < perPath; k++) {
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = 3;
        parent.add(m);
        list.push({ mesh: m, path: paths[p], u: k / perPath });
      }
    }
    return list;
  }

  /* ───────────────── кадр ───────────────── */

  update(frame, dt) {
    const f = frame || {};
    const step = clamp(num(dt, 0.016), 0, 0.05);
    this.time += step;

    const rpm = clamp(num(f.rpm, 800), 0, 12000);
    const rpmF = clamp(rpm / 6000, 0, 1.2);
    const diesel = f.fuelMode === 'diesel';
    const twoStroke = f.twoStroke !== undefined ? !!f.twoStroke : this.A.twoStroke;
    const cyls = Array.isArray(f.cyl) ? f.cyl : [];

    let Tmax = 0;
    for (let i = 0; i < this.n; i++) Tmax = Math.max(Tmax, num(cyls[i] && cyls[i].T_K, 300));

    for (let i = 0; i < this.n; i++) {
      const c = cyls[i] || {};
      const st = {
        stroke: clamp(Math.round(num(c.stroke, 0)), 0, 3),
        deg: num(c.deg, 0),
        xb: clamp(num(c.xb, 0), 0, 1),
        T: clamp(num(c.T_K, 300), 0, 4000),
        p: clamp(num(c.p_bar, 1), 0, 250),
        liftIn: clamp(num(c.liftIn, 0), 0, 1),
        liftEx: clamp(num(c.liftEx, 0), 0, 1),
        crown: crownOf(this.A, i, f),
        twoStroke,
      };
      if (!Number.isFinite(st.crown)) st.crown = this.A.deckY - 1;

      this._updateGas(i, st, f, step);
      this._updateFlame(i, st, f, step);
      if (this.vis.fuel && !twoStroke) this._updateFuel(i, st, diesel, rpmF, step);
      if (this.vis.exhaust && !twoStroke) this._updateExhaust(i, st, rpmF, step);
    }

    if (this.vis.fuel) stepSpray(this.fuel, step, -2.5, 2.6);
    if (this.vis.exhaust) stepSpray(this.exh, step, 1.2, 1.5);
    if (this.vis.oil) this._updateOil(step, rpmF);
    if (this.vis.coolant) this._updateCoolant(step, rpmF, Tmax);
    this._updateBoost(f, step, rpmF);
    this._updateTurbine(f, step, rpmF, cyls, twoStroke);
    this._updateScavenge(f, step, rpmF, cyls, twoStroke);
  }

  /** Газ: высота объёма и цвет по фазе цикла (у двухтактного своя раскладка). */
  _updateGas(i, st, f, dt) {
    const mesh = this.gasMesh[i], mat = this.gasMat[i];
    const c = this.A.cylinders[i];
    const h = Math.max(this.A.deckY - st.crown, 0.05);
    mesh.scale.y = h;
    mesh.position.copy(c.axis).multiplyScalar(st.crown + h / 2);
    mesh.position.z = c.z;
    if (!this.vis.gas) return;

    const col = this._col;
    let op;
    if (st.xb > 0.02) {
      // горение: фиолетовый → оранжевый по доле сгоревшего, добела по температуре
      col.copy(COL.comp).lerp(COL.fire, Math.min(st.xb * 1.7, 1));
      const hot = clamp((st.T - 1500) / 1300, 0, 1);
      col.lerp(COL.white, hot * Math.min(st.xb * 1.4, 1) * 0.85);
      op = 0.34 + 0.42 * st.xb;
    } else if (st.twoStroke) {
      /* цикл 360°: 0…~104° расширение, ~104…256° продувка, дальше сжатие */
      const exOpen = portOpen(this.A.portsExhaust[0], f, st.liftEx);
      const trOpen = portOpen(this.A.portsTransfer[0], f, st.liftIn);
      if (exOpen > 0.02) {
        col.copy(COL.exh).lerp(COL.fresh, clamp(trOpen * 0.85, 0, 0.8));
        op = 0.34 - 0.16 * exOpen;
      } else {
        const k = clamp((st.deg - 256) / 104, 0, 1);
        col.copy(COL.mix).lerp(COL.comp, k);
        op = 0.26 + 0.26 * k;
      }
    } else if (st.stroke === 0) {
      col.copy(COL.mix);
      op = 0.10 + 0.18 * clamp((st.deg % 180) / 180, 0, 1);
    } else if (st.stroke === 1) {
      const k = clamp((st.deg - 180) / 180, 0, 1);
      col.copy(COL.mix).lerp(COL.comp, k);
      op = 0.28 + 0.25 * k;
    } else if (st.stroke === 2) {
      const k = clamp((st.deg - 360) / 180, 0, 1);
      col.copy(COL.fire).lerp(COL.exh, k);
      op = 0.50 - 0.20 * k;
    } else {
      const k = clamp((st.deg - 540) / 180, 0, 1);
      col.copy(COL.exh);
      op = 0.30 * (1 - k * 0.85);
    }
    // белая вспышка детонации подсвечивает и сам объём газа
    const kn = this.knockT[i] > 0 ? clamp(this.knockT[i] / 0.45, 0, 1) : 0;
    if (kn > 0) { col.lerp(COL.white, kn * 0.9); op = Math.min(0.95, op + 0.45 * kn); }
    mat.color.copy(col);
    mat.opacity = clamp(op, 0, 1);
  }

  /** Пламя по xb + вспышка и ударная волна при детонации. */
  _updateFlame(i, st, f, dt) {
    const fl = this.flame[i];
    const on = this.vis.gas && this.vis.flame;
    const chamberMid = (st.crown + this.A.deckY) / 2;
    const yTop = this.A.deckY - 0.5;
    const put = (m, axisY) => {
      m.position.copy(fl.axis).multiplyScalar(axisY);
      m.position.z = fl.z;
    };

    // фронт пламени растёт от свечи к стенкам
    const burning = on && st.xb > 0.01 && st.xb < 0.995;
    fl.front.visible = burning;
    fl.core.visible = burning;
    if (burning) {
      const r = L.BORE_R * (0.22 + 0.9 * Math.pow(st.xb, 0.55));
      const y = lerp(yTop, chamberMid, st.xb);
      put(fl.front, y);
      fl.front.scale.setScalar(r);
      fl.front.material.opacity = 0.22 * (1 - st.xb * 0.5) + 0.12;
      fl.front.material.color.copy(COL.fire).lerp(COL.white, clamp((st.T - 1800) / 1200, 0, 1));

      put(fl.core, y);
      fl.core.scale.setScalar(r * 0.42);
      fl.core.material.opacity = 0.35 * clamp(st.xb * 2, 0, 1);
    }

    // детонация: белая вспышка и расходящаяся ударная волна
    if (f.knockNow && this.knockT[i] <= 0 && st.xb > 0.02 && st.xb < 0.95) {
      this.knockT[i] = 0.45;
    }
    if (this.knockT[i] > 0) this.knockT[i] = Math.max(0, this.knockT[i] - dt);

    const t = this.knockT[i];
    const showKnock = on && t > 0;
    fl.flash.visible = showKnock;
    if (showKnock) {
      const a = t / 0.45;                       // 1 → 0
      put(fl.flash, chamberMid);
      fl.flash.scale.setScalar(0.5 + L.BORE_R * 0.75 * (1 - a));
      fl.flash.material.opacity = Math.pow(a, 1.6);
    }
    for (let k = 0; k < fl.rings.length; k++) {
      const r = fl.rings[k];
      const tt = t - k * 0.11;                  // вторая волна с задержкой
      const vis = on && tt > 0;
      r.visible = vis;
      if (!vis) continue;
      const a = tt / 0.45;
      const grow = (1 - a) * L.BORE_R * 1.15 + 0.4;
      put(r, chamberMid);
      r.scale.set(grow, grow, Math.max(0.6, grow * 0.55));
      r.material.opacity = Math.pow(a, 1.3) * 0.9;
    }
  }

  /** Впрыск: во впускной канал (бензин) или прямо в камеру у ВМТ (дизель). */
  _updateFuel(i, st, diesel, rpmF, dt) {
    const A = this.A, c = A.cylinders[i];
    if (diesel) {
      // дизель: впрыск в конце такта сжатия, узкий конус из форсунки в головке
      const near = st.deg > 336 && st.deg < 378;
      if (!near) return;
      this.fuelAcc[i] += dt * (140 + 200 * rpmF);
      const cnt = Math.floor(this.fuelAcc[i]);
      this.fuelAcc[i] -= cnt;
      const o = c.dieselTip;
      const ax = c.axis;
      for (let k = 0; k < cnt; k++) {
        const ang = Math.random() * TAU, spr = 0.45 + Math.random() * 0.35;
        /* конус вдоль оси цилиндра: вниз по оси + радиальный разброс */
        const rx = Math.cos(ang) * spr * 9, rz = Math.sin(ang) * spr * 9;
        spawn(this.fuel, 1, o.x, o.y, o.z,
              -ax.x * 9.5 + rx * ax.y, -ax.y * 9.5 - rx * ax.x, rz,
              1.2, 4.2, COL.diesel, 0.12);
      }
      return;
    }
    // бензин: распыл во впускном канале, пока открыт впускной клапан
    if (st.stroke !== 0 || st.liftIn < 0.05) return;
    this.fuelAcc[i] += dt * (95 + 150 * rpmF) * st.liftIn;
    const cnt = Math.floor(this.fuelAcc[i]);
    this.fuelAcc[i] -= cnt;
    if (cnt <= 0) return;
    const o = c.injectorTip, tgt = c.valveInSeat;
    const dx = tgt.x - o.x, dy = tgt.y - o.y, dz = tgt.z - o.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const v = 11 + 9 * rpmF;
    spawn(this.fuel, cnt, o.x, o.y, o.z,
          (dx / len) * v, (dy / len) * v, (dz / len) * v, 2.0, 2.4, COL.petrol, 0.35);
  }

  /** Выхлоп: дым в выпускной канал, цвет и яркость по температуре газа. */
  _updateExhaust(i, st, rpmF, dt) {
    if (st.liftEx < 0.08) return;
    const A = this.A, c = A.cylinders[i];
    this.exhAcc[i] += dt * (35 + 130 * rpmF) * st.liftEx;
    const cnt = Math.floor(this.exhAcc[i]);
    this.exhAcc[i] -= cnt;
    if (cnt <= 0) return;

    const o = c.valveExSeat, tgt = c.exhaustPortEnd;
    const dx = tgt.x - o.x, dy = tgt.y - o.y, dz = tgt.z - o.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    // в начале выпуска (высокое давление) газ вылетает резко
    const v = 6 + 10 * rpmF + clamp(st.p * 0.6, 0, 9);
    const hot = clamp((st.T - 700) / 900, 0, 1);
    this._col.copy(COL.smokeCold).lerp(COL.smokeHot, hot);
    spawn(this.exh, cnt, o.x, o.y, o.z,
          (dx / len) * v, (dy / len) * v, (dz / len) * v, 2.4, 1.3, this._col, 0.4);
  }

  /** Масло: движение по замкнутому контуру, скорость пропорциональна оборотам. */
  _updateOil(dt, rpmF) {
    const s = this.oil, paths = this.oilPaths, p3 = this._tmp;
    const base = 0.055 + 0.42 * rpmF;               // оборот контура в секунду
    for (let i = 0; i < s.n; i++) {
      const path = paths[s.path[i]];
      if (!path) continue;
      s.u[i] += dt * base * s.spd[i];
      if (s.u[i] > 1) s.u[i] -= Math.floor(s.u[i]);
      pathPoint(path, s.u[i], p3);
      const i3 = i * 3;
      s.pos[i3] = p3.x + s.jx[i];
      s.pos[i3 + 1] = p3.y + s.jy[i];
      s.pos[i3 + 2] = p3.z + s.jz[i];
      // на подаче масло светлое, на сливе — тёмное
      const u = s.u[i];
      const bright = u < 0.55 ? 1 : clamp(1.15 - (u - 0.55) * 1.1, 0.35, 1);
      s.col[i3] = lerp(COL.oilDark.r, COL.oil.r, bright) * bright;
      s.col[i3 + 1] = lerp(COL.oilDark.g, COL.oil.g, bright) * bright;
      s.col[i3 + 2] = lerp(COL.oilDark.b, COL.oil.b, bright) * bright;
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
    this._moveArrows(this.oilArrows, dt, base * 1.0);
    if (this.sumpMat) this.sumpMat.opacity = 0.4 + 0.08 * Math.sin(this.time * 2.2);
  }

  /** Антифриз: подъём по рубашке, цвет от температуры (синий внизу → красный у головки). */
  _updateCoolant(dt, rpmF, Tmax) {
    const s = this.cool, paths = this.coolPaths, p3 = this._tmp;
    const base = 0.06 + 0.34 * rpmF;
    const heat = clamp((Tmax - 500) / 1800, 0, 1);
    const yBot = this.coolYBot, yTop = this.coolYTop;
    const span = Math.max(yTop - yBot, 0.5);
    for (let i = 0; i < s.n; i++) {
      const path = paths[s.path[i]];
      if (!path) continue;
      s.u[i] += dt * base * s.spd[i];
      if (s.u[i] > 1) s.u[i] -= Math.floor(s.u[i]);
      pathPoint(path, s.u[i], p3);
      const i3 = i * 3;
      s.pos[i3] = p3.x + s.jx[i];
      s.pos[i3 + 1] = p3.y + s.jy[i];
      s.pos[i3 + 2] = p3.z + s.jz[i];
      /* «высота» считается вдоль длины контура, чтобы наклонный ряд V8
         не выглядел равномерно холодным */
      const k = clamp(Math.min(s.u[i] * 1.6, 1), 0, 1) * (0.45 + 0.55 * heat);
      s.col[i3] = lerp(COL.coolCold.r, COL.coolHot.r, k);
      s.col[i3 + 1] = lerp(COL.coolCold.g, COL.coolHot.g, k);
      s.col[i3 + 2] = lerp(COL.coolCold.b, COL.coolHot.b, k);
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
    this._moveArrows(this.coolArrows, dt, base);
  }

  /** Наддув: плотность и скорость по boostNow_bar, цвет — по температуре заряда. */
  _updateBoost(f, dt, rpmF) {
    const s = this.boost;
    if (!s) return;
    const boost = clamp(num(f.boostNow_bar, 0), 0, 3);
    const wanted = this.vis.boost && (boost > 0.015 || !!f.turbo) && this.A.turboOn !== false;
    this.gBoost.visible = !!wanted;
    if (!wanted) return;

    const inter = (f.intercooler !== undefined ? !!f.intercooler : true)
      && !!(this.A.intercooler && this.A.intercooler.enabled);
    const Tout = num(f.chargeT_K, 320);
    const Tcomp = inter ? compressorT(Math.min(Tout, 340), boost) : Tout;
    chargeColor(this._colA, Tcomp);      // до интеркулера — горячий
    chargeColor(this._colB, Tout);       // после — охлаждённый

    /* плотность потока: чем выше наддув, тем больше «воздуха» в трубе */
    const active = Math.floor(s.n * clamp(0.14 + boost / 1.6, 0.08, 1));
    const speed = 0.20 + 0.85 * boost + 0.22 * rpmF;
    const p3 = this._tmp;
    for (let i = 0; i < s.n; i++) {
      const i3 = i * 3;
      if (i >= active) {
        s.pos[i3 + 1] = HIDE;
        s.col[i3] = s.col[i3 + 1] = s.col[i3 + 2] = 0;
        continue;
      }
      const path = this.boostPaths[s.path[i]];
      if (!path) continue;
      s.u[i] += dt * speed * s.spd[i];
      if (s.u[i] > 1) s.u[i] -= Math.floor(s.u[i]);
      pathPoint(path, s.u[i], p3);
      s.pos[i3] = p3.x + s.jx[i];
      s.pos[i3 + 1] = p3.y + s.jy[i];
      s.pos[i3 + 2] = p3.z + s.jz[i];
      /* до интеркулера — горячий цвет, после — охлаждённый (переход по трассе) */
      const mix = path.icU > 0 ? clamp((s.u[i] - path.icU) / 0.08 + 0.5, 0, 1) : 1;
      const a = edgeFade(path, s.u[i]) * (0.45 + 0.55 * clamp(boost / 0.9, 0, 1));
      s.col[i3] = lerp(this._colA.r, this._colB.r, mix) * a;
      s.col[i3 + 1] = lerp(this._colA.g, this._colB.g, mix) * a;
      s.col[i3 + 2] = lerp(this._colA.b, this._colB.b, mix) * a;
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
    this._moveArrows(this.boostArrows, dt, speed * 0.9);
  }

  /** Струя выхлопа на турбину: интенсивность по подъёму выпускного клапана и температуре. */
  _updateTurbine(f, dt, rpmF, cyls, twoStroke) {
    const s = this.turb;
    if (!s) return;
    const boost = clamp(num(f.boostNow_bar, 0), 0, 3);
    const wanted = this.vis.exhaust && this.vis.turbine
      && (!!f.turbo || boost > 0.015) && this.A.turboOn !== false;
    this.gTurb.visible = !!wanted;
    if (!wanted) return;

    /* сглаженная интенсивность импульса от каждого цилиндра */
    for (let i = 0; i < this.n; i++) {
      const c = cyls[i] || {};
      const gate = twoStroke
        ? portOpen(this.A.portsExhaust[0], f, num(c.liftEx, 0))
        : clamp(num(c.liftEx, 0), 0, 1);
      const T = clamp(num(c.T_K, 700), 200, 4000);
      this.turbI[i] = approach(this.turbI[i], gate, dt, 0.05);
      this.turbT[i] = approach(this.turbT[i], T, dt, 0.08);
    }

    const speed = 0.45 + 1.5 * rpmF;
    const p3 = this._tmp, col = this._col;
    for (let i = 0; i < s.n; i++) {
      const pi = s.path[i];
      const path = this.turbPaths[pi];
      if (!path) continue;
      const prev = s.u[i];
      s.u[i] += dt * speed * s.spd[i];
      if (s.u[i] > 1) {
        s.u[i] -= Math.floor(s.u[i]);
        /* перерождение: частица уносит текущий импульс своего цилиндра */
        const ci = Math.min(pi, this.n - 1);
        const hot = clamp((this.turbT[ci] - 700) / 900, 0, 1);
        s.a[i] = clamp(this.turbI[ci], 0, 1) * (0.35 + 0.65 * hot);
        col.copy(COL.smokeCold).lerp(COL.smokeHot, hot);
        s.cr[i] = col.r; s.cg[i] = col.g; s.cb[i] = col.b;
      } else if (prev === 0) {
        s.cr[i] = COL.smokeCold.r; s.cg[i] = COL.smokeCold.g; s.cb[i] = COL.smokeCold.b;
      }
      pathPoint(path, s.u[i], p3);
      const i3 = i * 3;
      s.pos[i3] = p3.x + s.jx[i];
      s.pos[i3 + 1] = p3.y + s.jy[i];
      s.pos[i3 + 2] = p3.z + s.jz[i];
      const a = s.a[i] * edgeFade(path, s.u[i]);
      s.col[i3] = s.cr[i] * a; s.col[i3 + 1] = s.cg[i] * a; s.col[i3 + 2] = s.cb[i] * a;
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
  }

  /** Двухтактная продувка: петля по Шнюрле, короткое замыкание и объём в картере. */
  _updateScavenge(f, dt, rpmF, cyls, twoStroke) {
    const s = this.scav;
    const wanted = this.vis.gas && this.vis.scavenge && twoStroke && !!s;
    this.gScav.visible = !!wanted;
    if (!wanted) return;

    const c0 = cyls[0] || {};
    const trOpen = portOpen(this.A.portsTransfer[0], f, num(c0.liftIn, 0));
    const exOpen = portOpen(this.A.portsExhaust[0], f, num(c0.liftEx, 0));
    this.scavGate = approach(this.scavGate, trOpen, dt, 0.04);
    this.exhGate = approach(this.exhGate, exOpen, dt, 0.04);

    /* объём смеси в картере: сжимается при ходе поршня вниз */
    const cf = clamp(num(f.crankcaseFrac, 0), 0, 1);
    if (this.ccMesh) {
      const k = 1 - 0.34 * cf;
      this.ccMesh.scale.set(this.ccR * k, this.ccLen, this.ccR * k);
      this.ccMat.opacity = 0.10 + 0.20 * cf;
      this.ccMat.color.copy(COL.fresh).lerp(COL.mix, cf * 0.6);
    }

    const T = clamp(num(c0.T_K, 700), 200, 4000);
    const hot = clamp((T - 700) / 900, 0, 1);
    const p3 = this._tmp, col = this._col;
    /* поток идёт, только пока окна открыты; при закрытых — еле заметный дрейф */
    const vLoop = 0.06 + 1.55 * this.scavGate + 0.5 * rpmF * this.scavGate;
    const vBurnt = 0.06 + 1.35 * this.exhGate + 0.5 * rpmF * this.exhGate;
    /* мгновенная «яркость окна»: закрылось — поток гаснет, не дожидаясь перерождения */
    const liveLoop = 0.12 + 0.88 * this.scavGate;
    const liveBurnt = 0.12 + 0.88 * this.exhGate;

    for (let i = 0; i < s.n; i++) {
      const pi = s.path[i];
      const path = this.scavPaths[pi];
      if (!path) continue;
      const role = this.scavRole[pi];
      const v = role === 2 ? vBurnt : vLoop;
      s.u[i] += dt * v * s.spd[i];
      if (s.u[i] > 1) {
        s.u[i] -= Math.floor(s.u[i]);
        /* порция «заряжается» той долей открытия, которая была в момент входа */
        s.a[i] = 0.15 + 0.85 * (role === 2 ? this.exhGate : this.scavGate);
      }
      pathPoint(path, s.u[i], p3);
      const i3 = i * 3;
      s.pos[i3] = p3.x + s.jx[i];
      s.pos[i3 + 1] = p3.y + s.jy[i];
      s.pos[i3 + 2] = p3.z + s.jz[i];

      if (role === 0) {
        /* свежая смесь постепенно перемешивается с выхлопом, вытесняя его */
        col.copy(COL.fresh).lerp(COL.burnt, clamp((s.u[i] - 0.62) / 0.3, 0, 0.85));
      } else if (role === 1) {
        col.copy(COL.shortCut);                     // короткое замыкание — яркая струя
      } else {
        col.copy(COL.burnt).lerp(COL.smokeHot, hot * 0.7);
      }
      const a = clamp(s.a[i], 0, 1) * edgeFade(path, s.u[i])
        * (role === 2 ? liveBurnt : liveLoop);
      s.col[i3] = col.r * a; s.col[i3 + 1] = col.g * a; s.col[i3 + 2] = col.b * a;
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
  }

  /** Сдвиг стрелок вдоль пути с ориентацией по касательной. */
  _moveArrows(list, dt, speed) {
    if (!list) return;
    const tan = this._tan, p3 = this._tmp;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      a.u += dt * speed;
      if (a.u > 1) a.u -= Math.floor(a.u);
      /* на одностороннем тракте прячем стрелку у самых кромок */
      if (a.path.open && (a.u < 0.04 || a.u > 0.94)) { a.mesh.visible = false; continue; }
      a.mesh.visible = true;
      pathPoint(a.path, a.u, p3);
      a.mesh.position.copy(p3);
      pathTangent(a.path, a.u, tan);
      _q.setFromUnitVectors(UP, tan);
      a.mesh.quaternion.copy(_q);
    }
  }

  /* ───────────────── управление ───────────────── */

  /**
   * Независимое включение подсистем:
   * { gas, fuel, oil, coolant, exhaust, flame, boost, turbine, scavenge }.
   */
  setVisible(flags) {
    const f = flags || {};
    for (const k of ['gas', 'fuel', 'oil', 'coolant', 'exhaust', 'flame',
                     'boost', 'turbine', 'scavenge']) {
      if (typeof f[k] === 'boolean') this.vis[k] = f[k];
    }
    this._applyVisible();
    return this.vis;
  }

  _applyVisible() {
    this.gGas.visible = this.vis.gas;
    this.gFlame.visible = this.vis.gas && this.vis.flame;
    this.gFuel.visible = this.vis.fuel;
    this.gExh.visible = this.vis.exhaust;
    this.gOil.visible = this.vis.oil;
    this.gCool.visible = this.vis.coolant;
    /* группы второй волны включаются ещё и по режиму — окончательное решение
       принимается в кадре (наддув есть только при boost > 0 и т. д.) */
    this.gBoost.visible = this.vis.boost;
    this.gTurb.visible = this.vis.exhaust && this.vis.turbine;
    this.gScav.visible = this.vis.gas && this.vis.scavenge && this.A.twoStroke;
  }

  /** Пересборка при смене компоновки, режима, числа цилиндров или степени сжатия. */
  setAnchors(anchors, opts) {
    if (opts) Object.assign(this.opts, opts);
    this._teardown();
    this._build(anchors);
  }

  /** Снять и уничтожить содержимое группы (без самой группы). */
  _teardown() {
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    for (const d of this._disposables) { if (d && typeof d.dispose === 'function') d.dispose(); }
    this._disposables.clear();
    this.gasMesh = this.gasMat = this.flame = null;
    this.oilPaths = this.coolPaths = this.oilArrows = this.coolArrows = null;
    this.fuel = this.exh = this.oil = this.cool = null;
    this.boost = this.turb = this.scav = null;
    this.boostPaths = this.turbPaths = this.scavPaths = null;
    this.boostArrows = this.boostMain = null;
    this.ccMesh = this.ccMat = null;
    this.sumpMat = null;
  }

  dispose() {
    this._teardown();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/**
 * Собрать визуализацию жидкостей и газов.
 * @param {object} anchors — mech.anchors из engine3d.js (см. контракты §4/§2)
 * @param {{cylinders?:1|4|8, eps?:number}} [opts]
 * @returns {Fluids}
 */
export function buildFluids(anchors, opts = {}) {
  return new Fluids(anchors, opts);
}

export default buildFluids;
