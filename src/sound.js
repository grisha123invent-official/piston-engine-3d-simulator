/**
 * src/sound.js — синтез звука двигателя на Web Audio API.
 *
 * Никаких сэмплов и внешних файлов: всё строится из одного зацикленного буфера
 * белого шума и пары осцилляторов. Граф узлов создаётся один раз при первом
 * включении, дальше меняются только параметры и расписание огибающих —
 * поэтому число узлов не растёт со временем.
 *
 * Что слышно:
 *   1. Выхлопные импульсы — расписание хлопков, частота = обороты/60 · цил/2
 *      (для двухтактного вдвое чаще), делённая на slowFactor.
 *   2. Впуск — шум через полосовой фильтр по подъёму впускного клапана,
 *      дросселю и наддуву; посвист компрессора при наддуве.
 *   3. Цокот клапанов (в двухтактном режиме отсутствует).
 *   4. Детонация — металлический звон высокодобротных резонаторов.
 *   5. Мастер-громкость, мягкий лимитер (компрессор + tanh), плавное затухание.
 *
 * Экспорт: createEngineSound() -> Sound
 *   sound.setEnabled(on)
 *   sound.setVolume(0…1)
 *   sound.update(frame, dt, opts)   opts = { slowFactor, cylinders, cycleDeg, throttle, boost }
 *   sound.dispose()
 * Дополнительно (для отладки и тестов): getStats(), getAnalyser(), getContext().
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v, def) => (Number.isFinite(v) ? v : def);

/** Горизонт планирования хлопков вперёд по времени аудиоконтекста, с. */
const LOOKAHEAD = 0.18;
/** Запас на задержку вывода, с. */
const SAFETY = 0.015;
/** Предохранитель от бесконечного цикла планирования. */
const MAX_PER_CALL = 512;

