/**
 * Расчётное ядро физики поршневого ДВС.
 *
 * Чистый ES-модуль: ни DOM, ни three.js (из layout.js берётся только таблица
 * компоновок). Однозонная термодинамическая модель, интегрирование по углу
 * поворота коленвала с шагом 0.5°.
 *
 * Экспорт:
 *   PRESETS                     — готовые наборы параметров (бензин / дизель)
 *   createEngine(params) → Engine
 *
 * Что умеет:
 *   • четыре такта (цикл 720°) и два такта с окнами и кривошипно-камерной
 *     продувкой (цикл 360°) — `params.cycleDeg` всегда говорит, какой сейчас;
 *   • компоновки single / i4 / v8 (развал 90°, крестообразный вал, порядок
 *     работы 1–8–4–3–6–5–7–2) — фазы берутся из layout.js;
 *   • наддув: компрессор с честным нагревом заряда, интеркулер, турбояма
 *     через инерцию ротора (`stepTurbo`), вестгейт, влияние на детонацию;
 *   • настроенный впуск: четвертьволновой резонанс, пик момента ездит
 *     по оборотам при изменении `intakeLen_mm`;
 *   • уравновешенность: `cycle.shakeX_N/shakeY_N` и `metrics.balance`.
 *
 * Таблицы цикла — Float32Array длиной 1441 (720°) или 721 (360°),
 * индекс i ↔ угол i·0.5°.
 */

import { layoutSpec } from './layout.js';

/* ═══════════════════════════════ константы ═══════════════════════════════ */

const R_GAS = 287;            // газовая постоянная воздуха, Дж/(кг·К)
const P_ATM = 1.0e5;          // давление в картере / атмосфера, Па
const T_WALL = 450;           // температура стенок камеры, К
const T_INTAKE = 320;         // температура свежего заряда с учётом подогрева, К
const P_EXH_BAR = 1.05;       // давление в выпускном коллекторе, бар
const N_PEAK = 3500;          // обороты максимального наполнения, об/мин
const ETA_V_MAX = 0.92;       // максимальный коэффициент наполнения
const ETA_COMB = 0.98;        // полнота сгорания
const WIEBE_A = 5, WIEBE_M = 2;              // бензин: S-образное тепловыделение
const DIESEL_PREMIX = 0.35;                  // доля топлива, сгорающая в premixed-фазе
const WIEBE_M_PREMIX = 1.5;                  // форма premixed-фазы (короткая, резкая)
const WIEBE_M_DIFF = 1.0;                    // форма диффузионной фазы (длинная)
const WIEBE_NORM = 1 - Math.exp(-WIEBE_A);   // xb(Δθ) → нормируем до ровной 1
const WOSCHNI_C = 3.26;                      // константа корреляции Вошни (СИ, p в кПа)
const HEAD_AREA_K = 1.35;                    // головка не плоская: клапаны, «крыша», свеча
const PORT_HEAT_FRAC = 0.18;                 // доля энтальпии выхлопа, снимаемая головкой и каналом

const STEP_DEG = 0.5;
const N_PTS = 1441;                 // 0…720° включительно (четырёхтактный)
const N_STEPS = N_PTS - 1;          // 1440 шагов = полный цикл
const SUB = 4;                      // подшагов интегрирования на каждые 0.5°

/* ── наддув и впускной тракт ── */
const T_AMB = 300;            // температура окружающего воздуха, К
const PORT_HEAT_K = 20;       // подогрев заряда во впускном канале, К (атмосферный: 300+20 = 320)
const ETA_COMPRESSOR = 0.72;  // адиабатный КПД компрессора
const IC_DT_MIN = 15, IC_DT_MAX = 25;   // насколько интеркулер оставляет заряд теплее воздуха, К
const BOOST_MAX = 1.5;        // предел ползунка наддува, бар
const TURBO_FULL_RPM = 2600;  // обороты, с которых энергии выхлопа хватает на полный наддув
const BOOST_EPS = 0.025;      // порог пересчёта цикла по изменению наддува, бар
const BOOST_MIN_DT = 0.045;   // и не чаще ~22 раз в секунду модельного времени

/* ── резонанс во впускном тракте (четвертьволновая настройка) ── */
const K_TUNE = 8.5;           // номер рабочей гармоники для четырёхтактного
const RES_A = 0.30;           // амплитуда резонансного горба
const RES_W = 0.24;           // относительная ширина горба
const RES_D = 0.08;           // «просадка» вне резонанса (настройка всегда за чей-то счёт)

/* ── двухтактный цикл ── */
const TWO_EO_DEG = 104;       // открытие выпускного окна, град. после ВМТ
const TWO_TO_DEG = 122;       // открытие продувочных окон
const PORT_H_EX = 0.17;       // высота выпускного окна в долях хода поршня
const PORT_H_TR = 0.14;       // высота продувочных окон
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Свойства топлива. */
const FUELS = {
  petrol: { LHV: 44.0e6, AFR: 14.7, socOffset: null, burn: 60 },
  diesel: { LHV: 42.5e6, AFR: 22.0, socOffset: 5, burn: 70 },
};

/* ═══════════════════════════════ утилиты ═══════════════════════════════ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Число или запасное значение — защита от NaN/Infinity на любом этапе. */
const fin = (v, def = 0) => (Number.isFinite(v) ? v : def);

/** Показатель адиабаты как функция температуры: 1.40 при 300 К → ≈1.26 при 2500 К. */
function gammaOf(T) {
  return 1.40 - 0.145 * clamp((T - 300) / 2100, 0, 1);
}

/** Угол внутри окна открытия клапана с учётом перехода через 720°. */
function valveLift(deg, open, close) {
  const dur = ((close - open) % 720 + 720) % 720;
  if (dur < 1) return 0;
  const u = (((deg - open) % 720) + 720) % 720 / dur;
  if (u <= 0 || u >= 1) return 0;
  return 0.5 * (1 - Math.cos(2 * Math.PI * u));   // гладкий профиль «приподнятый косинус»
}

/**
 * Наполнение цилиндра: базовая кривая потерь × множитель настроенного впуска.
 *
 * Физика резонанса. Впускной тракт длиной L работает как четвертьволновая труба:
 * открывшийся клапан посылает волну разрежения, она отражается от открытого конца
 * сжатием и возвращается. Собственная частота `f = c/(4L)`, где c — скорость звука
 * в подогретом заряде. Если к моменту закрытия впуска приходит гребень волны,
 * цилиндр «доливается» — наполнение растёт, и наоборот.
 *
 * Обороты резонанса: `n_рез = 120·f/k`. Порядок гармоники k для реальных длин
 * тракта 150…800 мм и рабочего диапазона 1000…6500 об/мин оказывается около 8,5
 * (низкие k = 2…4 из учебной формулы соответствуют трубам в несколько метров).
 * У двухтактного впуск открыт каждый оборот, поэтому та же труба резонирует
 * вдвое выше по оборотам — k вдвое меньше.
 *
 * @returns {{etaV:number, nRes:number, fRes:number, res:number, cSound:number}}
 */
function intakeTuning(rpm, len_mm, T_in, two) {
  const cSound = Math.sqrt(1.4 * R_GAS * Math.max(T_in, 200));    // скорость звука в заряде, м/с
  const Lm = clamp(fin(len_mm, 350), 100, 900) / 1000;
  const fRes = cSound / (4 * Lm);                                 // Гц
  const nRes = clamp(120 * fRes / (two ? K_TUNE / 2 : K_TUNE), 300, 30000);

  // базовая кривая: сверху душит проходное сечение (∝ n⁴), снизу — обратный
  // выброс через перекрытие клапанов и низкая скорость потока
  const base = ETA_V_MAX * (1 - 0.42 * Math.pow(rpm / 8000, 4) - 0.50 * Math.exp(-rpm / 1800));

  // горб на основной гармонике + слабый на второй (n_рез/2)
  const g = x => Math.exp(-Math.pow((x - 1) / RES_W, 2));
  const res = 1 + RES_A * (g(rpm / nRes) + 0.18 * g(2 * rpm / nRes)) - RES_D;

  return { etaV: clamp(base * res, 0.25, 1.15), nRes, fRes, res, cSound };
}

