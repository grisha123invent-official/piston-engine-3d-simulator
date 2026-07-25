/**
 * src/engine3d.js — 3D-модель механизма двигателя (агент M / M2).
 *
 * Строит кривошипно-шатунный механизм, головку блока с DOHC-распредвалами,
 * клапаны с пружинами и толкателями, привод ГРМ цепью со звёздочками 2:1,
 * маховик и блок цилиндров. Освещение, камеру и рендерер модуль не трогает —
 * наружу отдаётся только THREE.Group.
 *
 * Вторая волна: компоновки single / i4 / V8 (развал 90°, крестообразный вал),
 * двухтактный вариант с окнами в стенке цилиндра, турбокомпрессор с интеркулером,
 * впускные патрубки изменяемой длины.
 *
 * Третья волна: оппозитная четвёрка boxer4 (горизонтальные ряды ±90°,
 * раздельные шатунные шейки со сдвигом 180°), балансирные валы под коленвалом,
 * прямой впрыск бензина (форсунка переезжает в головку), плавная анимация
 * длины впускного тракта для переменного впуска и профиль впускного кулачка
 * под цикл Аткинсона.
 *
 *   import { buildMechanism } from './engine3d.js';
 *   const mech = buildMechanism({ layout: 'v8', eps: 10 });
 *   scene.add(mech.group);
 *   mech.update(frame);            // каждый кадр, frame — FrameState (§6 + §5 контракта 2)
 *
 * Для работы разреза интегратор должен включить renderer.localClippingEnabled = true.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { L, layoutSpec, PIN_Y_TDC } from './layout.js';
import { t, onLangChange } from './i18n.js';

/* ═══════════ подписи деталей: пары { ru, en } ═══════════
   Строки живут здесь, а не в общем словаре: подпись и деталь читаются рядом.
   Термины — по единому глоссарию проекта (crank pin, bucket tappet, …). */
const LBL = {
  piston:      { ru: 'Поршень',                 en: 'Piston' },
  ringsComp:   { ru: 'Компрессионные кольца',   en: 'Compression rings' },
  ringOil:     { ru: 'Маслосъёмное кольцо',     en: 'Oil control ring' },
  pistonPin:   { ru: 'Поршневой палец',         en: 'Piston pin' },
  rod:         { ru: 'Шатун',                   en: 'Connecting rod' },
  crank:       { ru: 'Коленчатый вал',          en: 'Crankshaft' },
  crankPin:    { ru: 'Шатунная шейка',          en: 'Crank pin' },
  crankPin2:   { ru: 'Шатунная шейка (2 шатуна)', en: 'Crank pin (2 rods)' },
  counterw:    { ru: 'Противовес',              en: 'Counterweight' },
  web:         { ru: 'Щека',                    en: 'Crank web' },
  mainJournal: { ru: 'Коренная шейка',          en: 'Main journal' },
  flywheel:    { ru: 'Маховик (метка ВМТ)',     en: 'Flywheel (TDC mark)' },
  cylinder:    { ru: 'Цилиндр',                 en: 'Cylinder' },
  head:        { ru: 'Головка блока',           en: 'Cylinder head' },
  valveIn:     { ru: 'Впускной клапан',         en: 'Intake valve' },
  valveEx:     { ru: 'Выпускной клапан',        en: 'Exhaust valve' },
  spring:      { ru: 'Клапанная пружина',       en: 'Valve spring' },
  tappet:      { ru: 'Толкатель (стакан)',      en: 'Bucket tappet' },
  camIn:       { ru: 'Распредвал впускной',     en: 'Intake camshaft' },
  camEx:       { ru: 'Распредвал выпускной',    en: 'Exhaust camshaft' },
  lobe:        { ru: 'Кулачок',                 en: 'Cam lobe' },
  sprCrank:    { ru: 'Звёздочка коленвала',     en: 'Crank sprocket' },
  sprCam:      { ru: 'Звёздочка распредвала',   en: 'Cam sprocket' },
  chain:       { ru: 'Цепь ГРМ (2:1)',          en: 'Timing chain (2:1)' },
  portIn:      { ru: 'Впускной канал',          en: 'Intake port' },
  portEx:      { ru: 'Выпускной канал',         en: 'Exhaust port' },
  runner:      { ru: 'Впускной патрубок',       en: 'Intake runner' },
  plenum:      { ru: 'Впускной ресивер',        en: 'Intake plenum' },
  plenumVee:   { ru: 'Впускной ресивер (в развале)', en: 'Intake plenum (in the vee)' },
  plug:        { ru: 'Свеча зажигания',         en: 'Spark plug' },
  injector:    { ru: 'Форсунка',                en: 'Injector' },
  bankL:       { ru: 'Левый ряд, −45° (цил. 1,3,5,7)',  en: 'Left bank, −45° (cyl. 1,3,5,7)' },
  bankR:       { ru: 'Правый ряд, +45° (цил. 2,4,6,8)', en: 'Right bank, +45° (cyl. 2,4,6,8)' },
  bankLBox:    { ru: 'Левый ряд, −90° (цил. 1, 3)',  en: 'Left bank, −90° (cyl. 1, 3)' },
  bankRBox:    { ru: 'Правый ряд, +90° (цил. 2, 4)', en: 'Right bank, +90° (cyl. 2, 4)' },
  pinsBoxer:   { ru: 'Раздельные шатунные шейки, сдвиг 180°',
                 en: 'Separate crank pins, 180° apart' },
  webShared:   { ru: 'Общая щека соседних колен',   en: 'Web shared by adjacent throws' },
  opposed:     { ru: 'Противолежащие поршни идут навстречу',
                 en: 'Opposed pistons move towards each other' },
  portExh2T:   { ru: 'Выпускное окно',          en: 'Exhaust port' },
  portTr2T:    { ru: 'Продувочное окно',        en: 'Transfer port' },
  ductTr:      { ru: 'Продувочный канал',       en: 'Transfer duct' },
  crankcase:   { ru: 'Кривошипная камера',      en: 'Crankcase' },
  reed:        { ru: 'Лепестковый клапан',      en: 'Reed valve' },
  turbine:     { ru: 'Турбина (выпуск)',        en: 'Turbine (exhaust)' },
  compressor:  { ru: 'Компрессор (впуск)',      en: 'Compressor (intake)' },
  turboRotor:  { ru: 'Ротор турбокомпрессора',  en: 'Turbo rotor' },
  wastegate:   { ru: 'Вестгейт',                en: 'Wastegate' },
  intercooler: { ru: 'Интеркулер',              en: 'Intercooler' },
  /* ── третья волна ── */
  balShaft:    { ru: 'Балансирный вал',         en: 'Balance shaft' },
  balWeight:   { ru: 'Противовес балансирного вала', en: 'Balance shaft weight' },
  injPort:     { ru: 'Форсунка во впускном канале', en: 'Port fuel injector' },
  injGdi:      { ru: 'Форсунка непосредственного впрыска (у свечи)',
                 en: 'Direct injector (next to the spark plug)' },
};

/** Подпись балансирного вала: кратность и направление вращения — в тексте. */
function lblBalShaft(ratio, sameAsCrank) {
  const k = ratio === 2 ? '×2' : '×1';
  return {
    ru: `Балансирный вал ${k} (${sameAsCrank ? 'по вращению коленвала' : 'против коленвала'})`,
    en: `Balance shaft ${k} (${sameAsCrank ? 'same way as the crank' : 'opposite to the crank'})`,
  };
}

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
/* Цикл Аткинсона удлиняет фазу впуска: тот же предел, что и в физике. */
const ATK_MAX_DEG = 70;

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

/* ═══════════ двухтактный вариант: окна в стенке цилиндра ═══════════
   Угол окна отсчитывается как в CylinderGeometry: θ = 0 → +Z, θ = 90° → +X.
   Выпускное окно — на стороне +X (там же выпускной коллектор и турбина),
   два продувочных — по бокам напротив него (петлевая продувка по Шнюрле). */
const PORT_EX = { theta: 90 * DEG, span: 76 * DEG, top: L.PORT_EXH_TOP, bot: L.PORT_EXH_BOT };
const PORT_TR = [
  { theta: 205 * DEG, span: 56 * DEG, top: L.PORT_TR_TOP, bot: L.PORT_TR_BOT },
  { theta: 335 * DEG, span: 56 * DEG, top: L.PORT_TR_TOP, bot: L.PORT_TR_BOT },
];

/* ═══════════ впускной тракт и наддув ═══════════ */
const RUNNER_BASE_U = 7.0;          // длина патрубка (юниты) при L.INTAKE_LEN_REF мм
const RUNNER_ANG    = 34 * DEG;     // наклон патрубка от горизонтали (в системе ряда)
const RUNNER_R      = 0.78;
const INTAKE_MM_MIN = 150, INTAKE_MM_MAX = 900;

/* Плавность длины впуска: переменный впуск переключает её скачком (700 → 200 мм),
   а на глаз это должно выглядеть как ход механизма, а не как телепортация. */
const INTAKE_TAU_S = 0.12;          // за столько «доезжает» остаток пути
const INTAKE_RATE_MIN = 380;        // мм/с — чтобы хвост не тянулся бесконечно
const INTAKE_RATE_MAX = 1800;       // мм/с — чтобы большой скачок не выглядел рывком

const nowMs = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Date.now());

const UP_Y = new THREE.Vector3(0, 1, 0);

/** Точка (x,y) ряда с наклоном tilt → координаты группы механизма. */
function bankXY(x, y, tilt) {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return { x: x * c + y * s, y: -x * s + y * c };
}
/** Вектор точки ряда в системе механизма. */
function bankVec(x, y, z, tilt) {
  const p = bankXY(x, y, tilt);
  return new THREE.Vector3(p.x, p.y, z);
}

/** Поставить единичную трубу (CylinderGeometry(1,1,1)) между двумя точками. */
function placeTube(m, a, b, r) {
  if (!m) return;
  const d = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(1e-3, d.length());
  m.position.copy(a).addScaledVector(d, 0.5);
  m.scale.set(r, len, r);
  m.quaternion.setFromUnitVectors(UP_Y, d.divideScalar(len));
}

/** Нормализация имени компоновки: layout важнее, число цилиндров — запасной вариант. */
function normLayout(layout, cylinders) {
  if (layout === 'single' || layout === 'i4' || layout === 'v8' || layout === 'boxer4') return layout;
  const n = num(cylinders, 4);
  return n === 1 ? 'single' : n === 8 ? 'v8' : 'i4';
}

/* ═══════════ оппозитная компоновка ═══════════
   У боксёра противолежащие цилиндры сидят на РАЗНЫХ шатунных шейках со сдвигом
   180° — именно это отличает его от V-образника с развалом 180°, где шейка одна
   на два шатуна. Раздельные шейки стоят рядом вдоль вала, поэтому и сами
   цилиндры разнесены на ту же величину (как на настоящем оппозитнике). */
/* ═══════════ балансирные валы ═══════════ */
const BAL_X = 3.9;                    // валы по бокам от коленвала
const BAL_Y = -4.7;                   // и ниже его оси — в картере
const BAL_W_R = 1.85;                 // радиус противовеса

/* ═══════════ форсунка непосредственного впрыска (бензин) ═══════════
   Ставится в головку между впускным клапаном (|x| = 2.05) и свечой (x = 0),
   со сдвигом вдоль оси вала, чтобы не спорить ни с тем, ни с другой. */
const GDI_X = 1.35, GDI_DZ = 1.55;
const GDI_TILT = 22 * Math.PI / 180, GDI_TILT_Z = 16 * Math.PI / 180;

const PIN_SPLIT_U = 3.5;              // расстояние между соседними шейками пары
const WEB_OFF_SPLIT = PIN_SPLIT_U / 2; // щёки: внутренние совпадают → общая щека
const WEB_OFF = 2.85;                  // обычная щека (рядные и V8)

