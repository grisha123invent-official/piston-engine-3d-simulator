/**
 * src/engine3d.js — 3D-модель механизма двигателя (агент M).
 *
 * Строит кривошипно-шатунный механизм, головку блока с DOHC-распредвалами,
 * клапаны с пружинами и толкателями, привод ГРМ цепью со звёздочками 2:1,
 * маховик и блок цилиндров. Освещение, камеру и рендерер модуль не трогает —
 * наружу отдаётся только THREE.Group.
 *
 *   import { buildMechanism } from './engine3d.js';
 *   const mech = buildMechanism({ cylinders: 4, eps: 10 });
 *   scene.add(mech.group);
 *   mech.update(frame);            // каждый кадр, frame — FrameState (§6 контракта)
 *
 * Для работы разреза интегратор должен включить renderer.localClippingEnabled = true.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { L, cylinderZ, cylinderPhase, PIN_Y_TDC } from './layout.js';

/* ═══════════ фазы газораспределения и профиль кулачка ═══════════ */
/* Те же числа, что и в физике: впуск 700→230, выпуск 490→20 (град. цикла). */
const IVO = 700, IVC = 230, EVO = 490, EVC = 20;
const IN_SPAN  = (IVC - IVO + 720) % 720;          // 250° цикла
const EX_SPAN  = (EVC - EVO + 720) % 720;          // 250° цикла
const IN_PEAK  = (IVO + IN_SPAN / 2) % 720;        // 105° — максимум подъёма впуска
const EX_PEAK  = (EVO + EX_SPAN / 2) % 720;        // 615° — максимум подъёма выпуска
/* Распредвал крутится вдвое медленнее: 250° цикла = 125° поворота вала,
   значит профиль занимает ±62.5° от вершины кулачка. */
const IN_HALF = IN_SPAN / 4;
const EX_HALF = EX_SPAN / 4;

/* Клапаны наклонены (крышевидная камера), чтобы распредвалы разошлись по ширине
   и звёздочки ГРМ (радиус 3.0) не пересекались. */
const VALVE_TILT = 15 * Math.PI / 180;
const CAM_X   = L.VALVE_X_EX + L.CAM_DY * Math.tan(VALVE_TILT);   // ≈ 3.50
const CAM_AX  = L.CAM_DY / Math.cos(VALVE_TILT);                  // ≈ 5.59 — ось кулачка вдоль оси клапана

const WALL_BOT_Y = 6.0;        // низ гильзы цилиндра (сцена)
const CHAIN_Z_SINGLE = -6.6;   // плоскость цепи у одноцилиндрового
const Z_PAD_FRONT = 4.8;       // вылет корпуса вперёд (до плоскости цепи)
const Z_PAD_BACK = 5.5;        // вылет корпуса назад (к маховику)

/** Границы корпуса (блок и головка) вдоль оси коленвала. */
function bodyZ(zs) {
  const min = zs[0] - Z_PAD_FRONT, max = zs[zs.length - 1] + Z_PAD_BACK;
  return { min, max, len: max - min, mid: (min + max) / 2 };
}