/* ═══════════════════════════════ пресеты ═══════════════════════════════ */

/** Параметры по умолчанию (см. §1 контракта). */
const DEFAULTS = {
  bore_mm: 86,
  stroke_mm: 86,
  rod_mm: 143,
  eps: 10,
  rpm: 3000,
  throttle: 1.0,
  sparkAdvance_deg: 20,
  burnDuration_deg: 60,
  fuel: 'petrol',
  octane: 95,
  cylinders: 4,
  ivo: 700, ivc: 230, evo: 490, evc: 20,
  recipMass_kg: 0.55,
  flywheelJ: 0.12,
  // ── вторая волна ──
  layout: 'i4',            // 'single' | 'i4' | 'v8' — число цилиндров производно от неё
  stroke2: false,          // двухтактный цикл (только одноцилиндровый)
  cycleDeg: 720,           // длина полного цикла: 720 или 360 (производное от stroke2)
  boost_bar: 0,            // наддув сверх атмосферы, бар
  turbo: false,            // турбина с инерцией ротора (иначе наддув мгновенный, как от нагнетателя)
  intercooler: true,       // промежуточный охладитель заряда
  intakeLen_mm: 350,       // длина впускного тракта (резонансная настройка)
};

/** Компоновка по числу цилиндров — для обратной совместимости со старым полем cylinders. */
const cylToLayout = n => (n === 1 ? 'single' : n === 8 ? 'v8' : 'i4');
const LAYOUT_NAMES = { single: 'одноцилиндровый', i4: 'рядная 4', v8: 'V8, крестообразный вал' };

/** Готовые наборы параметров. */
export const PRESETS = {
  petrol: {
    ...DEFAULTS,
    fuel: 'petrol',
    eps: 10,
    sparkAdvance_deg: 20,
    burnDuration_deg: 60,
    octane: 95,
  },
  diesel: {
    ...DEFAULTS,
    fuel: 'diesel',
    eps: 18,
    sparkAdvance_deg: 0,     // у дизеля не используется: впрыск за 5° до ВМТ
    burnDuration_deg: 70,
    octane: 95,
    ivc: 220, evo: 480,
  },
};

/* ═══════════════════════════════ класс Engine ═══════════════════════════════ */

class Engine {
  constructor(params) {
    this.params = { ...DEFAULTS };
    this._dyn = { deg: 0, omega: 0 };
    // состояние турбокомпрессора: p — текущее давление, target — куда стремится,
    // t — модельное время (для ограничения частоты пересчёта цикла)
    this._turbo = { p: 0, target: 0, t: 0, lastT: -1 };
    this._boostMode = 'state';    // 'state' — по инерции ротора, 'steady' — установившийся (для свипа)
    this._boostApplied = 0;
    this.setParams(params || {});
    this._turbo.p = this._boostTargetAt(this.params.rpm, this.params.throttle);
    this._compute();
  }

  /* ─────────────── наддув ─────────────── */

  /**
   * Установившееся давление наддува при данных оборотах и дросселе.
   * Энергия выхлопа растёт с оборотами и нагрузкой; вестгейт срезает всё выше boost_bar.
   */
  _boostTargetAt(rpm, thr) {
    const p = this.params;
    if (!p || !(p.boost_bar > 0)) return 0;
    if (!p.turbo) return p.boost_bar;                 // приводной нагнетатель — сразу полка
    const e = Math.pow(clamp(fin(rpm, 3000) / TURBO_FULL_RPM, 0, 1), 1.6)
            * Math.pow(clamp(fin(thr, 1), 0, 1), 0.8);
    return p.boost_bar * clamp(e, 0, 1);              // ограничение вестгейтом
  }

  /** Постоянная времени раскрутки ротора: на низах турбина «думает» дольше. */
  _turboTau(rpm) {
    return clamp(0.22 + 300 / Math.max(fin(rpm, 3000), 200), 0.30, 0.80);
  }

  /** Наддув, с которым считается текущий цикл. */
  _effectiveBoost() {
    const p = this.params;
    if (!p || !(p.boost_bar > 0)) return 0;
    if (this._boostMode === 'steady') return this._boostTargetAt(p.rpm, p.throttle);
    if (!p.turbo) return p.boost_bar;
    return clamp(this._turbo.p, 0, p.boost_bar);
  }

  /* ─────────────── параметры ─────────────── */

  /** Слить патч с текущими параметрами, привести к допустимым диапазонам и пересчитать цикл. */
  setParams(patch) {
    const p = { ...this.params, ...(patch || {}) };

    p.bore_mm = clamp(fin(p.bore_mm, 86), 40, 200);
    p.stroke_mm = clamp(fin(p.stroke_mm, 86), 40, 200);
    p.rod_mm = clamp(fin(p.rod_mm, 143), p.stroke_mm * 0.62, 500);   // λ ≤ ~0.8
    p.eps = clamp(fin(p.eps, 10), 6, 26);
    p.rpm = clamp(fin(p.rpm, 3000), 300, 9000);
    p.throttle = clamp(fin(p.throttle, 1), 0.02, 1);
    p.sparkAdvance_deg = clamp(fin(p.sparkAdvance_deg, 20), 0, 60);
    p.fuel = p.fuel === 'diesel' ? 'diesel' : 'petrol';
    p.burnDuration_deg = clamp(fin(p.burnDuration_deg, FUELS[p.fuel].burn), 10, 140);
    p.octane = clamp(fin(p.octane, 95), 70, 120);
    // ── компоновка и такт ──
    // Первичен layout; старое поле cylinders продолжает работать: если в патче есть
    // только оно, компоновка выводится из числа цилиндров.
    const has = k => patch && Object.prototype.hasOwnProperty.call(patch, k);
    let lay = has('layout') ? patch.layout
      : (has('cylinders') ? cylToLayout(patch.cylinders) : p.layout);
    if (!LAYOUT_NAMES[lay]) lay = cylToLayout(fin(p.cylinders, 4));
    p.stroke2 = !!p.stroke2;
    if (p.stroke2) lay = 'single';               // двухтактный — только одноцилиндровый
    p.layout = lay;
    p.cylinders = layoutSpec(lay).cylinders;
    p.cycleDeg = p.stroke2 ? 360 : 720;

    // ── наддув и впускной тракт ──
    p.boost_bar = clamp(fin(p.boost_bar, 0), 0, BOOST_MAX);
    p.turbo = !!p.turbo;
    p.intercooler = p.intercooler !== false;
    p.intakeLen_mm = clamp(fin(p.intakeLen_mm, 350), 100, 900);

    p.recipMass_kg = clamp(fin(p.recipMass_kg, 0.55), 0.05, 10);
    p.flywheelJ = clamp(fin(p.flywheelJ, 0.12), 0.005, 5);

    // фазы газораспределения: приводим в 0…720 и следим, чтобы закрытый участок был не нулевой
    const ph = v => ((fin(v, 0) % 720) + 720) % 720;
    p.ivo = ph(p.ivo); p.ivc = ph(p.ivc); p.evo = ph(p.evo); p.evc = ph(p.evc);
    if (!(p.ivc > 180 && p.ivc < 330)) p.ivc = 230;
    if (!(p.evo > 400 && p.evo < 600)) p.evo = 490;
    if (!(p.evc >= 0 && p.evc < 90)) p.evc = 20;
    if (!(p.ivo > 600 && p.ivo <= 720)) p.ivo = 700;

    // округляем фазы до узла сетки 0.5°
    for (const k of ['ivo', 'ivc', 'evo', 'evc']) p[k] = Math.round(p[k] / STEP_DEG) * STEP_DEG;

    const rpmChanged = p.rpm !== this.params.rpm;
    const turboChanged = p.turbo !== this.params.turbo;
    this.params = p;

    // Состояние ротора не сбрасываем при смене оборотов и дросселя — именно из этого
    // рождается турбояма. Сбрасываем только при переключении самого типа наддува.
    if (!p.turbo) this._turbo.p = p.boost_bar;
    else if (turboChanged) this._turbo.p = 0;
    this._turbo.p = clamp(this._turbo.p, 0, p.boost_bar);
    this._turbo.target = this._boostTargetAt(p.rpm, p.throttle);

    this._compute();

    // динамика: при первом расчёте и при смене оборотов встаём на номинал
    if (!this._dyn.omega || rpmChanged) this.reset();
    return this;
  }

