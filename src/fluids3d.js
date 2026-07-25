/**
 * src/fluids3d.js — визуализация всех рабочих тел двигателя.
 *
 * Шесть независимо включаемых подсистем:
 *   1. газ в цилиндре      — полупрозрачный объём между днищем поршня и головкой;
 *   2. впрыск топлива      — частицы из форсунки (во впускной канал или прямо в камеру);
 *   3. выхлоп              — дым в выпускной канал при подъёме выпускного клапана;
 *   4. пламя и детонация   — свечение по xb + белая вспышка и ударная волна при knockNow;
 *   5. масляная система    — замкнутый контур насос → коленвал → шатунная шейка → стенка → поддон;
 *   6. система охлаждения  — поток в рубашке вокруг цилиндров и петля к радиатору.
 *
 * Никаких текстур и внешних ресурсов: только процедурная геометрия и материалы.
 * Модуль не создаёт ни света, ни камеры, ни рендерера — отдаёт готовую THREE.Group.
 * Суммарный бюджет частиц — 1660 (см. BUDGET ниже).
 */

import * as THREE from 'three';
import { L, PIN_Y_TDC } from './layout.js';

/* ─────────────────────────── константы ─────────────────────────── */

/** Размеры пулов частиц. Сумма = 1660 (< 2000 по контракту). */
const BUDGET = {
  fuel: 300,     // впрыск топлива
  exhaust: 320,  // выхлопной дым
  oil: 480,      // масляный контур
  coolant: 560,  // рубашка охлаждения + петля к радиатору
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
};

const HIDE = -9999;           // «мёртвая» частица уезжает под сцену
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

/* ─────────────────────────── мелкие утилиты ─────────────────────────── */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Число или запасное значение — защита от NaN/undefined из внешних данных. */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (s) => (Math.random() - 0.5) * s;

/** Vector3 из произвольного «похожего на точку» объекта. */
function vec3(src, dx, dy, dz) {
  const o = src || {};
  return new THREE.Vector3(num(o.x, dx), num(o.y, dy), num(o.z, dz));
}

/* ─────────────────────────── якоря ─────────────────────────── */

/**
 * Приводит anchors из engine3d.js к полному виду: недостающие поля берём из layout.js,
 * чтобы модуль работал и в одиночку (например, в тестах).
 */
function normalizeAnchors(anchors, opts) {
  const a = anchors || {};
  const eps = num(opts.eps, 10);
  const deckY = num(a.deckY, L.deckY(eps));

  // цилиндры
  let src = Array.isArray(a.cylinders) && a.cylinders.length ? a.cylinders : null;
  const n = src ? src.length : (num(opts.cylinders, 1) === 4 ? 4 : 1);
  if (!src) {
    const zs = n === 1 ? L.CYL_Z_SINGLE : L.CYL_Z;
    src = zs.map((z) => ({ x: 0, z }));
  }
  const cylinders = src.map((c, i) => ({
    x: num(c && c.x, 0),
    z: num(c && c.z, (n === 1 ? L.CYL_Z_SINGLE : L.CYL_Z)[i] || 0),
    crownY: c && c.crownY,
  }));

  const zs = cylinders.map((c) => c.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);

  const intakePortEnd = vec3(a.intakePortEnd, L.VALVE_X_IN - 5.6, deckY + 4.4, 0);
  const exhaustPortEnd = vec3(a.exhaustPortEnd, L.VALVE_X_EX + 5.6, deckY + 4.4, 0);
  const injectorTip = vec3(a.injectorTip, L.VALVE_X_IN - 4.5, deckY + 4.8, 0);
  const sparkTip = vec3(a.sparkTip, 0, deckY - 0.35, 0);
  const crankCenter = vec3(a.crankCenter, 0, 0, 0);

  // рубашка охлаждения
  const jr = L.BORE_R + L.JACKET_GAP;
  const jb = a.jacketBox || {};
  const jmin = vec3(jb.min, -jr - 0.9, deckY - L.STROKE_U - 4.2, zMin - jr - 0.9);
  const jmax = vec3(jb.max, jr + 0.9, deckY, zMax + jr + 0.9);
  if (jmax.y - jmin.y < 2) jmin.y = jmax.y - L.STROKE_U - 4.2;   // страховка от вырожденной коробки

  return {
    eps, deckY, cylinders, count: cylinders.length, zMin, zMax,
    intakePortEnd, exhaustPortEnd, injectorTip, sparkTip, crankCenter,
    jacket: { min: jmin, max: jmax },
  };
}

/** Высота днища поршня цилиндра i: сначала спрашиваем механизм, иначе считаем сами. */
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

/* ─────────────────────────── пути потока ─────────────────────────── */

/**
 * Замкнутый путь: сглаживаем ломаную сплайном и раскладываем в Float32Array.
 * Готовая выборка нужна, чтобы в кадре двигать сотни частиц без аллокаций.
 */