const DEG = Math.PI / 180;
/** Материалы «оболочек» — их и режет плоскость разреза. */
const SHELL_MATS = ['wall', 'block', 'head', 'cover'];
const num   = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Радиус кулачка на угле beta (град.) от его вершины. */
function camRadius(beta, half) {
  let b = ((beta + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(b) >= half) return L.CAM_R;
  return L.CAM_R + L.CAM_LOBE * Math.cos((Math.PI * b) / (2 * half));
}

/**
 * Замкнутая траектория цепи вокруг набора звёздочек.
 * circles — [{x,y,r}] в порядке обхода против часовой стрелки.
 * Возвращает массив THREE.Vector2 (дуги охвата + прямые ветви).
 */
function beltPath(circles) {
  const k = circles.length;
  const nAng = [];                       // угол внешней нормали в точке схода i → i+1
  for (let i = 0; i < k; i++) {
    const a = circles[i], b = circles[(i + 1) % k];
    const dx = b.x - a.x, dy = b.y - a.y;
    const D = Math.max(1e-6, Math.hypot(dx, dy));
    nAng[i] = Math.atan2(dy, dx) - Math.acos(clamp((a.r - b.r) / D, -1, 1));
  }
  const pts = [];
  for (let i = 0; i < k; i++) {
    const c = circles[i], nx = circles[(i + 1) % k];
    const aIn = nAng[(i - 1 + k) % k], aOut = nAng[i];
    let sweep = aOut - aIn;
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    const steps = Math.max(2, Math.ceil(sweep / 0.12));
    for (let s = 0; s <= steps; s++) {
      const a = aIn + (sweep * s) / steps;
      pts.push(new THREE.Vector2(c.x + c.r * Math.cos(a), c.y + c.r * Math.sin(a)));
    }
    const p0 = new THREE.Vector2(c.x + c.r * Math.cos(aOut), c.y + c.r * Math.sin(aOut));
    const p1 = new THREE.Vector2(nx.x + nx.r * Math.cos(aOut), nx.y + nx.r * Math.sin(aOut));
    const segSteps = Math.max(1, Math.ceil(p0.distanceTo(p1) / 1.1));
    for (let s = 1; s < segSteps; s++) pts.push(p0.clone().lerp(p1, s / segSteps));
  }
  return pts;
}

/* ═══════════════════════════════════════════════════════════════
   buildMechanism
   ═══════════════════════════════════════════════════════════════ */

/**
 * @param {{cylinders?:1|4, eps?:number, cutaway?:boolean, labels?:boolean, fuelMode?:string}} opts
 * @returns {Mechanism}
 */
export function buildMechanism(opts = {}) {
  const state = {
    n: opts.cylinders === 1 ? 1 : 4,
    eps: num(opts.eps, 10),
    cutaway: opts.cutaway !== false,
    labels: opts.labels !== false,
    fuelMode: opts.fuelMode === 'diesel' ? 'diesel' : 'petrol',
  };

  const group = new THREE.Group();
  group.name = 'mechanism';

  /* Разрез: плоскость x = 0, оставляем половину x < 0 — классический
     продольный разрез рядного двигателя (видны все цилиндры сразу). */
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.02);

  /* Объекты-контейнеры живут всё время жизни механизма — интегратор и модуль
     жидкостей держат на них ссылки, поэтому при перестроении они мутируются. */
  const parts = {
    pistons: [], rods: [], crank: null, camIn: null, camEx: null,
    valvesIn: [], valvesEx: [], head: null, walls: [],
    tappetsIn: [], tappetsEx: [], springsIn: [], springsEx: [],
    flywheel: null, chain: null, chainLinks: [], sprocketCrank: null,
    sprocketIn: null, sprocketEx: null, block: null, crankcase: null,
    plugs: [], injectorsDirect: [], injectorsPort: [], labels: [],
  };
  const anchors = {};

  /* ── реестр ресурсов для dispose ── */
  let geoms = new Set(), mats = new Set(), labelObjs = [];
  const G = g => { geoms.add(g); return g; };
  const M = m => { mats.add(m); return m; };

  let mat = null;          // текущий набор материалов
  let chainCircles = null; // геометрия петли ГРМ (для перестроения при смене ε)
  let chainPath = null;    // { pts, cum, total }

  /* ═══════════ материалы ═══════════ */
  function makeMaterials() {
    const clip = state.cutaway ? [clipPlane] : null;
    const set = {
      steel:  M(new THREE.MeshStandardMaterial({ color: 0x8a95a1, metalness: 0.9, roughness: 0.3 })),
      metal:  M(new THREE.MeshStandardMaterial({ color: 0xb9c2cc, metalness: 0.85, roughness: 0.35 })),
      dark:   M(new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.6, roughness: 0.5 })),
      cast:   M(new THREE.MeshStandardMaterial({ color: 0x545c66, metalness: 0.45, roughness: 0.65 })),
      chain:  M(new THREE.MeshStandardMaterial({ color: 0x6f7885, metalness: 0.95, roughness: 0.35 })),
      mark:   M(new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0x3a2a00,
                metalness: 0.3, roughness: 0.5 })),
      wall:   M(new THREE.MeshPhysicalMaterial({
                color: 0xaab6c2, metalness: 0.2, roughness: 0.15, transparent: true,
                opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: clip })),
      block:  M(new THREE.MeshPhysicalMaterial({
                color: 0x7d8894, metalness: 0.3, roughness: 0.5, transparent: true,
                opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: clip })),
      head:   M(new THREE.MeshStandardMaterial({
                color: 0x6e7a87, metalness: 0.7, roughness: 0.4, transparent: true,
                opacity: 0.30, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: clip })),
      cover:  M(new THREE.MeshStandardMaterial({
                color: 0x4a535e, metalness: 0.6, roughness: 0.45, transparent: true,
                opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: clip })),
      valveIn:  M(new THREE.MeshStandardMaterial({ color: 0xa8c6ff, metalness: 0.8, roughness: 0.35 })),
      valveEx:  M(new THREE.MeshStandardMaterial({ color: 0xd98d6a, metalness: 0.8, roughness: 0.35 })),
      portIn:   M(new THREE.MeshStandardMaterial({ color: 0x5b7ea8, metalness: 0.5, roughness: 0.5,
                  transparent: true, opacity: 0.45, side: THREE.DoubleSide })),
      portEx:   M(new THREE.MeshStandardMaterial({ color: 0x7a6a5f, metalness: 0.5, roughness: 0.5,
                  transparent: true, opacity: 0.45, side: THREE.DoubleSide })),
      ceramic:  M(new THREE.MeshStandardMaterial({ color: 0xf0ead6, roughness: 0.4 })),
      inject:   M(new THREE.MeshStandardMaterial({ color: 0x4466aa, metalness: 0.6, roughness: 0.4 })),
    };
    /* запоминаем «разрезную» прозрачность оболочек — при выключенном разрезе
       делаем их чуть плотнее, чтобы корпус читался как деталь */
    for (const k of SHELL_MATS) set[k].userData.baseOpacity = set[k].opacity;
    return set;
  }

  /* ═══════════ мелкие помощники ═══════════ */

  function mesh(geo, material, parent, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(G(geo), material);
    m.position.set(x, y, z);
    if (parent) parent.add(m);
    return m;
  }

  /** Цилиндр с осью вдоль Z (шейки вала, пальцы, стаканы). */
  function zCyl(r1, r2, h, seg, material, parent, x = 0, y = 0, z = 0) {
    const m = mesh(new THREE.CylinderGeometry(r1, r2, h, seg), material, parent, x, y, z);
    m.rotation.x = Math.PI / 2;
    return m;
  }

  /** Спиральная пружина высотой h, ось Y, начало в y = 0. */
  function springMesh(h, coilR, wireR, turns, material, parent) {
    const pts = [];
    const N = Math.max(48, turns * 14);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2 * turns;
      pts.push(new THREE.Vector3(Math.cos(a) * coilR, (i / N) * h, Math.sin(a) * coilR));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, wireR, 5, false);
    return mesh(geo, material, parent);
  }

  /** Труба-канал между двумя точками в плоскости XY. */
  function portTube(x1, y1, x2, y2, r, material, parent, z) {
    const d = new THREE.Vector3(x2 - x1, y2 - y1, 0);
    const len = d.length();
    const m = mesh(new THREE.CylinderGeometry(r, r * 1.1, len, 16, 1, true), material, parent,
                   (x1 + x2) / 2, (y1 + y2) / 2, z);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  }

  /** Подпись детали; крепится к объекту, поэтому едет вместе с ним. */
  function label(text, parent, x, y, z) {
    let el;
    if (typeof document !== 'undefined' && document.createElement) {
      el = document.createElement('div');
      el.className = 'lbl';
      el.textContent = text;
    }
    const o = el ? new CSS2DObject(el) : new CSS2DObject();
    o.position.set(x, y, z);
    o.visible = state.labels;
    if (el) el.style.display = state.labels ? '' : 'none';
    parent.add(o);
    labelObjs.push(o);
    parts.labels.push(o);
    return o;
  }

  /* ═══════════ поршень ═══════════ */
  function makePiston() {
    const g = new THREE.Group();
    const r = L.BORE_R - 0.12;
    /* юбка */
    mesh(new THREE.CylinderGeometry(r, r, L.PISTON_H, 40, 1, true), mat.metal, g, 0, 0.5);
    /* днище (слегка выпуклое) */
    const crown = mesh(new THREE.SphereGeometry(r, 36, 10, 0, Math.PI * 2, 0, Math.PI * 0.24),
                       mat.metal, g, 0, L.PISTON_TOP_OFF - 0.75);
    crown.scale.y = 0.42;
    /* верхняя плита днища */
    mesh(new THREE.CylinderGeometry(r, r, 0.5, 40), mat.metal, g, 0, L.PISTON_TOP_OFF - 0.3);
    /* два компрессионных кольца и одно маслосъёмное */
    const ringY = [L.PISTON_TOP_OFF - 1.0, L.PISTON_TOP_OFF - 1.7, L.PISTON_TOP_OFF - 2.5];
    ringY.forEach((y, i) => {
      const ring = mesh(new THREE.TorusGeometry(L.BORE_R - 0.08, i === 2 ? 0.17 : 0.13, 8, 40),
                        mat.dark, g, 0, y);
      ring.rotation.x = Math.PI / 2;
      if (i === 0) g.userData.ringTop = ring;
      if (i === 2) g.userData.ringOil = ring;
    });
    /* бобышки и поршневой палец */
    zCyl(0.95, 0.95, 3.6, 8, mat.dark, g, 0, 0, 0);
    const pin = zCyl(0.72, 0.72, 4.2, 20, mat.steel, g, 0, 0, 0);
    g.userData.pin = pin;
    return g;
  }

  /* ═══════════ шатун (крепится к пальцу, висит вниз) ═══════════ */
  function makeRod() {
    const g = new THREE.Group();
    mesh(new THREE.BoxGeometry(1.7, L.ROD_L - 2.0, 0.6), mat.steel, g, 0, -L.ROD_L / 2);
    /* двутавровое сечение — две полки */
    for (const s of [-0.55, 0.55])
      mesh(new THREE.BoxGeometry(0.75, L.ROD_L - 2.4, 0.5), mat.dark, g, 0, -L.ROD_L / 2, s);
    /* верхняя головка */
    const small = mesh(new THREE.TorusGeometry(0.95, 0.38, 10, 24), mat.steel, g, 0, 0);
    small.rotation.x = 0;
    /* нижняя головка + крышка */
    const big = mesh(new THREE.TorusGeometry(L.PIN_R + 0.42, 0.5, 10, 26), mat.steel, g, 0, -L.ROD_L);
    mesh(new THREE.BoxGeometry(3.0, 0.55, 1.6), mat.dark, g, 0, -L.ROD_L - 1.15);
    g.userData.big = big; g.userData.small = small;
    return g;
  }

  /* ═══════════ коленчатый вал ═══════════ */
  function makeCrank(zs) {
    const g = new THREE.Group();
    const n = zs.length;
    const mainZ = n === 1 ? [-4.2, 4.2] : [-20.6, -11, 0, 11, 20.6];
    const mainW = n === 1 ? 2.0 : 2.6;
    for (const z of mainZ) zCyl(L.MAIN_R, L.MAIN_R, mainW, 24, mat.steel, g, 0, 0, z);

    /* носок вала под звёздочку ГРМ */
    const chainZ = n === 1 ? CHAIN_Z_SINGLE : L.CHAIN_Z;
    const noseFrom = mainZ[0] + mainW / 2, noseTo = chainZ - 0.8;
    zCyl(0.95, 0.95, Math.abs(noseFrom - noseTo), 20, mat.steel, g, 0, 0,
         (noseFrom + noseTo) / 2);

    /* хвостовик под маховик */
    const fwZ = n === 1 ? L.FLYWHEEL_Z_SINGLE : L.FLYWHEEL_Z_I4;
    const tailFrom = mainZ[mainZ.length - 1] - mainW / 2;
    zCyl(1.05, 1.05, Math.abs(fwZ - tailFrom), 20, mat.steel, g, 0, 0, (fwZ + tailFrom) / 2);

    /* колена: щёки + противовесы + шатунная шейка */
    for (let i = 0; i < n; i++) {
      const th = new THREE.Group();
      th.rotation.z = L.CRANK_PHASE[i] * DEG;     // 1 и 4 вверх, 2 и 3 вниз
      th.position.z = zs[i];
      g.add(th);
      for (const s of [-2.6, 2.6]) {
        /* щека */
        const web = mesh(new THREE.BoxGeometry(2.9, L.CRANK_R + 2.5, 0.9), mat.dark, th,
                         0, (L.CRANK_R - 1.25) / 2, s);
        web.userData.kind = 'web';
        /* противовес — полудиск напротив шейки */
        const cw = mesh(new THREE.CylinderGeometry(2.85, 2.85, 0.95, 26, 1, false, Math.PI / 2, Math.PI),
                        mat.dark, th, 0, -0.55, s);
        cw.rotation.x = Math.PI / 2;
        cw.rotation.y = Math.PI;
        cw.userData.kind = 'counterweight';
        if (i === 0 && s < 0) { th.userData.web = web; th.userData.cw = cw; }
      }
      /* шатунная шейка */
      const pin = zCyl(L.PIN_R, L.PIN_R, 4.2, 22, mat.steel, th, 0, L.CRANK_R, 0);
      th.userData.pin = pin;
      g.userData['throw' + i] = th;
    }

    /* маховик с меткой ВМТ и венцом */
    const fw = new THREE.Group();
    fw.position.z = fwZ;
    zCyl(L.FLYWHEEL_R, L.FLYWHEEL_R, 1.1, 48, mat.dark, fw);
    const gear = mesh(new THREE.TorusGeometry(L.FLYWHEEL_R, 0.3, 8, 60), mat.steel, fw);
    gear.rotation.x = 0;
    zCyl(2.2, 2.2, 1.5, 24, mat.steel, fw);
    mesh(new THREE.BoxGeometry(0.55, 1.7, 1.4), mat.mark, fw, 0, L.FLYWHEEL_R - 0.9, 0);
    g.add(fw);
    parts.flywheel = fw;

    /* звёздочка коленвала — вдвое меньше кулачковых (9 зубьев против 18) */
    const spr = makeSprocket(L.SPROCKET_CRANK_R, 9, 0.85);
    spr.position.z = chainZ;
    g.add(spr);
    parts.sprocketCrank = spr;
    return g;
  }

  /** Звёздочка ГРМ: диск + зубья, ось вдоль Z. */
  function makeSprocket(r, teeth, w) {
    const g = new THREE.Group();
    zCyl(r - 0.22, r - 0.22, w, 32, mat.steel, g);
    zCyl(r * 0.35, r * 0.35, w * 1.6, 18, mat.dark, g);
    const toothGeo = G(new THREE.BoxGeometry(0.3, 0.42, w * 0.7));
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const t = new THREE.Mesh(toothGeo, mat.steel);
      t.position.set(Math.cos(a) * (r - 0.05), Math.sin(a) * (r - 0.05), 0);
      t.rotation.z = a - Math.PI / 2;
      g.add(t);
    }
    g.userData.teeth = teeth;
    return g;
  }

  /* ═══════════ распредвал ═══════════ */
  function camLobeGeometry(width, half) {
    const shape = new THREE.Shape();
    const N = 144;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;                 // от +X против часовой
      const beta = (a - Math.PI / 2) / DEG;            // отклонение от вершины (+Y)
      const r = camRadius(beta, half);
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 2 });
    geo.translate(0, 0, -width / 2);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Вал с кулачками. Вершина кулачка цилиндра i смотрит на толкатель ровно тогда,
   * когда клапан открыт полностью: угол вала = −deg/2, поэтому фаза кулачка
   *   α = (направление «вниз» вдоль оси клапана) + (пик − смещение цикла)/2.
   */
  function makeCam(zs, isIntake, chainZ) {
    const g = new THREE.Group();
    const half = isIntake ? IN_HALF : EX_HALF;
    const peak = isIntake ? IN_PEAK : EX_PEAK;
    const down = isIntake ? Math.PI + VALVE_TILT : Math.PI - VALVE_TILT;

    const zFrom = chainZ - 0.9, zTo = zs[zs.length - 1] + 3.2;
    zCyl(0.62, 0.62, zTo - zFrom, 20, mat.steel, g, 0, 0, (zFrom + zTo) / 2);

    const lobeGeo = camLobeGeometry(1.5, half);
    for (let i = 0; i < zs.length; i++) {
      const lobe = new THREE.Mesh(G(lobeGeo), mat.cast);
      lobe.position.z = zs[i];
      lobe.rotation.z = down + (peak - cylinderPhase(i, zs.length)) * DEG / 2;
      g.add(lobe);
      /* опорная шейка рядом с кулачком */
      zCyl(0.8, 0.8, 0.9, 18, mat.steel, g, 0, 0, zs[i] + 2.3);
    }
    const spr = makeSprocket(L.SPROCKET_CAM_R, 18, 0.85);
    spr.position.z = chainZ;
    g.add(spr);
    g.userData.sprocket = spr;
    return g;
  }

  /* ═══════════ клапан в сборе ═══════════ */
  function makeValve(isIntake) {
    const mount = new THREE.Group();                 // неподвижная часть (наклонена)
    const mv = new THREE.Group();                    // подвижная часть — ход = подъём
    mount.add(mv);
    const mv2 = isIntake ? mat.valveIn : mat.valveEx;

    /* тарелка клапана: верх заподлицо с плоскостью головки */
    mesh(new THREE.CylinderGeometry(L.VALVE_HEAD_R, L.VALVE_HEAD_R * 0.72, 0.45, 26), mv2, mv, 0, -0.22);
    /* стержень */
    mesh(new THREE.CylinderGeometry(0.26, 0.26, 3.7, 14), mat.steel, mv, 0, 1.7);
    /* тарелка пружины (сухарь) */
    mesh(new THREE.CylinderGeometry(0.86, 0.7, 0.24, 20), mat.dark, mv, 0, 2.95);
    /* стакан-толкатель, по нему бьёт кулачок */
    const tapH = 1.2;
    const tappet = mesh(new THREE.CylinderGeometry(1.0, 1.0, tapH, 24), mat.metal, mv,
                        0, CAM_AX - L.CAM_R - tapH / 2);
    tappet.userData.kind = 'tappet';

    /* направляющая втулка и пружина — неподвижны, пружина сжимается */
    mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.7, 14), mat.cast, mount, 0, 1.75);
    const springLen = 2.4;
    const spring = springMesh(springLen, 0.62, 0.085, 6, mat.steel, mount);
    spring.position.y = 0.55;

    mount.userData = {
      moving: mv, tappet, spring, springLen,
      setLift(lift) {
        mv.position.y = -lift;
        spring.scale.y = Math.max(0.15, (springLen - lift) / springLen);
      },
    };
    mount.userData.setLift(0);
    return mount;
  }

  /* ═══════════ головка блока ═══════════ */
  function makeHead(zs, chainZ) {
    const g = new THREE.Group();                     // локальный ноль = плоскость головки
    const { len: zLen, mid: zMid } = bodyZ(zs);

    /* плита головки и клапанная крышка (прозрачные, режутся плоскостью) */
    mesh(new THREE.BoxGeometry(18.4, L.HEAD_H, zLen), mat.head, g, 0, L.HEAD_H / 2, zMid);
    mesh(new THREE.BoxGeometry(13.4, 4.6, zLen * 0.96), mat.cover, g, 0, L.HEAD_H + 2.3, zMid);

    /* распредвалы */
    const camIn = makeCam(zs, true, chainZ);
    camIn.position.set(-CAM_X, L.CAM_DY, 0);
    g.add(camIn);
    const camEx = makeCam(zs, false, chainZ);
    camEx.position.set(CAM_X, L.CAM_DY, 0);
    g.add(camEx);
    parts.camIn = camIn; parts.camEx = camEx;
    parts.sprocketIn = camIn.userData.sprocket;
    parts.sprocketEx = camEx.userData.sprocket;

    /* по цилиндрам: камера сгорания, клапаны, каналы, свеча/форсунка */
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      /* крышевидная камера сгорания — небольшой купол в плите */
      const dome = mesh(new THREE.SphereGeometry(L.BORE_R * 0.98, 28, 8, 0, Math.PI * 2, 0, Math.PI * 0.32),
                        mat.head, g, 0, -0.05, z);
      dome.scale.y = 0.35;

      const vi = makeValve(true);
      vi.position.set(L.VALVE_X_IN, 0, z);
      vi.rotation.z = VALVE_TILT;
      g.add(vi); parts.valvesIn.push(vi);
      parts.tappetsIn.push(vi.userData.tappet);
      parts.springsIn.push(vi.userData.spring);

      const ve = makeValve(false);
      ve.position.set(L.VALVE_X_EX, 0, z);
      ve.rotation.z = -VALVE_TILT;
      g.add(ve); parts.valvesEx.push(ve);
      parts.tappetsEx.push(ve.userData.tappet);
      parts.springsEx.push(ve.userData.spring);

      /* впускной и выпускной каналы */
      portTube(L.VALVE_X_IN - 0.35, 0.75, -8.9, 2.6, 0.9, mat.portIn, g, z);
      portTube(L.VALVE_X_EX + 0.35, 0.75, 8.9, 2.6, 0.85, mat.portEx, g, z);

      /* свеча зажигания (бензин) */
      const plug = new THREE.Group();
      plug.position.set(0, 0, z);
      mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.4, 12), mat.ceramic, plug, 0, 1.9);
      mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12), mat.steel, plug, 0, 0.4);
      mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 8), mat.steel, plug, 0, -0.35);
      g.add(plug); parts.plugs.push(plug);

      /* форсунка непосредственного впрыска (дизель) — на месте свечи */
      const inj = new THREE.Group();
      inj.position.set(0, 0, z);
      mesh(new THREE.CylinderGeometry(0.52, 0.52, 2.6, 14), mat.inject, inj, 0, 2.0);
      mesh(new THREE.ConeGeometry(0.34, 1.1, 14), mat.steel, inj, 0, 0.15);
      g.add(inj); parts.injectorsDirect.push(inj);

      /* форсунка во впускном канале (бензин) */
      const pinj = new THREE.Group();
      pinj.position.set(-7.6, 3.4, z);
      const body = mesh(new THREE.ConeGeometry(0.42, 1.7, 12), mat.inject, pinj);
      body.rotation.z = 2.62;
      g.add(pinj); parts.injectorsPort.push(pinj);
    }
    return g;
  }

  /* ═══════════ блок цилиндров, картер, поддон ═══════════ */
  function makeBlock(zs) {
    const g = new THREE.Group();
    const { len: zLen, mid: zMid } = bodyZ(zs);

    /* гильзы — единичной высоты, масштабируются по ε */
    for (const z of zs) {
      const w = mesh(new THREE.CylinderGeometry(L.BORE_R + 0.25, L.BORE_R + 0.25, 1, 44, 1, true),
                     mat.wall, g, 0, 0, z);
      parts.walls.push(w);
    }
    /* корпус блока (внутри него рубашка охлаждения) */
    const shell = mesh(new THREE.BoxGeometry(2 * (L.BORE_R + L.JACKET_GAP + 0.5), 1, zLen),
                       mat.block, g, 0, 0, zMid);
    parts.block = shell;

    /* картер и масляный поддон */
    const ccTop = WALL_BOT_Y, ccBot = L.SUMP_Y - 1.6;
    mesh(new THREE.BoxGeometry(15.2, ccTop - ccBot, zLen), mat.block, g, 0, (ccTop + ccBot) / 2, zMid);
    parts.crankcase = mesh(new THREE.BoxGeometry(13.4, 1.6, zLen * 0.9), mat.dark, g,
                           0, ccBot + 0.8, zMid);
    return g;
  }

  /* ═══════════ привод ГРМ: цепь ═══════════ */
  function rebuildChain() {
    const zs = cylinderZ(state.n);
    const chainZ = state.n === 1 ? CHAIN_Z_SINGLE : L.CHAIN_Z;
    const camY = L.deckY(state.eps) + L.CAM_DY;
    chainCircles = [
      { x: 0, y: 0, r: L.SPROCKET_CRANK_R },
      { x: CAM_X, y: camY, r: L.SPROCKET_CAM_R },
      { x: -CAM_X, y: camY, r: L.SPROCKET_CAM_R },
    ];
    const pts2 = beltPath(chainCircles);
    const pts3 = pts2.map(p => new THREE.Vector3(p.x, p.y, chainZ));

    /* длины дуг для движения звеньев */
    const cum = [0];
    for (let i = 1; i <= pts3.length; i++) {
      const a = pts3[i - 1], b = pts3[i % pts3.length];
      cum[i] = cum[i - 1] + a.distanceTo(b);
    }
    chainPath = { pts: pts3, cum, total: cum[cum.length - 1] };

    /* тело цепи — сплошная замкнутая петля */
    const curve = new THREE.CatmullRomCurve3(pts3, true, 'catmullrom', 0.02);
    const geo = new THREE.TubeGeometry(curve, Math.max(120, pts3.length * 2), 0.22, 6, true);
    if (parts.chain) {
      geoms.delete(parts.chain.geometry);
      parts.chain.geometry.dispose();
      parts.chain.geometry = G(geo);
    } else {
      parts.chain = new THREE.Mesh(G(geo), mat.chain);
      group.add(parts.chain);
    }

    /* звенья-пластины, бегущие по петле */
    const want = Math.max(24, Math.round(chainPath.total / 1.25));
    if (parts.chainLinks.length !== want) {
      for (const l of parts.chainLinks) { l.parent && l.parent.remove(l); }
      parts.chainLinks.length = 0;
      const linkGeo = G(new THREE.BoxGeometry(0.9, 0.62, 0.62));
      for (let i = 0; i < want; i++) {
        const l = new THREE.Mesh(linkGeo, mat.dark);
        group.add(l);
        parts.chainLinks.push(l);
      }
    }
    layoutChain(0);
  }

  /** Расставить звенья вдоль петли со смещением s (единицы сцены). */
  function layoutChain(s) {
    if (!chainPath || !parts.chainLinks.length) return;
    const { pts, cum, total } = chainPath;
    const step = total / parts.chainLinks.length;
    for (let k = 0; k < parts.chainLinks.length; k++) {
      let d = (s + k * step) % total;
      if (d < 0) d += total;
      /* бинарный поиск отрезка */
      let lo = 0, hi = cum.length - 1;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[(lo + 1) % pts.length];
      const segLen = Math.max(1e-6, cum[lo + 1] - cum[lo]);
      const t = clamp((d - cum[lo]) / segLen, 0, 1);
      const link = parts.chainLinks[k];
      link.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z);
      link.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }

  /* ═══════════ подписи ═══════════ */
  function makeLabels(zs) {
    const z0 = zs[0];
    const p0 = parts.pistons[0], r0 = parts.rods[0];
    label('Поршень', p0, L.BORE_R + 1.2, 0.4, 0);
    label('Компрессионные кольца', p0, -L.BORE_R - 1.4, L.PISTON_TOP_OFF - 1.3, 0);
    label('Маслосъёмное кольцо', p0, -L.BORE_R - 1.4, L.PISTON_TOP_OFF - 2.9, 0);
    label('Поршневой палец', p0, 0, -1.5, 2.6);
    label('Шатун', r0, 1.9, -L.ROD_L * 0.45, 0);
    label('Коленчатый вал', parts.crank, -6.4, -1.4, z0);
    const th0 = parts.crank.userData.throw0;
    if (th0) {
      label('Шатунная шейка', th0, 2.2, L.CRANK_R, 0);
      label('Противовес', th0, -3.4, -1.6, 0);
      label('Щека', th0, 0, 2.6, -3.4);
    }
    label('Коренная шейка', parts.crank, 0, -1.9, 0);
    label('Маховик (метка ВМТ)', parts.flywheel, 0, L.FLYWHEEL_R + 0.9, 0);
    label('Цилиндр', parts.walls[0], -L.BORE_R - 1.6, 0.32, 0);
    label('Головка блока', parts.head, -9.6, 1.6, z0);
    label('Впускной клапан', parts.valvesIn[0], -1.4, 1.0, 0);
    label('Выпускной клапан', parts.valvesEx[0], 1.4, 1.0, 0);
    label('Клапанная пружина', parts.valvesIn[0], -1.6, 2.4, 0);
    label('Толкатель (стакан)', parts.valvesEx[0], 1.6, CAM_AX - 1.0, 0);
    label('Распредвал впускной', parts.camIn, -2.6, 1.6, z0);
    label('Распредвал выпускной', parts.camEx, 2.6, 1.6, z0);
    label('Кулачок', parts.camEx, 0, -2.6, z0);
    label('Звёздочка коленвала', parts.sprocketCrank, 0, -L.SPROCKET_CRANK_R - 1.0, 0);
    label('Звёздочка распредвала', parts.sprocketIn, -L.SPROCKET_CAM_R - 1.2, 0.6, 0);
    label('Цепь ГРМ (2:1)', parts.head, -CAM_X - 2.0, L.CAM_DY - 7.5,
          state.n === 1 ? CHAIN_Z_SINGLE : L.CHAIN_Z);
    label('Свеча зажигания', parts.plugs[0], 0.4, 3.4, 0);
    label('Форсунка', parts.injectorsDirect[0], 0.4, 3.6, 0);
    label('Впускной канал', parts.head, -9.4, 3.4, z0);
    label('Выпускной канал', parts.head, 9.4, 3.4, z0);
  }

  /* ═══════════ сборка / разборка ═══════════ */
  function build() {
    mat = makeMaterials();
    const zs = cylinderZ(state.n);
    const chainZ = state.n === 1 ? CHAIN_Z_SINGLE : L.CHAIN_Z;

    parts.crank = makeCrank(zs);
    group.add(parts.crank);

    for (let i = 0; i < zs.length; i++) {
      const p = makePiston();
      p.position.z = zs[i];
      group.add(p);
      parts.pistons.push(p);

      const r = makeRod();
      r.position.z = zs[i];
      group.add(r);
      parts.rods.push(r);
    }

    parts.head = makeHead(zs, chainZ);
    group.add(parts.head);

    group.add(makeBlock(zs));

    rebuildChain();
    applyDeck();
    applyFuelMode(state.fuelMode);
    makeLabels(zs);
    updateAnchors();
  }

  function teardown() {
    /* подписи — сначала снять элементы из DOM */
    for (const o of labelObjs) {
      if (o.parent) o.parent.remove(o);
      if (o.element && typeof o.element.remove === 'function') {
        try { o.element.remove(); } catch (e) { /* нет DOM — не страшно */ }
      }
    }
    labelObjs = [];
    group.clear();
    for (const g of geoms) g.dispose();
    for (const m of mats) m.dispose();
    geoms = new Set(); mats = new Set();
    parts.pistons.length = 0; parts.rods.length = 0; parts.walls.length = 0;
    parts.valvesIn.length = 0; parts.valvesEx.length = 0;
    parts.tappetsIn.length = 0; parts.tappetsEx.length = 0;
    parts.springsIn.length = 0; parts.springsEx.length = 0;
    parts.chainLinks.length = 0; parts.plugs.length = 0;
    parts.injectorsDirect.length = 0; parts.injectorsPort.length = 0;
    parts.labels.length = 0;
    parts.crank = parts.camIn = parts.camEx = parts.head = null;
    parts.chain = null; parts.flywheel = null; parts.block = null; parts.crankcase = null;
    parts.sprocketCrank = parts.sprocketIn = parts.sprocketEx = null;
    chainPath = null; chainCircles = null;
  }

  /** Пересадить головку и гильзы под текущую степень сжатия. */
  function applyDeck() {
    const deck = L.deckY(state.eps);
    if (parts.head) parts.head.position.y = deck;
    const h = deck - WALL_BOT_Y;
    for (const w of parts.walls) { w.scale.y = h; w.position.y = WALL_BOT_Y + h / 2; }
    if (parts.block) { parts.block.scale.y = h; parts.block.position.y = WALL_BOT_Y + h / 2; }
  }

  function applyFuelMode(mode) {
    const diesel = mode === 'diesel';
    for (const p of parts.plugs) p.visible = !diesel;
    for (const p of parts.injectorsDirect) p.visible = diesel;
    for (const p of parts.injectorsPort) p.visible = !diesel;
  }

  /* ═══════════ точки привязки для модуля жидкостей ═══════════ */
  function updateAnchors() {
    const zs = cylinderZ(state.n);
    const deck = L.deckY(state.eps);
    const camY = deck + L.CAM_DY;
    const cyls = zs.map((z, i) => ({
      index: i,
      x: 0,
      z,
      /** Высота днища поршня в сцене; frame — FrameState либо доля хода 0…1. */
      crownY(frame) {
        let frac = 0;
        if (typeof frame === 'number') frac = frame;
        else if (frame && frame.cyl && frame.cyl[i]) frac = num(frame.cyl[i].pistonFrac, 0);
        return PIN_Y_TDC - clamp(frac, 0, 1) * L.STROKE_U + L.PISTON_TOP_OFF;
      },
      intakePortEnd:  new THREE.Vector3(-8.9, deck + 2.6, z),
      exhaustPortEnd: new THREE.Vector3(8.9, deck + 2.6, z),
      sparkTip:       new THREE.Vector3(0, deck - 0.8, z),
      injectorTip:    new THREE.Vector3(-6.9, deck + 2.7, z),   // порт-форсунка (бензин)
      dieselInjectorTip: new THREE.Vector3(0, deck - 0.4, z),   // прямой впрыск (дизель)
      valveInSeat:    new THREE.Vector3(L.VALVE_X_IN, deck, z),
      valveExSeat:    new THREE.Vector3(L.VALVE_X_EX, deck, z),
    }));

    const jr = L.BORE_R + L.JACKET_GAP;
    Object.assign(anchors, {
      deckY: deck,
      bore: L.BORE_R,
      cylinders: cyls,
      intakePortEnd: cyls[0].intakePortEnd,
      exhaustPortEnd: cyls[0].exhaustPortEnd,
      injectorTip: cyls[0].injectorTip,
      dieselInjectorTip: cyls[0].dieselInjectorTip,
      sparkTip: cyls[0].sparkTip,
      crankCenter: new THREE.Vector3(0, 0, 0),
      camInPos: new THREE.Vector3(-CAM_X, camY, zs[0]),
      camExPos: new THREE.Vector3(CAM_X, camY, zs[0]),
      sumpY: L.SUMP_Y,
      jacketBox: {
        min: new THREE.Vector3(-jr, WALL_BOT_Y, zs[0] - jr),
        max: new THREE.Vector3(jr, deck, zs[zs.length - 1] + jr),
      },
    });
    return anchors;
  }

  /* ═══════════ покадровое обновление ═══════════ */
  function update(frame) {
    if (!frame || !parts.crank) return;
    const deg = ((num(frame.deg, 0) % 720) + 720) % 720;
    const crankDeg = num(frame.crankDeg, deg % 360);
    const rad = crankDeg * DEG;

    parts.crank.rotation.z = -rad;

    const nc = Math.min(state.n, parts.pistons.length);
    for (let i = 0; i < nc; i++) {
      const c = (frame.cyl && frame.cyl[i]) || {};
      const frac = clamp(num(c.pistonFrac, 0), 0, 1);
      const pinY = PIN_Y_TDC - frac * L.STROKE_U;

      /* положение шатунной шейки этого цилиндра */
      const th = rad + L.CRANK_PHASE[i] * DEG;
      const cx = L.CRANK_R * Math.sin(th);
      const cy = L.CRANK_R * Math.cos(th);

      const p = parts.pistons[i];
      p.position.y = pinY;

      const r = parts.rods[i];
      r.position.y = pinY;
      r.rotation.z = Math.atan2(cx, pinY - cy);

      /* клапаны: подъём — из кадра, кулачок геометрически с ним совпадает */
      const li = clamp(num(c.liftIn, 0), 0, 1) * L.VALVE_LIFT_MAX;
      const le = clamp(num(c.liftEx, 0), 0, 1) * L.VALVE_LIFT_MAX;
      if (parts.valvesIn[i]) parts.valvesIn[i].userData.setLift(li);
      if (parts.valvesEx[i]) parts.valvesEx[i].userData.setLift(le);
    }

    /* распредвалы: ровно вдвое медленнее коленвала — один оборот на 720° цикла */
    const camRot = -deg * DEG / 2;
    if (parts.camIn) parts.camIn.rotation.z = camRot;
    if (parts.camEx) parts.camEx.rotation.z = camRot;

    /* цепь бежит вместе со звёздочкой коленвала */
    layoutChain(-rad * L.SPROCKET_CRANK_R);

    /* свеча/форсунка по типу топлива */
    const mode = frame.fuelMode === 'diesel' ? 'diesel' : 'petrol';
    if (mode !== state.fuelMode) { state.fuelMode = mode; applyFuelMode(mode); }
  }

  /* ═══════════ публичное API ═══════════ */
  function setCylinders(n) {
    const v = n === 1 ? 1 : 4;
    if (v === state.n) return;
    state.n = v;
    teardown();
    build();
  }

  function setCompression(eps) {
    const e = clamp(num(eps, state.eps), 4, 30);
    if (Math.abs(e - state.eps) < 1e-6) return;
    state.eps = e;
    applyDeck();
    rebuildChain();       // звёздочки распредвалов уехали — петля пересчитывается
    updateAnchors();
  }

  function setCutaway(on) {
    state.cutaway = !!on;
    const clip = state.cutaway ? [clipPlane] : null;
    for (const key of SHELL_MATS) {
      const m = mat && mat[key];
      if (!m) continue;
      const base = num(m.userData.baseOpacity, m.opacity);
      m.clippingPlanes = clip;
      m.opacity = state.cutaway ? base : Math.min(0.55, base + 0.12);
      m.needsUpdate = true;
    }
  }

  function setLabels(on) {
    state.labels = !!on;
    for (const o of labelObjs) {
      o.visible = state.labels;
      if (o.element && o.element.style) o.element.style.display = state.labels ? '' : 'none';
    }
  }

  function dispose() {
    teardown();
    if (group.parent) group.parent.remove(group);
  }

  build();

  return {
    group, parts, anchors,
    update, setCylinders, setCompression, setCutaway, setLabels, dispose,
    /** Текущее состояние модели (только чтение). */
    get state() { return { ...state }; },
    clippingPlane: clipPlane,
  };
}

export default buildMechanism;