  /** Сброс динамики маховика к номинальным оборотам и началу цикла. */
  reset() {
    this._dyn.deg = 0;
    this._dyn.omega = this.params.rpm * Math.PI / 30;
    return this;
  }

  /* ─────────────── основной расчёт ─────────────── */

  _compute() {
    const p = this.params;
    const F = FUELS[p.fuel];

    /* ── длина цикла: 720° (четыре такта) или 360° (два такта) ── */
    const two = !!p.stroke2;
    const CYC = two ? 360 : 720;
    const NPTS = Math.round(CYC / STEP_DEG) + 1;   // 1441 или 721
    const NST = NPTS - 1;
    const wrap = i => ((i % NST) + NST) % NST;

    /* ── геометрия ── */
    const B = p.bore_mm / 1000;
    const S = p.stroke_mm / 1000;
    const r = S / 2;
    const Lrod = p.rod_mm / 1000;
    const lam = r / Lrod;
    const A = Math.PI * B * B / 4;
    const Vd = A * S;
    const Vc = Vd / (p.eps - 1);

    this.geometry = {
      Vd_cm3: Vd * 1e6, Vc_cm3: Vc * 1e6, Vtotal_cm3: (Vd + Vc) * 1e6,
      A_m2: A, r_m: r, L_m: Lrod, lambda: lam, stroke_m: S,
    };

    const omega = p.rpm * Math.PI / 30;                       // рад/с
    const dth = STEP_DEG * DEG2RAD;                           // шаг по углу, рад
    const dtStep = dth / omega;                               // шаг по времени, с

    /* ── кинематика (шаг 0.5°) ── */
    // s(θ) — путь поршня от ВМТ, м;  ds/dθ и d²s/dθ² — производные по углу
    const posOf = th => (r + Lrod) - (r * Math.cos(th) + Math.sqrt(Math.max(Lrod * Lrod - (r * Math.sin(th)) ** 2, 1e-12)));
    const velOf = th => {
      const s2 = 1 - lam * lam * Math.sin(th) ** 2;
      return r * (Math.sin(th) + lam * Math.sin(2 * th) / (2 * Math.sqrt(Math.max(s2, 1e-9))));
    };

    const deg = new Float32Array(NPTS);
    const V_cm3 = new Float32Array(NPTS);
    const pistonFrac = new Float32Array(NPTS);
    const pistonVel = new Float32Array(NPTS);
    const pistonAcc = new Float32Array(NPTS);
    const liftIn = new Float32Array(NPTS);
    const liftEx = new Float32Array(NPTS);

    const Vm = new Float64Array(NPTS);      // объём, м³ (рабочая точность)
    const dVdth = new Float64Array(NPTS);   // dV/dθ, м³/рад

    // Двухтактный: окна открывает юбка поршня. Порог — по пройденной доле хода:
    // выпускное окно открывается на 104° после ВМТ (≈68 % хода), продувочные на 122° (≈80 %).
    const fPortEx = posOf(TWO_EO_DEG * DEG2RAD) / S;
    const fPortTr = posOf(TWO_TO_DEG * DEG2RAD) / S;

    const h = 1e-4;
    for (let i = 0; i < NPTS; i++) {
      const d = i * STEP_DEG;
      const th = d * DEG2RAD;
      const s = posOf(th);
      deg[i] = d;
      Vm[i] = Vc + A * s;
      V_cm3[i] = Vm[i] * 1e6;
      pistonFrac[i] = clamp(s / S, 0, 1);
      const v = velOf(th);
      dVdth[i] = A * v;
      pistonVel[i] = omega * v;
      pistonAcc[i] = omega * omega * (velOf(th + h) - velOf(th - h)) / (2 * h);
      if (two) {
        // доля открытия окон 0…1 — 3D и графики работают с ней как с подъёмом клапана
        liftEx[i] = clamp((pistonFrac[i] - fPortEx) / PORT_H_EX, 0, 1);
        liftIn[i] = clamp((pistonFrac[i] - fPortTr) / PORT_H_TR, 0, 1);
      } else {
        liftIn[i] = valveLift(d, p.ivo, p.ivc);
        liftEx[i] = valveLift(d, p.evo, p.evc);
      }
    }

    /* ── газообмен ── */
    // давление во впускном коллекторе (у дизеля дросселя нет)
    // ── наддув: компрессор, интеркулер, температура заряда ──
    const boost = this._effectiveBoost();                   // бар сверх атмосферы
    this._boostApplied = boost;                             // с чем посчитан текущий цикл
    const PR = (P_ATM + boost * 1e5) / P_ATM;               // степень повышения давления в компрессоре
    // адиабатное сжатие с учётом КПД компрессора: воздух заметно греется
    const T_comp = boost > 1e-4
      ? T_AMB * (1 + (Math.pow(PR, (1.4 - 1) / 1.4) - 1) / ETA_COMPRESSOR)
      : T_AMB;
    // интеркулер возвращает заряд почти к атмосферной температуре
    const T_charge = (boost > 1e-4 && p.intercooler)
      ? T_AMB + IC_DT_MIN + (IC_DT_MAX - IC_DT_MIN) * clamp((PR - 1) / 0.8, 0, 1)
      : T_comp;
    const T_in = T_charge + PORT_HEAT_K;                    // подогрев в канале и от стенок

    const p_man = (P_ATM + boost * 1e5) * (p.fuel === 'diesel' ? 1.0 : 0.12 + 0.88 * p.throttle);
    const p_exh = P_EXH_BAR * 1e5 * (1 + 0.35 * boost);     // турбина подпирает выпуск

    const tune = intakeTuning(p.rpm, p.intakeLen_mm, T_in, p.stroke2);
    const etaV = tune.etaV;

    const rho_ref = p_man / (R_GAS * T_in);          // плотность заряда во впуске

    /* ── масса заряда ── */
    let m_air, m_fuel, m_fuelDeliv, deliveryRatio = 0, trapEff = 1, scavEff = 1, etaCharge = etaV;

    if (two) {
      // Двухтактный: продувка кривошипной камерой. Насосная способность камеры
      // максимальна около 4200 об/мин, дополнительно её правит настроенный тракт.
      const pump = clamp(1 - 0.45 * Math.pow((p.rpm - 4200) / 4200, 2), 0.30, 1);
      deliveryRatio = clamp(1.05 * pump * tune.res, 0.15, 1.20);
      const m_deliv = deliveryRatio * rho_ref * Vd;

      // Короткое замыкание продувки: часть свежей смеси уходит прямо в выпускное
      // окно (оно открыто одновременно с продувочными). Потери растут с оборотами
      // и с количеством поданной смеси.
      trapEff = clamp(0.95 - 0.15 * deliveryRatio - 0.20 * Math.pow(p.rpm / 6500, 1.5), 0.40, 0.90);
      m_air = m_deliv * trapEff;                     // осталось в цилиндре
      m_fuel = m_air / F.AFR;                        // смесь готовится в кривошипной камере,
      m_fuelDeliv = m_deliv / F.AFR;                 // поэтому вылетает и часть топлива
      // Чистота заряда: смесь идеального вытеснения и идеального перемешивания.
      scavEff = clamp(0.45 * Math.min(deliveryRatio, 1) + 0.55 * (1 - Math.exp(-deliveryRatio)), 0.35, 0.95);
      etaCharge = deliveryRatio * trapEff;           // коэффициент наполнения двухтактного
    } else {
      m_air = etaV * p_man * Vd / (R_GAS * T_in);
      // бензин — количественное регулирование (смесь стехиометрическая),
      // дизель — качественное: масса топлива пропорциональна «педали»
      m_fuel = p.fuel === 'diesel' ? p.throttle * m_air / F.AFR : m_air / F.AFR;
      m_fuelDeliv = m_fuel;
    }
    const m_fresh = m_air + m_fuel;
    const Q_total = m_fuel * F.LHV * ETA_COMB;

    /* ── индексы фаз ── */
    // Четырёхтактный — клапаны; двухтактный — окна: выпускное 104…256°,
    // продувочные 122…238° (симметрично относительно НМТ, их открывает поршень).
    const iIVC = two ? Math.round((360 - TWO_EO_DEG) / STEP_DEG) : Math.round(p.ivc / STEP_DEG);
    const iEVO = two ? Math.round(TWO_EO_DEG / STEP_DEG) : Math.round(p.evo / STEP_DEG);
    const iEVC = two ? Math.round((360 - TWO_EO_DEG) / STEP_DEG) : Math.round(p.evc / STEP_DEG);
    const iTrO = Math.round(TWO_TO_DEG / STEP_DEG);            // открытие продувочных окон
    const iTrC = Math.round((360 - TWO_TO_DEG) / STEP_DEG);    // их закрытие

    /* ── функция Вибе ── */
    const soc = p.fuel === 'diesel' ? 360 - F.socOffset : 360 - p.sparkAdvance_deg;
    const dTh_burn = p.burnDuration_deg;
    // Базовая функция Вибе, нормированная так, что xb(u=1) = 1 ровно.
    const wiebeBase = (u, m) => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      return (1 - Math.exp(-WIEBE_A * Math.pow(u, m + 1))) / WIEBE_NORM;
    };
    // Бензин — одна S-образная кривая (a=5, m=2).
    // Дизель — классическая двойная Вибе: короткая premixed-фаза (топливо, накопленное
    // за период задержки, сгорает почти мгновенно и даёт резкий скачок давления)
    // плюс длинная диффузионная фаза по мере впрыска.
    const wiebe = p.fuel === 'diesel'
      ? (d => {
          const preDur = Math.max(0.3 * dTh_burn, 8);
          return DIESEL_PREMIX * wiebeBase((d - soc) / preDur, WIEBE_M_PREMIX)
            + (1 - DIESEL_PREMIX) * wiebeBase((d - soc) / dTh_burn, WIEBE_M_DIFF);
        })
      : (d => wiebeBase((d - soc) / dTh_burn, WIEBE_M));