/**
 * Разбор компоновки на ряды (банки) и цилиндры.
 * Цилиндры одного наклона образуют ряд; цилиндры с одинаковым z сидят на общей
 * шатунной шейке (для V8 — по два шатуна на шейку).
 *
 * Кинематика наклонного ряда: группа ряда повёрнута на −tilt, поэтому в её
 * системе координат шатунная шейка стоит под эффективным углом
 *     θ_эф = θ_кв − pin + tilt₀ − tilt,
 * где tilt₀ — наклон первого цилиндра (крутящий момент отсчитывается так, чтобы
 * θ = 0 отвечало ВМТ цилиндра №1). Проверка по таблице LAYOUTS.v8:
 * θ_эф ≡ (deg + phase) mod 360 для всех восьми цилиндров.
 */
function parseLayout(name) {
  const spec = layoutSpec(name);
  const tilt0 = spec.cyl[0].tilt || 0;

  /* Станции вдоль вала — цилиндры с одинаковым z из таблицы компоновки.
     Если на станции одна шейка (V8) — колено одно, на нём два шатуна.
     Если шейки разные (боксёр) — станция расщепляется на два колена,
     разнесённых вдоль вала на PIN_SPLIT_U; вместе с ними разъезжаются и сами
     цилиндры, поэтому нижняя головка шатуна остаётся точно на своей шейке. */
  const stations = [];
  for (const c of spec.cyl) {
    let st = stations.find(s => s.z === c.z);
    if (!st) { st = { z: c.z, pins: [] }; stations.push(st); }
    if (!st.pins.includes(c.pin)) st.pins.push(c.pin);
  }
  const throws = [];
  const zOfThrow = new Map();                       // «zНом|шейка» → z колена
  for (const st of stations) {
    const m = st.pins.length;
    st.pins.forEach((pin, k) => {
      const z = st.z + (m > 1 ? (k - (m - 1) / 2) * PIN_SPLIT_U : 0);
      zOfThrow.set(st.z + '|' + pin, z);
      throws.push({ z, zNom: st.z, pin, index: 0, split: m > 1,
                    webOff: m > 1 ? WEB_OFF_SPLIT : WEB_OFF, cyl: [] });
    });
  }
  throws.sort((a, b) => a.z - b.z);
  throws.forEach((t, i) => {
    t.index = i;
    /* поворот колена: мировой угол шейки = θ_кв − pin + tilt₀ */
    t.rot = (t.pin - tilt0 / DEG) * DEG;
  });

  const banks = [];
  const cyl = spec.cyl.map((c, i) => {
    let b = banks.find(v => Math.abs(v.tilt - c.tilt) < 1e-9);
    if (!b) {
      b = { bank: banks.length, tilt: c.tilt, idx: [], zs: [], phases: [],
            /* левый (наклонённый в −X) ряд зеркалим, чтобы впуск смотрел в развал,
               а у оппозитника — вверх, как на настоящем боксёре */
            sx: c.tilt < -1e-9 ? -1 : 1 };
      banks.push(b);
    }
    const th = throws.find(t => t.zNom === c.z && t.pin === c.pin);
    th.cyl.push(i);
    const z = zOfThrow.get(c.z + '|' + c.pin);
    const rec = {
      index: i, z, zNom: c.z, tilt: c.tilt, phase: c.phase, pin: c.pin,
      bank: b.bank, k: b.idx.length, throw: th.index, split: th.split,
      /* смещение эффективного угла относительно угла коленвала, град. */
      effOff: -c.pin + (tilt0 - c.tilt) / DEG,
    };
    b.idx.push(i); b.zs.push(z); b.phases.push(c.phase);
    return rec;
  });
  return { name, spec, banks, cyl, throws, n: spec.cylinders, tilt0 };
}

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
 * @param {{cylinders?:1|4|8, layout?:'single'|'i4'|'boxer4'|'v8', eps?:number,
 *          cutaway?:boolean, labels?:boolean, fuelMode?:string, twoStroke?:boolean,
 *          turbo?:boolean, intercooler?:boolean, intakeLen_mm?:number,
 *          balanceShafts?:boolean, directInjection?:boolean}} opts
 * @returns {Mechanism}
 */