function makePath(points, segs = 160) {
  const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.3);
  const arr = new Float32Array((segs + 1) * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, v);
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  return { arr, segs, curve };
}

/** Точка пути по параметру u (зацикленному). */
function pathPoint(p, u, out) {
  let t = u - Math.floor(u);
  if (!Number.isFinite(t)) t = 0;
  const f = t * p.segs;
  let i = Math.floor(f);
  if (i >= p.segs) i = p.segs - 1;
  const k = f - i;
  const i0 = i * 3, i1 = i0 + 3;
  out.x = lerp(p.arr[i0], p.arr[i1], k);
  out.y = lerp(p.arr[i0 + 1], p.arr[i1 + 1], k);
  out.z = lerp(p.arr[i0 + 2], p.arr[i1 + 2], k);
  return out;
}

const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Единичная касательная пути в точке u. */
function pathTangent(p, u, out) {
  pathPoint(p, u, _pa);
  pathPoint(p, u + 0.01, _pb);
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
  if (!Number.isFinite(ox + oy + oz + vx + vy + vz)) return;
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

/** Пул «текущих по контуру» частиц (масло, антифриз): параметр u вдоль пути. */
function makeFlow(n, size, opacity, blending) {
  const s = makePoints(n, size, blending || THREE.AdditiveBlending, opacity);
  s.u = new Float32Array(n);
  s.path = new Int16Array(n);
  s.spd = new Float32Array(n);
  s.jx = new Float32Array(n); s.jy = new Float32Array(n); s.jz = new Float32Array(n);
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
  }
}

/* ═══════════════════════════ основной класс ═══════════════════════════ */

class Fluids {
  constructor(anchors, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'fluids';
    this.opts = Object.assign({ cylinders: 1, eps: 10 }, opts || {});
    this.vis = { gas: true, fuel: true, oil: true, coolant: true, exhaust: true, flame: true };
    this.time = 0;
    this._disposables = new Set();
    this._tmp = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._col = new THREE.Color();
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
    this.group.add(this.gGas, this.gFlame, this.gFuel, this.gExh, this.gOil, this.gCool);

    this._buildGas(A);
    this._buildFlame(A);
    this._buildFuel(A);
    this._buildExhaust(A);
    this._buildOil(A);
    this._buildCoolant(A);

    // состояние детонации по цилиндрам
    this.knockT = new Float32Array(this.n);
    this.fuelAcc = new Float32Array(this.n);
    this.exhAcc = new Float32Array(this.n);
    this._applyVisible();
  }