    /* ── рабочие массивы состояния ── */
    const p_pa = new Float64Array(NPTS);
    const T_k = new Float64Array(NPTS);
    const m_kg = new Float64Array(NPTS);
    const xb = new Float32Array(NPTS);
    const knockInt = new Float32Array(NPTS);

    if (two) {
      // У двухтактного сгорание идёт через 0° (ВМТ), поэтому Вибе считаем не по
      // абсолютному углу, а по «прогрессу» закрытого цикла от закрытия окон.
      const ecDeg = iEVC * STEP_DEG;
      const prog = d => (((d - ecDeg) % 360) + 360) % 360;
      const socProg = prog(soc % 360);
      for (let i = 0; i < NPTS; i++) {
        xb[i] = wiebeBase((prog(deg[i]) - socProg) / dTh_burn, WIEBE_M);
      }
    } else {
      for (let i = 0; i < NPTS; i++) xb[i] = wiebe(deg[i]);
    }

    // геометрия теплоотдающей поверхности: днище поршня + головка + открытая часть гильзы
    // (площадь гильзы растёт вместе с объёмом — по мере движения поршня вниз)
    const surfOf = Vol => A * (1 + HEAD_AREA_K) + Math.PI * B * (Vol / A);

    // средняя скорость поршня — для Вошни
    const Sp = 2 * S * p.rpm / 60;
    const tau_deg = clamp(12 * (p.rpm / 3000), 3, 40);        // постоянная истечения, град
    const p_exh_eff = p_exh * (1 + 0.10 * (p.rpm / 3000) ** 2);

    let Q_wall_total = 0;
    let T_res = 1000;                                          // оценка температуры остаточных газов
    // Продувка камеры при наддуве: если давление во впуске выше, чем в выпуске,
    // на перекрытии клапанов свежий заряд выдувает часть остаточных газов.
    const scavK = clamp(Math.pow(p_exh / Math.max(p_man, 1e3), 0.7), 0.25, 1);
    let m_res = scavK * p_exh * Vm[iEVC] / (R_GAS * T_res);

    /**
     * Закрытый участок цикла (клапаны или окна закрыты): интегрирование
     * первого начала термодинамики по углу с подшагами, плюс интеграл
     * Ливенгуда–Ву по несгоревшей смеси. Индексы заворачиваются по циклу,
     * поэтому годится и для четырёхтактного (IVC→EVO), и для двухтактного
     * (закрытие окон → открытие выпускного окна через ВМТ).
     */
    const runClosed = (iStart, nSteps, m_cyl, T0, P0) => {
      const i0 = wrap(iStart);
      const T_ivc = T0, p_ivc = P0, V_ivc = Vm[i0];
      let T = T0, P = P0;
      m_kg[i0] = m_cyl;

      // детонация: интеграл Ливенгуда–Ву (только бензин)
      const knockOn = p.fuel === 'petrol';
      const onFac = 17.68 * Math.pow(p.octane / 100, 3.402);
      let LW = 0;
      let knockDeg = NaN;
      const dtSub = dtStep / SUB;

      for (let k = 0; k < nSteps; k++) {
        const i = wrap(iStart + k), j = wrap(i + 1);
        // подшаги: линейная интерполяция объёма и Вибе внутри шага 0.5°
        for (let s = 0; s < SUB; s++) {
          const fr = s / SUB, fr2 = (s + 1) / SUB;
          const Vol = Vm[i] + (Vm[j] - Vm[i]) * fr;
          const dV = (Vm[j] - Vm[i]) / SUB;
          const dxb = (xb[i] + (xb[j] - xb[i]) * fr2) - (xb[i] + (xb[j] - xb[i]) * fr);
          const dQc = Q_total * dxb;

          // теплоотдача (упрощённый Вошни)
          const p_mot = p_ivc * Math.pow(V_ivc / Vol, 1.35);
          const w = 2.28 * Sp + 3.24e-3 * (Vd * T_ivc / (p_ivc * V_ivc)) * Math.max(P - p_mot, 0);
          const hc = clamp(
            WOSCHNI_C * Math.pow(B, -0.2) * Math.pow(Math.max(P, 1e3) / 1000, 0.8) *
            Math.pow(Math.max(T, 200), -0.53) * Math.pow(Math.max(w, 0.5), 0.8),
            50, 12000);
          const dQw = hc * surfOf(Vol) * (T - T_WALL) * dtSub;
          Q_wall_total += dQw;

          const cv = R_GAS / (gammaOf(T) - 1);
          const dT = (dQc - dQw - P * dV) / Math.max(m_cyl * cv, 1e-9);
          T = clamp(T + dT, 200, 4500);
          P = m_cyl * R_GAS * T / Math.max(Vol + dV, 1e-9);
          P = clamp(P, 1e3, 5e7);

          // ── детонация (Ливенгуд–Ву), только бензин ──
          // Самовоспламениться может лишь та смесь, до которой ещё не дошёл фронт пламени,
          // поэтому подынтегральное выражение взвешено на несгоревшую долю (1 − xb):
          // к концу сгорания «концевых газов» уже нет и вклад обнуляется.
          if (knockOn && LW < 8) {
            const xbLoc = xb[i] + (xb[j] - xb[i]) * fr;
            const unburned = 1 - xbLoc;
            if (unburned > 5e-3) {
              // состояние несгоревшей зоны: адиабатическое сжатие от условий в начале сжатия
              const gu = 1.32;                              // показатель адиабаты свежей смеси
              const Tu = clamp(T_ivc * Math.pow(Math.max(P / p_ivc, 1e-6), (gu - 1) / gu), 250, 2200);
              const p_atm = P / 101325;                     // корреляция требует давление в АТМ
              const tau_ms = onFac * Math.pow(Math.max(p_atm, 1e-3), -1.7) * Math.exp(3800 / Tu);
              const prev = LW;
              LW += unburned * (dtSub * 1000) / Math.max(tau_ms, 1e-6);
              if (prev < 1 && LW >= 1) knockDeg = deg[i];
            }
          }
        }
        T_k[j] = T;
        p_pa[j] = P;
        m_kg[j] = m_cyl;
        knockInt[j] = LW;
      }
      return { T, P, LW, knockDeg };
    };

