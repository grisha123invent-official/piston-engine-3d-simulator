/**
 * Расчётное ядро физики четырёхтактного ДВС.
 *
 * Чистый ES-модуль: ни DOM, ни three.js, ни внешних зависимостей.
 * Однозонная термодинамическая модель, интегрирование по углу поворота
 * коленвала с шагом 0.5° (1441 точка на цикл 0…720°).
 *
 * Экспорт:
 *   PRESETS                     — готовые наборы параметров (бензин / дизель)
 *   createEngine(params) → Engine
 *
 * Все таблицы цикла — Float32Array длиной 1441, индекс i ↔ угол i·0.5°.
 */

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
const N_PTS = 1441;                 // 0…720° включительно
const N_STEPS = N_PTS - 1;          // 1440 шагов = полный цикл
const SUB = 4;                      // подшагов интегрирования на каждые 0.5°
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

/** Индекс таблицы по модулю 1440 (углы 0 и 720 — одна и та же точка). */
const wrapIdx = i => ((i % N_STEPS) + N_STEPS) % N_STEPS;

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
};

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
    this.setParams(params || {});
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
    p.cylinders = p.cylinders === 1 ? 1 : 4;
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
    this.params = p;
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

    const deg = new Float32Array(N_PTS);
    const V_cm3 = new Float32Array(N_PTS);
    const pistonFrac = new Float32Array(N_PTS);
    const pistonVel = new Float32Array(N_PTS);
    const pistonAcc = new Float32Array(N_PTS);
    const liftIn = new Float32Array(N_PTS);
    const liftEx = new Float32Array(N_PTS);

    const Vm = new Float64Array(N_PTS);      // объём, м³ (рабочая точность)
    const dVdth = new Float64Array(N_PTS);   // dV/dθ, м³/рад

    const h = 1e-4;
    for (let i = 0; i < N_PTS; i++) {
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
      liftIn[i] = valveLift(d, p.ivo, p.ivc);
      liftEx[i] = valveLift(d, p.evo, p.evc);
    }

    /* ── газообмен ── */
    // давление во впускном коллекторе (у дизеля дросселя нет)
    const p_man = (p.fuel === 'diesel' ? 1.0 : 0.12 + 0.88 * p.throttle) * 1e5;
    const p_exh = P_EXH_BAR * 1e5;

    let etaV = ETA_V_MAX * (1 - 0.6 * ((p.rpm - N_PEAK) / N_PEAK) ** 2);
    etaV = clamp(etaV, 0.35, 0.95);

    const m_air = etaV * p_man * Vd / (R_GAS * T_INTAKE);
    // бензин — количественное регулирование (смесь стехиометрическая),
    // дизель — качественное: масса топлива пропорциональна «педали»
    const m_fuel = p.fuel === 'diesel'
      ? p.throttle * m_air / F.AFR
      : m_air / F.AFR;
    const m_fresh = m_air + m_fuel;
    const Q_total = m_fuel * F.LHV * ETA_COMB;

    /* ── индексы фаз ── */
    const iIVC = Math.round(p.ivc / STEP_DEG);
    const iEVO = Math.round(p.evo / STEP_DEG);
    const iEVC = Math.round(p.evc / STEP_DEG);

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
    const p_pa = new Float64Array(N_PTS);
    const T_k = new Float64Array(N_PTS);
    const m_kg = new Float64Array(N_PTS);
    const xb = new Float32Array(N_PTS);
    const knockInt = new Float32Array(N_PTS);

    for (let i = 0; i < N_PTS; i++) xb[i] = wiebe(deg[i]);

    // геометрия теплоотдающей поверхности: днище поршня + головка + открытая часть гильзы
    // (площадь гильзы растёт вместе с объёмом — по мере движения поршня вниз)
    const surfOf = Vol => A * (1 + HEAD_AREA_K) + Math.PI * B * (Vol / A);

    // средняя скорость поршня — для Вошни
    const Sp = 2 * S * p.rpm / 60;
    const tau_deg = clamp(12 * (p.rpm / 3000), 3, 40);        // постоянная истечения, град
    const p_exh_eff = p_exh * (1 + 0.10 * (p.rpm / 3000) ** 2);

    let Q_wall_total = 0;
    let T_res = 1000;                                          // оценка температуры остаточных газов
    let m_res = p_exh * Vm[iEVC] / (R_GAS * T_res);

    // два прохода: второй уточняет параметры остаточных газов
    for (let pass = 0; pass < 2; pass++) {
      Q_wall_total = 0;

      /* ── 1. Впуск: EVC → IVC ── */
      // масса набирается по вытесняемому объёму; к IVC доходит до полного заряда
      const V_evc = Vm[iEVC];
      const iBDC = Math.round(180 / STEP_DEG);
      const Vspan = Math.max(Vm[iBDC] - V_evc, 1e-9);
      const nIntake = ((iIVC - iEVC) + N_STEPS) % N_STEPS;
      for (let k = 0; k <= nIntake; k++) {
        const i = wrapIdx(iEVC + k);
        const d = i * STEP_DEG;
        let f;
        if (d <= 180) f = 0.93 * clamp((Vm[i] - V_evc) / Vspan, 0, 1);
        else f = 0.93 + 0.07 * clamp((d - 180) / Math.max(p.ivc - 180, 1), 0, 1);
        const mm = m_res + m_fresh * f;
        const TT = (m_res * T_res + m_fresh * f * T_INTAKE) / Math.max(mm, 1e-12);
        m_kg[i] = mm;
        T_k[i] = TT;
        p_pa[i] = mm * R_GAS * TT / Vm[i];
      }

      /* ── 2. Закрытый цикл: IVC → EVO ── */
      const m_cyl = m_res + m_fresh;
      const T_ivc = T_k[iIVC];
      const p_ivc = p_pa[iIVC];
      let T = T_ivc;
      let P = p_ivc;
      m_kg[iIVC] = m_cyl;

      // детонация: интеграл Ливенгуда–Ву (только бензин)
      const knockOn = p.fuel === 'petrol';
      const onFac = 17.68 * Math.pow(p.octane / 100, 3.402);
      let LW = 0;
      let knockDeg = NaN;

      const hSub = dth / SUB;
      const dtSub = dtStep / SUB;

      for (let i = iIVC; i < iEVO; i++) {
        // подшаги: линейная интерполяция объёма и Вибе внутри шага 0.5°
        for (let s = 0; s < SUB; s++) {
          const fr = s / SUB, fr2 = (s + 1) / SUB;
          const Vol = Vm[i] + (Vm[i + 1] - Vm[i]) * fr;
          const dV = (Vm[i + 1] - Vm[i]) / SUB;
          const dxb = (xb[i] + (xb[i + 1] - xb[i]) * fr2) - (xb[i] + (xb[i + 1] - xb[i]) * fr);
          const dQc = Q_total * dxb;

          // теплоотдача (упрощённый Вошни)
          const p_mot = p_ivc * Math.pow(Vm[iIVC] / Vol, 1.35);
          const w = 2.28 * Sp + 3.24e-3 * (Vd * T_ivc / (p_ivc * Vm[iIVC])) * Math.max(P - p_mot, 0);
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
            const xbLoc = xb[i] + (xb[i + 1] - xb[i]) * fr;
            const unburned = 1 - xbLoc;
            if (unburned > 5e-3) {
              // состояние несгоревшей зоны: адиабатическое сжатие от условий в момент IVC
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
        T_k[i + 1] = T;
        p_pa[i + 1] = P;
        m_kg[i + 1] = m_cyl;
        knockInt[i + 1] = LW;
      }
      this._knock = { happens: LW >= 1, intensity: LW, deg: Number.isFinite(knockDeg) ? knockDeg : NaN };

      /* ── 3. Выпуск: EVO → EVC ── */
      const nExh = ((iEVC - iEVO) + N_STEPS) % N_STEPS;
      for (let k = 0; k < nExh; k++) {
        const i = wrapIdx(iEVO + k);
        const j = wrapIdx(i + 1);
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
      m_res = clamp(p_pa[iEVC] * Vm[iEVC] / (R_GAS * T_res), 1e-8, m_fresh);
    }

    // замыкаем таблицу: 720° = 0°
    p_pa[N_PTS - 1] = p_pa[0];
    T_k[N_PTS - 1] = T_k[0];
    m_kg[N_PTS - 1] = m_kg[0];
    knockInt[N_PTS - 1] = knockInt[N_PTS - 2];

    /* ── силы и моменты ── */
    const p_bar = new Float32Array(N_PTS);
    const T_K = new Float32Array(N_PTS);
    const mass_g = new Float32Array(N_PTS);
    const gasForce = new Float32Array(N_PTS);
    const inertiaForce = new Float32Array(N_PTS);
    const rodForce = new Float32Array(N_PTS);
    const sideForce = new Float32Array(N_PTS);
    const torque = new Float32Array(N_PTS);
    const torqueTotal = new Float32Array(N_PTS);

    for (let i = 0; i < N_PTS; i++) {
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

    // суммарный момент рядной четвёрки, порядок работы 1–3–4–2 (смещения 0/180/360/540°)
    const offs = p.cylinders === 4 ? [0, 360, 720, 1080] : [0];
    for (let i = 0; i < N_PTS; i++) {
      let s = 0;
      for (const o of offs) s += torque[wrapIdx(i + o)];
      torqueTotal[i] = fin(s);
    }
    torqueTotal[N_PTS - 1] = torqueTotal[0];

    /* ── интегральные показатели ── */
    // работа за цикл ∮ p dV (трапеции по полному циклу 0…720)
    let W = 0, Wgross = 0, pmax = 0, ipmax = 0, Tmax = 0;
    for (let i = 0; i < N_STEPS; i++) {
      const dW = 0.5 * (p_pa[i] + p_pa[i + 1]) * (Vm[i + 1] - Vm[i]);
      W += dW;
      if (i >= iIVC && i < iEVO) Wgross += dW;
      if (p_pa[i] > pmax) { pmax = p_pa[i]; ipmax = i; }
      if (T_k[i] > Tmax) Tmax = T_k[i];
    }

    const imep = W / Vd;                                  // Па
    const fmep = (0.97 + 0.15 * (p.rpm / 1000) + 0.05 * (p.rpm / 1000) ** 2) * 1e5;
    const bmep = imep - fmep;

    const cyclesPerSec = p.rpm / 120;                     // рабочих циклов в секунду
    const indPower = imep * Vd * cyclesPerSec * p.cylinders;          // Вт
    const brakePower = bmep * Vd * cyclesPerSec * p.cylinders;
    const brakeTorque = brakePower / Math.max(omega, 1e-6);

    const Qfuel = m_fuel * F.LHV;                         // энергия топлива за цикл на цилиндр
    const effInd = Qfuel > 1e-9 ? W / Qfuel : 0;
    const effBrake = Qfuel > 1e-9 ? (bmep * Vd) / Qfuel : 0;
    const effOtto = 1 - Math.pow(p.eps, -0.4);

    const fuelFlow_g_h = m_fuel * 1000 * cyclesPerSec * p.cylinders * 3600;
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
    const exhRaw = Math.max(Qfuel - eb.work - eb.coolant - eb.friction, 0);
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
    for (let i = 0; i < N_STEPS; i++) Msum += torqueTotal[i];
    const Mload = Msum / N_STEPS;
    const Jtot = p.flywheelJ * p.cylinders;
    const w2 = new Float64Array(N_PTS);
    w2[0] = omega * omega;
    for (let i = 0; i < N_STEPS; i++) {
      w2[i + 1] = Math.max(w2[i] + 2 * (torqueTotal[i] - Mload) * dth / Jtot, (0.05 * omega) ** 2);
    }
    let wmin = Infinity, wmax = 0, wsum = 0;
    for (let i = 0; i < N_STEPS; i++) {
      const wv = Math.sqrt(w2[i]);
      if (wv < wmin) wmin = wv;
      if (wv > wmax) wmax = wv;
      wsum += wv;
    }
    const wavg = wsum / N_STEPS;
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
      volEff: fin(etaV, 0),
      knock: {
        happens: !!this._knock.happens,
        intensity: fin(this._knock.intensity, 0),
        deg: Number.isFinite(this._knock.deg) ? this._knock.deg : null,
      },
      energy,
      speedFluctuation: fin(delta, 0),
      meanPistonSpeed_ms: fin(2 * S * p.rpm / 60, 0),
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
    const d = ((fin(degIn, 0) % 720) + 720) % 720;
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
    const x = (((fin(d, 0) % 720) + 720) % 720) / STEP_DEG;
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

    const J = Math.max(p.flywheelJ * p.cylinders, 1e-4);
    const nSub = clamp(Math.ceil(dt / 4e-4), 1, 400);
    const hStep = dt / nSub;
    const wLo = 0.15 * p.rpm * Math.PI / 30;
    const wHi = 3.0 * p.rpm * Math.PI / 30;

    for (let k = 0; k < nSub; k++) {
      const M = this._torqueAt(st.deg);
      st.omega = clamp(st.omega + (M - this._Mload) / J * hStep, wLo, wHi);
      st.deg += st.omega * hStep * RAD2DEG;
      if (st.deg >= 720 || st.deg < 0) st.deg = ((st.deg % 720) + 720) % 720;
    }
    if (!Number.isFinite(st.omega)) this.reset();
    return { deg: st.deg, rpmInstant: st.omega * 30 / Math.PI };
  }

  /* ─────────────── экспорт ─────────────── */

  /** Все таблицы цикла в CSV (разделитель — запятая, десятичная точка). */
  toCSV() {
    const c = this.cycle;
    const keys = Object.keys(c);
    const head = keys.join(',');
    const lines = new Array(N_PTS + 1);
    lines[0] = head;
    for (let i = 0; i < N_PTS; i++) {
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