  /** 1. Газ в цилиндре — цилиндрический объём от днища поршня до головки. */
  _buildGas(A) {
    const geo = this._reg(new THREE.CylinderGeometry(L.BORE_R - 0.15, L.BORE_R - 0.15, 1, 32));
    this.gasMesh = [];
    this.gasMat = [];
    for (let i = 0; i < A.count; i++) {
      const mat = this._reg(new THREE.MeshBasicMaterial({
        color: COL.mix.clone(), transparent: true, opacity: 0, depthWrite: false,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.position.set(A.cylinders[i].x, A.deckY - 1, A.cylinders[i].z);
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
        m.rotation.x = -Math.PI / 2;
        m.visible = false; m.renderOrder = 4;
        this.gFlame.add(m);
        rings.push(m);
      }
      this.flame.push({ front, core, flash, rings, x: c.x, z: c.z });
    }
  }

  /** 2. Впрыск топлива. */
  _buildFuel(A) {
    this.fuel = makeSpray(BUDGET.fuel, 0.28, 0.95);
    this._reg(this.fuel.geo); this._reg(this.fuel.mat);
    this.gFuel.add(this.fuel.pts);
    // точка выхода факела: во впускном канале (бензин) или в головке (дизель)
    this.injPort = A.injectorTip.clone();
    this.injHead = (A.injectorTip.y < A.deckY + 0.6)
      ? A.injectorTip.clone()
      : new THREE.Vector3(A.sparkTip.x * 0.4, A.deckY - 0.3, 0);
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
      const z = c.z;
      const pts = [
        new THREE.Vector3(0, sumpY + 0.35, z),                          // маслоприёмник в поддоне
        new THREE.Vector3(-3.2, sumpY + 0.9, z),                        // насос
        new THREE.Vector3(-5.2, -3.2, z),                               // магистраль в блоке
        new THREE.Vector3(cc.x - 1.9, cc.y + 0.3, z),                   // коренная шейка
        new THREE.Vector3(cc.x + 0.4, cc.y + L.CRANK_R * 0.9, z),       // шатунная шейка
        new THREE.Vector3(c.x - L.BORE_R * 0.55, 9.4, z),               // разбрызгивание вверх
        new THREE.Vector3(c.x - L.BORE_R * 0.9, 13.8, z),               // масло на стенке цилиндра
        new THREE.Vector3(c.x + L.BORE_R * 0.9, 12.2, z),               // снимается маслосъёмным кольцом
        new THREE.Vector3(c.x + 3.4, 2.0, z),                           // стекание
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
    const yBot = A.jacket.min.y + 0.6;
    const yTop = A.deckY - 0.4;
    const paths = [];

    for (let i = 0; i < A.count; i++) {
      const c = A.cylinders[i];
      const pts = [];
      const turns = 1.5, steps = 18;
      for (let k = 0; k <= steps; k++) {         // подъём по спирали вокруг гильзы
        const t = k / steps;
        const ang = t * TAU * turns;
        pts.push(new THREE.Vector3(
          c.x + Math.cos(ang) * R,
          lerp(yBot, yTop, t),
          c.z + Math.sin(ang) * R * 0.85,
        ));
      }
      // возврат вниз по внешней стороне блока (замыкание контура рубашки)
      pts.push(new THREE.Vector3(c.x + R + 1.1, yTop - 1.0, c.z + R * 0.4));
      pts.push(new THREE.Vector3(c.x + R + 1.4, lerp(yBot, yTop, 0.5), c.z));
      pts.push(new THREE.Vector3(c.x + R + 1.1, yBot + 0.4, c.z - R * 0.4));
      paths.push(makePath(pts, 200));

      // полупрозрачная оболочка рубашки
      const shell = new THREE.Mesh(
        this._reg(new THREE.CylinderGeometry(R + 0.35, R + 0.35, yTop - yBot, 24, 1, true)),
        this._reg(new THREE.MeshBasicMaterial({
          color: 0x2f7fe0, transparent: true, opacity: 0.07,
          depthWrite: false, side: THREE.DoubleSide,
        })),
      );
      shell.position.set(c.x, (yBot + yTop) / 2, c.z);
      this.gCool.add(shell);
    }

    // главный контур: выход из головки → радиатор → насос → низ рубашки
    const zF = A.zMax + 3.0, zB = A.zMin - 3.0, jy = A.jacket.min.y;
    const main = makePath([
      new THREE.Vector3(2.2, A.deckY + 0.9, zF),
      new THREE.Vector3(1.2, A.deckY + 1.9, zF + 5),
      new THREE.Vector3(0.0, A.deckY - 1.0, zF + 10),     // верхний бачок радиатора
      new THREE.Vector3(0.0, jy + 1.0, zF + 10),          // нижний бачок радиатора
      new THREE.Vector3(-2.0, jy - 0.5, zF + 5),
      new THREE.Vector3(-3.2, jy - 1.4, zB - 1),          // насос
      new THREE.Vector3(-3.6, A.deckY - 6.0, zB - 1),     // подъём по стенке блока
      new THREE.Vector3(-2.6, A.deckY + 0.7, zB),
      new THREE.Vector3(0.0, A.deckY + 1.1, (zB + zF) / 2),
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
      };
      if (!Number.isFinite(st.crown)) st.crown = this.A.deckY - 1;

      this._updateGas(i, st, f, step);
      this._updateFlame(i, st, f, step);
      if (this.vis.fuel) this._updateFuel(i, st, diesel, rpmF, step);
      if (this.vis.exhaust) this._updateExhaust(i, st, rpmF, step);
    }

    if (this.vis.fuel) stepSpray(this.fuel, step, -2.5, 2.6);
    if (this.vis.exhaust) stepSpray(this.exh, step, 1.2, 1.5);
    if (this.vis.oil) this._updateOil(step, rpmF);
    if (this.vis.coolant) this._updateCoolant(step, rpmF, Tmax);
  }

  /** Газ: высота объёма и цвет по фазе цикла. */
  _updateGas(i, st, f, dt) {
    const mesh = this.gasMesh[i], mat = this.gasMat[i];
    const h = Math.max(this.A.deckY - st.crown, 0.05);
    mesh.scale.y = h;
    mesh.position.y = st.crown + h / 2;
    if (!this.vis.gas) return;

    const col = this._col;
    let op;
    if (st.xb > 0.02) {
      // горение: фиолетовый → оранжевый по доле сгоревшего, добела по температуре
      col.copy(COL.comp).lerp(COL.fire, Math.min(st.xb * 1.7, 1));
      const hot = clamp((st.T - 1500) / 1300, 0, 1);
      col.lerp(COL.white, hot * Math.min(st.xb * 1.4, 1) * 0.85);
      op = 0.34 + 0.42 * st.xb;
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

    // фронт пламени растёт от свечи к стенкам
    const burning = on && st.xb > 0.01 && st.xb < 0.995;
    fl.front.visible = burning;
    fl.core.visible = burning;
    if (burning) {
      const r = L.BORE_R * (0.22 + 0.9 * Math.pow(st.xb, 0.55));
      const y = lerp(yTop, chamberMid, st.xb);
      fl.front.position.set(fl.x, y, fl.z);
      fl.front.scale.setScalar(r);
      fl.front.material.opacity = 0.22 * (1 - st.xb * 0.5) + 0.12;
      fl.front.material.color.copy(COL.fire).lerp(COL.white, clamp((st.T - 1800) / 1200, 0, 1));

      fl.core.position.set(fl.x, y, fl.z);
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
      fl.flash.position.set(fl.x, chamberMid, fl.z);
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
      r.position.set(fl.x, chamberMid, fl.z);
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
      const ox = this.injHead.x + c.x, oy = Math.min(this.injHead.y, A.deckY - 0.2), oz = c.z;
      for (let k = 0; k < cnt; k++) {
        const ang = Math.random() * TAU, spr = 0.45 + Math.random() * 0.35;
        spawn(this.fuel, 1, ox, oy, oz,
          Math.cos(ang) * spr * 9, -9.5, Math.sin(ang) * spr * 9,
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
    const ox = this.injPort.x, oy = this.injPort.y, oz = c.z;
    // направление — на тарелку впускного клапана
    const tx = c.x + L.VALVE_X_IN, ty = A.deckY - 0.6;
    const dx = tx - ox, dy = ty - oy;
    const len = Math.hypot(dx, dy) || 1;
    const v = 11 + 9 * rpmF;
    spawn(this.fuel, cnt, ox, oy, oz, (dx / len) * v, (dy / len) * v, 0, 2.0, 2.4, COL.petrol, 0.35);
  }

  /** Выхлоп: дым в выпускной канал, цвет и яркость по температуре газа. */
  _updateExhaust(i, st, rpmF, dt) {
    if (st.liftEx < 0.08) return;
    const A = this.A, c = A.cylinders[i];
    this.exhAcc[i] += dt * (35 + 130 * rpmF) * st.liftEx;
    const cnt = Math.floor(this.exhAcc[i]);
    this.exhAcc[i] -= cnt;
    if (cnt <= 0) return;

    const ox = c.x + L.VALVE_X_EX, oy = A.deckY - 0.4, oz = c.z;
    const dx = A.exhaustPortEnd.x - ox, dy = A.exhaustPortEnd.y - oy;
    const len = Math.hypot(dx, dy) || 1;
    // в начале выпуска (высокое давление) газ вылетает резко
    const v = 6 + 10 * rpmF + clamp(st.p * 0.6, 0, 9);
    const hot = clamp((st.T - 700) / 900, 0, 1);
    this._col.copy(COL.smokeCold).lerp(COL.smokeHot, hot);
    spawn(this.exh, cnt, ox, oy, oz, (dx / len) * v, (dy / len) * v, 0, 2.4, 1.3, this._col, 0.4);
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
      // чем выше по рубашке и чем горячее двигатель — тем краснее
      const k = clamp((p3.y - yBot) / span, 0, 1) * (0.45 + 0.55 * heat);
      s.col[i3] = lerp(COL.coolCold.r, COL.coolHot.r, k);
      s.col[i3 + 1] = lerp(COL.coolCold.g, COL.coolHot.g, k);
      s.col[i3 + 2] = lerp(COL.coolCold.b, COL.coolHot.b, k);
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.color.needsUpdate = true;
    this._moveArrows(this.coolArrows, dt, base);
  }

  /** Сдвиг стрелок вдоль пути с ориентацией по касательной. */
  _moveArrows(list, dt, speed) {
    if (!list) return;
    const tan = this._tan, p3 = this._tmp;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      a.u += dt * speed;
      if (a.u > 1) a.u -= Math.floor(a.u);
      pathPoint(a.path, a.u, p3);
      a.mesh.position.copy(p3);
      pathTangent(a.path, a.u, tan);
      _q.setFromUnitVectors(UP, tan);
      a.mesh.quaternion.copy(_q);
    }
  }

  /* ───────────────── управление ───────────────── */

  /** Независимое включение подсистем: { gas, fuel, oil, coolant, exhaust, flame }. */
  setVisible(flags) {
    const f = flags || {};
    for (const k of ['gas', 'fuel', 'oil', 'coolant', 'exhaust', 'flame']) {
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
  }

  /** Пересборка при смене числа цилиндров или степени сжатия. */
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
  }

  dispose() {
    this._teardown();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/**
 * Собрать визуализацию жидкостей и газов.
 * @param {object} anchors — mech.anchors из engine3d.js (см. контракт §4)
 * @param {{cylinders?:1|4, eps?:number}} [opts]
 * @returns {Fluids}
 */
export function buildFluids(anchors, opts = {}) {
  return new Fluids(anchors, opts);
}

export default buildFluids;