    // два прохода: второй уточняет параметры остаточных газов
    for (let pass = 0; pass < 2; pass++) {
      Q_wall_total = 0;

      if (two) {
        /* ═══ двухтактный цикл: 0° ВМТ → расширение → продувка → сжатие ═══ */

        // Состав заряда к моменту закрытия продувочных окон: свежая смесь плюс
        // то, что не удалось выдуть (чистота продувки scavEff).
        const m_res2 = m_fresh * (1 - scavEff) / Math.max(scavEff, 1e-3);
        const m_cyl = m_fresh + m_res2;
        const T_ec = (m_fresh * T_in + m_res2 * T_res) / Math.max(m_cyl, 1e-12);
        const P_ec = m_cyl * R_GAS * T_ec / Vm[iEVC];

        /* ── 1. Закрытый цикл: закрытие выпускного окна → его открытие (через ВМТ) ── */
        const nClosed = ((iEVO - iEVC) + NST) % NST;
        const cl2 = runClosed(iEVC, nClosed, m_cyl, T_ec, P_ec);
        let T = cl2.T, P = cl2.P;
        this._knock = {
          happens: cl2.LW >= 1, intensity: cl2.LW,
          deg: Number.isFinite(cl2.knockDeg) ? cl2.knockDeg : NaN,
        };

        /* ── 2. Выпуск и продувка: EO → EC ── */
        // Сначала свободный выпуск (перепад давлений), затем окна продувки открыты
        // и цилиндр промывается смесью из кривошипной камеры: температура плавно
        // сходится к смеси свежего заряда и остатков.
        const tau2 = clamp(7 * (p.rpm / 3000), 2, 30);
        const nScav = ((iEVC - iEVO) + NST) % NST;
        for (let k = 0; k < nScav; k++) {
          const i = wrap(iEVO + k);
          const j = wrap(i + 1);
          const g = gammaOf(T);
          const dV = Vm[j] - Vm[i];
          // давление в цилиндре тянется к выпускному; при открытых продувочных окнах
          // кривошипная камера немного подпирает его снизу
          const scavOpen = liftIn[i] > 0.01;
          const pTarget = scavOpen ? p_exh_eff * 1.04 : p_exh_eff;
          let Pn = P + (-(P - pTarget) / tau2 * STEP_DEG) - g * P * dV / Math.max(Vm[i], 1e-9);
          Pn = clamp(Pn, 0.2e5, 5e7);
          T = clamp(T * Math.pow(Pn / Math.max(P, 1e3), (g - 1) / g), 250, 4500);
          if (scavOpen) {
            // промывка: доля замещённого газа за шаг пропорциональна открытию окон
            const mix = clamp(liftIn[i] * 0.055, 0, 0.5);
            T = clamp(T + (T_ec - T) * mix, 250, 4500);
          }
          P = Pn;
          p_pa[j] = P;
          T_k[j] = T;
          m_kg[j] = P * Vm[j] / (R_GAS * T);
        }
        // в точке закрытия окон состав известен точно
        p_pa[iEVC] = P_ec;
        T_k[iEVC] = T_ec;
        m_kg[iEVC] = m_cyl;

        T_res = clamp(T, 500, 1800);
        continue;
      }

      /* ── 1. Впуск: EVC → IVC ── */
      // масса набирается по вытесняемому объёму; к IVC доходит до полного заряда
      const V_evc = Vm[iEVC];
      const iBDC = Math.round(180 / STEP_DEG);
      const Vspan = Math.max(Vm[iBDC] - V_evc, 1e-9);
      const nIntake = ((iIVC - iEVC) + NST) % NST;
      for (let k = 0; k <= nIntake; k++) {
        const i = wrap(iEVC + k);
        const d = i * STEP_DEG;
        let f;
        if (d <= 180) f = 0.93 * clamp((Vm[i] - V_evc) / Vspan, 0, 1);
        else f = 0.93 + 0.07 * clamp((d - 180) / Math.max(p.ivc - 180, 1), 0, 1);
        const mm = m_res + m_fresh * f;
        const TT = (m_res * T_res + m_fresh * f * T_in) / Math.max(mm, 1e-12);
        m_kg[i] = mm;
        T_k[i] = TT;
        p_pa[i] = mm * R_GAS * TT / Vm[i];
      }

      /* ── 2. Закрытый цикл: IVC → EVO ── */
      const m_cyl = m_res + m_fresh;
      const cl = runClosed(iIVC, iEVO - iIVC, m_cyl, T_k[iIVC], p_pa[iIVC]);
      let T = cl.T, P = cl.P;
      this._knock = { happens: cl.LW >= 1, intensity: cl.LW, deg: Number.isFinite(cl.knockDeg) ? cl.knockDeg : NaN };

      /* ── 3. Выпуск: EVO → EVC ── */
      const nExh = ((iEVC - iEVO) + NST) % NST;
      for (let k = 0; k < nExh; k++) {
        const i = wrap(iEVO + k);
        const j = wrap(i + 1);
        const g = gammaOf(T);
        const dV = Vm[j] - Vm[i];
        // истечение через клапан + работа поршня
        let Pn = P + (-(P - p_exh_eff) / tau_deg * STEP_DEG) - g * P * dV / Math.max(Vm[i], 1e-9);
        Pn = clamp(Pn, 0.2e5, 5e7);
        // оставшийся в цилиндре газ расширяется изоэнтропийно
        T = clamp(T * Math.pow(Pn / Math.max(P, 1e3), (g - 1) / g), 250, 4500);
        P = Pn;
        p_pa[j] = P;
        T_k[j] = T;
        m_kg[j] = P * Vm[j] / (R_GAS * T);
      }

      // уточняем остаточные газы для следующего прохода
      T_res = clamp(T_k[iEVC], 500, 1800);
      m_res = clamp(scavK * p_pa[iEVC] * Vm[iEVC] / (R_GAS * T_res), 1e-8, m_fresh);
    }