export function createEngineSound() {
  /* ───────── состояние модуля ───────── */
  const S = {
    ctx: null,
    g: null,                 // узлы графа
    enabled: false,
    volume: 0.7,
    disposed: false,
    suspendTimer: 0,
    gestureBound: false,

    // расписание
    nextPulseT: 0,           // время следующего ещё не запланированного хлопка
    haveSchedule: false,
    lastKnockT: -1,
    fireDeg: 365,            // опорный угол вспышки (калибруется по xb)
    prevXb: 0,
    prevCycleDeg: 720,

    lastParamT: -1,
    lastInterval: 0.02,
    lastFireHz: 0,
    pulseIdx: 0,

    stats: {
      nodesCreated: 0,       // сколько AudioNode создано за всё время жизни
      pulses: 0,             // сколько выхлопных хлопков запланировано
      ticks: 0,              // цокотов клапанов
      knocks: 0,             // ударов детонации
      resyncs: 0,            // пересинхронизаций расписания
      paramUpdates: 0,
    },
  };

  /* ───────── создание узлов со счётчиком ───────── */
  function mk(kind, ctx, arg) {
    let n;
    switch (kind) {
      case 'gain':      n = ctx.createGain(); break;
      case 'biquad':    n = ctx.createBiquadFilter(); break;
      case 'osc':       n = ctx.createOscillator(); break;
      case 'buffer':    n = ctx.createBufferSource(); break;
      case 'shaper':    n = ctx.createWaveShaper(); break;
      case 'comp':      n = ctx.createDynamicsCompressor(); break;
      case 'analyser':  n = ctx.createAnalyser(); break;
      default: throw new Error('неизвестный тип узла: ' + kind);
    }
    if (arg) Object.assign(n, arg);
    S.stats.nodesCreated++;
    return n;
  }

  /** Буфер белого шума на 2 с — один на все ветки. */
  function noiseBuffer(ctx) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = 0.72 * last + 0.28 * w;          // лёгкий «розовый» наклон
      d[i] = w * 0.7 + last * 0.6;
    }
    return buf;
  }

  /** Кривая мягкого ограничителя: y = tanh(1.6x)·0.86, |y| < 0.87. */
  function tanhCurve(n = 2049) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(1.6 * x) * 0.86;
    }
    return c;
  }

  /* ───────── построение графа ───────── */
  function buildGraph() {
    const ctx = S.ctx;
    const t0 = ctx.currentTime;

    /* мастер-цепочка: шины → pre(громкость) → компрессор → tanh → out(фейд) → анализатор → выход */
    const out = mk('gain', ctx);      out.gain.value = 0;                 // молчим до setEnabled
    const analyser = mk('analyser', ctx);
    analyser.fftSize = 32768;
    analyser.smoothingTimeConstant = 0.4;

    const shaper = mk('shaper', ctx);
    shaper.curve = tanhCurve();
    shaper.oversample = '2x';

    const comp = mk('comp', ctx);
    comp.threshold.value = -9;
    comp.knee.value = 12;
    comp.ratio.value = 14;
    comp.attack.value = 0.002;
    comp.release.value = 0.14;

    const pre = mk('gain', ctx);     pre.gain.value = S.volume;

    pre.connect(comp).connect(shaper).connect(out).connect(analyser);
    analyser.connect(ctx.destination);

    /* общий источник шума */
    const noise = mk('buffer', ctx);
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;

    /* ── выхлоп ── */
    const exhEnv = mk('gain', ctx);  exhEnv.gain.value = 0;   // огибающая хлопка
    noise.connect(exhEnv);

    const pipeLow = mk('biquad', ctx);                        // резонанс трубы: бас
    pipeLow.type = 'lowpass'; pipeLow.frequency.value = 110; pipeLow.Q.value = 8;
    const pipeMid = mk('biquad', ctx);                        // средний «рык»
    pipeMid.type = 'bandpass'; pipeMid.frequency.value = 520; pipeMid.Q.value = 2.4;
    const rasp = mk('biquad', ctx);                           // жёсткая окраска под нагрузкой
    rasp.type = 'highpass'; rasp.frequency.value = 1400; rasp.Q.value = 0.7;

    const gLow = mk('gain', ctx);  gLow.gain.value = 1.0;
    const gMid = mk('gain', ctx);  gMid.gain.value = 0.55;
    const gRasp = mk('gain', ctx); gRasp.gain.value = 0.10;

    const exhBus = mk('gain', ctx); exhBus.gain.value = 0.8;
    exhEnv.connect(pipeLow).connect(gLow).connect(exhBus);
    exhEnv.connect(pipeMid).connect(gMid).connect(exhBus);
    exhEnv.connect(rasp).connect(gRasp).connect(exhBus);
    exhBus.connect(pre);

    /* тональная составляющая рокота: пила на частоте следования вспышек */
    const droneOsc = mk('osc', ctx); droneOsc.type = 'sawtooth'; droneOsc.frequency.value = 60;
    const droneLp = mk('biquad', ctx); droneLp.type = 'lowpass';
    droneLp.frequency.value = 600; droneLp.Q.value = 0.8;
    const droneGain = mk('gain', ctx); droneGain.gain.value = 0;
    droneOsc.connect(droneLp).connect(droneGain).connect(exhBus);

    /* ── впуск ── */
    const intakeEnv = mk('gain', ctx); intakeEnv.gain.value = 0;
    noise.connect(intakeEnv);
    const intakeBP = mk('biquad', ctx);
    intakeBP.type = 'bandpass'; intakeBP.frequency.value = 600; intakeBP.Q.value = 1.4;
    const intakeBus = mk('gain', ctx); intakeBus.gain.value = 0.45;
    intakeEnv.connect(intakeBP).connect(intakeBus).connect(pre);

    /* посвист компрессора наддува */
    const compOsc = mk('osc', ctx);  compOsc.type = 'sine';    compOsc.frequency.value = 2200;
    const compOsc2 = mk('osc', ctx); compOsc2.type = 'triangle'; compOsc2.frequency.value = 3300;
    const compG2 = mk('gain', ctx);  compG2.gain.value = 0.28;
    const whistle = mk('gain', ctx); whistle.gain.value = 0;
    compOsc.connect(whistle);
    compOsc2.connect(compG2).connect(whistle);
    whistle.connect(intakeBus);

    /* ── механика: цокот клапанов ── */
    const mechEnv = mk('gain', ctx); mechEnv.gain.value = 0;
    noise.connect(mechEnv);
    const mechBP = mk('biquad', ctx);
    mechBP.type = 'bandpass'; mechBP.frequency.value = 2900; mechBP.Q.value = 5;
    const mechBus = mk('gain', ctx); mechBus.gain.value = 0.22;
    mechEnv.connect(mechBP).connect(mechBus).connect(pre);

    /* ── детонация: три высокодобротных резонатора ── */
    const knockEnv = mk('gain', ctx); knockEnv.gain.value = 0;
    noise.connect(knockEnv);
    const knockBus = mk('gain', ctx); knockBus.gain.value = 0.9;
    const knockFs = [];
    // усиление компенсирует узкую полосу: через фильтр с Q≈30 проходит лишь ~7 % энергии шума
    [[3150, 26, 6.0], [5100, 30, 5.0], [6900, 26, 3.5]].forEach(([f, q, a]) => {
      const bp = mk('biquad', ctx);
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gg = mk('gain', ctx); gg.gain.value = a;
      knockEnv.connect(bp).connect(gg).connect(knockBus);
      knockFs.push(bp);
    });
    knockBus.connect(pre);

    noise.start(t0);
    droneOsc.start(t0);
    compOsc.start(t0);
    compOsc2.start(t0);

    S.g = {
      out, analyser, shaper, comp, pre,
      noise, exhEnv, pipeLow, pipeMid, rasp, gLow, gMid, gRasp, exhBus,
      droneOsc, droneLp, droneGain,
      intakeEnv, intakeBP, intakeBus, whistle, compOsc, compOsc2,
      mechEnv, mechBP, mechBus,
      knockEnv, knockBus, knockFs,
    };
  }

  /* ───────── контекст и политика автозапуска ───────── */
  function ensureCtx() {
    if (S.disposed) return null;
    if (S.ctx) return S.ctx;
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      S.ctx = new AC({ latencyHint: 'interactive' });
      buildGraph();
    } catch (e) {
      // контекст запрещён политикой — просто молчим
      S.ctx = null; S.g = null;
      return null;
    }
    bindGesture();
    return S.ctx;
  }

  function tryResume() {
    const ctx = S.ctx;
    if (!ctx || !S.enabled) return;
    if (ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => { /* ждём жеста */ });
    }
  }

  const onGesture = () => { tryResume(); };
  function bindGesture() {
    if (S.gestureBound || typeof window === 'undefined') return;
    S.gestureBound = true;
    ['pointerdown', 'touchend', 'keydown', 'mousedown'].forEach(ev =>
      window.addEventListener(ev, onGesture, { passive: true }));
  }
  function unbindGesture() {
    if (!S.gestureBound || typeof window === 'undefined') return;
    S.gestureBound = false;
    ['pointerdown', 'touchend', 'keydown', 'mousedown'].forEach(ev =>
      window.removeEventListener(ev, onGesture));
  }

  /* ───────── планирование событий (без создания узлов) ───────── */

  /** Хлопок выхлопа: короткая огибающая на общем узле exhEnv. */
  function schedulePulse(t, amp, dur) {
    const p = S.g.exhEnv.gain;
    const a = Math.max(1e-4, amp);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(a, t + Math.min(0.0015, dur * 0.12));
    p.exponentialRampToValueAtTime(a * 0.002, t + dur);
    p.setValueAtTime(0, t + dur + 0.0002);
    S.stats.pulses++;
  }

  /** Цокот клапана. */
  function scheduleTick(t, amp, dur) {
    const p = S.g.mechEnv.gain;
    const a = Math.max(1e-4, amp);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(a, t + 0.0004);
    p.exponentialRampToValueAtTime(a * 0.01, t + dur);
    p.setValueAtTime(0, t + dur + 0.0002);
    S.stats.ticks++;
  }

  /** Металлический звон детонации. */
  function scheduleKnock(t, amp) {
    const p = S.g.knockEnv.gain;
    const a = Math.max(1e-4, amp);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(a, t + 0.0004);
    p.exponentialRampToValueAtTime(a * 0.02, t + 0.012);
    p.exponentialRampToValueAtTime(a * 0.001, t + 0.055);
    p.setValueAtTime(0, t + 0.056);
    S.stats.knocks++;
  }

  /* ───────── непрерывные параметры тембра ───────── */
  function updateTone(now, env) {
    const g = S.g;
    const TAU = 0.05;
    const set = (param, v) => param.setTargetAtTime(v, now, TAU);
    const { load, boost, throttle, rpmNorm, fireHz, liftIn, twoStroke } = env;

    // выхлопная труба: бас ниже на малой нагрузке, звонче на наддуве
    set(g.pipeLow.frequency, 85 + 45 * load + 30 * boost);
    set(g.pipeLow.Q, 6 + 5 * load);
    set(g.pipeMid.frequency, 360 + 560 * load + 320 * boost);
    set(g.pipeMid.Q, 2.2 + 1.4 * boost);
    set(g.gRasp.gain, 0.05 + 0.20 * load + 0.22 * Math.min(boost, 1.2));
    set(g.gMid.gain, 0.40 + 0.35 * load);

    // тональный рокот: включается, когда хлопки сливаются (выше ~20 Гц)
    const droneMix = clamp((fireHz - 18) / 30, 0, 1) * (0.09 + 0.15 * load);
    set(g.droneOsc.frequency, clamp(fireHz, 20, 1800));
    set(g.droneLp.frequency, clamp(fireHz * 7, 220, 6000));
    set(g.droneGain.gain, droneMix);

    // впуск: громкость по подъёму впускного клапана, дросселю и наддуву
    const intakeAmp = (0.10 + 0.90 * liftIn) * (0.18 + 0.82 * throttle)
                    * (0.45 + 0.55 * rpmNorm) * (1 + 0.5 * boost) * 0.34;
    set(g.intakeEnv.gain, intakeAmp);
    set(g.intakeBP.frequency, 300 + 720 * rpmNorm + 380 * boost);
    set(g.intakeBP.Q, 1.1 + 1.4 * throttle);

    // посвист компрессора: частота растёт с наддувом и оборотами
    const wh = boost > 0.03 ? 0.030 * clamp(boost / 1.0, 0, 1.2) * (0.3 + 0.7 * throttle) : 0;
    set(g.whistle.gain, wh);
    set(g.compOsc.frequency, 1800 + 2600 * clamp(boost, 0, 1.5) + 700 * rpmNorm);
    set(g.compOsc2.frequency, 2700 + 3900 * clamp(boost, 0, 1.5) + 1050 * rpmNorm);

    // механика: в двухтактном клапанов нет
    set(g.mechBus.gain, twoStroke ? 0 : 0.20 + 0.10 * (1 - load));

    S.stats.paramUpdates++;
  }

  /* ───────── публичный API ───────── */
  const api = {
    /** Включить/выключить звук. Контекст создаётся лениво, resume — по жесту. */
    setEnabled(on) {
      if (S.disposed) return;
      const want = !!on;
      S.enabled = want;
      if (want) {
        const ctx = ensureCtx();
        if (!ctx || !S.g) return;                 // автозапуск запрещён — молчим
        if (S.suspendTimer) { clearTimeout(S.suspendTimer); S.suspendTimer = 0; }
        tryResume();
        const t = ctx.currentTime;
        const p = S.g.out.gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(1, t + 0.12);   // плавное появление
        S.haveSchedule = false;
      } else {
        if (!S.ctx || !S.g) return;
        const t = S.ctx.currentTime;
        const p = S.g.out.gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(0, t + 0.3);    // плавное затухание
        S.haveSchedule = false;
        if (S.suspendTimer) clearTimeout(S.suspendTimer);
        S.suspendTimer = setTimeout(() => {
          S.suspendTimer = 0;
          if (!S.enabled && S.ctx && S.ctx.state === 'running') S.ctx.suspend().catch(() => {});
        }, 450);
      }
    },

    /** Мастер-громкость 0…1. */
    setVolume(v) {
      S.volume = clamp(fin(v, 0.7), 0, 1);
      if (S.g && S.ctx) S.g.pre.gain.setTargetAtTime(S.volume, S.ctx.currentTime, 0.03);
    },

    /**
     * Кадр симуляции.
     * @param {object} frame  FrameState (см. контракт §6 / §5 второй волны)
     * @param {number} dt     реальное время кадра, с
     * @param {object} opts   { slowFactor, cylinders, cycleDeg, throttle, boost }
     */
    update(frame, dt, opts) {
      if (S.disposed || !S.enabled || !frame) return;
      const ctx = S.ctx;
      if (!ctx || !S.g) return;
      if (ctx.state !== 'running') { tryResume(); S.haveSchedule = false; return; }

      const o = opts || {};
      const dtR = clamp(fin(dt, 0.016), 0.001, 0.2);
      const cyl = Array.isArray(frame.cyl) ? frame.cyl : [];
      const cylN = clamp(Math.round(fin(o.cylinders, fin(frame.cylinders, cyl.length || 1))), 1, 16);
      const cycleDeg = (fin(o.cycleDeg, fin(frame.cycleDeg, 720)) <= 360) ? 360 : 720;
      const twoStroke = (frame.twoStroke !== undefined) ? !!frame.twoStroke : (cycleDeg === 360);
      const rpm = clamp(fin(frame.rpm, 800), 60, 12000);
      const slow = Math.max(1, fin(o.slowFactor, 1));
      const throttle = clamp(fin(o.throttle, 1), 0, 1);
      const boost = clamp(fin(o.boost, fin(frame.boostNow_bar, 0)), 0, 2);

      // при смене длины цикла сбрасываем опорный угол вспышки
      if (cycleDeg !== S.prevCycleDeg) {
        S.prevCycleDeg = cycleDeg;
        S.fireDeg = twoStroke ? 5 : 365;
        S.haveSchedule = false;
      }

      /* ── частота следования вспышек «как видно на экране» ── */
      const stepDeg = cycleDeg / cylN;                       // угол между вспышками
      let T = (stepDeg / 360) * (60 / rpm) * slow;           // период хлопков, с
      T = clamp(T, 0.0008, 30);
      const fireHz = 1 / T;
      S.lastInterval = T; S.lastFireHz = fireHz;

      /* ── нагрузка и вспомогательные величины ── */
      let pmax = 0, liftSum = 0;
      for (let i = 0; i < cyl.length; i++) {
        const c = cyl[i] || 0;
        if (c) {
          if (c.p_bar > pmax) pmax = c.p_bar;
          liftSum += clamp(fin(c.liftIn, 0), 0, 1);
        }
      }
      const load = clamp(0.65 * throttle + 0.35 * clamp(pmax / 70, 0, 1) + 0.25 * boost, 0.05, 1);
      const rpmNorm = clamp(rpm / 6000, 0, 1.2);
      // мгновенный подъём клапана виден только когда кадры успевают за циклом
      const liftInst = cyl.length ? liftSum / cyl.length : 0;
      const liftIn = (T > 4 * dtR) ? liftInst : 0.3;

      /* ── калибровка опорного угла вспышки по порогу xb ── */
      const c0 = cyl[0];
      if (c0 && T > 4 * dtR) {
        const xb = clamp(fin(c0.xb, 0), 0, 1);
        // порог один и тот же на входе и на выходе — иначе редкие кадры «перепрыгивают» окно
        if (S.prevXb < 0.12 && xb >= 0.12) {
          const d = fin(c0.deg, fin(frame.deg, 0));
          S.fireDeg = ((d % cycleDeg) + cycleDeg) % cycleDeg;
        }
        S.prevXb = xb;
      }

      /* ── фаза: сколько осталось до ближайшей вспышки ── */
      const degNow = fin(frame.deg, 0) - S.fireDeg;
      const ph = ((((degNow % stepDeg) + stepDeg) % stepDeg)) / stepDeg;  // 0 = только что хлопнуло
      const desiredNext = ctx.currentTime + SAFETY + (1 - ph) * T;
      const now = ctx.currentTime;

      if (!S.haveSchedule || !Number.isFinite(S.nextPulseT) ||
          S.nextPulseT < now - 0.25 || S.nextPulseT > now + LOOKAHEAD + 2 * T + 1) {
        S.nextPulseT = Math.max(desiredNext, now + 0.004);
        S.haveSchedule = true;
        S.stats.resyncs++;
      } else if (T > 0.05) {
        // отдельные хлопки слышны — плавно подтягиваем фазу к картинке.
        // Зона нечувствительности 2 % периода: иначе на замедлении хлопок
        // заметно расходится с вспышкой в цилиндре.
        let d = S.nextPulseT - desiredNext;
        d -= Math.round(d / T) * T;
        if (Math.abs(d) > Math.max(0.004, T * 0.02)) {
          S.nextPulseT = Math.max(now + 0.004, S.nextPulseT - d * 0.6);
        }
      }

      /* ── громкость хлопка: энергия в секунду не должна расти с оборотами ── */
      const cylScale = 1 / (1 + 0.13 * (cylN - 1));
      const rateScale = Math.sqrt(clamp(T / 0.02, 0.18, 1));
      const baseAmp = 0.95 * (0.35 + 0.65 * load) * cylScale * rateScale;
      const dur = Math.min(0.045 + 0.06 * load, T * 0.85);
      const knockOn = !!frame.knockNow;
      const knockAmp = 0.55 * (0.5 + 0.5 * load);
      const tickAmp = 0.06 + 0.05 * (1 - load);
      const tickDur = Math.min(0.010, T * 0.2);

      /* ── планирование вперёд ── */
      const horizon = now + LOOKAHEAD;
      let n = 0;
      while (S.nextPulseT < horizon && n < MAX_PER_CALL) {
        const t = S.nextPulseT;
        const idx = S.pulseIdx++;
        // лёгкая неравномерность по амплитуде — иначе звук стерильный
        const amp = baseAmp * (1 + 0.09 * Math.sin(idx * 2.3999632));
        schedulePulse(t, amp, dur);

        if (!twoStroke && T > 0.008) {
          scheduleTick(t + T * 0.30, tickAmp, tickDur);
          scheduleTick(t + T * 0.68, tickAmp * 0.75, tickDur);
        }
        if (knockOn && (t - S.lastKnockT) >= Math.max(T * 0.95, 0.035)) {
          scheduleKnock(t + T * 0.06, knockAmp);
          S.lastKnockT = t;
        }
        S.nextPulseT += T;
        n++;
      }
      if (n >= MAX_PER_CALL) {           // предохранитель: не даём расписанию убежать
        S.nextPulseT = now + LOOKAHEAD;
        S.stats.resyncs++;
      }

      /* ── непрерывные параметры, ~30 раз в секунду ── */
      if (S.lastParamT < 0 || now - S.lastParamT > 0.03) {
        S.lastParamT = now;
        updateTone(now, { load, boost, throttle, rpmNorm, fireHz, liftIn, twoStroke });
      }
    },

    /** Полная остановка и освобождение ресурсов. */
    dispose() {
      if (S.disposed) return;
      S.disposed = true;
      S.enabled = false;
      unbindGesture();
      if (S.suspendTimer) { clearTimeout(S.suspendTimer); S.suspendTimer = 0; }
      const g = S.g;
      if (g) {
        try { g.noise.stop(); } catch { /* уже остановлен */ }
        try { g.droneOsc.stop(); } catch { /* */ }
        try { g.compOsc.stop(); } catch { /* */ }
        try { g.compOsc2.stop(); } catch { /* */ }
        Object.values(g).forEach(v => {
          const list = Array.isArray(v) ? v : [v];
          list.forEach(nd => { try { nd.disconnect(); } catch { /* */ } });
        });
      }
      S.g = null;
      if (S.ctx) { try { S.ctx.close(); } catch { /* */ } }
      S.ctx = null;
    },

    /* ── служебное: для отладки и автотестов ── */
    getStats() {
      return {
        ...S.stats,
        ctxState: S.ctx ? S.ctx.state : 'none',
        enabled: S.enabled,
        interval_s: S.lastInterval,
        fireHz: S.lastFireHz,
        volume: S.volume,
      };
    },
    getAnalyser() { return S.g ? S.g.analyser : null; },
    getContext() { return S.ctx; },
  };

  return api;
}

export default createEngineSound;