export function buildMechanism(opts = {}) {
  const state = {
    layout: normLayout(opts.layout, opts.cylinders),
    n: 1,
    eps: num(opts.eps, 10),
    cutaway: opts.cutaway !== false,
    labels: opts.labels !== false,
    fuelMode: opts.fuelMode === 'diesel' ? 'diesel' : 'petrol',
    twoStroke: !!opts.twoStroke,
    turbo: !!opts.turbo,
    turboShown: !!opts.turbo,          // фактическая видимость узла наддува
    intercooler: opts.intercooler !== false,
    intakeLen_mm: clamp(num(opts.intakeLen_mm, L.INTAKE_LEN_REF), INTAKE_MM_MIN, INTAKE_MM_MAX),
    boost_bar: 0,
    chargeT_K: 300,
    /* ── третья волна ── */
    balanceShafts: !!opts.balanceShafts,
    directInjection: !!opts.directInjection,
    atkinson_deg: clamp(num(opts.atkinson_deg, 0), 0, ATK_MAX_DEG),
  };
  /* целевая длина впуска: переменный впуск дёргает её на ходу, поэтому
     видимая длина едет к цели плавно (см. stepIntake) */
  state.intakeLenTarget_mm = state.intakeLen_mm;
  /* двухтактный вариант — только одноцилиндровый (см. §0 контракта 2) */
  if (state.twoStroke) state.layout = 'single';
  let LO = parseLayout(state.layout);
  state.n = LO.n;

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
    /* ── вторая волна ── */
    banks: [],            // THREE.Group на каждый ряд (наклон ±45° у V8)
    heads: [], blocks: [], camsIn: [], camsEx: [], chains: [],
    portsExhaust: [], portsTransfer: [],   // окна двухтактного
    portFrames: [], transferDucts: [], crankcaseShell: null, reed: null,
    runners: [], stacks: [], plenum: null,
    turbo: null, turbineWheel: null, compressorWheel: null, turboShaft: null,
    intercooler: null, wastegate: null, pipes: [],
    /* ── третья волна ── */
    balanceShafts: [], balanceGroup: null, injectorsGdi: [], gdiTips: [],
  };
  const anchors = {};

  /* ── реестр ресурсов для dispose ── */
  let geoms = new Set(), mats = new Set(), labelObjs = [];
  const G = g => { geoms.add(g); return g; };
  const M = m => { mats.add(m); return m; };

  let mat = null;          // текущий набор материалов
  let shellMats = [];      // все материалы-оболочки (у каждого ряда своя плоскость реза)
  let pipeGeo = null;      // общая единичная труба для всех патрубков
  let banks = [];          // рабочие описания рядов (группа + петля ГРМ)
  let turboSpin = 0, prevCrank = null;
  let lastUpdateMs = null, intakeStepMs = null;

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
      /* ── вторая волна ── */
      hot:    M(new THREE.MeshStandardMaterial({ color: 0x7a4a38, metalness: 0.75, roughness: 0.55,
                emissive: 0x140600 })),
      alu:    M(new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.8, roughness: 0.4 })),
      core:   M(new THREE.MeshStandardMaterial({ color: 0x5f6b78, metalness: 0.6, roughness: 0.5 })),
      runner: M(new THREE.MeshStandardMaterial({ color: 0x5b7ea8, metalness: 0.55, roughness: 0.45,
                transparent: true, opacity: 0.55, side: THREE.DoubleSide })),
      exhaust:M(new THREE.MeshStandardMaterial({ color: 0x6d6058, metalness: 0.6, roughness: 0.55,
                transparent: true, opacity: 0.6, side: THREE.DoubleSide })),
      portEdge: M(new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.5, roughness: 0.7,
                side: THREE.DoubleSide })),
    };
    /* окна двухтактного — свои материалы, чтобы менять свечение по открытию */
    set.glowEx = M(new THREE.MeshStandardMaterial({ color: 0xff7a3a, emissive: 0xff5a10,
      emissiveIntensity: 0.6, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    set.glowIn = M(new THREE.MeshStandardMaterial({ color: 0x6fc4ff, emissive: 0x1e7ad0,
      emissiveIntensity: 0.6, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    /* запоминаем «разрезную» прозрачность оболочек — при выключенном разрезе
       делаем их чуть плотнее, чтобы корпус читался как деталь */
    for (const k of SHELL_MATS) registerShell(set[k], clipPlane);
    return set;
  }

  /** Материал-оболочка со своей плоскостью разреза. */
  function registerShell(m, plane) {
    m.userData.baseOpacity = m.opacity;
    m.userData.plane = plane;
    m.clippingPlanes = state.cutaway ? [plane] : null;
    shellMats.push(m);
    return m;
  }

  /**
   * Набор материалов ряда: у наклонного ряда плоскость разреза повёрнута
   * вместе с ним, иначе весь правый ряд V8 срезался бы целиком.
   */
  function bankMaterials(tilt) {
    if (Math.abs(tilt) < 1e-9) return mat;
    const n = bankXY(-1, 0, tilt);
    const plane = new THREE.Plane(new THREE.Vector3(n.x, n.y, 0), 0.02);
    const set = Object.create(mat);
    for (const k of SHELL_MATS) set[k] = registerShell(M(mat[k].clone()), plane);
    set.clipPlane = plane;
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

  /**
   * Подпись детали; крепится к объекту, поэтому едет вместе с ним.
   * dict — пара { ru, en } (обычная строка тоже сойдёт); пара остаётся жить
   * в userData.i18n, чтобы при смене языка переписать только текст.
   */
  function label(dict, parent, x, y, z, tag) {
    if (!parent) return null;
    let el;
    if (typeof document !== 'undefined' && document.createElement) {
      el = document.createElement('div');
      el.className = 'lbl';
      el.textContent = t(dict);
    }
    const o = el ? new CSS2DObject(el) : new CSS2DObject();
    o.userData.i18n = dict;
    if (tag) o.userData.tag = tag;
    o.position.set(x, y, z);
    o.visible = state.labels;
    if (el) el.style.display = state.labels ? '' : 'none';
    parent.add(o);
    labelObjs.push(o);
    parts.labels.push(o);
    return o;
  }

  /** Смена языка: переписываем тексты уже существующих подписей, сцену не трогаем. */
  function refreshLabels() {
    for (const o of labelObjs) {
      if (!o || !o.element) continue;
      o.element.textContent = t(o.userData.i18n);
    }
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
  /**
   * Крестообразный (у V8) коленвал: по колену на каждую шатунную шейку,
   * поворот колена th.rotation.z = pin − tilt₀, чтобы при θ_кв = 0 шейка
   * первого цилиндра смотрела вдоль оси его (наклонного) цилиндра.
   */
  function makeCrank(chainZs) {
    const g = new THREE.Group();
    const zs = LO.throws.map(t => t.z);
    const n = zs.length;
    const mainZ = [zs[0] - 4.1];
    for (let i = 1; i < n; i++) {
      /* у пары раздельных шеек боксёра между коленами общая щека — коренной
         шейки там нет, иначе она бы села прямо на щёки */
      if (LO.throws[i].zNom === LO.throws[i - 1].zNom) continue;
      mainZ.push((zs[i - 1] + zs[i]) / 2);
    }
    mainZ.push(zs[n - 1] + 4.1);
    const mainW = n === 1 ? 2.0 : 2.6;
    for (const z of mainZ) zCyl(L.MAIN_R, L.MAIN_R, mainW, 24, mat.steel, g, 0, 0, z);

    /* носок вала под звёздочки ГРМ */
    const noseFrom = mainZ[0] + mainW / 2, noseTo = Math.min(...chainZs) - 0.8;
    zCyl(0.95, 0.95, Math.abs(noseFrom - noseTo), 20, mat.steel, g, 0, 0,
         (noseFrom + noseTo) / 2);

    /* хвостовик под маховик */
    const fwZ = flywheelZ();
    const tailFrom = mainZ[mainZ.length - 1] - mainW / 2;
    zCyl(1.05, 1.05, Math.abs(fwZ - tailFrom), 20, mat.steel, g, 0, 0, (fwZ + tailFrom) / 2);

    /* колена: щёки + противовесы + шатунная шейка */
    LO.throws.forEach((t, i) => {
      const th = new THREE.Group();
      th.rotation.z = t.rot;
      th.position.z = t.z;
      g.add(th);
      const wide = t.cyl.length > 1;              // общая шейка на два шатуна (V8)
      const wo = num(t.webOff, WEB_OFF);          // у раздельных шеек щёки сдвинуты внутрь
      for (const s of [-wo, wo]) {
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
      /* шатунная шейка: широкая под два шатуна (V8), узкая у раздельных шеек боксёра */
      const pin = zCyl(L.PIN_R, L.PIN_R, wide ? 5.0 : t.split ? 2.4 : 4.2, 22,
                       mat.steel, th, 0, L.CRANK_R, 0);
      th.userData.pin = pin;
      th.userData.pinAngle = t.rot;
      th.userData.throwZ = t.z;
      g.userData['throw' + i] = th;
    });

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

    /* звёздочка коленвала на каждую петлю ГРМ — вдвое меньше кулачковых */
    chainZs.forEach((cz, k) => {
      const spr = makeSprocket(L.SPROCKET_CRANK_R, 9, 0.85);
      spr.position.z = cz;
      g.add(spr);
      if (k === 0) parts.sprocketCrank = spr;
    });
    return g;
  }

  /** Положение маховика вдоль вала для текущей компоновки. */
  function flywheelZ() {
    const zs = LO.throws.map(t => t.z);
    if (LO.name === 'single') return L.FLYWHEEL_Z_SINGLE;
    if (LO.name === 'i4') return L.FLYWHEEL_Z_I4;
    return zs[zs.length - 1] + 6.5;
  }

  /** Плоскости цепей ГРМ: по одной на ряд. */
  function chainZs() {
    const zs = LO.throws.map(t => t.z);
    const base = LO.name === 'single' ? CHAIN_Z_SINGLE : Math.min(L.CHAIN_Z, zs[0] - 5.0);
    return LO.banks.map((b, k) => base - k * 1.9);
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
  function makeCam(zs, phases, isIntake, chainZ, sx = 1) {
    const g = new THREE.Group();
    const half = isIntake ? IN_HALF : EX_HALF;
    const peak = isIntake ? IN_PEAK : EX_PEAK;
    /* направление «вниз по оси клапана» от оси кулачка; при зеркальном ряде
       (левый ряд V8) вся головка отражена по X, отражается и это направление */
    const down = isIntake ? Math.PI + sx * VALVE_TILT : Math.PI - sx * VALVE_TILT;

    const zFrom = chainZ - 0.9, zTo = zs[zs.length - 1] + 3.2;
    zCyl(0.62, 0.62, zTo - zFrom, 20, mat.steel, g, 0, 0, (zFrom + zTo) / 2);

    const lobeGeo = camLobeGeometry(1.5, half);
    const lobes = [];
    for (let i = 0; i < zs.length; i++) {
      const lobe = new THREE.Mesh(G(lobeGeo), mat.cast);
      lobe.position.z = zs[i];
      lobe.rotation.z = down + (peak - num(phases[i], 0)) * DEG / 2;
      g.add(lobe);
      lobes.push(lobe);
      /* опорная шейка рядом с кулачком */
      zCyl(0.8, 0.8, 0.9, 18, mat.steel, g, 0, 0, zs[i] + 2.3);
    }
    /* профиль впускного кулачка перестраивается под цикл Аткинсона (см. applyAtkinson) */
    g.userData.lobes = lobes;
    g.userData.lobeGeo = lobeGeo;
    g.userData.down = down;
    g.userData.phases = phases.slice();
    g.userData.isIntake = isIntake;
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
  /**
   * Головка ряда. sx = −1 — зеркальная головка (левый ряд V8): впуск смотрит
   * в развал, выпуск наружу. Все X-координаты умножаются на sx.
   */
  function makeHead(b, chainZ) {
    const zs = b.zs, sx = b.sx, mm = b.mat || mat;
    const g = new THREE.Group();                     // локальный ноль = плоскость головки
    const { len: zLen, mid: zMid } = bodyZ(zs);

    /* плита головки и клапанная крышка (прозрачные, режутся плоскостью) */
    mesh(new THREE.BoxGeometry(18.4, L.HEAD_H, zLen), mm.head, g, 0, L.HEAD_H / 2, zMid);
    mesh(new THREE.BoxGeometry(13.4, 4.6, zLen * 0.96), mm.cover, g, 0, L.HEAD_H + 2.3, zMid);

    /* распредвалы */
    const camIn = makeCam(zs, b.phases, true, chainZ, sx);
    camIn.position.set(-sx * CAM_X, L.CAM_DY, 0);
    g.add(camIn);
    const camEx = makeCam(zs, b.phases, false, chainZ, sx);
    camEx.position.set(sx * CAM_X, L.CAM_DY, 0);
    g.add(camEx);
    parts.camsIn[b.bank] = camIn; parts.camsEx[b.bank] = camEx;
    if (b.bank === 0) {
      parts.camIn = camIn; parts.camEx = camEx;
      parts.sprocketIn = camIn.userData.sprocket;
      parts.sprocketEx = camEx.userData.sprocket;
    }

    /* по цилиндрам: камера сгорания, клапаны, каналы, свеча/форсунка */
    for (let k = 0; k < zs.length; k++) {
      const z = zs[k], gi = b.idx[k];
      /* крышевидная камера сгорания — небольшой купол в плите */
      const dome = mesh(new THREE.SphereGeometry(L.BORE_R * 0.98, 28, 8, 0, Math.PI * 2, 0, Math.PI * 0.32),
                        mm.head, g, 0, -0.05, z);
      dome.scale.y = 0.35;

      const vi = makeValve(true);
      vi.position.set(sx * L.VALVE_X_IN, 0, z);
      vi.rotation.z = sx * VALVE_TILT;
      g.add(vi);
      parts.valvesIn[gi] = vi;
      parts.tappetsIn[gi] = vi.userData.tappet;
      parts.springsIn[gi] = vi.userData.spring;

      const ve = makeValve(false);
      ve.position.set(sx * L.VALVE_X_EX, 0, z);
      ve.rotation.z = -sx * VALVE_TILT;
      g.add(ve);
      parts.valvesEx[gi] = ve;
      parts.tappetsEx[gi] = ve.userData.tappet;
      parts.springsEx[gi] = ve.userData.spring;

      /* впускной и выпускной каналы */
      portTube(sx * (L.VALVE_X_IN - 0.35), 0.75, sx * -8.9, 2.6, 0.9, mat.portIn, g, z);
      portTube(sx * (L.VALVE_X_EX + 0.35), 0.75, sx * 8.9, 2.6, 0.85, mat.portEx, g, z);

      /* впускной патрубок изменяемой длины (резонанс) */
      const run = new THREE.Group();
      run.position.set(sx * -8.9, 2.6, z);
      run.rotation.z = Math.atan2(sx * Math.cos(RUNNER_ANG), Math.sin(RUNNER_ANG));
      const tube = new THREE.Mesh(pipeGeo, mat.runner);
      run.add(tube);
      const stack = mesh(new THREE.CylinderGeometry(RUNNER_R * 1.45, RUNNER_R, 0.7, 18, 1, true),
                         mat.runner, run);
      g.add(run);
      parts.runners[gi] = { group: run, tube, stack, bank: b.bank, sx, z };
      parts.stacks[gi] = stack;

      /* свеча зажигания (бензин) */
      const plug = new THREE.Group();
      plug.position.set(0, 0, z);
      mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.4, 12), mat.ceramic, plug, 0, 1.9);
      mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12), mat.steel, plug, 0, 0.4);
      mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 8), mat.steel, plug, 0, -0.35);
      g.add(plug); parts.plugs[gi] = plug;

      /* форсунка непосредственного впрыска (дизель) — на месте свечи */
      const inj = new THREE.Group();
      inj.position.set(0, 0, z);
      mesh(new THREE.CylinderGeometry(0.52, 0.52, 2.6, 14), mat.inject, inj, 0, 2.0);
      mesh(new THREE.ConeGeometry(0.34, 1.1, 14), mat.steel, inj, 0, 0.15);
      g.add(inj); parts.injectorsDirect[gi] = inj;

      /* форсунка во впускном канале (бензин, распределённый впрыск) */
      const pinj = new THREE.Group();
      pinj.position.set(sx * -7.6, 3.4, z);
      const body = mesh(new THREE.ConeGeometry(0.42, 1.7, 12), mat.inject, pinj);
      body.rotation.z = sx * 2.62;
      g.add(pinj); parts.injectorsPort[gi] = pinj;

      /* форсунка непосредственного впрыска бензина: сидит в головке рядом
         со свечой, между впускным клапаном и центром камеры, и льёт прямо
         в цилиндр. Включается setDirectInjection(true). */
      const gdi = new THREE.Group();
      gdi.position.set(-sx * GDI_X, 0, z + GDI_DZ);   // со стороны впуска, рядом со свечой
      gdi.rotation.z = sx * GDI_TILT;                 // распылителем к центру камеры
      gdi.rotation.x = -GDI_TILT_Z;
      mesh(new THREE.CylinderGeometry(0.4, 0.4, 2.3, 12), mat.inject, gdi, 0, 1.55);
      mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.4, 12), mat.dark, gdi, 0, 2.9);
      mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.7, 10), mat.steel, gdi, 0, 0.15);
      mesh(new THREE.ConeGeometry(0.24, 0.5, 10), mat.steel, gdi, 0, -0.35);
      g.add(gdi); parts.injectorsGdi[gi] = gdi;
      /* кончик распылителя в системе головки (y отсчитывается от плоскости головки) */
      parts.gdiTips[gi] = new THREE.Vector3(0, -0.62, 0)
        .applyEuler(gdi.rotation).add(gdi.position);
    }
    return g;
  }

  /* ═══════════ головка двухтактного (без клапанов) ═══════════ */
  function makeHead2T(b) {
    const zs = b.zs, mm = b.mat || mat;
    const g = new THREE.Group();
    const { len: zLen, mid: zMid } = bodyZ(zs);
    mesh(new THREE.BoxGeometry(2 * (L.BORE_R + 1.6), L.HEAD_H, zLen), mm.head, g, 0, L.HEAD_H / 2, zMid);
    /* рёбра воздушного охлаждения — характерный вид двухтактной головки */
    for (let i = 0; i < 4; i++)
      mesh(new THREE.CylinderGeometry(L.BORE_R + 1.5, L.BORE_R + 1.5, 0.28, 30),
           mat.cast, g, 0, L.HEAD_H + 0.45 + i * 0.75, zMid);

    for (let k = 0; k < zs.length; k++) {
      const z = zs[k], gi = b.idx[k];
      const dome = mesh(new THREE.SphereGeometry(L.BORE_R * 0.96, 28, 8, 0, Math.PI * 2, 0, Math.PI * 0.34),
                        mm.head, g, 0, -0.05, z);
      dome.scale.y = 0.4;
      const plug = new THREE.Group();
      plug.position.set(0, 0, z);
      mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.4, 12), mat.ceramic, plug, 0, 1.9);
      mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12), mat.steel, plug, 0, 0.4);
      mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 8), mat.steel, plug, 0, -0.35);
      g.add(plug); parts.plugs[gi] = plug;
      parts.injectorsDirect[gi] = null; parts.injectorsPort[gi] = null;
      parts.injectorsGdi[gi] = null; parts.gdiTips[gi] = null;
    }
    return g;
  }

  /* ═══════════ блок цилиндров ═══════════ */
  /** Высота днища поршня (ось ряда) при доле хода frac. */
  function crownAxisY(frac) {
    return PIN_Y_TDC - clamp(frac, 0, 1) * L.STROKE_U + L.PISTON_TOP_OFF;
  }

  function makeBlock(b) {
    const zs = b.zs, mm = b.mat || mat;
    const g = new THREE.Group();
    const { len: zLen, mid: zMid } = bodyZ(zs);

    /* гильзы — единичной высоты, масштабируются по ε */
    for (let k = 0; k < zs.length; k++) {
      const w = mesh(new THREE.CylinderGeometry(L.BORE_R + 0.25, L.BORE_R + 0.25, 1, 44, 1, true),
                     mm.wall, g, 0, 0, zs[k]);
      parts.walls[b.idx[k]] = w;
    }
    /* корпус блока (внутри него рубашка охлаждения) */
    const shell = mesh(new THREE.BoxGeometry(2 * (L.BORE_R + L.JACKET_GAP + 0.5), 1, zLen),
                       mm.block, g, 0, 0, zMid);
    if (b.bank === 0) parts.block = shell;
    parts.blocks[b.bank] = shell;
    if (state.twoStroke) makePorts(b, g);
    return g;
  }

  /* ═══════════ окна двухтактного в стенке цилиндра ═══════════ */
  /**
   * Окно — дуга в стенке гильзы. Верхняя кромка стоит там, где днище поршня
   * при доле хода port.top, нижняя — при port.bot. Поршень юбкой перекрывает
   * всё, что ниже своего днища, поэтому открытая часть окна — от кромки
   * до днища поршня; её высоту и считаем каждый кадр.
   */
  function makePorts(b, g) {
    const z = b.zs[0];
    for (const spec of [PORT_EX, ...PORT_TR]) {
      const isEx = spec === PORT_EX;
      const topY = crownAxisY(spec.top), botY = crownAxisY(spec.bot);
      const th0 = spec.theta - spec.span / 2;
      /* тёмная «ниша» окна во всю высоту — виден вырез в стенке */
      const frame = mesh(new THREE.CylinderGeometry(L.BORE_R + 0.34, L.BORE_R + 0.34, topY - botY,
                          20, 1, true, th0, spec.span), mat.portEdge, g, 0, (topY + botY) / 2, z);
      frame.userData.kind = 'portFrame';
      parts.portFrames.push(frame);
      /* открытая часть окна (единичная высота, масштабируется по положению поршня) */
      const ap = mesh(new THREE.CylinderGeometry(L.BORE_R + 0.16, L.BORE_R + 0.16, 1,
                       20, 1, true, th0, spec.span),
                      isEx ? mat.glowEx : mat.glowIn, g, 0, (topY + botY) / 2, z);
      const rec = {
        mesh: ap, frame, topY, botY, theta: spec.theta, span: spec.span,
        z, cyl: b.idx[0], tilt: b.tilt, kind: isEx ? 'exhaust' : 'transfer',
        open: 0,
      };
      if (isEx) parts.portsExhaust.push(rec); else parts.portsTransfer.push(rec);

      const dx = Math.sin(spec.theta), dz = Math.cos(spec.theta);
      if (isEx) {
        /* выпускной патрубок наружу */
        const pipe = new THREE.Mesh(pipeGeo, mat.exhaust);
        g.add(pipe);
        placeTube(pipe,
          new THREE.Vector3(dx * (L.BORE_R + 0.2), (topY + botY) / 2, z + dz * (L.BORE_R + 0.2)),
          new THREE.Vector3(dx * (L.BORE_R + 6.2), (topY + botY) / 2 + 1.2, z + dz * (L.BORE_R + 6.2)),
          1.0);
        rec.duct = pipe;
      } else {
        /* продувочный канал из кривошипной камеры вверх к окну */
        const R = L.BORE_R + 1.45;
        const duct = new THREE.Mesh(pipeGeo, mat.portIn);
        g.add(duct);
        placeTube(duct,
          new THREE.Vector3(dx * R, WALL_BOT_Y - 2.6, z + dz * R),
          new THREE.Vector3(dx * R, topY + 0.3, z + dz * R), 0.92);
        parts.transferDucts.push(duct);
        rec.duct = duct;
        /* окно входа канала в кривошипную камеру */
        mesh(new THREE.SphereGeometry(1.05, 14, 10), mat.portIn, g,
             dx * R, WALL_BOT_Y - 2.9, z + dz * R);
      }
    }
  }

  /* ═══════════ картер и поддон (общие для всех рядов) ═══════════ */
  function makeCase() {
    const g = new THREE.Group();
    const zs = LO.throws.map(t => t.z);
    const { len: zLen, mid: zMid } = bodyZ(zs);

    if (state.twoStroke) {
      /* герметичная кривошипная камера: цилиндрический корпус вокруг вала */
      const R = 6.4, len = 9.0;
      const shell = zCyl(R, R, len, 40, mat.block, g, 0, 0.6, zMid);
      shell.userData.kind = 'crankcase';
      parts.crankcaseShell = shell;
      zCyl(R, R, 0.5, 40, mat.cast, g, 0, 0.6, zMid - len / 2);
      zCyl(R, R, 0.5, 40, mat.cast, g, 0, 0.6, zMid + len / 2);
      /* впуск в картер через лепестковый клапан */
      const reed = new THREE.Group();
      reed.position.set(-R - 0.9, 0.6, zMid);
      mesh(new THREE.BoxGeometry(2.2, 2.6, 3.0), mat.cast, reed);
      mesh(new THREE.BoxGeometry(0.16, 2.0, 1.1), mat.steel, reed, 0.9, 0, -0.7);
      mesh(new THREE.BoxGeometry(0.16, 2.0, 1.1), mat.steel, reed, 0.9, 0, 0.7);
      g.add(reed); parts.reed = reed;
      parts.crankcase = shell;
      g.userData.box = { min: new THREE.Vector3(-R, 0.6 - R, zMid - len / 2),
                         max: new THREE.Vector3(R, 0.6 + R, zMid + len / 2) };
      return g;
    }

    /* у оппозитника картер узкий: по бокам сразу начинаются горизонтальные
       гильзы, а поддон мелкий — отсюда и плоский силуэт */
    const wide = LO.name === 'v8' ? 19.0 : LO.name === 'boxer4' ? 12.2 : 15.2;
    const ccTop = WALL_BOT_Y, ccBot = L.SUMP_Y - 1.6;
    mesh(new THREE.BoxGeometry(wide, ccTop - ccBot, zLen), mat.block, g, 0, (ccTop + ccBot) / 2, zMid);
    parts.crankcase = mesh(new THREE.BoxGeometry(wide - 1.8, 1.6, zLen * 0.9), mat.dark, g,
                           0, ccBot + 0.8, zMid);
    g.userData.box = { min: new THREE.Vector3(-wide / 2, ccBot, zs[0] - Z_PAD_FRONT),
                       max: new THREE.Vector3(wide / 2, ccTop, zs[zs.length - 1] + Z_PAD_BACK) };
    return g;
  }

  /* ═══════════ балансирные валы ═══════════ */
  /**
   * Два вала с противовесами под коленвалом. Вращаются навстречу друг другу:
   * левый — против вращения коленвала, правый — вместе с ним. Кратность:
   * у одноцилиндрового 1× (гасят первый порядок), у рядной четвёрки 2×
   * (валы Ланчестера, второй порядок). У оппозитника и V8 гасить почти нечего,
   * поэтому валы там оставлены на 1× — это видно и по подписи.
   */
  function balanceRatio() {
    return LO.name === 'i4' ? 2 : 1;
  }

  function makeBalanceShafts() {
    if (state.twoStroke) return null;             // картер герметичный, валам там не место
    const g = new THREE.Group();
    g.name = 'balanceShafts';
    const zs = LO.throws.map(t => t.z);
    const z0 = zs[0] - 2.8, z1 = zs[zs.length - 1] + 2.8;
    const ratio = balanceRatio();
    /* противовесы: у одноцилиндрового один посередине, иначе по краям вала */
    const wz = zs.length > 1 ? [zs[0], zs[zs.length - 1]] : [0];

    [-1, 1].forEach((sx, k) => {
      const sh = new THREE.Group();
      sh.position.set(sx * BAL_X, BAL_Y, 0);
      /* сам вал */
      zCyl(0.44, 0.44, z1 - z0, 16, mat.steel, sh, 0, 0, (z0 + z1) / 2);
      /* эксцентричные противовесы — полудиски, как на коленвале */
      for (const z of wz) {
        const cw = mesh(new THREE.CylinderGeometry(BAL_W_R, BAL_W_R, 1.15, 24, 1, false,
                                                   Math.PI / 2, Math.PI), mat.dark, sh, 0, -0.45, z);
        cw.rotation.x = Math.PI / 2;
        cw.rotation.y = Math.PI;
        cw.userData.kind = 'balanceWeight';
      }
      /* светлая метка на тяжёлой стороне: по ней глазом видно и скорость, и сторону вращения */
      mesh(new THREE.BoxGeometry(0.46, 0.5, z1 - z0), mat.mark, sh,
           0, -(BAL_W_R + 0.1), (z0 + z1) / 2);
      /* опорные подшипники по концам */
      for (const z of [z0 + 0.5, z1 - 0.5]) zCyl(0.78, 0.78, 0.8, 16, mat.cast, sh, 0, 0, z);

      sh.userData = { dir: sx < 0 ? 1 : -1, ratio, sameAsCrank: sx > 0 };
      g.add(sh);
      parts.balanceShafts[k] = sh;
    });

    g.visible = state.balanceShafts;
    parts.balanceGroup = g;
    return g;
  }

  /**
   * Цикл Аткинсона: впускной клапан закрывается позже на atkinson_deg, значит
   * и кулачок обязан стать шире и повернуться — иначе клапан открывался бы сам
   * по себе, без кулачка. Подъём по-прежнему берётся из кадра, здесь только
   * геометрия профиля: фаза впуска = IN_SPAN + atkinson_deg.
   */
  function applyAtkinson() {
    const atk = clamp(num(state.atkinson_deg, 0), 0, ATK_MAX_DEG);
    const span = IN_SPAN + atk, half = span / 4, peak = (IVO + span / 2) % 720;
    for (const cm of parts.camsIn) {
      if (!cm || !cm.userData.lobes) continue;
      const geo = camLobeGeometry(1.5, half);
      const old = cm.userData.lobeGeo;
      if (old) { geoms.delete(old); old.dispose(); }
      cm.userData.lobeGeo = G(geo);
      cm.userData.lobes.forEach((lobe, i) => {
        lobe.geometry = geo;
        lobe.rotation.z = cm.userData.down + (peak - num(cm.userData.phases[i], 0)) * DEG / 2;
      });
    }
    anchors.atkinson_deg = atk;
  }

  /** Показать/спрятать узел балансирных валов вместе с их подписями. */
  function applyBalanceShafts() {
    const on = state.balanceShafts && !!parts.balanceGroup;
    if (parts.balanceGroup) parts.balanceGroup.visible = on;
    for (const o of labelObjs) {
      if (!o || o.userData.tag !== 'balance') continue;
      o.visible = state.labels && on;
      if (o.element && o.element.style) o.element.style.display = o.visible ? '' : 'none';
    }
    anchors.balanceShafts = {
      on, ratio: balanceRatio(), x: BAL_X, y: BAL_Y,
      dirs: parts.balanceShafts.map(s => (s ? s.userData.dir : 0)),
    };
  }

  /* ═══════════ привод ГРМ: цепь (по петле на ряд) ═══════════ */
  function rebuildChain() {
    if (state.twoStroke) return;                 // у двухтактного привода ГРМ нет
    const camY = L.deckY(state.eps) + L.CAM_DY;
    for (const b of banks) {
      /* обход против часовой стрелки; у зеркального ряда порядок обратный */
      const circles = [
        { x: 0, y: 0, r: L.SPROCKET_CRANK_R },
        { x: b.sx * CAM_X, y: camY, r: L.SPROCKET_CAM_R },
        { x: -b.sx * CAM_X, y: camY, r: L.SPROCKET_CAM_R },
      ];
      if (b.sx < 0) circles.reverse();
      const pts3 = beltPath(circles).map(p => new THREE.Vector3(p.x, p.y, b.chainZ));

      /* длины дуг для движения звеньев */
      const cum = [0];
      for (let i = 1; i <= pts3.length; i++) {
        const a = pts3[i - 1], c = pts3[i % pts3.length];
        cum[i] = cum[i - 1] + a.distanceTo(c);
      }
      b.chainPath = { pts: pts3, cum, total: cum[cum.length - 1] };

      /* тело цепи — сплошная замкнутая петля */
      const curve = new THREE.CatmullRomCurve3(pts3, true, 'catmullrom', 0.02);
      const geo = new THREE.TubeGeometry(curve, Math.max(120, pts3.length * 2), 0.22, 6, true);
      if (b.chain) {
        geoms.delete(b.chain.geometry);
        b.chain.geometry.dispose();
        b.chain.geometry = G(geo);
      } else {
        b.chain = new THREE.Mesh(G(geo), mat.chain);
        b.group.add(b.chain);
        parts.chains[b.bank] = b.chain;
        if (b.bank === 0) parts.chain = b.chain;
      }

      /* звенья-пластины, бегущие по петле */
      const want = Math.max(24, Math.round(b.chainPath.total / 1.25));
      if (b.links.length !== want) {
        for (const l of b.links) { l.parent && l.parent.remove(l); }
        b.links.length = 0;
        const linkGeo = G(new THREE.BoxGeometry(0.9, 0.62, 0.62));
        for (let i = 0; i < want; i++) {
          const l = new THREE.Mesh(linkGeo, mat.dark);
          b.group.add(l);
          b.links.push(l);
        }
        if (b.bank === 0) { parts.chainLinks.length = 0; parts.chainLinks.push(...b.links); }
      }
    }
    layoutChain(0);
  }

  /** Расставить звенья вдоль петель со смещением s (единицы сцены). */
  function layoutChain(s) {
    for (const b of banks) {
      if (!b.chainPath || !b.links.length) continue;
      const { pts, cum, total } = b.chainPath;
      const step = total / b.links.length;
      const s0 = b.sx < 0 ? -s : s;              // зеркальная петля бежит в другую сторону
      for (let k = 0; k < b.links.length; k++) {
        let d = (s0 + k * step) % total;
        if (d < 0) d += total;
        /* бинарный поиск отрезка */
        let lo = 0, hi = cum.length - 1;
        while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
        const a = pts[lo], c = pts[(lo + 1) % pts.length];
        const segLen = Math.max(1e-6, cum[lo + 1] - cum[lo]);
        const t = clamp((d - cum[lo]) / segLen, 0, 1);
        const link = b.links[k];
        link.position.set(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t, a.z);
        link.rotation.z = Math.atan2(c.y - a.y, c.x - a.x);
      }
    }
  }

  /* ═══════════ турбокомпрессор, интеркулер, впускной коллектор ═══════════ */

  /** Улитка (спираль Архимеда) в плоскости XY на глубине z. */
  function volute(r0, growth, material, parent, z, r = 0.6) {
    const pts = [];
    const turns = Math.PI * 2 * 1.08;
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * turns;
      const rr = r0 + growth * a;
      pts.push(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a) * rr, z));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, r, 10, false);
    const m = new THREE.Mesh(G(geo), material);
    parent.add(m);
    return { mesh: m, end: pts[pts.length - 1].clone() };
  }

  /** Рабочее колесо: ступица и лопатки. */
  function makeWheel(r, blades, material) {
    const g = new THREE.Group();
    zCyl(r * 0.34, r * 0.2, 1.15, 16, material, g);
    const bladeGeo = G(new THREE.BoxGeometry(0.1, r * 0.86, 0.95));
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      const holder = new THREE.Group();
      holder.rotation.z = a;
      const bl = new THREE.Mesh(bladeGeo, material);
      bl.position.y = r * 0.55;
      bl.rotation.y = 0.55;                     // закрутка лопатки
      holder.add(bl);
      g.add(holder);
    }
    return g;
  }

  /** Узел наддува целиком; скрыт, пока setTurbo(false). */
  function makeTurbo() {
    const g = new THREE.Group();
    g.position.set(L.TURBO_POS[0], L.TURBO_POS[1], L.TURBO_POS[2]);

    /* корпус подшипников и вал */
    const shaft = zCyl(0.34, 0.34, 4.4, 14, mat.steel, g);
    zCyl(1.5, 1.5, 1.9, 24, mat.alu, g);
    parts.turboShaft = shaft;

    /* улитка турбины (горячая, со стороны выпуска, z > 0) */
    const tv = volute(1.75, 0.32, mat.hot, g, 1.5, 0.62);
    const turbine = makeWheel(1.45, 11, mat.hot);
    turbine.position.z = 1.5;
    g.add(turbine);
    parts.turbineWheel = turbine;

    /* улитка компрессора (холодная, z < 0) */
    const cv = volute(1.75, 0.32, mat.alu, g, -1.5, 0.62);
    const comp = makeWheel(1.45, 9, mat.metal);
    comp.position.z = -1.5;
    g.add(comp);
    parts.compressorWheel = comp;
    /* входной раструб компрессора */
    zCyl(1.15, 1.35, 1.2, 20, mat.alu, g, 0, 0, -2.9);

    /* вестгейт — перепускной клапан на горячей улитке */
    const wg = new THREE.Group();
    wg.position.set(tv.end.x * 0.72, tv.end.y * 0.72 - 1.6, 1.5);
    mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 16), mat.hot, wg);
    mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.4, 18), mat.alu, wg, 0, 1.0);
    g.add(wg); parts.wastegate = wg;

    g.userData.inlet = new THREE.Vector3().copy(tv.end).add(g.position);
    g.userData.outlet = new THREE.Vector3().copy(cv.end).add(g.position);
    g.visible = state.turboShown;
    return g;
  }

  /** Интеркулер: соты + бачки. */
  function makeIntercooler() {
    const g = new THREE.Group();
    g.position.set(L.INTERCOOLER_POS[0], L.INTERCOOLER_POS[1], L.INTERCOOLER_POS[2]);
    const W = 8.4, H = 4.6, D = 2.2;
    mesh(new THREE.BoxGeometry(W, H, D), mat.core, g);
    /* соты — тонкие пластины */
    for (let i = -3; i <= 3; i++)
      mesh(new THREE.BoxGeometry(W * 0.98, 0.12, D * 1.02), mat.metal, g, 0, i * 0.62, 0);
    /* бачки по бокам */
    mesh(new THREE.BoxGeometry(1.1, H + 0.5, D + 0.4), mat.alu, g, -W / 2 - 0.5, 0, 0);
    mesh(new THREE.BoxGeometry(1.1, H + 0.5, D + 0.4), mat.alu, g, W / 2 + 0.5, 0, 0);
    g.userData.in = new THREE.Vector3(W / 2 + 1.0, 0, 0).add(g.position);
    g.userData.out = new THREE.Vector3(-W / 2 - 1.0, 0, 0).add(g.position);
    g.userData.box = {
      min: new THREE.Vector3(-W / 2 - 1.1, -H / 2 - 0.3, -D / 2 - 0.2).add(g.position),
      max: new THREE.Vector3(W / 2 + 1.1, H / 2 + 0.3, D / 2 + 0.2).add(g.position),
    };
    g.visible = state.turboShown && state.intercooler;
    return g;
  }

  /** Труба наддува/выпуска из общего пула. */
  function pipe(material) {
    const m = new THREE.Mesh(pipeGeo, material);
    group.add(m);
    parts.pipes.push(m);
    return m;
  }

  /** Разложить трубы: коллекторы → турбина → интеркулер → впускной ресивер. */
  function layoutTurboPipes() {
    if (!parts.turbo) return;
    const on = state.turboShown;
    parts.turbo.visible = on;
    if (parts.intercooler) parts.intercooler.visible = on && state.intercooler;
    for (const p of parts.pipes) p.visible = on;
    if (!on) return;

    const inlet = parts.turbo.userData.inlet;
    const outlet = parts.turbo.userData.outlet;
    const ic = parts.intercooler;
    const plen = parts.plenum ? parts.plenum.position.clone() : new THREE.Vector3(0, 26, 0);

    /* у двухтактного выпуск идёт не из головки, а из окна в стенке цилиндра */
    const twoEx = state.twoStroke && anchors.portsExhaust && anchors.portsExhaust[0]
      ? anchors.portsExhaust[0].pos : null;
    banks.forEach((b) => {
      const ends = b.idx.map(gi => twoEx || anchors.cylinders[gi].exhaustPortEnd);
      const a = ends[0].clone(), c = ends[ends.length - 1].clone();
      if (ends.length === 1) c.z += 3.0;
      placeTube(b.collector, a, c, 0.85);
      placeTube(b.downpipe, c, inlet, 0.8);
    });

    /* ресивер двухтактного — это картер, труба наддува идёт в него */
    const chargeEnd = state.twoStroke && anchors.crankcase
      ? anchors.crankcase.center.clone().setX(anchors.crankcase.min.x - 1.2) : plen;
    if (state.intercooler && ic) {
      placeTube(parts.pipeToIc, outlet, ic.userData.in, 0.75);
      placeTube(parts.pipeToPlenum, ic.userData.out, chargeEnd, 0.75);
    } else {
      placeTube(parts.pipeToIc, outlet, outlet.clone().add(new THREE.Vector3(0, 2.2, 0)), 0.75);
      placeTube(parts.pipeToPlenum, outlet.clone().add(new THREE.Vector3(0, 2.2, 0)), chargeEnd, 0.75);
    }
  }

  /**
   * Длина впускных патрубков: 150…900 мм → пропорционально в юнитах
   * (L.INTAKE_LEN_REF мм = RUNNER_BASE_U юнитов). Ресивер сидит на концах
   * патрубков — у V8 это и есть коллектор в развале.
   */
  function applyIntakeLength() {
    const lenU = RUNNER_BASE_U * state.intakeLen_mm / L.INTAKE_LEN_REF;
    const ends = [];
    for (const r of parts.runners) {
      if (!r) continue;
      r.tube.position.y = lenU / 2;
      r.tube.scale.set(RUNNER_R, lenU, RUNNER_R);
      r.stack.position.y = lenU + 0.3;
      /* конец патрубка в системе механизма */
      const b = banks[r.bank];
      const dirX = -r.sx * Math.cos(RUNNER_ANG), dirY = Math.sin(RUNNER_ANG);
      const lx = r.group.position.x + dirX * (lenU + 0.3);
      const ly = L.deckY(state.eps) + r.group.position.y + dirY * (lenU + 0.3);
      ends.push(bankVec(lx, ly, r.z, b ? b.tilt : 0));
    }
    if (parts.plenum && ends.length) {
      const c = new THREE.Vector3();
      for (const e of ends) c.add(e);
      c.multiplyScalar(1 / ends.length);
      const zs = ends.map(e => e.z);
      const zSpan = Math.max(...zs) - Math.min(...zs);
      /* у оппозитника патрубки обоих рядов приходят сверху, но разъезжаются
         по ширине: ресивер становится перекидной трубой поперёк двигателя —
         широкой по X и узкой вдоль вала, иначе он накрыл бы мотор крышкой */
      const box = LO.name === 'boxer4';
      const zLen = box ? clamp(zSpan * 0.34 + 3.0, 4.5, 11.0) : Math.max(4.5, zSpan + 5.0);
      const xs = ends.map(e => e.x);
      const sxScale = box ? Math.max(1, (Math.max(...xs) - Math.min(...xs) + 3.0) / 5.2) : 1;
      parts.plenum.position.copy(c);
      parts.plenum.scale.set(sxScale, 1, zLen);
      parts.plenum.visible = true;
    }
    anchors.intakeLen_mm = state.intakeLen_mm;
    anchors.intakeLenTarget_mm = state.intakeLenTarget_mm;
    anchors.intakeRunnerLen_u = lenU;
    anchors.plenum = parts.plenum ? parts.plenum.position.clone() : null;
  }

  /**
   * Шаг анимации длины впускного тракта: видимая длина едет к целевой
   * экспоненциально и с ограничением скорости, поэтому переключение
   * переменного впуска на ходу выглядит как движение заслонки, а не как рывок.
   */
  function stepIntake() {
    const target = state.intakeLenTarget_mm;
    const cur = state.intakeLen_mm;
    const t = nowMs();
    const dt = clamp((t - (intakeStepMs === null ? t : intakeStepMs)) / 1000, 0, 0.1);
    intakeStepMs = t;
    const diff = target - cur;
    if (Math.abs(diff) < 1e-9) return;
    if (Math.abs(diff) <= 0.5) {                 // остаток меньше полумиллиметра — дотягиваем
      state.intakeLen_mm = target;
    } else {
      if (dt <= 0) return;
      /* скорость: пропорциональна остатку (мягкое торможение у цели),
         но зажата снизу и сверху — отсюда и плавность, и конечное время хода */
      const rate = clamp(Math.abs(diff) / INTAKE_TAU_S, INTAKE_RATE_MIN, INTAKE_RATE_MAX);
      state.intakeLen_mm = cur + Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    }
    applyIntakeLength();
    layoutTurboPipes();
  }

  /* ═══════════ подписи ═══════════ */
  function makeLabels() {
    const z0 = LO.cyl[0].z;
    const sx0 = banks[0] ? banks[0].sx : 1;
    const p0 = parts.pistons[0], r0 = parts.rods[0];
    label(LBL.piston, p0, L.BORE_R + 1.2, 0.4, 0);
    label(LBL.ringsComp, p0, -L.BORE_R - 1.4, L.PISTON_TOP_OFF - 1.3, 0);
    label(LBL.ringOil, p0, -L.BORE_R - 1.4, L.PISTON_TOP_OFF - 2.9, 0);
    label(LBL.pistonPin, p0, 0, -1.5, 2.6);
    label(LBL.rod, r0, 1.9, -L.ROD_L * 0.45, 0);
    label(LBL.crank, parts.crank, -6.4, -1.4, z0);
    const th0 = parts.crank && parts.crank.userData.throw0;
    if (th0) {
      label(LO.name === 'v8' ? LBL.crankPin2 : LBL.crankPin, th0, 2.2, L.CRANK_R, 0);
      label(LBL.counterw, th0, -3.4, -1.6, 0);
      label(LBL.web, th0, 0, 2.6, -(LO.throws[0].webOff + 0.55));
    }
    /* ── оппозитная: раздельные шейки и общая щека пары ── */
    if (LO.name === 'boxer4') {
      const th1 = parts.crank && parts.crank.userData.throw1;
      if (th1) {
        label(LBL.pinsBoxer, th1, 2.4, L.CRANK_R + 0.6, 0);
        label(LBL.webShared, th1, -2.0, 3.4, -WEB_OFF_SPLIT);
      }
    }
    label(LBL.mainJournal, parts.crank, 0, -1.9, 0);
    label(LBL.flywheel, parts.flywheel, 0, L.FLYWHEEL_R + 0.9, 0);
    label(LBL.cylinder, parts.walls[0], -L.BORE_R - 1.6, 0.32, 0);
    label(LBL.head, parts.heads[0], -9.6, 1.6, z0);

    if (!state.twoStroke) {
      label(LBL.valveIn, parts.valvesIn[0], -sx0 * 1.4, 1.0, 0);
      label(LBL.valveEx, parts.valvesEx[0], sx0 * 1.4, 1.0, 0);
      label(LBL.spring, parts.valvesIn[0], -sx0 * 1.6, 2.4, 0);
      label(LBL.tappet, parts.valvesEx[0], sx0 * 1.6, CAM_AX - 1.0, 0);
      label(LBL.camIn, parts.camsIn[0], -2.6, 1.6, z0);
      label(LBL.camEx, parts.camsEx[0], 2.6, 1.6, z0);
      label(LBL.lobe, parts.camsEx[0], 0, -2.6, z0);
      label(LBL.sprCrank, parts.sprocketCrank, 0, -L.SPROCKET_CRANK_R - 1.0, 0);
      label(LBL.sprCam, parts.sprocketIn, -L.SPROCKET_CAM_R - 1.2, 0.6, 0);
      label(LBL.chain, parts.heads[0], -sx0 * (CAM_X + 2.0), L.CAM_DY - 7.5,
            banks[0] ? banks[0].chainZ : CHAIN_Z_SINGLE);
      label(LBL.portIn, parts.heads[0], -sx0 * 9.4, 3.4, z0);
      label(LBL.portEx, parts.heads[0], sx0 * 9.4, 3.4, z0);
      label(LBL.runner, parts.runners[0] && parts.runners[0].group, 1.3, 2.2, 0);
      label(LO.name === 'v8' ? LBL.plenumVee : LBL.plenum, parts.plenum, 0, 1.5, 0);
    }
    label(LBL.plug, parts.plugs[0], 0.4, 3.4, 0);
    label(LBL.injector, parts.injectorsDirect[0], 0.4, 3.6, 0);
    label(LBL.injPort, parts.injectorsPort[0], -sx0 * 1.1, 1.3, 0);
    label(LBL.injGdi, parts.injectorsGdi[0], -sx0 * 1.2, 3.5, 0);

    /* ── подписи рядов ── */
    if (LO.name === 'v8' && banks.length > 1) {
      label(LBL.bankL, banks[0].group, -6.0, L.deckY(state.eps) + 6.5, z0);
      label(LBL.bankR, banks[1].group, 6.0, L.deckY(state.eps) + 6.5, z0);
    }
    if (LO.name === 'boxer4' && banks.length > 1) {
      /* ряды горизонтальные: подпись висит на конце ряда, в его же системе */
      label(LBL.bankLBox, banks[0].group, 0, L.deckY(state.eps) + 3.0, banks[0].zs[0] - 3.0);
      label(LBL.bankRBox, banks[1].group, 0, L.deckY(state.eps) + 3.0, banks[1].zs[0] - 3.0);
      label(LBL.opposed, parts.pistons[0], 0, -2.2, -3.2);
    }

    /* ── балансирные валы ── */
    parts.balanceShafts.forEach((sh) => {
      if (!sh) return;
      label(lblBalShaft(sh.userData.ratio, sh.userData.sameAsCrank), sh,
            0, -(BAL_W_R + 1.0), sh.userData.dir > 0 ? -2.2 : 2.2, 'balance');
      label(LBL.balWeight, sh, 0, 0.9, LO.throws[0].z, 'balance');
    });

    /* ── двухтактный: окна и картер ── */
    for (const p of parts.portsExhaust)
      label(LBL.portExh2T, p.mesh, Math.sin(p.theta) * 2.4, 0.6, Math.cos(p.theta) * 2.4);
    if (parts.portsTransfer[0]) {
      const p = parts.portsTransfer[0];
      label(LBL.portTr2T, p.mesh, Math.sin(p.theta) * 2.6, 0.6, Math.cos(p.theta) * 2.6);
      /* канал — масштабированная труба, поэтому подпись вешаем без смещения */
      label(LBL.ductTr, parts.transferDucts[0], 0, 0, 0);
    }
    if (state.twoStroke) {
      label(LBL.crankcase, parts.crankcaseShell, -0.4, -4.4, 0);
      label(LBL.reed, parts.reed, -1.6, 1.8, 0);
    }

    /* ── наддув ── */
    if (parts.turbo) {
      label(LBL.turbine, parts.turbo, 0, 3.2, 1.5);
      label(LBL.compressor, parts.turbo, 0, -3.4, -1.5);
      label(LBL.turboRotor, parts.turboShaft, 0, 0.9, 0);
      label(LBL.wastegate, parts.wastegate, 1.2, 1.4, 0);
    }
    label(LBL.intercooler, parts.intercooler, 0, 3.4, 0);
  }

  /* ═══════════ сборка / разборка ═══════════ */
  function build() {
    mat = makeMaterials();
    pipeGeo = G(new THREE.CylinderGeometry(1, 1, 1, 16, 1, true));
    const czs = chainZs();

    /* ряды: своя группа, повёрнутая на −tilt вокруг оси коленвала */
    banks = LO.banks.map((b, k) => {
      const g = new THREE.Group();
      g.name = 'bank' + k;
      g.rotation.z = -b.tilt;
      group.add(g);
      parts.banks[k] = g;
      return { ...b, group: g, chainZ: czs[k], links: [], chain: null, chainPath: null,
               collector: null, downpipe: null, mat: bankMaterials(b.tilt) };
    });

    parts.crank = makeCrank(czs);
    group.add(parts.crank);

    /* поршни и шатуны живут в системе своего ряда */
    for (const c of LO.cyl) {
      const b = banks[c.bank];
      const p = makePiston();
      p.position.z = c.z;
      b.group.add(p);
      parts.pistons[c.index] = p;

      const r = makeRod();
      /* на общей шейке два шатуна — разводим их вдоль вала */
      r.position.z = c.z + (LO.throws[c.throw].cyl.length > 1 ? (c.bank === 0 ? -0.85 : 0.85) : 0);
      b.group.add(r);
      parts.rods[c.index] = r;
    }

    for (const b of banks) {
      const head = state.twoStroke ? makeHead2T(b) : makeHead(b, b.chainZ);
      b.group.add(head);
      parts.heads[b.bank] = head;
      if (b.bank === 0) parts.head = head;
      b.group.add(makeBlock(b));
    }

    const cse = makeCase();
    group.add(cse);
    anchors.crankcaseBox = cse.userData.box;

    /* балансирные валы: узел строится всегда (кроме двухтактного),
       показывается по setBalanceShafts */
    const bal = makeBalanceShafts();
    if (bal) group.add(bal);

    /* впускной ресивер (у V8 — в развале, на концах патрубков) */
    if (!state.twoStroke) {
      parts.plenum = mesh(new THREE.BoxGeometry(5.2, 3.0, 1), mat.runner, group);
      parts.plenum.visible = false;
    }

    /* наддув: узел строится всегда, показывается по setTurbo */
    parts.turbo = makeTurbo();
    group.add(parts.turbo);
    parts.intercooler = makeIntercooler();
    group.add(parts.intercooler);
    for (const b of banks) {
      b.collector = pipe(mat.exhaust);
      b.downpipe = pipe(mat.exhaust);
    }
    parts.pipeToIc = pipe(mat.runner);
    parts.pipeToPlenum = pipe(mat.runner);

    rebuildChain();
    applyDeck();
    applyFuelMode(state.fuelMode);
    updateAnchors();
    applyIntakeLength();
    layoutTurboPipes();
    makeLabels();
    applyBalanceShafts();
    if (state.atkinson_deg > 0) applyAtkinson();
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
    geoms = new Set(); mats = new Set(); shellMats = [];
    parts.pistons.length = 0; parts.rods.length = 0; parts.walls.length = 0;
    parts.valvesIn.length = 0; parts.valvesEx.length = 0;
    parts.tappetsIn.length = 0; parts.tappetsEx.length = 0;
    parts.springsIn.length = 0; parts.springsEx.length = 0;
    parts.chainLinks.length = 0; parts.plugs.length = 0;
    parts.injectorsDirect.length = 0; parts.injectorsPort.length = 0;
    parts.injectorsGdi.length = 0; parts.gdiTips.length = 0;
    parts.balanceShafts.length = 0; parts.balanceGroup = null;
    parts.labels.length = 0;
    parts.banks.length = 0; parts.heads.length = 0; parts.blocks.length = 0;
    parts.camsIn.length = 0; parts.camsEx.length = 0; parts.chains.length = 0;
    parts.portsExhaust.length = 0; parts.portsTransfer.length = 0;
    parts.portFrames.length = 0; parts.transferDucts.length = 0;
    parts.runners.length = 0; parts.stacks.length = 0; parts.pipes.length = 0;
    parts.crank = parts.camIn = parts.camEx = parts.head = null;
    parts.chain = null; parts.flywheel = null; parts.block = null; parts.crankcase = null;
    parts.sprocketCrank = parts.sprocketIn = parts.sprocketEx = null;
    parts.crankcaseShell = parts.reed = parts.plenum = null;
    parts.turbo = parts.turbineWheel = parts.compressorWheel = parts.turboShaft = null;
    parts.intercooler = parts.wastegate = null;
    parts.pipeToIc = parts.pipeToPlenum = null;
    banks = []; pipeGeo = null; prevCrank = null;
  }

  /** Пересадить головки и гильзы под текущую степень сжатия. */
  function applyDeck() {
    const deck = L.deckY(state.eps);
    for (const h of parts.heads) if (h) h.position.y = deck;
    const h = deck - WALL_BOT_Y;
    for (const w of parts.walls) { if (!w) continue; w.scale.y = h; w.position.y = WALL_BOT_Y + h / 2; }
    for (const b of parts.blocks) { if (!b) continue; b.scale.y = h; b.position.y = WALL_BOT_Y + h / 2; }
  }

  /**
   * Куда воткнута форсунка. Дизель — всегда в головку (штатная форсунка по центру).
   * Бензин: при setDirectInjection(false) во впускном канале, при true —
   * в головке рядом со свечой, отсюда и подпись меняется.
   */
  function applyFuelMode(mode) {
    const diesel = mode === 'diesel';
    const gdi = state.directInjection && !diesel;
    for (const p of parts.plugs) if (p) p.visible = !diesel;
    for (const p of parts.injectorsDirect) if (p) p.visible = diesel;
    for (const p of parts.injectorsGdi) if (p) p.visible = gdi;
    for (const p of parts.injectorsPort) if (p) p.visible = !diesel && !gdi;
  }

  /** Доля хода поршня цилиндра i из кадра (или из угла коленвала). */
  function fracOf(frame, i) {
    if (typeof frame === 'number') return clamp(frame, 0, 1);
    const c = frame && frame.cyl && frame.cyl[i];
    if (c && Number.isFinite(c.pistonFrac)) return clamp(c.pistonFrac, 0, 1);
    const rec = LO.cyl[i];
    if (!rec || !frame) return 0;
    const th = (num(frame.crankDeg, num(frame.deg, 0)) + rec.effOff) * DEG;
    const y = L.CRANK_R * Math.cos(th)
            + Math.sqrt(Math.max(0, L.ROD_L * L.ROD_L - (L.CRANK_R * Math.sin(th)) ** 2));
    return clamp((PIN_Y_TDC - y) / L.STROKE_U, 0, 1);
  }

  /* ═══════════ точки привязки для модуля жидкостей ═══════════ */
  function updateAnchors() {
    const deck = L.deckY(state.eps);
    const camY = deck + L.CAM_DY;
    const sx0 = banks[0] ? banks[0].sx : 1;
    const z0 = LO.cyl[0].z;

    const gdiOn = state.directInjection && state.fuelMode !== 'diesel';
    const cyls = LO.cyl.map(c => {
      const i = c.index, z = c.z, t = c.tilt;
      const sx = banks[c.bank] ? banks[c.bank].sx : 1;
      const axis = new THREE.Vector3(Math.sin(t), Math.cos(t), 0);   // ось цилиндра «вверх»
      const gt = parts.gdiTips[i];
      /* кончик форсунки непосредственного впрыска (в головке, у свечи) */
      const gdiTip = gt ? bankVec(gt.x, deck + gt.y, gt.z, t) : bankVec(0, deck - 0.6, z, t);
      const portTip = bankVec(sx * -6.9, deck + 2.7, z, t);
      return {
        index: i, x: 0, z,
        bankTilt: t, bank: c.bank, mirror: sx, axis,
        phase: c.phase, pin: c.pin,
        /** Высота днища поршня вдоль оси ряда; при tilt = 0 это обычный Y сцены. */
        crownY(frame) { return crownAxisY(fracOf(frame, i)); },
        /** Днище поршня как точка в системе механизма (учитывает наклон ряда). */
        crownPos(frame) { return bankVec(0, crownAxisY(fracOf(frame, i)), z, t); },
        intakePortEnd:  bankVec(sx * -8.9, deck + 2.6, z, t),
        exhaustPortEnd: bankVec(sx * 8.9, deck + 2.6, z, t),
        sparkTip:       bankVec(0, deck - 0.8, z, t),
        /* активная форсунка: во впускном канале либо в головке (прямой впрыск) */
        injectorTip:    gdiOn ? gdiTip.clone() : portTip.clone(),
        portInjectorTip: portTip,                               // порт-форсунка (бензин)
        gdiInjectorTip: gdiTip,                                 // прямой впрыск (бензин)
        directInjection: gdiOn,
        dieselInjectorTip: bankVec(0, deck - 0.4, z, t),        // прямой впрыск (дизель)
        valveInSeat:    bankVec(sx * L.VALVE_X_IN, deck, z, t),
        valveExSeat:    bankVec(sx * L.VALVE_X_EX, deck, z, t),
        deckPos:        bankVec(0, deck, z, t),
      };
    });

    /* рубашка охлаждения: объединение коробок всех рядов */
    const jr = L.BORE_R + L.JACKET_GAP;
    const jmin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const jmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const b of banks) {
      for (const sxs of [-jr, jr]) for (const yy of [WALL_BOT_Y, deck]) {
        const p = bankXY(sxs, yy, b.tilt);
        jmin.x = Math.min(jmin.x, p.x); jmax.x = Math.max(jmax.x, p.x);
        jmin.y = Math.min(jmin.y, p.y); jmax.y = Math.max(jmax.y, p.y);
      }
      jmin.z = Math.min(jmin.z, b.zs[0] - jr);
      jmax.z = Math.max(jmax.z, b.zs[b.zs.length - 1] + jr);
    }

    /* окна двухтактного */
    const portRec = (p, k) => {
      const dx = Math.sin(p.theta), dz = Math.cos(p.theta);
      const rad = bankXY(dx, 0, p.tilt);
      const mid = (p.topY + p.botY) / 2;
      return {
        index: k, cyl: p.cyl, kind: p.kind, theta: p.theta, span: p.span,
        topY: p.topY, botY: p.botY, bankTilt: p.tilt,
        pos: bankVec(dx * (L.BORE_R + 0.2), mid, p.z + dz * (L.BORE_R + 0.2), p.tilt),
        inner: bankVec(dx * (L.BORE_R - 0.4), mid, p.z + dz * (L.BORE_R - 0.4), p.tilt),
        dir: new THREE.Vector3(rad.x, rad.y, dz).normalize(),
        /** Доля открытия окна поршнем: 0 — перекрыто юбкой, 1 — открыто целиком. */
        openFrac(frame) {
          const cy = crownAxisY(fracOf(frame, p.cyl));
          return clamp((p.topY - clamp(cy, p.botY, p.topY)) / Math.max(1e-6, p.topY - p.botY), 0, 1);
        },
      };
    };

    const cc = anchors.crankcaseBox || { min: new THREE.Vector3(), max: new THREE.Vector3() };
    Object.assign(anchors, {
      deckY: deck,
      bore: L.BORE_R,
      cylinders: cyls,
      layout: LO.name,
      cylCount: LO.n,
      twoStroke: state.twoStroke,
      cycleDeg: state.twoStroke ? 360 : 720,
      bankTilt: LO.cyl.map(c => c.tilt),
      banks: LO.banks.map(b => ({ bank: b.bank, tilt: b.tilt, mirror: b.sx, cyl: b.idx.slice() })),
      /* раздельные шатунные шейки: у боксёра их четыре, у V8 — по одной на пару */
      crankThrows: LO.throws.map(t => ({ index: t.index, z: t.z, pin: t.pin,
                                         split: !!t.split, cyl: t.cyl.slice() })),
      opposed: LO.name === 'boxer4',
      balanceShafts: {
        on: state.balanceShafts && !!parts.balanceGroup,
        ratio: balanceRatio(), x: BAL_X, y: BAL_Y,
        dirs: parts.balanceShafts.map(s => (s ? s.userData.dir : 0)),
      },
      intakePortEnd: cyls[0].intakePortEnd,
      exhaustPortEnd: cyls[0].exhaustPortEnd,
      injectorTip: cyls[0].injectorTip,
      portInjectorTip: cyls[0].portInjectorTip,
      gdiInjectorTip: cyls[0].gdiInjectorTip,
      directInjection: gdiOn,
      dieselInjectorTip: cyls[0].dieselInjectorTip,
      sparkTip: cyls[0].sparkTip,
      crankCenter: new THREE.Vector3(0, 0, 0),
      camInPos: bankVec(-sx0 * CAM_X, camY, z0, LO.cyl[0].tilt),
      camExPos: bankVec(sx0 * CAM_X, camY, z0, LO.cyl[0].tilt),
      sumpY: L.SUMP_Y,
      jacketBox: { min: jmin, max: jmax },
      /* ── вторая волна ── */
      portsExhaust: parts.portsExhaust.map(portRec),
      portsTransfer: parts.portsTransfer.map(portRec),
      crankcase: {
        min: cc.min, max: cc.max,
        center: new THREE.Vector3().addVectors(cc.min, cc.max).multiplyScalar(0.5),
        topY: cc.max.y, sealed: state.twoStroke,
      },
      turbo: state.turboShown,
      turboInlet:  parts.turbo ? parts.turbo.userData.inlet.clone()
                               : new THREE.Vector3(...L.TURBO_POS),
      turboOutlet: parts.turbo ? parts.turbo.userData.outlet.clone()
                               : new THREE.Vector3(...L.TURBO_POS),
      turboCenter: new THREE.Vector3(...L.TURBO_POS),
      intercoolerBox: parts.intercooler
        ? { ...parts.intercooler.userData.box,
            center: new THREE.Vector3(...L.INTERCOOLER_POS),
            in: parts.intercooler.userData.in.clone(),
            out: parts.intercooler.userData.out.clone(),
            enabled: state.intercooler }
        : null,
    });
    return anchors;
  }

  /* ═══════════ покадровое обновление ═══════════ */
  function update(frame) {
    if (!frame || !parts.crank) return;
    lastUpdateMs = nowMs();
    /* режимы, которые могут прийти прямо в кадре (переменный впуск, прямой
       впрыск, балансирные валы) — принимаем только явные булевы значения */
    if (typeof frame.balanceShafts === 'boolean' && frame.balanceShafts !== state.balanceShafts)
      setBalanceShafts(frame.balanceShafts);
    if (typeof frame.directInjection === 'boolean' && frame.directInjection !== state.directInjection)
      setDirectInjection(frame.directInjection);
    if (Number.isFinite(frame.intakeLenNow_mm)) setIntakeLength(frame.intakeLenNow_mm);
    if (Number.isFinite(frame.atkinson_deg)) setAtkinson(frame.atkinson_deg);
    stepIntake();

    const cycle = state.twoStroke ? 360 : num(frame.cycleDeg, 720);
    const deg = ((num(frame.deg, 0) % 720) + 720) % 720;
    const crankDeg = num(frame.crankDeg, deg % 360);
    const rad = crankDeg * DEG;

    parts.crank.rotation.z = -rad;

    const nc = Math.min(state.n, parts.pistons.length);
    for (let i = 0; i < nc; i++) {
      const c = (frame.cyl && frame.cyl[i]) || {};
      const rec = LO.cyl[i];
      const frac = fracOf(frame, i);
      const pinY = PIN_Y_TDC - frac * L.STROKE_U;

      /* шатунная шейка в системе своего ряда: эффективный угол θ − α */
      const th = (crankDeg + rec.effOff) * DEG;
      const cx = L.CRANK_R * Math.sin(th);
      const cy = L.CRANK_R * Math.cos(th);

      const p = parts.pistons[i];
      p.position.y = pinY;

      const r = parts.rods[i];
      r.position.y = pinY;
      /* нижняя головка обязана лечь на шейку: sin β = cx / L_шатуна */
      r.rotation.z = Math.asin(clamp(cx / L.ROD_L, -1, 1));

      /* клапаны: подъём — из кадра, кулачок геометрически с ним совпадает */
      const li = clamp(num(c.liftIn, 0), 0, 1) * L.VALVE_LIFT_MAX;
      const le = clamp(num(c.liftEx, 0), 0, 1) * L.VALVE_LIFT_MAX;
      if (parts.valvesIn[i]) parts.valvesIn[i].userData.setLift(li);
      if (parts.valvesEx[i]) parts.valvesEx[i].userData.setLift(le);
    }

    if (state.twoStroke) {
      updatePorts(frame);
    } else {
      /* распредвалы: ровно вдвое медленнее коленвала — один оборот на 720° цикла */
      const camRot = -deg * DEG / 2;
      for (const cm of parts.camsIn) if (cm) cm.rotation.z = camRot;
      for (const cm of parts.camsEx) if (cm) cm.rotation.z = camRot;
      /* цепь бежит вместе со звёздочкой коленвала */
      layoutChain(-rad * L.SPROCKET_CRANK_R);
    }

    /* балансирные валы: коленвал крутится как −rad, поэтому вал с dir = +1
       идёт против него, а с dir = −1 — вместе; кратность 1× или 2× */
    if (parts.balanceGroup && parts.balanceGroup.visible) {
      for (const sh of parts.balanceShafts) {
        if (!sh) continue;
        sh.rotation.z = sh.userData.dir * sh.userData.ratio * rad;
      }
    }

    updateTurbo(frame, crankDeg);

    /* свеча/форсунка по типу топлива */
    const mode = frame.fuelMode === 'diesel' ? 'diesel' : 'petrol';
    if (mode !== state.fuelMode) { state.fuelMode = mode; applyFuelMode(mode); }
    anchors.cycleDeg = cycle;
  }

  /** Окна двухтактного: высота открытой части — по днищу поршня. */
  function updatePorts(frame) {
    const all = [[parts.portsExhaust, 'liftEx'], [parts.portsTransfer, 'liftIn']];
    for (const [list, key] of all) {
      for (const p of list) {
        const cy = crownAxisY(fracOf(frame, p.cyl));
        const openTop = p.topY, openBot = Math.max(p.botY, Math.min(cy, p.topY));
        const h = Math.max(1e-4, openTop - openBot);
        p.open = clamp((openTop - openBot) / Math.max(1e-6, p.topY - p.botY), 0, 1);
        p.mesh.scale.y = h;
        p.mesh.position.y = (openTop + openBot) / 2;
        p.mesh.visible = p.open > 0.004;
        /* свечение — по доле открытия из физики (frame.cyl[i].liftEx / liftIn) */
        const c = (frame && frame.cyl && frame.cyl[p.cyl]) || {};
        const lift = clamp(num(c[key], p.open), 0, 1);
        p.mesh.material.emissiveIntensity = 0.25 + 1.15 * lift;
        p.mesh.material.opacity = 0.45 + 0.45 * Math.max(lift, p.open);
      }
    }
  }

  /**
   * Ротор турбокомпрессора: скорость пропорциональна оборотам (прирост угла
   * коленвала за кадр) и растёт с наддувом frame.boostNow_bar.
   */
  function updateTurbo(frame, crankDeg) {
    const boost = clamp(num(frame.boostNow_bar, 0), 0, 3);
    /* узел показываем, если его включили setTurbo(), либо кадр говорит о наддуве;
       выключить может только setTurbo(false) — иначе frame.turbo (это признак
       «турбина с инерцией» в физике) гасил бы приводной наддув */
    const wantTurbo = state.turbo || frame.turbo === true || boost > 0.01;
    const wantIc = typeof frame.intercooler === 'boolean' ? frame.intercooler : state.intercooler;
    if (wantTurbo !== state.turboShown || wantIc !== state.intercooler) {
      state.turboShown = wantTurbo; state.intercooler = wantIc;
      layoutTurboPipes();
      anchors.turbo = wantTurbo;
      if (anchors.intercoolerBox) anchors.intercoolerBox.enabled = state.intercooler;
    }
    state.boost_bar = boost;
    state.chargeT_K = num(frame.chargeT_K, state.chargeT_K);

    if (!parts.turbo || !parts.turbo.visible) { prevCrank = crankDeg; return; }
    let d = crankDeg - (prevCrank === null ? crankDeg : prevCrank);
    prevCrank = crankDeg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    turboSpin -= d * DEG * (1.6 + 6.5 * boost);       // ≈ 8× оборотов вала при 1 бар
    if (parts.turbineWheel) parts.turbineWheel.rotation.z = turboSpin;
    if (parts.compressorWheel) parts.compressorWheel.rotation.z = turboSpin;
    if (parts.turboShaft) parts.turboShaft.rotation.y = turboSpin;

    /* цвет заряда: горячий после компрессора, холодный после интеркулера */
    const t = clamp((state.chargeT_K - 290) / 180, 0, 1);
    if (mat && mat.core) mat.core.color.setRGB(0.30 + 0.55 * t, 0.42 - 0.16 * t, 0.55 - 0.35 * t);
    if (mat && mat.hot) mat.hot.emissive.setRGB(0.08 + 0.5 * t, 0.02 + 0.1 * t, 0.0);
  }

  /* ═══════════ публичное API ═══════════ */

  /** Полная пересборка под текущее state. */
  function rebuild() {
    teardown();
    LO = parseLayout(state.layout);
    state.n = LO.n;
    build();
  }

  /** Компоновка: 'single' | 'i4' | 'boxer4' | 'v8'. */
  function setLayout(name) {
    const v = normLayout(name, name);
    if (v === state.layout && !(state.twoStroke && v !== 'single')) return;
    state.layout = v;
    /* двухтактный существует только одноцилиндровым */
    if (state.twoStroke && v !== 'single') state.twoStroke = false;
    rebuild();
  }

  /** Совместимость: число цилиндров вместо имени компоновки. */
  function setCylinders(n) {
    setLayout(n === 1 ? 'single' : n === 8 ? 'v8' : 'i4');
  }

  /** Двухтактный вариант: окна вместо клапанов, герметичный картер. */
  function setTwoStroke(on) {
    const v = !!on;
    if (v === state.twoStroke) return;
    state.twoStroke = v;
    if (v) state.layout = 'single';
    rebuild();
  }

  /** Турбокомпрессор с интеркулером (узел просто показывается/прячется). */
  function setTurbo(on) {
    state.turbo = !!on;
    state.turboShown = !!on;
    layoutTurboPipes();
    anchors.turbo = state.turboShown;
    updateAnchors();
  }

  /** Интеркулер в тракте наддува. */
  function setIntercooler(on) {
    state.intercooler = !!on;
    layoutTurboPipes();
    updateAnchors();
  }

  /**
   * Длина впускных патрубков, мм (150…900) — меняется на глазах.
   * По умолчанию едет к новой длине плавно (за ~0,3 с): переменный впуск
   * дёргает её прямо на работающем двигателе. `immediate` ставит сразу.
   */
  function setIntakeLength(mm, immediate) {
    const v = clamp(num(mm, L.INTAKE_LEN_REF), INTAKE_MM_MIN, INTAKE_MM_MAX);
    if (Math.abs(v - state.intakeLenTarget_mm) < 1e-6) return;
    state.intakeLenTarget_mm = v;
    anchors.intakeLenTarget_mm = v;
    /* если кадры не идут (сцена на паузе), плавно ехать некому — ставим сразу */
    const idle = lastUpdateMs === null || nowMs() - lastUpdateMs > 400;
    if (immediate || idle) {
      state.intakeLen_mm = v;
      intakeStepMs = null;
      applyIntakeLength();
      layoutTurboPipes();
    }
  }

  /**
   * Задержка закрытия впускного клапана (цикл Аткинсона), град. цикла 0…70.
   * Меняет профиль впускного кулачка, чтобы он совпадал с подъёмом из кадра.
   */
  function setAtkinson(deg) {
    const v = clamp(num(deg, 0), 0, ATK_MAX_DEG);
    if (Math.abs(v - state.atkinson_deg) < 0.25) return;
    state.atkinson_deg = v;
    applyAtkinson();
  }

  /** Балансирные валы под коленвалом (валы Ланчестера у рядной четвёрки). */
  function setBalanceShafts(on) {
    state.balanceShafts = !!on;
    applyBalanceShafts();
  }

  /**
   * Прямой впрыск бензина: форсунка переезжает из впускного канала в головку,
   * рядом со свечой. У дизеля форсунка и так в головке — режим на него не влияет.
   */
  function setDirectInjection(on) {
    const v = !!on;
    if (v === state.directInjection) return;
    state.directInjection = v;
    applyFuelMode(state.fuelMode);
    updateAnchors();
  }

  function setCompression(eps) {
    const e = clamp(num(eps, state.eps), 4, 30);
    if (Math.abs(e - state.eps) < 1e-6) return;
    state.eps = e;
    applyDeck();
    rebuildChain();       // звёздочки распредвалов уехали — петля пересчитывается
    updateAnchors();
    applyIntakeLength();
    layoutTurboPipes();
  }

  function setCutaway(on) {
    state.cutaway = !!on;
    for (const m of shellMats) {
      if (!m) continue;
      const base = num(m.userData.baseOpacity, m.opacity);
      m.clippingPlanes = state.cutaway ? [m.userData.plane || clipPlane] : null;
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
    applyBalanceShafts();     // подписи спрятанных валов не должны всплывать
  }

  function dispose() {
    offLang();
    teardown();
    if (group.parent) group.parent.remove(group);
  }

  build();

  /* Язык меняется на лету: подписи уже висят на деталях, поэтому пересобирать
     сцену не нужно — достаточно переписать текст в их DOM-элементах. */
  const offLang = onLangChange(refreshLabels);

  return {
    group, parts, anchors,
    update, setCylinders, setCompression, setCutaway, setLabels, dispose,
    /* ── вторая волна ── */
    setLayout, setTwoStroke, setTurbo, setIntercooler, setIntakeLength,
    /* ── третья волна ── */
    setBalanceShafts, setDirectInjection, setAtkinson,
    /** Пересчитать точки привязки (после смены ε или компоновки). */
    updateAnchors,
    /** Текущее состояние модели (только чтение). */
    get state() { return { ...state }; },
    get layout() { return state.layout; },
    clippingPlane: clipPlane,
  };
}

export default buildMechanism;