    // замыкаем таблицу: 720° = 0°
    p_pa[NPTS - 1] = p_pa[0];
    T_k[NPTS - 1] = T_k[0];
    m_kg[NPTS - 1] = m_kg[0];
    knockInt[NPTS - 1] = knockInt[NPTS - 2];

    /* ── силы и моменты ── */
    const p_bar = new Float32Array(NPTS);
    const T_K = new Float32Array(NPTS);
    const mass_g = new Float32Array(NPTS);
    const gasForce = new Float32Array(NPTS);
    const inertiaForce = new Float32Array(NPTS);
    const rodForce = new Float32Array(NPTS);
    const sideForce = new Float32Array(NPTS);
    const torque = new Float32Array(NPTS);
    const torqueTotal = new Float32Array(NPTS);

    for (let i = 0; i < NPTS; i++) {
      const th = deg[i] * DEG2RAD;
      p_bar[i] = fin(p_pa[i] / 1e5, 1);
      T_K[i] = fin(T_k[i], 300);
      mass_g[i] = fin(m_kg[i] * 1000, 0);

      const Fg = (p_pa[i] - P_ATM) * A;                       // вниз положительно
      const Fi = -p.recipMass_kg * pistonAcc[i];              // инерционная сила
      const Fp = Fg + Fi;                                     // суммарная сила на палец
      const sb = clamp(lam * Math.sin(th), -0.999, 0.999);
      const beta = Math.asin(sb);
      const cb = Math.max(Math.cos(beta), 1e-6);
      const bracket = Math.sin(th) + lam * Math.sin(2 * th) /
        (2 * Math.sqrt(Math.max(1 - lam * lam * Math.sin(th) ** 2, 1e-9)));

      gasForce[i] = fin(Fg);
      inertiaForce[i] = fin(Fi);
      rodForce[i] = fin(Fp / cb);
      sideForce[i] = fin(Fp * Math.tan(beta));
      torque[i] = fin(Fp * r * bracket);
    }

    // Суммарный момент компоновки: смещения цикла берём из таблицы компоновок
    // (рядная 4 — порядок 1–3–4–2, V8 — 1–8–4–3–6–5–7–2 через каждые 90°).
    const spec = layoutSpec(p.layout);
    const offs = spec.cyl.map(c => Math.round((((c.phase || 0) % CYC) + CYC) % CYC / STEP_DEG));
    for (let i = 0; i < NPTS; i++) {
      let s = 0;
      for (const o of offs) s += torque[wrap(i + o)];
      torqueTotal[i] = fin(s);
    }
    torqueTotal[NPTS - 1] = torqueTotal[0];

    /* ── уравновешенность: суммарные силы инерции возвратно-поступательных масс ──
     * Сила каждого цилиндра направлена вдоль его оси, поэтому у V-образного
     * двигателя её надо раскладывать по наклону ряда (±45° у V8).
     * Продольный момент считаем относительно середины блока по разносу цилиндров.  */
    const shakeX = new Float32Array(NPTS);
    const shakeY = new Float32Array(NPTS);
    const coupleZ = new Float64Array(NPTS);
    {
      let zMid = 0;
      for (const c of spec.cyl) zMid += (c.z || 0);
      zMid /= Math.max(spec.cyl.length, 1);
      for (let i = 0; i < NPTS; i++) {
        let fx = 0, fy = 0, mx = 0, my = 0;
        for (let q = 0; q < spec.cyl.length; q++) {
          const c = spec.cyl[q];
          const a = c.tilt || 0;                       // наклон оси цилиндра от вертикали
          const F = inertiaForce[wrap(i + offs[q])];   // сила вдоль оси этого цилиндра
          const ex = Math.sin(a), ey = Math.cos(a);
          fx += F * ex;
          fy += F * ey;
          const z = ((c.z || 0) - zMid) * 0.01;        // юниты сцены (1 = 10 мм) → метры
          mx += F * ey * z;
          my += F * ex * z;
        }
        shakeX[i] = fin(fx);
        shakeY[i] = fin(fy);
        coupleZ[i] = Math.hypot(mx, my);
      }
    }

    /** Амплитуда гармоники k-го порядка (частота = k × обороты) вектора (X, Y). */
    const orderAmp = k => {
      let axc = 0, axs = 0, ayc = 0, ays = 0;
      for (let i = 0; i < NST; i++) {
        const th = k * deg[i] * DEG2RAD;
        const cs = Math.cos(th), sn = Math.sin(th);
        axc += shakeX[i] * cs; axs += shakeX[i] * sn;
        ayc += shakeY[i] * cs; ays += shakeY[i] * sn;
      }
      const n2 = 2 / NST;
      axc *= n2; axs *= n2; ayc *= n2; ays *= n2;
      // вектор порядка k вращается — берём наибольшую его длину за оборот
      let mx = 0;
      for (let d = 0; d < 360; d += 2) {
        const th = k * d * DEG2RAD;
        const cs = Math.cos(th), sn = Math.sin(th);
        mx = Math.max(mx, Math.hypot(axc * cs + axs * sn, ayc * cs + ays * sn));
      }
      return mx;
    };

    const primary_N = orderAmp(1);
    const secondary_N = orderAmp(2);
    let couple_Nm = 0;
    for (let i = 0; i < NST; i++) if (coupleZ[i] > couple_Nm) couple_Nm = coupleZ[i];

    // словесный вывод — то, чем компоновка хороша или плоха
    const kN = v => (v >= 1000 ? (v / 1000).toFixed(1) + ' кН' : Math.round(v) + ' Н');
    let verdict;
    if (p.layout === 'single') {
      verdict = `Одноцилиндровый: сила первого порядка (${kN(primary_N)}) ничем не скомпенсирована — `
        + 'её гасят только противовесами и балансирным валом, отсюда характерная тряска.';
    } else if (p.layout === 'i4') {
      verdict = `Рядная четвёрка: первый порядок взаимно погашен (${kN(primary_N)}), но силы второго порядка `
        + `всех четырёх цилиндров складываются (${kN(secondary_N)}) — классическая вибрация I4 на средних оборотах.`;
    } else {
      verdict = `V8, развал 90°, крестообразный вал: и первый (${kN(primary_N)}), и второй (${kN(secondary_N)}) порядки `
        + `уравновешены, остаётся лишь продольный момент ${couple_Nm.toFixed(0)} Н·м — платой за это идёт неравномерный выпуск.`;
    }
    const balance = {
      primary_N: fin(primary_N, 0),
      secondary_N: fin(secondary_N, 0),
      couple_Nm: fin(couple_Nm, 0),
      verdict,
    };

    /* ── интегральные показатели ── */
    // работа за цикл ∮ p dV (трапеции по полному циклу 0…720)
    let W = 0, Wgross = 0, pmax = 0, ipmax = 0, Tmax = 0;
    for (let i = 0; i < NST; i++) {
      const dW = 0.5 * (p_pa[i] + p_pa[i + 1]) * (Vm[i + 1] - Vm[i]);
      W += dW;
      if (i >= iIVC && i < iEVO) Wgross += dW;
      if (p_pa[i] > pmax) { pmax = p_pa[i]; ipmax = i; }
      if (T_k[i] > Tmax) Tmax = T_k[i];
    }

    const imep = W / Vd;                                  // Па
    const fmep = (0.97 + 0.15 * (p.rpm / 1000) + 0.05 * (p.rpm / 1000) ** 2) * 1e5;
    const bmep = imep - fmep;

    // у двухтактного рабочий ход каждый оборот — вдвое чаще
    const cyclesPerSec = two ? p.rpm / 60 : p.rpm / 120;   // рабочих циклов в секунду
    const indPower = imep * Vd * cyclesPerSec * p.cylinders;          // Вт
    const brakePower = bmep * Vd * cyclesPerSec * p.cylinders;
    const brakeTorque = brakePower / Math.max(omega, 1e-6);

    // КПД и расход считаем по ПОДАННОМУ топливу: у двухтактного часть смеси
    // вылетает в выпуск несгоревшей, и это должно бить по экономичности
    const Qfuel = m_fuelDeliv * F.LHV;                    // энергия топлива за цикл на цилиндр
    const Qburn = m_fuel * F.LHV;                         // из неё реально попало в камеру
    const effInd = Qfuel > 1e-9 ? W / Qfuel : 0;
    const effBrake = Qfuel > 1e-9 ? (bmep * Vd) / Qfuel : 0;
    const effOtto = 1 - Math.pow(p.eps, -0.4);

    const fuelFlow_g_h = m_fuelDeliv * 1000 * cyclesPerSec * p.cylinders * 3600;
    const bsfc = brakePower > 100 ? fuelFlow_g_h / (brakePower / 1000) : 0;

    // энергетический баланс, %
    // В «охлаждение» входит не только теплоотдача в стенки цилиндра, но и тепло,
    // снимаемое рубашкой с головки и выпускного канала по пути газов наружу.
    const Wfric = fmep * Vd;
    const eb = {
      work: Math.max(bmep * Vd, 0),
      coolant: Math.max(Q_wall_total, 0),
      friction: Math.max(Wfric, 0),
    };
    const exhRaw = Math.max(Qfuel - eb.work - eb.coolant - eb.friction, 0);   // + несгоревшая смесь
    const Q_port = PORT_HEAT_FRAC * exhRaw;
    eb.coolant += Q_port;
    eb.exhaust = Math.max(exhRaw - Q_port, 0);
    const ebSum = eb.work + eb.coolant + eb.friction + eb.exhaust || 1;
    const energy = {
      work_pct: 100 * eb.work / ebSum,
      exhaust_pct: 100 * eb.exhaust / ebSum,
      coolant_pct: 100 * eb.coolant / ebSum,
      friction_pct: 100 * eb.friction / ebSum,
    };

    /* ── неравномерность хода: J·ω·dω/dθ = M(θ) − M_ср ── */
    let Msum = 0;
    for (let i = 0; i < NST; i++) Msum += torqueTotal[i];
    const Mload = Msum / NST;
    const Jtot = p.flywheelJ * p.cylinders;
    const w2 = new Float64Array(NPTS);
    w2[0] = omega * omega;
    for (let i = 0; i < NST; i++) {
      w2[i + 1] = Math.max(w2[i] + 2 * (torqueTotal[i] - Mload) * dth / Jtot, (0.05 * omega) ** 2);
    }
    let wmin = Infinity, wmax = 0, wsum = 0;
    for (let i = 0; i < NST; i++) {
      const wv = Math.sqrt(w2[i]);
      if (wv < wmin) wmin = wv;
      if (wv > wmax) wmax = wv;
      wsum += wv;
    }
    const wavg = wsum / NST;
    const delta = wavg > 1e-6 ? (wmax - wmin) / wavg : 0;

    /* ── публикуем ── */
    this.cycle = {
      deg, V_cm3, p_bar, T_K, mass_g, xb,
      pistonFrac, pistonVel_ms: pistonVel, pistonAcc_ms2: pistonAcc,
      liftIn, liftEx,
      gasForce_N: gasForce, inertiaForce_N: inertiaForce,
      rodForce_N: rodForce, sideForce_N: sideForce,
      torque_Nm: torque, torqueTotal_Nm: torqueTotal,
      knockIntegral: knockInt,
      shakeX_N: shakeX, shakeY_N: shakeY,
    };

    this.metrics = {
      pmax_bar: fin(pmax / 1e5, 0),
      pmax_deg: fin(ipmax * STEP_DEG, 0),
      Tmax_K: fin(Tmax, 300),
      imep_bar: fin(imep / 1e5, 0),
      fmep_bar: fin(fmep / 1e5, 0),
      bmep_bar: fin(bmep / 1e5, 0),
      workPerCycle_J: fin(W, 0),
      grossWork_J: fin(Wgross, 0),
      indPower_kW: fin(indPower / 1000, 0),
      brakePower_kW: fin(brakePower / 1000, 0),
      brakeTorque_Nm: fin(brakeTorque, 0),
      effIndicated: fin(effInd, 0),
      effBrake: fin(effBrake, 0),
      effOtto: fin(effOtto, 0),
      bsfc_g_kWh: fin(bsfc, 0),
      volEff: fin(etaCharge, 0),
      // ── двухтактный ──
      twoStroke: two,
      cycleDeg: CYC,
      deliveryRatio: fin(deliveryRatio, 0),      // сколько подано относительно рабочего объёма
      trappingEff: fin(trapEff, 1),              // сколько из поданного осталось в цилиндре
      scavengeEff: fin(scavEff, 1),              // чистота заряда после продувки
      shortCircuit_pct: fin(two ? 100 * (1 - trapEff) : 0, 0),
      litrePower_kW_L: fin(brakePower / 1000 / Math.max(Vd * 1e3 * p.cylinders, 1e-9), 0),
      knock: {
        happens: !!this._knock.happens,
        intensity: fin(this._knock.intensity, 0),
        deg: Number.isFinite(this._knock.deg) ? this._knock.deg : null,
      },
      energy,
      balance,
      speedFluctuation: fin(delta, 0),
      meanPistonSpeed_ms: fin(2 * S * p.rpm / 60, 0),
      // ── наддув ──
      boostNow_bar: fin(boost, 0),
      boostTarget_bar: fin(this._boostTargetAt(p.rpm, p.throttle), 0),
      turboLagState: fin(this._turbo.target > 1e-3 ? clamp(boost / this._turbo.target, 0, 1) : 1, 1),
      chargeT_K: fin(T_charge, T_AMB),                 // заряд после компрессора/интеркулера
      chargeT_afterComp_K: fin(T_comp, T_AMB),         // он же до интеркулера
      intakeT_K: fin(T_in, T_INTAKE),
      pressureRatio: fin(PR, 1),
      // ── настройка впуска ──
      intakeResonance_rpm: fin(tune.nRes, 0),
      intakeResonance_Hz: fin(tune.fRes, 0),
      intakeResFactor: fin(tune.res, 1),
      soundSpeed_ms: fin(tune.cSound, 340),
      // дополнительно — полезно интерфейсу и графикам
      p_man_bar: fin(p_man / 1e5, 1),
      airMass_g: fin(m_air * 1000, 0),
      fuelMass_mg: fin(m_fuel * 1e6, 0),
      fuelFlow_g_h: fin(fuelFlow_g_h, 0),
      heatToWalls_J: fin(Q_wall_total, 0),
      socDeg: soc,
      meanTorque_Nm: fin(Mload, 0),
    };

    this._Mload = Mload;
    this._sanitize();
  }

  /** Страховка: ни одного NaN/Infinity в таблицах — заменяем на соседнее корректное значение. */
  _sanitize() {
    for (const key of Object.keys(this.cycle)) {
      const arr = this.cycle[key];
      let last = 0;
      for (let i = 0; i < arr.length; i++) {
        if (Number.isFinite(arr[i])) last = arr[i];
        else arr[i] = last;
      }
    }
  }

  /* ─────────────── выборка ─────────────── */

  /** Линейная интерполяция всех таблиц в произвольной точке угла цикла. */
  sample(degIn) {
    const C = this.params.cycleDeg || 720;
    const d = ((fin(degIn, 0) % C) + C) % C;
    const x = d / STEP_DEG;
    const i0 = Math.floor(x);
    const i1 = i0 + 1;
    const t = x - i0;
    const c = this.cycle;
    const out = { deg: d, stroke: Math.floor(d / 180) };
    for (const key of Object.keys(c)) {
      if (key === 'deg') continue;
      const a = c[key];
      out[key] = a[i0] + (a[i1] - a[i0]) * t;
    }
    return out;
  }

  /** Суммарный момент в произвольной точке (для динамики). */
  _torqueAt(d) {
    const C = this.params.cycleDeg || 720;
    const x = (((fin(d, 0) % C) + C) % C) / STEP_DEG;
    const i0 = Math.floor(x), t = x - i0;
    const a = this.cycle.torqueTotal_Nm;
    return a[i0] + (a[i0 + 1] - a[i0]) * t;
  }

  /* ─────────────── динамика маховика ─────────────── */

  /**
   * Интегрирование вращения: J·dω/dt = M_total(θ) − M_load.
   * Нагрузка равна среднему моменту, поэтому обороты колеблются вокруг номинала.
   * @returns {{deg:number, rpmInstant:number}}
   */
  stepDynamics(dt_s) {
    const st = this._dyn;
    const p = this.params;
    const dt = clamp(fin(dt_s, 0), 0, 0.25);
    if (dt <= 0) return { deg: st.deg, rpmInstant: st.omega * 30 / Math.PI };

    const C = p.cycleDeg || 720;
    const J = Math.max(p.flywheelJ * p.cylinders, 1e-4);
    const nSub = clamp(Math.ceil(dt / 4e-4), 1, 400);
    const hStep = dt / nSub;
    const wLo = 0.15 * p.rpm * Math.PI / 30;
    const wHi = 3.0 * p.rpm * Math.PI / 30;

    for (let k = 0; k < nSub; k++) {
      const M = this._torqueAt(st.deg);
      st.omega = clamp(st.omega + (M - this._Mload) / J * hStep, wLo, wHi);
      st.deg += st.omega * hStep * RAD2DEG;
      if (st.deg >= C || st.deg < 0) st.deg = ((st.deg % C) + C) % C;
    }
    if (!Number.isFinite(st.omega)) this.reset();
    return { deg: st.deg, rpmInstant: st.omega * 30 / Math.PI };
  }

  /* ─────────────── внешняя скоростная характеристика ─────────────── */

  /**
   * Свип по оборотам при текущих остальных параметрах.
   * Наддув берётся установившийся (турбояма — эффект переходного режима,
   * на внешней характеристике её нет). Текущее состояние движка не портится:
   * параметры, динамика маховика и таблицы восстанавливаются.
   *
   * @param {{from?:number,to?:number,step?:number}} opts
   * @returns {{rpm:Float32Array, power_kW:Float32Array, torque_Nm:Float32Array,
   *            volEff:Float32Array, knockIntegral:Float32Array, boost_bar:Float32Array}}
   */
  sweepRpm(opts) {
    const o = opts || {};
    let from = clamp(fin(o.from, 800), 300, 9000);
    let to = clamp(fin(o.to, 6500), 300, 9000);
    if (to < from) { const t = from; from = to; to = t; }
    const step = clamp(fin(o.step, 100), 10, 2000);
    const n = clamp(Math.floor((to - from) / step) + 1, 2, 400);

    const out = {
      rpm: new Float32Array(n),
      power_kW: new Float32Array(n),
      torque_Nm: new Float32Array(n),
      volEff: new Float32Array(n),
      knockIntegral: new Float32Array(n),
      boost_bar: new Float32Array(n),
    };

    const savedRpm = this.params.rpm;
    const savedMode = this._boostMode;
    const savedDyn = { ...this._dyn };
    this._boostMode = 'steady';
    try {
      for (let i = 0; i < n; i++) {
        const rpm = clamp(from + i * step, 300, 9000);
        this.params.rpm = rpm;          // напрямую, чтобы не сбрасывать динамику
        this._compute();
        const m = this.metrics;
        out.rpm[i] = rpm;
        out.power_kW[i] = fin(m.brakePower_kW, 0);
        out.torque_Nm[i] = fin(m.brakeTorque_Nm, 0);
        out.volEff[i] = fin(m.volEff, 0);
        out.knockIntegral[i] = fin(m.knock ? m.knock.intensity : 0, 0);
        out.boost_bar[i] = fin(m.boostNow_bar, 0);
      }
    } finally {
      this.params.rpm = savedRpm;
      this._boostMode = savedMode;
      this._compute();
      this._dyn.deg = savedDyn.deg;
      this._dyn.omega = savedDyn.omega;
    }
    return out;
  }

  /* ─────────────── турбояма ─────────────── */

  /**
   * Шаг наддува во времени: ротор турбины разгоняется не мгновенно.
   * `dp/dt = (p_цель − p)/τ`, τ зависит от оборотов (на низах инерция ротора
   * чувствуется сильнее), сброс давления идёт быстрее набора.
   * Цикл пересчитывается только когда наддув заметно изменился и не чаще ~22 раз
   * в секунду модельного времени — иначе каждый кадр стоил бы полного расчёта.
   *
   * @param {number} dt_s шаг модельного времени, с
   * @returns {number} текущее давление наддува, бар
   */
  stepTurbo(dt_s) {
    const p = this.params;
    const dt = clamp(fin(dt_s, 0), 0, 0.25);
    const T = this._turbo;

    if (!p.turbo || !(p.boost_bar > 0)) {
      // приводной нагнетатель или атмосферный режим — давление есть сразу
      T.p = p.boost_bar;
      T.target = p.boost_bar;
    } else {
      T.target = this._boostTargetAt(p.rpm, p.throttle);
      const tau = this._turboTau(p.rpm) * (T.target >= T.p ? 1 : 0.6);
      T.p += (T.target - T.p) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
      T.p = clamp(fin(T.p, 0), 0, p.boost_bar);
    }
    T.t += dt;

    // дешёвое обновление метрик без пересчёта цикла
    this.metrics.boostNow_bar = T.p;
    this.metrics.boostTarget_bar = T.target;
    this.metrics.turboLagState = T.target > 1e-3 ? clamp(T.p / T.target, 0, 1) : 1;

    const far = Math.abs(T.p - this._boostApplied) > BOOST_EPS;
    const settled = Math.abs(T.p - T.target) < 1e-4 && Math.abs(this._boostApplied - T.p) > 1e-4;
    if ((far || settled) && (T.lastT < 0 || T.t - T.lastT >= BOOST_MIN_DT)) {
      T.lastT = T.t;
      this._compute();
    }
    return T.p;
  }

  /* ─────────────── экспорт ─────────────── */

  /** Все таблицы цикла в CSV (разделитель — запятая, десятичная точка). */
  toCSV() {
    const c = this.cycle;
    const keys = Object.keys(c);
    const head = keys.join(',');
    const n = c.deg ? c.deg.length : 0;
    const lines = new Array(n + 1);
    lines[0] = head;
    for (let i = 0; i < n; i++) {
      const row = new Array(keys.length);
      for (let k = 0; k < keys.length; k++) {
        const v = c[keys[k]][i];
        row[k] = Number.isFinite(v) ? v.toPrecision(7) : '0';
      }
      lines[i + 1] = row.join(',');
    }
    return lines.join('\n');
  }
}

/* ═══════════════════════════════ фабрика ═══════════════════════════════ */

/**
 * Создать расчётный объект двигателя.
 * @param {object} params см. §2 контракта; любые поля можно опускать.
 * @returns {Engine}
 */
export function createEngine(params = {}) {
  const base = params && params.preset && PRESETS[params.preset]
    ? PRESETS[params.preset]
    : (params && params.fuel === 'diesel' ? PRESETS.diesel : DEFAULTS);
  return new Engine({ ...base, ...params });
}

export default { createEngine, PRESETS };
