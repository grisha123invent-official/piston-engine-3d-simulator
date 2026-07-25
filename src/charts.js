/**
 * src/charts.js — научные графики симулятора ДВС.
 * Canvas 2D, без внешних библиотек, тёмная тема, поддержка devicePixelRatio.
 *
 * Модуль сам создаёт внутри переданного root свою разметку (вкладки + canvas)
 * и сам следит за размерами. Данные берутся только из объекта engine (physics.js):
 * таблицы engine.cycle.* (шаг 0.5° по углу цикла) и engine.metrics.
 *
 * Длина цикла берётся из данных: 720° (четыре такта) или 360° (два такта,
 * engine.params.cycleDeg = 360). Длина массивов нигде не захардкожена.
 *
 * Необязательные возможности движка (если их нет — рисуется корректная заглушка):
 *   engine.sweepRpm({from,to,step}) → { rpm, power_kW, torque_Nm, volEff, knockIntegral, boost_bar }
 *   engine.mapRpmLoad({rpmFrom,rpmTo,rpmSteps,loadSteps}) → { rpm, load, power_kW, torque_Nm,
 *                       bsfc_g_kWh, effBrake, knockIntegral, best } — карта режимов
 *   engine.cycle.shakeX_N / shakeY_N,  engine.metrics.balance
 *
 *   import { createCharts } from './charts.js?v=7';
 *   const charts = createCharts(document.getElementById('charts'));
 *   charts.setEngine(engine);
 *   charts.setActive('pv');
 *   charts.update(frame);          // каждый кадр
 */

import { t, onLangChange } from './i18n.js?v=7';

/* ══════════════ палитра и мелкие утилиты ══════════════ */

const C = {
  grid:      '#2a3038',
  gridSoft:  '#1e242b',
  axis:      '#3a424c',
  text:      '#8b949e',
  bright:    '#e6edf3',
  blue:      '#58a6ff',
  orange:    '#f97316',
  purple:    '#a855f7',
  green:     '#2ea043',
  gray:      '#6b7280',
  red:       '#ef4444',
  yellow:    '#fbbf24',
  panel:     'rgba(13,17,23,.82)',
};

/** Названия тактов и фаз — общие для полос фона, легенд и подписей. */
const PH = {
  intake:  { ru: 'впуск',       en: 'intake' },
  compr:   { ru: 'сжатие',      en: 'compression' },
  power:   { ru: 'рабочий ход', en: 'power stroke' },
  exhaust: { ru: 'выпуск',      en: 'exhaust' },
  scav:    { ru: 'продувка',    en: 'scavenging' },
};

/** Цвета тактов — как в основном интерфейсе. */
const STROKES = [
  { from: 0,   to: 180, color: '#3b82f6', name: PH.intake },
  { from: 180, to: 360, color: '#a855f7', name: PH.compr },
  { from: 360, to: 540, color: '#f97316', name: PH.power },
  { from: 540, to: 720, color: '#6b7280', name: PH.exhaust },
];

/** Фазы двухтактного цикла (0…360, 0 = ВМТ). Границы уточняются по данным окон. */
const TWO_STROKE = [
  { from: 0,   to: 104, color: '#f97316', name: PH.power },
  { from: 104, to: 122, color: '#6b7280', name: PH.exhaust },
  { from: 122, to: 238, color: '#3b82f6', name: PH.scav },
  { from: 238, to: 256, color: '#6b7280', name: PH.exhaust },
  { from: 256, to: 360, color: '#a855f7', name: PH.compr },
];

const G = 9.80665;                       // ускорение свободного падения, м/с²
const FONT_FAMILY = '-apple-system, "Segoe UI", Roboto, sans-serif';
const font = (size, weight) => `${weight ? weight + ' ' : ''}${size}px ${FONT_FAMILY}`;

const num = v => typeof v === 'number' && isFinite(v);
const isArr = a => !!a && typeof a.length === 'number' && a.length > 1;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mod = (v, m) => (((v % m) + m) % m);
const nowMs = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Date.now());

/** Формат числа с фиксированным числом знаков, без NaN в подписях. */
function f(v, d = 1) {
  return num(v) ? v.toFixed(d) : '—';
}

/** Экстремумы массива с пропуском нечисловых значений. */
function extent(arr) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!num(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return isFinite(mn) ? [mn, mx] : [0, 1];
}

/** Индекс максимума |значения|. */
function argMaxAbs(arr) {
  let bi = 0, bv = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (num(v) && Math.abs(v) > bv) { bv = Math.abs(v); bi = i; }
  }
  return bi;
}

/** Среднее по массиву (нечисловые пропускаются). */
function mean(arr) {
  let s = 0, n = 0;
  for (let i = 0; i < arr.length; i++) if (num(arr[i])) { s += arr[i]; n++; }
  return n ? s / n : NaN;
}

/** Линейная интерполяция таблицы цикла по углу 0…span (span = 720 или 360). */
function sampleAt(arr, deg, span = 720) {
  if (!isArr(arr) || !num(span) || span <= 0) return NaN;
  const n = arr.length, step = span / (n - 1);
  const d = mod(deg, span);
  const x = d / step;
  const i0 = clamp(Math.floor(x), 0, n - 1);
  const i1 = clamp(i0 + 1, 0, n - 1);
  const a = arr[i0], b = arr[i1];
  if (!num(a)) return NaN;
  if (!num(b)) return a;
  return a + (b - a) * (x - i0);
}

/**
 * Границы непрерывного «открытого» участка (клапан или окно) с учётом заворота цикла.
 * @returns {{open:number, close:number, width:number}|null}
 */
function openSpan(arr, span, thr = 0.01) {
  if (!isArr(arr) || !num(span) || span <= 0) return null;
  const P = arr.length - 1;                       // период в отсчётах (последняя точка = первой)
  if (P < 2) return null;
  const step = span / P;
  const on = i => { const v = arr[mod(i, P)]; return num(v) && v > thr; };
  let anyOn = false, anyOff = false;
  for (let i = 0; i < P; i++) { if (on(i)) anyOn = true; else anyOff = true; }
  if (!anyOn) return null;
  if (!anyOff) return { open: 0, close: span, width: span };
  let start = -1;
  for (let i = 0; i < P; i++) if (!on(i - 1) && on(i)) { start = i; break; }
  if (start < 0) return null;
  let len = 1;
  while (len < P && on(start + len)) len++;
  return { open: mod(start * step, span), close: mod((start + len) * step, span), width: len * step };
}

/** Значение массива по индексу с заворотом периода (последняя точка дублирует первую). */
function atWrap(arr, i) {
  const P = arr.length - 1;
  const v = arr[mod(i, P)];
  return num(v) ? v : NaN;
}

/** «Красивые» деления оси. */
function niceTicks(min, max, count = 5) {
  if (!num(min) || !num(max)) return [0, 1];
  if (max - min < 1e-12) return [min];
  const step0 = (max - min) / Math.max(2, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const n = step0 / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out.length ? out : [min, max];
}

/** Деления логарифмической оси: 1-2-5 внутри каждой декады. */
function logTicks(min, max) {
  const out = [];
  const d0 = Math.floor(Math.log10(Math.max(min, 1e-9)));
  const d1 = Math.ceil(Math.log10(Math.max(max, 1e-8)));
  for (let d = d0; d <= d1; d++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, d);
      if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
    }
  }
  return out.length ? out : [min, max];
}

/** Линейная шкала домен→пиксели. */
function linScale(d0, d1, r0, r1) {
  const k = (d1 - d0) || 1;
  const s = v => r0 + ((v - d0) / k) * (r1 - r0);
  s.d0 = d0; s.d1 = d1;
  return s;
}

/** Логарифмическая шкала (домен строго > 0). */
function logScale(d0, d1, r0, r1) {
  const a = Math.log10(Math.max(d0, 1e-9));
  const b = Math.log10(Math.max(d1, d0 * 1.0001, 1e-8));
  const k = (b - a) || 1;
  const s = v => r0 + ((Math.log10(Math.max(v, 1e-9)) - a) / k) * (r1 - r0);
  s.d0 = d0; s.d1 = d1;
  return s;
}

/* ══════════════ примитивы отрисовки ══════════════ */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Текст по центру заданной точки (заглушка «нет данных» и т.п.). */
function centerText(ctx, cx, cy, text, color) {
  ctx.save();
  ctx.font = font(11);
  ctx.fillStyle = color || C.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/** Рамка и сетка. ticksX/ticksY — значения домена, sx/sy — шкалы. */
function drawGrid(ctx, box, sx, sy, ticksX, ticksY, fmtX, fmtY, labelX, labelY) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = font(10);
  ctx.textBaseline = 'middle';

  // горизонтальные линии
  for (const tv of ticksY) {
    const y = Math.round(sy(tv)) + 0.5;
    if (y < box.y - 1 || y > box.y + box.h + 1) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right';
    ctx.fillText(fmtY(tv), box.x - 6, y);
  }
  // вертикальные линии
  ctx.textBaseline = 'top';
  for (const tv of ticksX) {
    const x = Math.round(sx(tv)) + 0.5;
    if (x < box.x - 1 || x > box.x + box.w + 1) continue;
    ctx.strokeStyle = C.gridSoft;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(fmtX(tv), x, box.y + box.h + 5);
  }
  // рамка
  ctx.strokeStyle = C.axis;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

  // подписи осей
  ctx.fillStyle = C.text;
  ctx.font = font(10.5);
  if (labelX) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(labelX, box.x + box.w, box.y + box.h + 30);
  }
  if (labelY && ctx.measureText(labelY).width < box.h - 4) {
    ctx.save();
    ctx.translate(11, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(labelY, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Полилиния по индексам массивов с отбрасыванием нечисловых точек. */
function polyline(ctx, xs, ys, sx, sy, i0, i1, color, width, dash) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = i0; i <= i1; i++) {
    const xv = xs[i], yv = ys[i];
    if (!num(xv) || !num(yv)) { started = false; continue; }
    const px = sx(xv), py = sy(yv);
    if (!num(px) || !num(py)) { started = false; continue; }
    if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
  }
  ctx.stroke();
  ctx.restore();
}

/** Плашка-подпись с фоном (чтобы текст читался поверх кривых). */
function tag(ctx, x, y, text, color, box, align) {
  ctx.save();
  ctx.font = font(10);
  const w = ctx.measureText(text).width + 9;
  const h = 15;
  let tx = align === 'right' ? x - w : x;
  let ty = y - h / 2;
  if (box) {
    tx = clamp(tx, box.x + 2, box.x + box.w - w - 2);
    ty = clamp(ty, box.y + 2, box.y + box.h - h - 2);
  }
  roundRect(ctx, tx, ty, w, h, 4);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.bright;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, tx + 4.5, ty + h / 2 + 0.5);
  ctx.restore();
}

/** Точка-маркер с обводкой. */
function dot(ctx, x, y, r, color, ring) {
  if (!num(x) || !num(y)) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (ring) {
    ctx.beginPath();
    ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = ring;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
  ctx.restore();
}

/** Легенда: массив { color, text, dash }. */
function drawLegend(ctx, x, y, items, maxW) {
  ctx.save();
  ctx.font = font(10.5);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let cx = x;
  let cy = y;
  for (const it of items) {
    const tw = ctx.measureText(it.text).width;
    if (maxW && cx + tw + 26 > x + maxW) { cx = x; cy += 15; }
    ctx.strokeStyle = it.color;
    ctx.lineWidth = 2.2;
    if (it.dash) ctx.setLineDash(it.dash); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 15, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.text;
    ctx.fillText(it.text, cx + 20, cy + 0.5);
    cx += tw + 32;
  }
  ctx.restore();
  return cy;
}

/**
 * Фоновые полосы фаз по оси углов (четыре такта или фазы двухтактного).
 * bands — массив { from, to, color, name }; подписи рисуются, если хватает ширины.
 */
function drawPhaseBands(ctx, box, sx, bands, withNames) {
  ctx.save();
  ctx.font = font(9.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const s of bands) {
    const x0 = sx(s.from), x1 = sx(s.to);
    if (!num(x0) || !num(x1)) continue;
    ctx.fillStyle = s.color + '12';
    ctx.fillRect(x0, box.y, x1 - x0, box.h);
    const nm = t(s.name);
    if (withNames && nm && x1 - x0 > ctx.measureText(nm).width + 10) {
      ctx.fillStyle = s.color + '99';
      ctx.fillText(nm, (x0 + x1) / 2, box.y + 3);
    }
  }
  ctx.restore();
}

/** Сообщение при отсутствии данных. */
function drawEmpty(ctx, W, H, text) {
  ctx.save();
  ctx.font = font(12);
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2);
  ctx.restore();
}

/** Информационная плашка в углу области построения. */
function drawReadout(ctx, box, lines, corner) {
  if (!lines.length) return;
  ctx.save();
  ctx.font = font(10.5);
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  w += 14;
  const h = lines.length * 14 + 8;
  if (w > box.w - 6 || h > box.h - 6) { ctx.restore(); return; }   // не влезает — не рисуем
  const x = corner === 'left'
    ? box.x + 8
    : clamp(box.x + box.w - w - 8, box.x + 4, box.x + box.w - w - 4);
  const y = box.y + 8;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.bright;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x + 7, y + 11 + i * 14));
  ctx.restore();
}

/** Вторая (правая) ось: деления, подписи и вертикальный заголовок. */
function drawRightAxis(ctx, box, sy, ticks, fmt, color, label) {
  ctx.save();
  ctx.font = font(10);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.strokeStyle = color + '55';
  ctx.lineWidth = 1;
  for (const tv of ticks) {
    const y = Math.round(sy(tv)) + 0.5;
    if (!num(y) || y < box.y - 1 || y > box.y + box.h + 1) continue;
    ctx.beginPath();
    ctx.moveTo(box.x + box.w, y);
    ctx.lineTo(box.x + box.w + 4, y);
    ctx.stroke();
    ctx.fillText(fmt(tv), box.x + box.w + 6, y);
  }
  if (label && ctx.measureText(label).width < box.h - 4) {
    ctx.save();
    ctx.translate(box.x + box.w + 42, box.y + box.h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Разбивка текста по ширине; возвращает массив строк. */
function wrapText(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (line && ctx.measureText(probe).width > maxW) { out.push(line); line = w; }
    else line = probe;
  }
  if (line) out.push(line);
  return out;
}

/* ══════════════ тепловая карта: цвет и изолинии ══════════════ */

/** Опорные цвета шкалы: холодный минимум → горячий максимум. */
const RAMP = [
  [ 22,  46,  92],
  [ 30, 110, 190],
  [ 38, 172, 162],
  [124, 198,  86],
  [246, 200,  66],
  [240, 128,  48],
  [198,  46,  46],
];

/** Цвет по нормированному значению 0…1; нечисловое — нейтральная заливка «нет данных». */
function rampColor(u, alpha) {
  if (!num(u)) return 'rgba(90,100,112,.20)';
  const x = clamp(u, 0, 1) * (RAMP.length - 1);
  const i = clamp(Math.floor(x), 0, RAMP.length - 2);
  const k = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  const ch = q => Math.round(a[q] + (b[q] - a[q]) * k);
  const rgb = `${ch(0)},${ch(1)},${ch(2)}`;
  return num(alpha) && alpha < 1 ? `rgba(${rgb},${alpha})` : `rgb(${rgb})`;
}

/**
 * Диапазон цветовой шкалы с обрезкой длинного хвоста.
 * У удельного расхода на околонулевой нагрузке значения улетают в десятки тысяч
 * (двигатель почти не отдаёт мощности) — если красить по всему диапазону,
 * полезная область 230…600 г/(кВт·ч) сливается в один цвет. Поэтому верх шкалы
 * берётся по 95-му перцентилю (для «чем меньше, тем лучше» — ещё и не выше 2,5× минимума),
 * а всё, что выше, красится крайним цветом и честно подписывается как «вне диапазона».
 * Если хвоста нет (максимум не более чем на 25 % выше потолка), шкала не обрезается.
 * @returns {{lo:number, hi:number, mn:number, mx:number, clipped:boolean}|null}
 */
function colorRange(V, lowIsGood) {
  const fin = [];
  for (let i = 0; i < V.length; i++) if (num(V[i])) fin.push(V[i]);
  if (!fin.length) return null;
  fin.sort((a, b) => a - b);
  const n = fin.length;
  const q = p => fin[clamp(Math.round(p * (n - 1)), 0, n - 1)];
  const mn = fin[0], mx = fin[n - 1];
  let hi = lowIsGood ? Math.min(q(0.95), mn > 0 ? mn * 2.5 : q(0.95)) : q(0.98);
  if (!num(hi) || hi <= mn) hi = mx > mn ? mx : mn + 1;
  if (mx <= hi * 1.25) hi = mx;                    // хвоста нет — обрезать нечего
  if (hi <= mn) hi = mn + Math.max(Math.abs(mn) * 0.01, 1);
  return { lo: mn, hi, mn, mx, clipped: mx > hi * 1.0001 };
}

/**
 * Отрезки изолинии уровня level методом марширующих квадратов.
 * get(i, j) — значение в узле сетки; координаты возвращаются в дробных индексах.
 * @returns {Array<[number,number,number,number]>} [i0, j0, i1, j1]
 */
function contourSegments(get, nx, ny, level) {
  const out = [];
  if (!num(level) || nx < 2 || ny < 2) return out;
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const v00 = get(i, j), v10 = get(i + 1, j), v11 = get(i + 1, j + 1), v01 = get(i, j + 1);
      if (!num(v00) || !num(v10) || !num(v11) || !num(v01)) continue;
      const pts = [];
      const edge = (ax, ay, va, bx, by, vb) => {
        if ((va < level) === (vb < level)) return;
        const d = vb - va;
        const k = d ? (level - va) / d : 0;
        pts.push(ax + (bx - ax) * k, ay + (by - ay) * k);
      };
      edge(i, j, v00, i + 1, j, v10);
      edge(i + 1, j, v10, i + 1, j + 1, v11);
      edge(i + 1, j + 1, v11, i, j + 1, v01);
      edge(i, j + 1, v01, i, j, v00);
      if (pts.length >= 4) out.push([pts[0], pts[1], pts[2], pts[3]]);
      if (pts.length === 8) out.push([pts[4], pts[5], pts[6], pts[7]]);
    }
  }
  return out;
}

/* ══════════════ стили вкладок (вставляются один раз) ══════════════ */

const CSS = `
.engch{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:180px;
  font-family:${FONT_FAMILY};color:#e6edf3;}
.engch-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:0 0 6px 0;flex:0 0 auto;align-items:center;}
.engch-tab{background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:7px;
  padding:4px 9px;cursor:pointer;font-size:11.5px;font-family:inherit;line-height:1.2;}
.engch-tab:hover{background:#30363d;color:#e6edf3;}
.engch-tab.on{background:rgba(88,166,255,.16);border-color:#58a6ff;color:#58a6ff;font-weight:600;}
.engch-opt{margin-left:auto;display:none;align-items:center;gap:5px;font-size:11px;color:#8b949e;cursor:pointer;}
.engch-opt.show{display:flex;}
.engch-opt input{accent-color:#58a6ff;}
.engch-holder{position:relative;flex:1 1 auto;min-height:150px;}
.engch-holder>canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
`;

function injectCSS() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById('engch-style')) return;
  const st = document.createElement('style');
  st.id = 'engch-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ══════════════ основной модуль ══════════════ */

const TABS = [
  { key: 'pv',         label: { ru: 'p–V',            en: 'p–V' } },
  { key: 'torque',     label: { ru: 'Момент',         en: 'Torque' } },
  { key: 'kinematics', label: { ru: 'Кинематика',     en: 'Kinematics' } },
  { key: 'valves',     label: { ru: 'Фазы ГРМ',       en: 'Valve timing' } },
  { key: 'energy',     label: { ru: 'Энергия',        en: 'Energy' } },
  { key: 'sweep',      label: { ru: 'Характеристика', en: 'Speed curve' } },
  { key: 'balance',    label: { ru: 'Баланс',         en: 'Balance' } },
  { key: 'map',        label: { ru: 'Карта режимов',  en: 'Engine map' } },
];

/** Подпись переключателя логарифмических осей. */
const OPT_LABEL = { ru: 'лог. оси', en: 'log axes' };

/** Свип не пересчитывается чаще этого интервала (защита от дёрганья ползунков). */
const SWEEP_MIN_MS = 120;

/**
 * Переключаемые величины карты режимов. Кнопки рисуются на самом холсте,
 * поэтому подписи короткие; полное название и единицы уходят в заголовок шкалы.
 */
const MAP_METRICS = [
  {
    key: 'bsfc', field: 'bsfc_g_kWh', digits: 0,
    btn:  { ru: 'расход',  en: 'fuel' },
    name: { ru: 'удельный расход топлива', en: 'brake specific fuel consumption' },
    unit: { ru: 'г/(кВт·ч)', en: 'g/(kW·h)' },
    lowIsGood: true,
  },
  {
    key: 'power', field: 'power_kW', digits: 1,
    btn:  { ru: 'мощность', en: 'power' },
    name: { ru: 'мощность', en: 'power' },
    unit: { ru: 'кВт', en: 'kW' },
    lowIsGood: false,
  },
  {
    key: 'eff', field: 'effBrake', digits: 1, pct: true,
    btn:  { ru: 'КПД',  en: 'efficiency' },
    name: { ru: 'эффективный КПД', en: 'brake efficiency' },
    unit: { ru: '%', en: '%' },
    lowIsGood: false,
  },
];

/** Сетка карты режимов: 24×16 = 384 точки — как в контракте. */
const MAP_GRID = { rpmFrom: 800, rpmTo: 6000, rpmSteps: 24, loadSteps: 16 };

/**
 * Создаёт блок графиков внутри root.
 * @param {HTMLElement} root
 * @returns {{setEngine:Function, update:Function, setActive:Function, resize:Function,
 *            getActive:Function, setLogAxes:Function, dispose:Function}}
 */
export function createCharts(root) {
  if (!root) throw new Error('createCharts: не передан root-элемент');
  injectCSS();

  /* ── разметка ── */
  const wrap = document.createElement('div');
  wrap.className = 'engch';

  const tabsEl = document.createElement('div');
  tabsEl.className = 'engch-tabs';

  const tabBtns = {};
  for (const tb of TABS) {
    const b = document.createElement('button');
    b.className = 'engch-tab';
    b.textContent = t(tb.label);
    b.title = t(tb.label);
    b.addEventListener('click', () => api.setActive(tb.key));
    tabsEl.appendChild(b);
    tabBtns[tb.key] = b;
  }

  // переключатель логарифмических осей — только для p–V
  const optEl = document.createElement('label');
  optEl.className = 'engch-opt';
  const optChk = document.createElement('input');
  optChk.type = 'checkbox';
  const optTxt = document.createElement('span');
  optTxt.textContent = t(OPT_LABEL);
  optEl.appendChild(optChk);
  optEl.appendChild(optTxt);
  optChk.addEventListener('change', () => api.setLogAxes(!!optChk.checked));
  tabsEl.appendChild(optEl);

  const holder = document.createElement('div');
  holder.className = 'engch-holder';
  const canvas = document.createElement('canvas');
  holder.appendChild(canvas);

  wrap.appendChild(tabsEl);
  wrap.appendChild(holder);
  root.appendChild(wrap);

  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  // фоновый слой: статичные кривые рисуются один раз, каждый кадр — только маркер
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext ? bgCanvas.getContext('2d') : null;

  /* ── состояние ── */
  const st = {
    engine: null,
    frame: null,
    active: 'pv',
    log: false,
    W: 0, H: 0, dpr: 1,
    staticDirty: true,
    disposed: false,
    // кэш внешней скоростной характеристики: считается только при setEngine/invalidate
    sweep: null, sweepPrev: null, sweepAt: -1e9, sweepMs: 0, sweepFail: false, sweepWarned: false,
    // кэш карты режимов: mapRpmLoad() дорогой, поэтому тот же порядок — только setEngine/invalidate
    map: null, mapMs: 0, mapFail: false, mapEmpty: false, mapWarned: false, mapMetric: 'bsfc',
  };

  /* ── доступ к данным двигателя (везде с проверками) ── */
  const cyc = () => (st.engine && st.engine.cycle) || null;
  const met = () => (st.engine && st.engine.metrics) || null;
  const par = () => (st.engine && st.engine.params) || {};
  const geo = () => (st.engine && st.engine.geometry) || {};
  const degArr = () => {
    const c = cyc();
    if (c && isArr(c.deg)) return c.deg;
    return null;
  };

  /**
   * Длина полного цикла в градусах: 720 (четыре такта) или 360 (два такта).
   * Приоритет у самих данных — так графики не разъедутся, даже если params врут.
   */
  function cycSpan() {
    const c = cyc();
    if (c && isArr(c.deg)) {
      const last = c.deg[c.deg.length - 1];
      if (num(last) && last > 90) return last <= 400 ? 360 : 720;
    }
    const p = par();
    if (num(p.cycleDeg) && p.cycleDeg > 90) return p.cycleDeg <= 400 ? 360 : 720;
    if (st.frame && num(st.frame.cycleDeg) && st.frame.cycleDeg > 90) {
      return st.frame.cycleDeg <= 400 ? 360 : 720;
    }
    return 720;
  }
  /** Двухтактный режим — цикл 360°: клапанов нет, вместо них окна. */
  const twoStroke = () => cycSpan() === 360;
  /** Угол ВМТ конца сжатия: у четырёхтактного 360°, у двухтактного 0°. */
  const tdcDeg = () => (twoStroke() ? 0 : 360);
  /** Интерполяция таблицы цикла с учётом текущей длины цикла. */
  const SA = (arr, deg) => sampleAt(arr, deg, cycSpan());
  /** Деления оси угла. */
  const angleTicks = () => (twoStroke() ? [0, 90, 180, 270, 360] : [0, 180, 360, 540, 720]);
  /** Обороты с единицами: об/мин → rpm. */
  const rpmText = v => t({ ru: `${Math.round(v)} об/мин`, en: `${Math.round(v)} rpm` });
  /** Длина впускного тракта с единицами. */
  const runnerText = (mm, pre = '') => t({
    ru: `${pre}тракт ${Math.round(mm)} мм`,
    en: `${pre}runner ${Math.round(mm)} mm`,
  });
  /** Подпись оси углов — одна на четыре графика. */
  const angleAxisLabel = span => t({
    ru: `угол цикла θ, град (цикл ${span}°)`,
    en: `crank angle θ, deg (cycle ${span}°)`,
  });

  /**
   * Углы открытия/закрытия впуска и выпуска.
   * У двухтактного params.ivo/ivc/evo/evc относятся к клапанам, которых нет,
   * поэтому окна определяются по самим таблицам liftIn/liftEx, а таблица
   * из контракта — только запасной вариант.
   */
  function phaseAngles() {
    const span = cycSpan(), p = par(), c = cyc(), two = span === 360;
    const inRange = v => num(v) && v >= 0 && v <= span;
    const sIn = c ? openSpan(c.liftIn, span) : null;
    const sEx = c ? openSpan(c.liftEx, span) : null;
    const def = two ? { ivo: 122, ivc: 238, evo: 104, evc: 256 }
                    : { ivo: 700, ivc: 230, evo: 490, evc: 20 };
    const pick = (measured, key) => {
      if (two) return num(measured) ? measured : def[key];
      return inRange(p[key]) ? p[key] : (num(measured) ? measured : def[key]);
    };
    return {
      two,
      ivo: pick(sIn && sIn.open, 'ivo'),
      ivc: pick(sIn && sIn.close, 'ivc'),
      evo: pick(sEx && sEx.open, 'evo'),
      evc: pick(sEx && sEx.close, 'evc'),
      names: two
        ? { in: t({ ru: 'продувочные окна', en: 'transfer ports' }),
            ex: t({ ru: 'выпускное окно', en: 'exhaust port' }),
            io: t({ ru: 'откр. продув.', en: 'transfer open' }),
            ic: t({ ru: 'закр. продув.', en: 'transfer close' }),
            eo: t({ ru: 'откр. выпуск', en: 'exhaust open' }),
            ec: t({ ru: 'закр. выпуск', en: 'exhaust close' }),
            overlap: t(PH.scav) }
        : { in: t({ ru: 'впускной клапан', en: 'intake valve' }),
            ex: t({ ru: 'выпускной клапан', en: 'exhaust valve' }),
            io: t({ ru: 'откр. впуск', en: 'IVO' }),
            ic: t({ ru: 'закр. впуск', en: 'IVC' }),
            eo: t({ ru: 'откр. выпуск', en: 'EVO' }),
            ec: t({ ru: 'закр. выпуск', en: 'EVC' }),
            overlap: t({ ru: 'перекрытие клапанов', en: 'valve overlap' }) },
    };
  }

  /** Полосы фаз для фона: четыре такта либо фазы двухтактного по реальным окнам. */
  function phaseBands() {
    if (!twoStroke()) return STROKES;
    const ph = phaseAngles();
    const out = [];
    const push = (from, to, color, name) => {
      if (num(from) && num(to) && to > from + 0.5) out.push({ from, to, color, name });
    };
    push(0, ph.evo, '#f97316', PH.power);
    push(ph.evo, ph.ivo, '#6b7280', PH.exhaust);
    push(ph.ivo, ph.ivc, '#3b82f6', PH.scav);
    push(ph.ivc, ph.evc, '#6b7280', PH.exhaust);
    push(ph.evc, 360, '#a855f7', PH.compr);
    return out.length >= 3 ? out : TWO_STROKE;
  }

  const curDeg = () => (st.frame && num(st.frame.deg) ? mod(st.frame.deg, cycSpan()) : null);
  /** Текущие обороты: приоритет у кадра, затем параметры двигателя. */
  const curRpm = () => {
    if (st.frame && num(st.frame.rpm) && st.frame.rpm > 0) return st.frame.rpm;
    const p = par();
    return num(p.rpm) && p.rpm > 0 ? p.rpm : NaN;
  };
  /** Текущий наддув, бар (0 — атмосферный). */
  const curBoost = () => {
    if (st.frame && num(st.frame.boostNow_bar)) return st.frame.boostNow_bar;
    const p = par();
    return num(p.boost_bar) ? p.boost_bar : NaN;
  };
  /** Человеческое имя компоновки. */
  function layoutName() {
    const p = par();
    const l = p.layout || (st.frame && st.frame.layout);
    const single = { ru: 'одноцилиндровый', en: 'single cylinder' };
    const i4 = { ru: 'рядная 4', en: 'inline-4' };
    if (l === 'single') return t(single);
    if (l === 'i4') return t(i4);
    if (l === 'v8') return t({ ru: 'V8, крестообразный вал', en: 'V8, cross-plane crank' });
    const n = num(p.cylinders) ? p.cylinders : (st.frame && num(st.frame.cylinders) ? st.frame.cylinders : NaN);
    if (n === 1) return t(single);
    if (n === 4) return t(i4);
    if (n === 8) return 'V8';
    return num(n) ? t({ ru: `${n} цил.`, en: `${n} cyl.` }) : '';
  }

  /* ── шапка: заголовок слева, числа справа в той же строке ── */
  const head = { w1: 0, w2: 0 };

  function drawTitle(g, title, subtitle) {
    g.save();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = font(12.5, '600');
    g.fillStyle = C.bright;
    g.fillText(title, 8, 15);
    head.w1 = g.measureText(title).width;
    head.w2 = 0;
    if (subtitle) {
      g.font = font(10.5);
      g.fillStyle = C.text;
      g.fillText(subtitle, 8, 27);
      head.w2 = g.measureText(subtitle).width;
    }
    g.restore();
  }

  /**
   * Числовая строка справа в шапке. Возвращает false, если места нет
   * (тогда вызывающий рисует плашку внутри поля графика).
   */
  function headerRight(g, row, text, color) {
    if (!text) return true;
    g.save();
    g.font = font(10.5);
    const w = g.measureText(text).width;
    const leftW = row === 1 ? head.w1 : head.w2;
    const ok = 8 + leftW + 16 + w <= st.W - 8;
    if (ok) {
      g.fillStyle = color || C.text;
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      g.fillText(text, st.W - 8, row === 1 ? 15 : 27);
    }
    g.restore();
    return ok;
  }

  /* ══════════ 1. p–V — индикаторная диаграмма ══════════ */

  function pvStatic(g, box) {
    const c = cyc();
    const V = c.V_cm3, P = c.p_bar;
    const n = V.length;
    const [vmin, vmax] = extent(V);
    const [pmin, pmax] = extent(P);

    const sx = st.log
      ? logScale(vmin * 0.9, vmax * 1.1, box.x, box.x + box.w)
      : linScale(vmin - (vmax - vmin) * 0.06, vmax + (vmax - vmin) * 0.06, box.x, box.x + box.w);
    const sy = st.log
      ? logScale(Math.max(0.05, pmin * 0.7), pmax * 1.4, box.y + box.h, box.y)
      : linScale(0, pmax * 1.10 || 1, box.y + box.h, box.y);

    const tx = st.log ? logTicks(sx.d0, sx.d1) : niceTicks(sx.d0, sx.d1, 5);
    const ty = st.log ? logTicks(sy.d0, sy.d1) : niceTicks(sy.d0, sy.d1, 5);
    drawGrid(g, box, sx, sy, tx, ty,
      v => (v >= 100 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 0)),
      v => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)),
      t({ ru: 'объём V, см³', en: 'volume V, cm³' }),
      t({ ru: 'давление p, бар', en: 'pressure p, bar' }));

    // ── ВМТ / НМТ ──
    g.save();
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.strokeStyle = C.axis;
    g.font = font(10);
    g.textBaseline = 'top';
    const TDC = t({ ru: 'ВМТ', en: 'TDC' }), BDC = t({ ru: 'НМТ', en: 'BDC' });
    for (const [v, name] of [[vmin, TDC], [vmax, BDC]]) {
      const x = sx(v);
      g.beginPath();
      g.moveTo(x, box.y);
      g.lineTo(x, box.y + box.h);
      g.stroke();
      g.fillStyle = C.text;
      g.textAlign = v === vmin ? 'left' : 'right';
      g.fillText(name, x + (v === vmin ? 4 : -4), box.y + 4);
    }
    g.restore();

    const span = cycSpan();
    const ph = phaseAngles();

    // ── идеальный цикл Отто пунктиром ──
    const eps = num(par().eps) ? par().eps : (vmax / Math.max(vmin, 1e-6));
    const gam = 1.35;
    const pIvc = SA(P, ph.ivc);
    const p1 = num(pIvc) ? pIvc : 1;
    const p2 = p1 * Math.pow(eps, gam);
    const m = met();
    const p3 = m && num(m.pmax_bar) ? m.pmax_bar : p2 * 3.2;
    const xsO = [], ysO = [];
    const K = 48;
    for (let i = 0; i <= K; i++) {                       // сжатие V1→V2
      const v = vmax + (vmin - vmax) * (i / K);
      xsO.push(v); ysO.push(p1 * Math.pow(vmax / v, gam));
    }
    xsO.push(vmin); ysO.push(p3);                        // подвод тепла при V=const
    for (let i = 0; i <= K; i++) {                       // расширение V2→V1
      const v = vmin + (vmax - vmin) * (i / K);
      xsO.push(v); ysO.push(p3 * Math.pow(vmin / v, gam));
    }
    xsO.push(vmax); ysO.push(p1);                        // отвод тепла при V=const
    polyline(g, xsO, ysO, sx, sy, 0, xsO.length - 1, C.green, 1.3, [5, 4]);

    // ── реальная петля: заливка = работа за цикл ──
    g.save();
    g.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (!num(V[i]) || !num(P[i])) continue;
      const px = sx(V[i]), py = sy(P[i]);
      if (started) g.lineTo(px, py); else { g.moveTo(px, py); started = true; }
    }
    g.closePath();
    g.fillStyle = 'rgba(88,166,255,.13)';
    g.fill('evenodd');
    g.restore();

    // ── петля по фазам ──
    const step = span / (n - 1);
    for (const s of phaseBands()) {
      const i0 = clamp(Math.round(s.from / step), 0, n - 1);
      const i1 = clamp(Math.round(s.to / step), 0, n - 1);
      polyline(g, V, P, sx, sy, i0, i1, s.color, 1.9);
    }

    // ── петля газообмена: при наддуве она становится положительной ──
    const pump = pumpLoop(c, span, ph);
    if (pump) {
      g.save();
      g.beginPath();
      let ok = false;
      for (const i of pump.idx) {
        const vv = atWrap(V, i), pp = atWrap(P, i);
        if (!num(vv) || !num(pp)) continue;
        const px = sx(vv), py = sy(pp);
        if (!num(px) || !num(py)) continue;
        if (ok) g.lineTo(px, py); else { g.moveTo(px, py); ok = true; }
      }
      if (ok) {
        g.closePath();
        g.fillStyle = pump.work_J > 0 ? 'rgba(46,160,67,.30)' : 'rgba(107,114,128,.26)';
        g.fill();
        g.strokeStyle = pump.work_J > 0 ? C.green : C.gray;
        g.lineWidth = 1.2;
        g.stroke();
      }
      g.restore();
      if (ok && Math.abs(pump.work_J) > 0.05 && !narrow()) {
        const im = pump.idx[Math.floor(pump.idx.length / 2)];
        const vv = atWrap(V, im), pp = atWrap(P, im);
        if (num(vv) && num(pp)) {
          const b = curBoost();
          const why = num(b) && b > 0.02
            ? t({ ru: ` — наддув ${f(b, 2)} бар, p_вп > p_вып`,
                  en: ` — boost ${f(b, 2)} bar, p_in > p_ex` })
            : t({ ru: ' — p_вп > p_вып', en: ' — p_in > p_ex' });
          const txt = pump.work_J > 0
            ? t({ ru: `петля газообмена положительная: +${f(pump.work_J, 2)} Дж`,
                  en: `pumping loop positive: +${f(pump.work_J, 2)} J` }) + why
            : t({ ru: `петля газообмена: −${f(Math.abs(pump.work_J), 2)} Дж — насосные потери`,
                  en: `pumping loop: −${f(Math.abs(pump.work_J), 2)} J — pumping losses` });
          tag(g, sx(vv) + 8, sy(pp) + 14, txt, pump.work_J > 0 ? C.green : C.gray, box);
        }
      }
    }

    // ── характерные точки ──
    const p = par();
    const soc = num(p.sparkAdvance_deg)
      ? mod(tdcDeg() - p.sparkAdvance_deg, span)
      : firstBurnDeg(c, span);
    const pmaxDeg = m && num(m.pmax_deg) ? mod(m.pmax_deg, span) : argMaxAbs(P) * step;
    const pts = [
      { deg: ph.ivc, color: C.blue,
        name: ph.two ? t({ ru: 'закр. продув. окон', en: 'transfer ports close' })
                     : t({ ru: 'закр. впуска', en: 'intake closes' }) },
      { deg: soc, color: C.yellow,
        name: p.fuel === 'diesel' ? t({ ru: 'впрыск', en: 'injection' })
                                  : t({ ru: 'искра', en: 'spark' }) },
      { deg: pmaxDeg, color: C.red,
        name: t({ ru: `p max ${f(SA(P, pmaxDeg), 1)} бар`, en: `p max ${f(SA(P, pmaxDeg), 1)} bar` }) },
      { deg: ph.evo, color: C.gray,
        name: ph.two ? t({ ru: 'откр. выпускного окна', en: 'exhaust port opens' })
                     : t({ ru: 'откр. выпуска', en: 'exhaust opens' }) },
    ];
    for (const pt of pts) {
      if (!num(pt.deg)) continue;
      const vv = SA(V, pt.deg), pp = SA(P, pt.deg);
      if (!num(vv) || !num(pp)) continue;
      const x = sx(vv), y = sy(pp);
      dot(g, x, y, 3, pt.color);
      if (!narrow()) tag(g, x + 7, y - 9, `${pt.name} · ${Math.round(pt.deg)}°`, pt.color, box);
    }

    // ── легенда и работа цикла ──
    const wrk = m && num(m.workPerCycle_J) ? m.workPerCycle_J : NaN;
    const leg = [
      { color: C.blue, text: t({ ru: 'реальный цикл (заливка = работа)',
                                 en: 'actual cycle (shaded area = work)' }) },
      { color: C.green, text: t({ ru: 'идеальный цикл Отто', en: 'ideal Otto cycle' }), dash: [5, 4] },
    ];
    if (pump && Math.abs(pump.work_J) > 0.05) {
      leg.push({
        color: pump.work_J > 0 ? C.green : C.gray,
        text: pump.work_J > 0
          ? t({ ru: 'петля газообмена (+, наддув)', en: 'pumping loop (+, boost)' })
          : t({ ru: 'петля газообмена (−, насосные потери)', en: 'pumping loop (−, pumping losses)' }),
      });
    }
    drawLegend(g, box.x + 4, box.y + box.h + 47, leg, box.w);
    const lines = [];
    if (num(wrk)) lines.push(t({ ru: `работа ${f(wrk, 1)} Дж/цил.`, en: `work ${f(wrk, 1)} J/cyl.` }));
    if (m && num(m.imep_bar)) {
      lines.push(t({ ru: `p_i ${f(m.imep_bar, 2)} бар`, en: `p_i ${f(m.imep_bar, 2)} bar` }));
    }
    if (m && num(m.effIndicated)) {
      lines.push(t({ ru: `КПД инд. ${f(m.effIndicated * 100, 1)} %`,
                     en: `indicated eff. ${f(m.effIndicated * 100, 1)} %` }));
    }
    if (m && num(m.effOtto)) {
      lines.push(t({ ru: `Отто ${f(m.effOtto * 100, 1)} %`, en: `Otto ${f(m.effOtto * 100, 1)} %` }));
    }
    headerRight(g, 1, lines.join('  ·  '));

    return { sx, sy };
  }

  /**
   * Петля газообмена и её работа ∮p dV, Дж.
   * Четыре такта: классическая насосная петля — такты выпуска и впуска, от НМТ до НМТ
   * (продувка после EVO относится к рабочему ходу и в петлю не входит).
   * Два такта: период открытых окон.
   * Положительная работа = давление впуска выше выпуска, то есть наддув подталкивает поршень.
   */
  function pumpLoop(c, span, ph) {
    const V = c.V_cm3, P = c.p_bar;
    if (!isArr(V) || !isArr(P)) return null;
    const n = Math.min(V.length, P.length);
    if (n < 8) return null;
    const step = span / (n - 1);
    let from, width;
    if (span === 360) {
      if (!num(ph.evo) || !num(ph.evc)) return null;
      from = ph.evo;
      width = mod(ph.evc - ph.evo, span);
    } else {
      from = mod(tdcDeg() + 180, span);          // НМТ конца рабочего хода
      width = 360;                               // такт выпуска + такт впуска
    }
    if (!(width > step * 2) || width > span - step) return null;
    const i0 = Math.round(from / step);
    const cnt = Math.round(width / step);
    const idx = [];
    for (let k = 0; k <= cnt; k++) idx.push(i0 + k);
    let W = 0;
    for (let k = 0; k < cnt; k++) {
      const va = atWrap(V, idx[k]), vb = atWrap(V, idx[k + 1]);
      const pa = atWrap(P, idx[k]), pb = atWrap(P, idx[k + 1]);
      if (!num(va) || !num(vb) || !num(pa) || !num(pb)) continue;
      W += 0.5 * (pa + pb) * (vb - va) * 0.1;      // бар·см³ → Дж
    }
    if (!num(W)) return null;
    return { idx, work_J: W };
  }

  /** Угол начала сгорания по таблице Вибе, если параметров нет. */
  function firstBurnDeg(c, span) {
    if (!c || !isArr(c.xb)) return NaN;
    const step = (num(span) ? span : 720) / (c.xb.length - 1);
    for (let i = 0; i < c.xb.length; i++) if (num(c.xb[i]) && c.xb[i] > 0.002) return i * step;
    return NaN;
  }

  function pvDynamic(g, box, sc) {
    const d = curDeg();
    const c = cyc();
    if (d === null || !c || !sc) return;
    const v = SA(c.V_cm3, d), p = SA(c.p_bar, d);
    if (!num(v) || !num(p)) return;
    const x = sc.sx(v), y = sc.sy(p);
    dot(g, x, y, 4.5, '#ffffff', C.orange);
    const T = SA(c.T_K, d);
    const lines = [
      `θ = ${d.toFixed(0)}°`,
      t({ ru: `p = ${f(p, 2)} бар`, en: `p = ${f(p, 2)} bar` }),
      t({ ru: `V = ${f(v, 1)} см³`, en: `V = ${f(v, 1)} cm³` }),
      num(T) ? `T = ${Math.round(T)} K` : '',
    ].filter(Boolean);
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) drawReadout(g, box, lines, 'left');
  }

  /* ══════════ 2. Момент на коленвале ══════════ */

  function torqueStatic(g, box) {
    const c = cyc();
    const D = c.deg;
    const T1 = isArr(c.torque_Nm) ? c.torque_Nm : null;
    const TT = isArr(c.torqueTotal_Nm) ? c.torqueTotal_Nm : null;
    const cyl = num(par().cylinders) ? par().cylinders : 1;

    let mn = Infinity, mx = -Infinity;
    for (const a of [T1, TT]) {
      if (!a) continue;
      const [x0, x1] = extent(a);
      mn = Math.min(mn, x0); mx = Math.max(mx, x1);
    }
    if (!isFinite(mn)) { mn = -1; mx = 1; }
    const pad = (mx - mn) * 0.12 || 1;

    const span = cycSpan();
    const sx = linScale(0, span, box.x, box.x + box.w);
    const sy = linScale(mn - pad, mx + pad, box.y + box.h, box.y);
    drawGrid(g, box, sx, sy, angleTicks(), niceTicks(mn - pad, mx + pad, 5),
      v => v.toFixed(0), v => v.toFixed(Math.abs(mx) < 20 ? 1 : 0),
      angleAxisLabel(span), t({ ru: 'момент M, Н·м', en: 'torque M, N·m' }));
    drawPhaseBands(g, box, sx, phaseBands(), !narrow());

    // нулевая линия
    const y0 = sy(0);
    g.save();
    g.strokeStyle = C.axis;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(box.x, y0);
    g.lineTo(box.x + box.w, y0);
    g.stroke();
    g.restore();

    // заливка положительной/отрицательной частей суммарного момента
    const main = TT || T1;
    if (main) fillAroundZero(g, box, D, main, sx, sy, y0, span);

    if (T1) polyline(g, D, T1, sx, sy, 0, D.length - 1, C.blue, 1.6);
    if (TT && cyl > 1) polyline(g, D, TT, sx, sy, 0, D.length - 1, C.orange, 2.0);

    // средний момент (индикаторный) и эффективный
    const avg = main ? mean(main) : NaN;
    const m = met();
    if (num(avg)) {
      dashedH(g, box, sy(avg), C.green, [6, 4]);
      if (!narrow()) {
        tag(g, box.x + box.w - 6, sy(avg) - 9,
          t({ ru: `средний ${f(avg, 1)} Н·м`, en: `mean ${f(avg, 1)} N·m` }), C.green, box, 'right');
      }
    }
    if (m && num(m.brakeTorque_Nm)) {
      dashedH(g, box, sy(m.brakeTorque_Nm), C.gray, [3, 3]);
      if (!narrow()) {
        tag(g, box.x + 6, sy(m.brakeTorque_Nm) + 10,
          t({ ru: `эффективный ${f(m.brakeTorque_Nm, 1)} Н·м (за вычетом трения)`,
              en: `brake ${f(m.brakeTorque_Nm, 1)} N·m (friction subtracted)` }), C.gray, box);
      }
    }

    const items = [{ color: C.blue, text: t({ ru: 'один цилиндр', en: 'single cylinder' }) }];
    if (TT && cyl > 1) {
      items.push({ color: C.orange,
        text: t({ ru: `сумма ${cyl} цил.`, en: `sum of ${cyl} cyl.` }) });
    }
    items.push({ color: C.green, text: t({ ru: 'средний момент', en: 'mean torque' }), dash: [6, 4] });
    drawLegend(g, box.x + 4, box.y + box.h + 47, items, box.w);

    const lines = [];
    if (num(par().rpm)) lines.push(rpmText(par().rpm));
    if (m && num(m.brakePower_kW)) {
      lines.push(t({ ru: `${f(m.brakePower_kW, 1)} кВт`, en: `${f(m.brakePower_kW, 1)} kW` }));
    }
    if (m && num(m.speedFluctuation)) lines.push(`δ = ${f(m.speedFluctuation, 3)}`);
    headerRight(g, 1, lines.join('  ·  '));

    return { sx, sy, main };
  }

  function dashedH(g, box, y, color, dash) {
    if (!num(y)) return;
    g.save();
    g.setLineDash(dash);
    g.strokeStyle = color;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(box.x, y);
    g.lineTo(box.x + box.w, y);
    g.stroke();
    g.restore();
  }

  function fillAroundZero(g, box, D, arr, sx, sy, y0, span) {
    for (const sign of [1, -1]) {
      g.save();
      g.beginPath();
      g.moveTo(sx(0), y0);
      for (let i = 0; i < arr.length; i++) {
        const v = num(arr[i]) ? arr[i] : 0;
        const use = sign > 0 ? Math.max(v, 0) : Math.min(v, 0);
        if (!num(D[i])) continue;
        g.lineTo(sx(D[i]), sy(use));
      }
      g.lineTo(sx(span), y0);
      g.closePath();
      g.fillStyle = sign > 0 ? 'rgba(249,115,22,.14)' : 'rgba(239,68,68,.16)';
      g.fill();
      g.restore();
    }
  }

  function torqueDynamic(g, box, sc) {
    const d = curDeg();
    const c = cyc();
    if (d === null || !c || !sc) return;
    const x = sc.sx(d);
    vline(g, box, x);
    const lines = [`θ = ${d.toFixed(0)}°`];
    if (isArr(c.torque_Nm)) {
      const v = SA(c.torque_Nm, d);
      dot(g, x, sc.sy(v), 3.5, C.blue, '#fff');
      lines.push(t({ ru: `1 цил.: ${f(v, 1)} Н·м`, en: `1 cyl.: ${f(v, 1)} N·m` }));
    }
    if (isArr(c.torqueTotal_Nm) && num(par().cylinders) && par().cylinders > 1) {
      const v = SA(c.torqueTotal_Nm, d);
      dot(g, x, sc.sy(v), 4, C.orange, '#fff');
      lines.push(t({ ru: `сумма: ${f(v, 1)} Н·м`, en: `total: ${f(v, 1)} N·m` }));
    }
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) drawReadout(g, box, lines, 'left');
  }

  function vline(g, box, x) {
    if (!num(x)) return;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x, box.y);
    g.lineTo(x, box.y + box.h);
    g.stroke();
    g.restore();
  }

  /* ══════════ 3. Кинематика поршня (три панели) ══════════ */

  /** Три панели одна под другой; в тесноте подписи панелей уезжают внутрь поля. */
  function kinBoxes(W, H) {
    const tight = H < 300;
    const top = tight ? 36 : 48, bottom = tight ? 26 : 32, gap = tight ? 12 : 20;
    const left = 54, right = 12;
    const h = (H - top - bottom - gap * 2) / 3;
    if (h < 22) return null;
    const boxes = [0, 1, 2].map(i => ({ x: left, y: top + i * (h + gap), w: W - left - right, h }));
    boxes.tight = tight;
    return boxes;
  }

  function kinStatic(g, W, H) {
    const c = cyc();
    const boxes = kinBoxes(W, H);
    if (!boxes) { drawEmpty(g, W, H, t({ ru: 'Мало места для графика', en: 'Not enough space for the chart' })); return null; }
    const span = cycSpan();
    const D = c.deg;
    const stroke_mm = num(geo().stroke_m) ? geo().stroke_m * 1000
      : (num(par().stroke_mm) ? par().stroke_mm : 86);
    const lambda = num(geo().lambda) ? geo().lambda : NaN;

    // перемещение поршня от ВМТ, мм (pistonFrac: 0 = ВМТ, 1 = НМТ)
    let S = null;
    if (isArr(c.pistonFrac)) {
      S = new Float64Array(c.pistonFrac.length);
      for (let i = 0; i < S.length; i++) S[i] = (num(c.pistonFrac[i]) ? c.pistonFrac[i] : 0) * stroke_mm;
    }
    const Vv = isArr(c.pistonVel_ms) ? c.pistonVel_ms : null;
    const Av = isArr(c.pistonAcc_ms2) ? c.pistonAcc_ms2 : null;

    let note = t({ ru: 'перемещение, скорость и ускорение поршня по углу цикла',
                   en: 'piston displacement, velocity and acceleration versus crank angle' });
    const panels = [
      { data: S,  color: C.blue,   zero: false,
        title: t({ ru: 'перемещение от ВМТ, мм', en: 'displacement from TDC, mm' }) },
      { data: Vv, color: C.purple, zero: true,
        title: t({ ru: 'скорость, м/с', en: 'velocity, m/s' }) },
      { data: Av, color: C.orange, zero: true,
        title: t({ ru: 'ускорение, м/с²', en: 'acceleration, m/s²' }) },
    ];

    const scales = [];
    panels.forEach((p, i) => {
      const box = boxes[i];
      if (!p.data) {
        g.save();
        g.strokeStyle = C.grid;
        g.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
        g.restore();
        centerText(g, box.x + box.w / 2, box.y + box.h / 2,
          t({ ru: `нет данных: ${p.title}`, en: `no data: ${p.title}` }));
        scales.push(null);
        return;
      }
      let [mn, mx] = extent(p.data);
      if (p.zero) { const a = Math.max(Math.abs(mn), Math.abs(mx)) * 1.15 || 1; mn = -a; mx = a; }
      else { mn = 0; mx = mx * 1.08 || 1; }
      const sx = linScale(0, span, box.x, box.x + box.w);
      const sy = linScale(mn, mx, box.y + box.h, box.y);
      const showX = i === 2;
      drawGrid(g, box, sx, sy, angleTicks(), niceTicks(mn, mx, 3),
        v => (showX ? v.toFixed(0) : ''),
        v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(Math.abs(mx) < 20 ? 1 : 0)),
        showX && !boxes.tight ? angleAxisLabel(span) : '', '');
      // заголовок панели: над полем, а в тесноте — внутри него
      g.save();
      g.font = font(10.5, '600');
      g.fillStyle = p.color;
      g.textAlign = 'left';
      if (boxes.tight) {
        g.textBaseline = 'top';
        g.fillText(p.title, box.x + 4, box.y + 3);
      } else {
        g.textBaseline = 'alphabetic';
        g.fillText(p.title, box.x, box.y - 5);
      }
      g.restore();
      if (p.zero) dashedH(g, box, sy(0), C.axis, [2, 3]);
      polyline(g, D, p.data, sx, sy, 0, D.length - 1, p.color, 1.8);
      scales.push({ sx, sy, data: p.data, box });
    });

    // ── подписи максимумов ──
    if (Vv && scales[1]) {
      const i = argMaxAbs(Vv);
      const step = span / (Vv.length - 1);
      const b = boxes[1];
      const x = scales[1].sx(i * step), y = scales[1].sy(Vv[i]);
      dot(g, x, y, 3, C.purple);
      tag(g, x + 7, y,
        t({ ru: `макс. |v| = ${f(Math.abs(Vv[i]), 2)} м/с при ${Math.round(mod(i * step, 360))}°`,
            en: `max |v| = ${f(Math.abs(Vv[i]), 2)} m/s at ${Math.round(mod(i * step, 360))}°` }),
        C.purple, b);
      const mps = met() && num(met().meanPistonSpeed_ms) ? met().meanPistonSpeed_ms : NaN;
      if (num(mps) && b.h > 54) {
        tag(g, b.x + 6, b.y + 11,
          t({ ru: `средняя скорость поршня ${f(mps, 2)} м/с`,
              en: `mean piston speed ${f(mps, 2)} m/s` }), C.text, b);
      }
    }
    if (Av && scales[2]) {
      // экстремумы ускорения лежат в мёртвых точках; знак зависит от соглашения,
      // поэтому берём значения по углу, а не по знаку
      const b = boxes[2];
      const dT = tdcDeg(), dB = 180;                 // ВМТ конца сжатия и ближайшая НМТ
      const aT = SA(Av, dT), aB = SA(Av, dB);
      if (num(aT) && num(aB)) {
        const xT = scales[2].sx(dT), yT = scales[2].sy(aT);
        const xB = scales[2].sx(dB), yB = scales[2].sy(aB);
        dot(g, xT, yT, 3, C.orange);
        dot(g, xB, yB, 3, C.gray);
        tag(g, xT + 7, yT + (aT > aB ? -2 : 2),
          t({ ru: `ВМТ: |a| = ${f(Math.abs(aT), 0)} м/с² = ${f(Math.abs(aT) / G, 0)} g`,
              en: `TDC: |a| = ${f(Math.abs(aT), 0)} m/s² = ${f(Math.abs(aT) / G, 0)} g` }), C.orange, b);
        tag(g, xB + 7, yB + (aT > aB ? 2 : -2),
          t({ ru: `НМТ: |a| = ${f(Math.abs(aB), 0)} м/с² = ${f(Math.abs(aB) / G, 0)} g`,
              en: `BDC: |a| = ${f(Math.abs(aB), 0)} m/s² = ${f(Math.abs(aB) / G, 0)} g` }), C.gray, b);
        // ключевой учебный вывод — в подзаголовок графика
        const ratio = Math.abs(aB) > 1e-6 ? Math.abs(aT / aB) : NaN;
        note = t({ ru: `у ВМТ ускорение в ${f(ratio, 2)} раза больше, чем у НМТ`,
                   en: `acceleration at TDC is ${f(ratio, 2)}× that at BDC` }) +
          (num(lambda)
            ? t({ ru: ` — влияние конечной длины шатуна, λ = r/L = ${f(lambda, 3)}`,
                  en: ` — effect of finite rod length, λ = r/L = ${f(lambda, 3)}` })
            : '');
      }
    }
    if (S && scales[0] && boxes[0].h > 54) {
      tag(g, boxes[0].x + 6, boxes[0].y + 11,
        t({ ru: `ход поршня S = ${f(stroke_mm, 0)} мм`, en: `piston stroke S = ${f(stroke_mm, 0)} mm` }),
        C.blue, boxes[0]);
    }
    return { boxes, scales, note };
  }

  function kinDynamic(g, sc) {
    const d = curDeg();
    if (d === null || !sc) return;
    const units = [
      t({ ru: 'мм', en: 'mm' }),
      t({ ru: 'м/с', en: 'm/s' }),
      t({ ru: 'м/с²', en: 'm/s²' }),
    ];
    const names = ['s', 'v', 'a'];
    const vals = [];
    sc.scales.forEach((s, i) => {
      if (!s) return;
      const x = s.sx(d);
      vline(g, s.box, x);
      const v = SA(s.data, d);
      if (!num(v)) return;
      dot(g, x, s.sy(v), 3.5, '#ffffff', C.orange);
      vals.push(`${names[i]} = ${f(v, i === 2 ? 0 : 1)} ${units[i]}` + (i === 2 ? ` (${f(v / G, 0)} g)` : ''));
    });
    const lines = [`θ = ${d.toFixed(0)}°`, ...vals];
    if (!headerRight(g, 1, lines.join('  ·  '), C.bright) && sc.scales[0]) {
      drawReadout(g, sc.scales[0].box, lines, 'right');
    }
  }

  /* ══════════ 4. Диаграмма фаз газораспределения ══════════ */

  function valvesStatic(g, box) {
    const c = cyc();
    const D = c.deg;
    const span = cycSpan();
    const ph = phaseAngles();
    const sx = linScale(0, span, box.x, box.x + box.w);
    const sy = linScale(0, 1.08, box.y + box.h, box.y);
    drawGrid(g, box, sx, sy, angleTicks(), [0, 0.25, 0.5, 0.75, 1],
      v => v.toFixed(0), v => (v * 100).toFixed(0),
      angleAxisLabel(span),
      ph.two ? t({ ru: 'открытие окон и доля сгоревшего, %',
                   en: 'port opening and burned fraction, %' })
             : t({ ru: 'подъём клапана и доля сгоревшего, %',
                   en: 'valve lift and burned fraction, %' }));
    drawPhaseBands(g, box, sx, phaseBands(), !narrow());

    const LI = isArr(c.liftIn) ? c.liftIn : null;
    const LE = isArr(c.liftEx) ? c.liftEx : null;
    const XB = isArr(c.xb) ? c.xb : null;

    // ── зона перекрытия (у двухтактного — совместное открытие окон, то есть продувка) ──
    if (LI && LE) {
      g.save();
      g.fillStyle = 'rgba(46,160,67,.20)';
      const n = Math.min(LI.length, LE.length);
      const step = span / (n - 1);
      let runStart = -1;
      let labelled = false;
      for (let i = 0; i <= n; i++) {
        const both = i < n && num(LI[i]) && num(LE[i]) && LI[i] > 0.01 && LE[i] > 0.01;
        if (both && runStart < 0) runStart = i;
        if (!both && runStart >= 0) {
          const x0 = sx(runStart * step), x1 = sx((i - 1) * step);
          g.fillRect(x0, box.y, Math.max(x1 - x0, 1.5), box.h);
          if (!labelled && x1 - x0 > 2 && !narrow()) {
            labelled = true;
            tag(g, (x0 + x1) / 2 + 6, box.y + box.h * 0.42,
              `${ph.names.overlap} ≈ ${Math.round((i - runStart) * step)}°`, C.green, box);
          }
          runStart = -1;
        }
      }
      g.restore();
    }

    if (LI) polyline(g, D, LI, sx, sy, 0, D.length - 1, C.blue, 1.9);
    if (LE) polyline(g, D, LE, sx, sy, 0, D.length - 1, C.orange, 1.9);
    if (XB) polyline(g, D, XB, sx, sy, 0, D.length - 1, C.red, 1.7, [5, 3]);

    // ── момент искры / впрыска ──
    const p = par();
    const soc = num(p.sparkAdvance_deg)
      ? mod(tdcDeg() - p.sparkAdvance_deg, span)
      : firstBurnDeg(c, span);
    if (num(soc)) {
      const x = sx(soc);
      g.save();
      g.strokeStyle = C.yellow;
      g.lineWidth = 1.4;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(x, box.y);
      g.lineTo(x, box.y + box.h);
      g.stroke();
      g.restore();
      const nm = p.fuel === 'diesel' ? t({ ru: 'впрыск', en: 'injection' })
                                     : t({ ru: 'искра', en: 'spark' });
      const btdc = f(mod(tdcDeg() - soc, span), 0);
      tag(g, x + 6, box.y + 26,
        t({ ru: `${nm} ${Math.round(soc)}° (${btdc}° до ВМТ)`,
            en: `${nm} ${Math.round(soc)}° (${btdc}° BTDC)` }), C.yellow, box);
    }

    // ── фазы: подписи открытия/закрытия ──
    const phases = [
      { deg: ph.ivo, txt: ph.names.io, color: C.blue },
      { deg: ph.ivc, txt: ph.names.ic, color: C.blue },
      { deg: ph.evo, txt: ph.names.eo, color: C.orange },
      { deg: ph.evc, txt: ph.names.ec, color: C.orange },
    ];
    g.save();
    g.font = font(9.5);
    g.textBaseline = 'bottom';
    let lastTxtX = -1e9;
    const ordered = phases.filter(q => num(q.deg)).sort((a, b) => mod(a.deg, span) - mod(b.deg, span));
    for (const q of ordered) {
      const x = sx(mod(q.deg, span));
      g.strokeStyle = q.color + '66';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, box.y + box.h);
      g.lineTo(x, box.y + box.h - 7);
      g.stroke();
      if (narrow()) continue;                       // на узкой панели подписи не влезают
      const txt = `${q.txt} ${Math.round(mod(q.deg, span))}°`;
      const tw = g.measureText(txt).width;
      const cx = clamp(x, box.x + tw / 2 + 2, box.x + box.w - tw / 2 - 2);
      if (cx - tw / 2 < lastTxtX + 6) continue;     // не наезжать на предыдущую подпись
      lastTxtX = cx + tw / 2;
      g.fillStyle = q.color;
      g.textAlign = 'center';
      g.fillText(txt, cx, box.y + box.h - 9);
    }
    g.restore();

    drawLegend(g, box.x + 4, box.y + box.h + 47, [
      { color: C.blue, text: ph.names.in },
      { color: C.orange, text: ph.names.ex },
      { color: C.red, text: t({ ru: 'сгорело топлива (Вибе)',
                                en: 'burned fuel fraction (Wiebe)' }), dash: [5, 3] },
      { color: C.green, text: ph.names.overlap },
    ], box.w);

    return { sx, sy, two: ph.two };
  }

  function valvesDynamic(g, box, sc) {
    const d = curDeg();
    const c = cyc();
    if (d === null || !c || !sc) return;
    const x = sc.sx(d);
    vline(g, box, x);
    const two = !!(sc && sc.two);
    const lines = [`θ = ${d.toFixed(0)}°`];
    if (isArr(c.liftIn)) {
      const v = SA(c.liftIn, d);
      if (num(v)) {
        dot(g, x, sc.sy(v), 3.2, C.blue, '#fff');
        const nm = two ? t({ ru: 'продув. окна', en: 'transfer ports' })
                       : t({ ru: 'впуск', en: 'intake' });
        lines.push(`${nm}: ${(v * 100).toFixed(0)} %`);
      }
    }
    if (isArr(c.liftEx)) {
      const v = SA(c.liftEx, d);
      if (num(v)) {
        dot(g, x, sc.sy(v), 3.2, C.orange, '#fff');
        const nm = two ? t({ ru: 'вып. окно', en: 'exhaust port' })
                       : t({ ru: 'выпуск', en: 'exhaust' });
        lines.push(`${nm}: ${(v * 100).toFixed(0)} %`);
      }
    }
    if (isArr(c.xb)) {
      const v = SA(c.xb, d);
      if (num(v)) {
        lines.push(t({ ru: `сгорело: ${(v * 100).toFixed(0)} %`,
                       en: `burned: ${(v * 100).toFixed(0)} %` }));
      }
    }
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) drawReadout(g, box, lines, 'left');
  }

  /* ══════════ 5. Энергетический баланс ══════════ */

  function energyStatic(g, W, H) {
    const m = met();
    const e = m && m.energy ? m.energy : null;
    if (!e) {
      drawEmpty(g, W, H, t({ ru: 'Нет данных энергетического баланса',
                             en: 'No energy balance data' }));
      return;
    }

    const parts = [
      { key: 'work_pct',     color: C.green,
        name: t({ ru: 'Полезная работа', en: 'Useful work' }) },
      { key: 'exhaust_pct',  color: C.orange,
        name: t({ ru: 'Потери с выхлопом', en: 'Exhaust losses' }) },
      { key: 'coolant_pct',  color: C.blue,
        name: t({ ru: 'Отвод в охлаждение', en: 'Heat to coolant' }) },
      { key: 'friction_pct', color: C.purple,
        name: t({ ru: 'Механическое трение', en: 'Mechanical friction' }) },
    ].map(p => ({ ...p, val: num(e[p.key]) ? Math.max(0, e[p.key]) : 0 }));

    const total = parts.reduce((s, p) => s + p.val, 0) || 100;

    const left = 16, right = 16;
    const bw = W - left - right;
    const by = 46;
    const bh = Math.min(52, Math.max(26, H * 0.18));
    if (bw < 60) { drawEmpty(g, W, H, t({ ru: 'Слишком узко', en: 'Too narrow' })); return; }

    // ── стековая полоса ──
    let x = left;
    g.save();
    for (const p of parts) {
      const w = (p.val / total) * bw;
      g.fillStyle = p.color;
      g.fillRect(x, by, w, bh);
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(x, by, w, bh * 0.35);
      if (w > 42) {
        g.fillStyle = '#0d1117';
        g.font = font(12, '700');
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(`${p.val.toFixed(1)} %`, x + w / 2, by + bh / 2);
      }
      x += w;
    }
    g.strokeStyle = C.axis;
    g.lineWidth = 1;
    g.strokeRect(left + 0.5, by + 0.5, bw, bh);
    g.restore();

    // ── шкала 0…100 % ──
    g.save();
    g.font = font(9.5);
    g.fillStyle = C.text;
    g.strokeStyle = C.grid;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let tk = 0; tk <= 100; tk += 10) {
      const px = left + (tk / 100) * bw;
      g.beginPath();
      g.moveTo(px, by + bh);
      g.lineTo(px, by + bh + 4);
      g.stroke();
      if (tk % 20 === 0) g.fillText(tk + ' %', px, by + bh + 6);
    }
    g.restore();

    // ── легенда со значениями ──
    let ly = by + bh + 26;
    g.save();
    g.font = font(11.5);
    g.textBaseline = 'middle';
    for (const p of parts) {
      if (ly > H - 8) break;
      g.fillStyle = p.color;
      roundRect(g, left, ly - 5, 11, 11, 3);
      g.fill();
      g.fillStyle = C.bright;
      g.textAlign = 'left';
      g.fillText(p.name, left + 18, ly);
      g.fillStyle = C.text;
      g.textAlign = 'right';
      g.fillText(`${p.val.toFixed(1)} %`, left + bw, ly);
      ly += 18;
    }
    g.restore();

    // ── сводка цифр ──
    const rows = [];
    if (num(m.brakePower_kW)) {
      rows.push([t({ ru: 'Эффективная мощность', en: 'Brake power' }),
        t({ ru: `${f(m.brakePower_kW, 1)} кВт`, en: `${f(m.brakePower_kW, 1)} kW` })]);
    }
    if (num(m.indPower_kW)) {
      rows.push([t({ ru: 'Индикаторная мощность', en: 'Indicated power' }),
        t({ ru: `${f(m.indPower_kW, 1)} кВт`, en: `${f(m.indPower_kW, 1)} kW` })]);
    }
    if (num(m.brakeTorque_Nm)) {
      rows.push([t({ ru: 'Эффективный момент', en: 'Brake torque' }),
        t({ ru: `${f(m.brakeTorque_Nm, 1)} Н·м`, en: `${f(m.brakeTorque_Nm, 1)} N·m` })]);
    }
    if (num(m.effBrake)) {
      rows.push([t({ ru: 'Эффективный КПД', en: 'Brake efficiency' }), `${f(m.effBrake * 100, 1)} %`]);
    }
    if (num(m.bsfc_g_kWh)) {
      rows.push([t({ ru: 'Удельный расход', en: 'BSFC' }),
        t({ ru: `${f(m.bsfc_g_kWh, 0)} г/(кВт·ч)`, en: `${f(m.bsfc_g_kWh, 0)} g/(kW·h)` })]);
    }
    if (num(m.volEff)) {
      rows.push([t({ ru: 'Коэф. наполнения', en: 'Volumetric efficiency' }),
        `${f(m.volEff * 100, 0)} %`]);
    }
    if (rows.length && ly + 10 < H) {
      g.save();
      g.strokeStyle = C.grid;
      g.beginPath();
      g.moveTo(left, ly - 2);
      g.lineTo(left + bw, ly - 2);
      g.stroke();
      g.font = font(11);
      g.textBaseline = 'middle';
      ly += 12;
      for (const [k, v] of rows) {
        if (ly > H - 6) break;
        g.fillStyle = C.text;
        g.textAlign = 'left';
        g.fillText(k, left, ly);
        g.fillStyle = C.bright;
        g.textAlign = 'right';
        g.fillText(v, left + bw, ly);
        ly += 16;
      }
      g.restore();
    }

    drawTitle(g, t({ ru: 'Энергетический баланс двигателя', en: 'Engine energy balance' }),
      t({ ru: 'куда уходит теплота сгорания топлива, % от подведённой',
          en: 'where the fuel heat goes, % of heat supplied' }));
  }

  /* ══════════ 6. Внешняя скоростная характеристика ══════════ */

  /** Диапазон свипа: от холостых до максимума, с запасом относительно текущих оборотов. */
  function sweepRange() {
    const p = par();
    const rpm = num(p.rpm) ? p.rpm : 3000;
    const to = Math.max(6500, Math.ceil((rpm + 400) / 500) * 500);
    return { from: 800, to, step: 100 };
  }

  /**
   * Свип с кэшем. Пересчитывается только когда кэш сброшен (setEngine / invalidate),
   * то есть никогда не считается «каждый кадр». Дополнительно короткий антидребезг,
   * чтобы перетаскивание ползунка не вызывало десятки свипов подряд.
   */
  function getSweep() {
    const e = st.engine;
    if (!e || typeof e.sweepRpm !== 'function') return null;
    if (st.sweep) return st.sweep;
    const t0 = nowMs();
    if (st.sweepPrev && t0 - st.sweepAt < SWEEP_MIN_MS) {
      // слишком часто — показываем прошлый результат, но обязательно возвращаемся за свежим
      scheduleSweepRefresh(SWEEP_MIN_MS - (t0 - st.sweepAt) + 10);
      return st.sweepPrev;
    }
    let s = null;
    try {
      s = e.sweepRpm(sweepRange());
    } catch (err) {
      st.sweepAt = nowMs();
      st.sweepFail = true;
      if (!st.sweepWarned && typeof console !== 'undefined' && console.warn) {
        st.sweepWarned = true;
        console.warn('[charts] engine.sweepRpm() бросил исключение:', err);
      }
      return st.sweepPrev || null;
    }
    st.sweepAt = nowMs();
    st.sweepMs = st.sweepAt - t0;
    if (!s || !isArr(s.rpm)) { st.sweepFail = true; return null; }
    st.sweepFail = false;
    st.sweep = s;
    st.sweepPrev = s;
    return s;
  }

  /**
   * Отложенный пересчёт свипа: если из-за антидребезга показан прошлый результат,
   * график сам вернётся за свежим, а не останется с устаревшими кривыми.
   */
  let sweepTimer = null;
  function scheduleSweepRefresh(ms) {
    if (sweepTimer || typeof setTimeout !== 'function') return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      if (st.disposed || st.sweep) return;
      st.staticDirty = true;
      render();
    }, Math.max(10, ms));
  }

  /** Максимум серии: { i, x, y } или null. */
  function peakOf(xs, ys) {
    let bi = -1, bv = -Infinity;
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      if (num(xs[i]) && num(ys[i]) && ys[i] > bv) { bv = ys[i]; bi = i; }
    }
    return bi < 0 ? null : { i: bi, x: xs[bi], y: bv };
  }

  /** Линейная интерполяция серии y(x) по возрастающему x. */
  function interpAt(xs, ys, x) {
    if (!isArr(xs) || !isArr(ys) || !num(x)) return NaN;
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return NaN;
    if (x <= xs[0]) return num(ys[0]) ? ys[0] : NaN;
    for (let i = 1; i < n; i++) {
      if (!num(xs[i]) || !num(xs[i - 1])) continue;
      if (x <= xs[i]) {
        const dx = xs[i] - xs[i - 1];
        const kx = dx ? (x - xs[i - 1]) / dx : 0;
        const a = ys[i - 1], bq = ys[i];
        if (!num(a)) return num(bq) ? bq : NaN;
        if (!num(bq)) return a;
        return a + (bq - a) * kx;
      }
    }
    return num(ys[n - 1]) ? ys[n - 1] : NaN;
  }

  /** Две панели с общей осью оборотов; при нехватке высоты остаётся одна. */
  function sweepBoxes(W, H) {
    const left = 50, right = 50, top = 34;
    const bottom = narrow() ? 88 : 72;
    const w = W - left - right;
    const availH = H - top - bottom;
    if (w < 90 || availH < 56) return null;
    if (availH < 168) return { two: false, main: { x: left, y: top, w, h: availH } };
    const gap = 24;
    const h2 = clamp(availH * 0.32, 44, 96);
    return {
      two: true,
      main: { x: left, y: top, w, h: availH - h2 - gap },
      sub: { x: left, y: top + (availH - h2 - gap) + gap, w, h: h2 },
    };
  }

  function sweepStatic(g, W, H) {
    if (!st.engine || typeof st.engine.sweepRpm !== 'function') {
      drawEmpty(g, W, H, t({
        ru: 'Скоростная характеристика недоступна: движок не умеет sweepRpm()',
        en: 'Speed curve unavailable: engine has no sweepRpm()' }));
      return null;
    }
    const s = getSweep();
    if (!s || !isArr(s.rpm)) {
      drawEmpty(g, W, H, st.sweepFail
        ? t({ ru: 'Свип не выполнен: engine.sweepRpm() вернул ошибку',
              en: 'Sweep failed: engine.sweepRpm() returned an error' })
        : t({ ru: 'Свип не дал данных', en: 'Sweep returned no data' }));
      return null;
    }
    const boxes = sweepBoxes(W, H);
    if (!boxes) {
      drawEmpty(g, W, H, t({ ru: 'Мало места для характеристики',
                             en: 'Not enough space for the speed curve' }));
      return null;
    }

    const R = s.rpm;
    const n = R.length;
    const pick = k => (isArr(s[k]) && s[k].length >= n ? s[k] : null);
    const PW = pick('power_kW');
    const TQ = pick('torque_Nm');
    const VE = pick('volEff');
    const BO = pick('boost_bar');
    const KI = pick('knockIntegral');
    if (!PW && !TQ) {
      drawEmpty(g, W, H, t({ ru: 'В свипе нет ни мощности, ни момента',
                             en: 'Sweep has neither power nor torque' }));
      return null;
    }
    // нечего рисовать на второй панели — отдаём её место основной
    if (boxes.two && !VE && !BO) {
      boxes.main = { x: boxes.main.x, y: boxes.main.y, w: boxes.main.w,
        h: boxes.main.h + 24 + boxes.sub.h };
      boxes.two = false;
      boxes.sub = null;
    }

    const [r0, r1] = extent(R);
    const box = boxes.main;
    const sx = linScale(r0, r1, box.x, box.x + box.w);

    // ── левая ось: момент, правая: мощность ──
    const tqMax = TQ ? Math.max(1, extent(TQ)[1] * 1.12) : 1;
    const pwMax = PW ? Math.max(1, extent(PW)[1] * 1.12) : 1;
    const syT = linScale(0, tqMax, box.y + box.h, box.y);
    const syP = linScale(0, pwMax, box.y + box.h, box.y);
    const tickX = niceTicks(r0, r1, narrow() ? 3 : 5);
    drawGrid(g, box, sx, syT, tickX, niceTicks(0, tqMax, 4),
      boxes.two ? () => '' : v => v.toFixed(0), v => v.toFixed(0),
      boxes.two ? '' : t({ ru: 'обороты n, об/мин', en: 'speed n, rpm' }),
      t({ ru: 'момент M, Н·м', en: 'torque M, N·m' }));
    if (PW) {
      drawRightAxis(g, box, syP, niceTicks(0, pwMax, 4), v => v.toFixed(0), C.blue,
        box.h > 90 ? t({ ru: 'мощность, кВт', en: 'power, kW' }) : '');
    }

    // ── зона детонации ──
    if (KI) {
      g.save();
      g.fillStyle = 'rgba(239,68,68,.14)';
      let k0 = -1, labelled = false;
      for (let i = 0; i <= n; i++) {
        const on = i < n && num(KI[i]) && KI[i] >= 1;
        if (on && k0 < 0) k0 = i;
        if (!on && k0 >= 0) {
          const x0 = sx(R[k0]), x1 = sx(R[Math.max(k0, i - 1)]);
          if (num(x0) && num(x1)) {
            g.fillRect(x0, box.y, Math.max(x1 - x0, 2), box.h);
            if (!labelled && !narrow()) {
              labelled = true;
              tag(g, (x0 + x1) / 2, box.y + 12, t({ ru: 'детонация', en: 'knock' }), C.red, box);
            }
          }
          k0 = -1;
        }
      }
      g.restore();
    }

    if (TQ) polyline(g, R, TQ, sx, syT, 0, n - 1, C.orange, 2.0);
    if (PW) polyline(g, R, PW, sx, syP, 0, n - 1, C.blue, 2.0);

    // ── отметки максимумов ──
    const pkT = TQ ? peakOf(R, TQ) : null;
    const pkP = PW ? peakOf(R, PW) : null;
    if (pkT) {
      const x = sx(pkT.x), y = syT(pkT.y);
      dot(g, x, y, 3.4, C.orange, '#fff');
      if (!narrow()) {
        tag(g, x + 8, y + 12,
          t({ ru: `M max ${f(pkT.y, 1)} Н·м при ${Math.round(pkT.x)} об/мин`,
              en: `M max ${f(pkT.y, 1)} N·m at ${Math.round(pkT.x)} rpm` }), C.orange, box);
      }
    }
    if (pkP) {
      const x = sx(pkP.x), y = syP(pkP.y);
      dot(g, x, y, 3.4, C.blue, '#fff');
      if (!narrow()) {
        tag(g, x + 8, y - 11,
          t({ ru: `P max ${f(pkP.y, 1)} кВт при ${Math.round(pkP.x)} об/мин`,
              en: `P max ${f(pkP.y, 1)} kW at ${Math.round(pkP.x)} rpm` }), C.blue, box);
      }
    }

    // ── вторая панель: наполнение и наддув пунктиром ──
    let sub = null;
    if (boxes.two && (VE || BO)) {
      const sb = boxes.sub;
      // наполнение приводим к процентам (0…1 или сразу проценты — определяем по масштабу)
      let vePct = null;
      if (VE) {
        const mxv = extent(VE)[1];
        const k = mxv > 3 ? 1 : 100;
        vePct = new Float64Array(VE.length);
        for (let i = 0; i < VE.length; i++) vePct[i] = num(VE[i]) ? VE[i] * k : NaN;
      }
      const veMax = vePct ? Math.max(20, extent(vePct)[1] * 1.15) : 100;
      const syV = linScale(0, veMax, sb.y + sb.h, sb.y);
      drawGrid(g, sb, sx, syV, tickX, niceTicks(0, veMax, 3),
        v => v.toFixed(0), v => v.toFixed(0),
        t({ ru: 'обороты n, об/мин', en: 'speed n, rpm' }), 'ηv, %');
      const boMax = BO ? Math.max(0.2, extent(BO)[1] * 1.25) : 1;
      const syB = linScale(0, boMax, sb.y + sb.h, sb.y);
      if (vePct) polyline(g, R, vePct, sx, syV, 0, n - 1, C.blue, 1.7, [5, 3]);
      if (BO) {
        polyline(g, R, BO, sx, syB, 0, n - 1, C.purple, 1.7, [2, 3]);
        drawRightAxis(g, sb, syB, niceTicks(0, boMax, 3), v => v.toFixed(1), C.purple,
          sb.h > 70 ? t({ ru: 'наддув, бар', en: 'boost, bar' }) : '');
      }
      // резонансный горб наполнения — главное, ради чего этот график
      const pkV = vePct ? peakOf(R, vePct) : null;
      if (pkV) {
        const x = sx(pkV.x), y = syV(pkV.y);
        dot(g, x, y, 3.2, C.blue, '#fff');
        if (!narrow()) {
          const Lmm = num(par().intakeLen_mm) ? runnerText(par().intakeLen_mm, ', ') : '';
          tag(g, x + 8, y + 11,
            t({ ru: `резонансный горб: ηv ${f(pkV.y, 0)} % при ${Math.round(pkV.x)} об/мин${Lmm}`,
                en: `resonance peak: ηv ${f(pkV.y, 0)} % at ${Math.round(pkV.x)} rpm${Lmm}` }),
            C.blue, sb);
        }
      }
      sub = { box: sb, syV, syB, vePct, pkV };
    }

    // ── легенда и цифры в шапке ──
    const items = [];
    if (TQ) {
      items.push({ color: C.orange,
        text: t({ ru: 'момент, Н·м (левая ось)', en: 'torque, N·m (left axis)' }) });
    }
    if (PW) {
      items.push({ color: C.blue,
        text: t({ ru: 'мощность, кВт (правая ось)', en: 'power, kW (right axis)' }) });
    }
    if (sub && sub.vePct) {
      items.push({ color: C.blue, dash: [5, 3],
        text: t({ ru: 'коэф. наполнения, %', en: 'volumetric efficiency, %' }) });
    }
    if (sub && BO) {
      items.push({ color: C.purple, dash: [2, 3],
        text: t({ ru: 'наддув, бар', en: 'boost, bar' }) });
    }
    drawLegend(g, box.x + 4, (boxes.two ? boxes.sub : box).y + (boxes.two ? boxes.sub.h : box.h) + 46,
      items, box.w);

    const head2 = [];
    if (pkP) {
      head2.push(t({ ru: `P max ${f(pkP.y, 1)} кВт @ ${Math.round(pkP.x)}`,
                     en: `P max ${f(pkP.y, 1)} kW @ ${Math.round(pkP.x)}` }));
    }
    if (pkT) {
      head2.push(t({ ru: `M max ${f(pkT.y, 1)} Н·м @ ${Math.round(pkT.x)}`,
                     en: `M max ${f(pkT.y, 1)} N·m @ ${Math.round(pkT.x)}` }));
    }
    if (num(par().intakeLen_mm)) head2.push(runnerText(par().intakeLen_mm));
    headerRight(g, 1, head2.join('  ·  '));

    return { sx, syT, syP, sub, boxes, R, PW, TQ, VE: sub && sub.vePct, BO };
  }

  function sweepDynamic(g, sc) {
    if (!sc) return;
    const rpm = curRpm();
    if (!num(rpm)) return;
    const x = sc.sx(rpm);
    if (!num(x)) return;
    const inBox = x >= sc.boxes.main.x - 1 && x <= sc.boxes.main.x + sc.boxes.main.w + 1;
    if (!inBox) return;
    vline(g, sc.boxes.main, x);
    if (sc.sub) vline(g, sc.sub.box, x);
    const lines = [rpmText(rpm)];
    if (sc.TQ) {
      const v = interpAt(sc.R, sc.TQ, rpm);
      if (num(v)) {
        dot(g, x, sc.syT(v), 3.6, C.orange, '#fff');
        lines.push(t({ ru: `M = ${f(v, 1)} Н·м`, en: `M = ${f(v, 1)} N·m` }));
      }
    }
    if (sc.PW) {
      const v = interpAt(sc.R, sc.PW, rpm);
      if (num(v)) {
        dot(g, x, sc.syP(v), 3.6, C.blue, '#fff');
        lines.push(t({ ru: `P = ${f(v, 1)} кВт`, en: `P = ${f(v, 1)} kW` }));
      }
    }
    if (sc.sub && sc.VE) {
      const v = interpAt(sc.R, sc.VE, rpm);
      if (num(v)) { dot(g, x, sc.sub.syV(v), 3.2, C.blue, '#fff'); lines.push(`ηv = ${f(v, 0)} %`); }
    }
    if (sc.sub && sc.BO) {
      const v = interpAt(sc.R, sc.BO, rpm);
      if (num(v)) {
        dot(g, x, sc.sub.syB(v), 3.2, C.purple, '#fff');
        lines.push(t({ ru: `наддув ${f(v, 2)} бар`, en: `boost ${f(v, 2)} bar` }));
      }
    }
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) drawReadout(g, sc.boxes.main, lines, 'left');
  }

  /* ══════════ 7. Уравновешенность компоновки ══════════ */

  function balanceStatic(g, W, H) {
    const c = cyc();
    const m = met();
    const bal = m && m.balance && typeof m.balance === 'object' ? m.balance : null;
    const SXa = c && isArr(c.shakeX_N) ? c.shakeX_N : null;
    const SYa = c && isArr(c.shakeY_N) ? c.shakeY_N : null;
    if (!SXa && !SYa && !bal) {
      drawEmpty(g, W, H, t({
        ru: 'Данных уравновешенности нет: engine.cycle.shakeX_N / engine.metrics.balance',
        en: 'No balance data: engine.cycle.shakeX_N / engine.metrics.balance' }));
      return null;
    }

    const left = 54, right = 16, top = 36;
    const bw = W - left - right;
    if (bw < 80 || H < 120) { drawEmpty(g, W, H, t({ ru: 'Мало места для графика', en: 'Not enough space for the chart' })); return null; }

    // ── что показываем в столбиках ──
    const rows = [];
    if (bal) {
      const uN = t({ ru: 'Н', en: 'N' });
      if (num(bal.primary_N)) {
        rows.push({ v: bal.primary_N, u: uN, color: C.orange,
          name: t({ ru: '1-й порядок (частота = обороты)',
                    en: 'first order (frequency = crank speed)' }) });
      }
      if (num(bal.secondary_N)) {
        rows.push({ v: bal.secondary_N, u: uN, color: C.purple,
          name: t({ ru: '2-й порядок (2× обороты)', en: 'second order (2× crank speed)' }) });
      }
      if (num(bal.couple_Nm)) {
        rows.push({ v: bal.couple_Nm, u: t({ ru: 'Н·м', en: 'N·m' }), color: C.blue,
          name: t({ ru: 'продольный момент', en: 'longitudinal couple' }) });
      }
    }
    // вердикт приходит из physics.js: сейчас это пара { ru, en }, но t() терпит и строку
    const verdictRaw = bal ? t(bal.verdict) : '';
    const verdict = typeof verdictRaw === 'string' ? verdictRaw.trim() : '';

    g.save();
    g.font = font(10.5);
    const vLines = verdict ? wrapText(g, verdict, bw - 4) : [];
    g.restore();

    const barsH = rows.length ? (16 + rows.length * 26 + 14 + vLines.length * 14) : (vLines.length * 14 + 8);
    const haveCurves = !!(SXa || SYa);
    let curveBox = null, barsY = top;
    if (haveCurves) {
      const ch = H - top - 52 - barsH - (barsH ? 18 : 0);
      if (ch >= 56) {
        curveBox = { x: left, y: top, w: bw, h: ch };
        barsY = top + ch + 52 + 18;
      }
    }
    if (!curveBox) barsY = top + 4;

    const span = cycSpan();

    // ── кривые суммарных неуравновешенных сил ──
    if (curveBox) {
      let a = 0;
      for (const arr of [SXa, SYa]) {
        if (!arr) continue;
        const [q0, q1] = extent(arr);
        a = Math.max(a, Math.abs(q0), Math.abs(q1));
      }
      a = a * 1.15 || 1;
      const sx = linScale(0, span, curveBox.x, curveBox.x + curveBox.w);
      const sy = linScale(-a, a, curveBox.y + curveBox.h, curveBox.y);
      drawGrid(g, curveBox, sx, sy, angleTicks(), niceTicks(-a, a, 4),
        v => v.toFixed(0),
        v => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0)),
        angleAxisLabel(span), t({ ru: 'сила инерции, Н', en: 'inertia force, N' }));
      dashedH(g, curveBox, sy(0), C.axis, [2, 3]);
      const D = isArr(c.deg) ? c.deg : null;
      const mkX = arr => {
        if (D && D.length === arr.length) return D;
        const out = new Float64Array(arr.length);
        const stp = span / (arr.length - 1);
        for (let i = 0; i < arr.length; i++) out[i] = i * stp;
        return out;
      };
      if (SXa) polyline(g, mkX(SXa), SXa, sx, sy, 0, SXa.length - 1, C.blue, 1.8);
      if (SYa) polyline(g, mkX(SYa), SYa, sx, sy, 0, SYa.length - 1, C.orange, 1.9);
      // пики
      const nmV = t({ ru: 'вертикальная', en: 'vertical' });
      const nmH = t({ ru: 'горизонтальная', en: 'horizontal' });
      for (const [arr, col, nm] of [[SYa, C.orange, nmV], [SXa, C.blue, nmH]]) {
        if (!arr || narrow()) continue;
        const i = argMaxAbs(arr);
        const stp = span / (arr.length - 1);
        const x = sx(i * stp), y = sy(arr[i]);
        dot(g, x, y, 3, col);
        tag(g, x + 7, y + (arr === SYa ? -10 : 10),
          t({ ru: `${nm}: макс |F| = ${f(Math.abs(arr[i]), 0)} Н`,
              en: `${nm}: max |F| = ${f(Math.abs(arr[i]), 0)} N` }), col, curveBox);
      }
      drawLegend(g, curveBox.x + 4, curveBox.y + curveBox.h + 46, [
        SYa ? { color: C.orange, text: t({ ru: 'F вертикальная (вдоль цилиндра)',
                                           en: 'F vertical (along the cylinder)' }) } : null,
        SXa ? { color: C.blue, text: t({ ru: 'F горизонтальная', en: 'F horizontal' }) } : null,
      ].filter(Boolean), curveBox.w);
    }

    // ── столбики амплитуд ──
    let y = barsY;
    if (rows.length && y + 40 < H) {
      const mxAbs = rows.reduce((s2, r) => Math.max(s2, Math.abs(r.v)), 0) || 1;
      g.save();
      g.font = font(10.5, '600');
      g.fillStyle = C.text;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(t({ ru: 'Амплитуды неуравновешенных сил и момента',
                     en: 'Amplitudes of unbalanced forces and couple' }), left, y);
      g.restore();
      y += 14;

      const nameW = clamp(bw * 0.42, 70, 190);
      const valW = clamp(bw * 0.22, 52, 96);
      const trackW = Math.max(12, bw - nameW - valW - 10);
      for (const r of rows) {
        if (y + 22 > H - 2) break;
        const len = Math.max(1.5, (Math.abs(r.v) / mxAbs) * trackW);
        g.save();
        g.font = font(10.5);
        g.textBaseline = 'middle';
        g.fillStyle = C.text;
        g.textAlign = 'left';
        g.fillText(r.name, left, y + 9);
        // дорожка и столбик
        g.fillStyle = 'rgba(255,255,255,.05)';
        g.fillRect(left + nameW, y + 2, trackW, 14);
        g.fillStyle = r.color;
        g.fillRect(left + nameW, y + 2, len, 14);
        g.fillStyle = 'rgba(255,255,255,.10)';
        g.fillRect(left + nameW, y + 2, len, 5);
        g.fillStyle = C.bright;
        g.textAlign = 'right';
        g.fillText(`${f(Math.abs(r.v), Math.abs(r.v) < 10 ? 1 : 0)} ${r.u}`, left + bw, y + 9);
        g.restore();
        y += 26;
      }
      g.save();
      g.font = font(9.5);
      g.fillStyle = C.text;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      if (y + 10 < H) {
        g.fillText(t({ ru: 'длина столбика — доля от наибольшего из трёх (единицы разные)',
                       en: 'bar length is the share of the largest of the three (units differ)' }),
          left, y + 8);
      }
      g.restore();
      y += 16;
    }

    // ── короткий вывод ──
    if (vLines.length && y + 12 < H) {
      g.save();
      g.font = font(10.5);
      g.fillStyle = C.green;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      for (const ln of vLines) {
        if (y + 12 > H - 2) break;
        y += 13;
        g.fillText(ln, left, y);
      }
      g.restore();
    }

    const lay = layoutName();
    if (lay) headerRight(g, 1, t({ ru: `компоновка: ${lay}`, en: `layout: ${lay}` }));
    return null;
  }

  /* ══════════ 8. Карта режимов «обороты × нагрузка» ══════════ */

  /** Описание выбранной величины (переключатель под заголовком). */
  const mapMetric = () =>
    MAP_METRICS.find(m => m.key === st.mapMetric) || MAP_METRICS[0];

  /**
   * Карта режимов с кэшем: mapRpmLoad() стоит до полутора секунд, поэтому
   * считается ровно один раз на setEngine/invalidate, а не каждый кадр.
   * Маркер текущей точки живёт в динамическом слое и пересчёта не требует.
   */
  function getMap() {
    const e = st.engine;
    if (!e || typeof e.mapRpmLoad !== 'function') return null;
    if (st.map) return st.map;
    if (st.mapFail || st.mapEmpty) return null;   // повторно не дёргаем сломанный метод
    const t0 = nowMs();
    let s = null;
    try {
      s = e.mapRpmLoad(Object.assign({}, MAP_GRID));
    } catch (err) {
      st.mapFail = true;
      st.mapMs = nowMs() - t0;
      if (!st.mapWarned && typeof console !== 'undefined' && console.warn) {
        st.mapWarned = true;
        console.warn('[charts] engine.mapRpmLoad() бросил исключение:', err);
      }
      return null;
    }
    st.mapMs = nowMs() - t0;
    // пустой ответ — не ошибка метода: сообщение другое, но переспрашивать тоже не будем
    if (!s || !isArr(s.rpm) || !isArr(s.load)) { st.mapEmpty = true; return null; }
    st.map = s;
    return s;
  }

  /** Текущая нагрузка 0…1: кадр, затем params.throttle (терпит и проценты). */
  function curLoad() {
    const p = par();
    const pick = [st.frame && st.frame.throttle, p.throttle,
      st.frame && st.frame.load, p.load];
    for (const v of pick) {
      if (!num(v) || v < 0) continue;
      return clamp(v > 1.5 ? v / 100 : v, 0, 1);
    }
    return NaN;
  }

  /**
   * Значения выбранной величины в единицах подписи (КПД — в процентах).
   * Ноль и отрицательные у «чем меньше, тем лучше» — это не рекордная экономичность,
   * а отсутствие данных: на нулевой нагрузке двигатель не отдаёт мощности и
   * удельный расход не определён. Такие клетки помечаются NaN и красятся серым.
   */
  function mapValues(s, m) {
    const need = s.rpm.length * s.load.length;
    const src = s[m.field];
    if (!isArr(src) || src.length < need) return null;
    let k = 1;
    if (m.pct) {
      const [, mx] = extent(src);
      k = num(mx) && mx > 1.5 ? 1 : 100;          // уже проценты или ещё доли
    }
    if (k === 1 && !m.lowIsGood) return src;
    const out = new Float64Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      out[i] = num(v) && (!m.lowIsGood || v > 0) ? v * k : NaN;
    }
    return out;
  }

  /** Дробный индекс значения в возрастающей сетке (вне сетки — NaN). */
  function gridPos(arr, v) {
    const n = arr.length;
    if (!num(v) || n < 2) return NaN;
    if (v < arr[0] || v > arr[n - 1]) return NaN;
    for (let i = 1; i < n; i++) {
      if (!num(arr[i]) || !num(arr[i - 1])) continue;
      if (v <= arr[i]) {
        const d = arr[i] - arr[i - 1];
        return (i - 1) + (d ? (v - arr[i - 1]) / d : 0);
      }
    }
    return n - 1;
  }

  /** Билинейная выборка из сетки rpmSteps×loadSteps по дробным индексам. */
  function gridSample(V, nL, fi, fj) {
    if (!V || !num(fi) || !num(fj)) return NaN;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const i1 = i0 + 1, j1 = j0 + 1;
    const at = (i, j) => {
      const v = V[i * nL + j];
      return num(v) ? v : NaN;
    };
    const nR = V.length / nL;
    const ci = clamp(i0, 0, nR - 1), cj = clamp(j0, 0, nL - 1);
    const di = clamp(i1, 0, nR - 1), dj = clamp(j1, 0, nL - 1);
    const v00 = at(ci, cj), v10 = at(di, cj), v01 = at(ci, dj), v11 = at(di, dj);
    const ki = clamp(fi - i0, 0, 1), kj = clamp(fj - j0, 0, 1);
    if (num(v00) && num(v10) && num(v01) && num(v11)) {
      return (v00 * (1 - ki) + v10 * ki) * (1 - kj) + (v01 * (1 - ki) + v11 * ki) * kj;
    }
    for (const v of [v00, v10, v01, v11]) if (num(v)) return v;   // дырка в данных — ближайшее
    return NaN;
  }

  /** Границы клеток по сетке узлов (значения домена, длина n+1). */
  function cellEdges(arr) {
    const n = arr.length;
    const out = new Float64Array(n + 1);
    for (let i = 1; i < n; i++) out[i] = (arr[i - 1] + arr[i]) / 2;
    out[0] = arr[0] - (num(out[1]) ? out[1] - arr[0] : 0.5);
    out[n] = arr[n - 1] + (num(out[n - 1]) ? arr[n - 1] - out[n - 1] : 0.5);
    return out;
  }

  /** Кнопки переключения величины: рисуются на холсте, клики ловит canvas. */
  let mapBtns = [];

  function drawMapButtons(g, xRight, y, maxW) {
    mapBtns = [];
    g.save();
    g.font = font(10);
    const h = 17, gap = 5;
    const items = MAP_METRICS.map(m => {
      const text = t(m.btn);
      return { key: m.key, text, w: g.measureText(text).width + 14 };
    });
    let total = -gap;
    for (const it of items) total += it.w + gap;
    if (!num(maxW) || total > maxW) { g.restore(); return false; }
    let x = xRight - total;
    for (const it of items) {
      const on = it.key === st.mapMetric;
      roundRect(g, x, y, it.w, h, 5);
      g.fillStyle = on ? 'rgba(88,166,255,.18)' : 'rgba(255,255,255,.04)';
      g.fill();
      g.strokeStyle = on ? C.blue : C.grid;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = on ? C.blue : C.text;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(it.text, x + it.w / 2, y + h / 2 + 0.5);
      mapBtns.push({ key: it.key, x, y, w: it.w, h });
      x += it.w + gap;
    }
    g.restore();
    return true;
  }

  /** Вертикальная цветовая шкала с делениями и единицами. */
  function drawColorBar(g, x, y, w, h, v0, v1, fmt, unit, clipped) {
    const N = 36;
    g.save();
    for (let i = 0; i < N; i++) {
      g.fillStyle = rampColor(i / (N - 1));
      g.fillRect(x, y + h - (i + 1) * (h / N), w, h / N + 0.8);
    }
    g.strokeStyle = C.axis;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w, h);
    g.font = font(9.5);
    g.fillStyle = C.text;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const ticks = niceTicks(v0, v1, h > 150 ? 5 : 3);
    for (const tv of ticks) {
      const k = (tv - v0) / ((v1 - v0) || 1);
      if (k < -0.02 || k > 1.02) continue;
      if (clipped && k > 0.88) continue;                 // место занято подписью «≥»
      const ty = y + h - clamp(k, 0, 1) * h;
      g.strokeStyle = 'rgba(230,237,243,.45)';
      g.beginPath();
      g.moveTo(x + w, ty);
      g.lineTo(x + w + 3, ty);
      g.stroke();
      g.fillText(fmt(tv), x + w + 5, ty);
    }
    if (clipped) {
      // верх шкалы обрезан: крайним цветом покрашено всё, что выше
      g.fillStyle = C.bright;
      g.fillText(`≥ ${fmt(v1)}`, x + w + 5, y + 5);
    }
    if (unit) {
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      g.fillStyle = C.text;
      g.fillText(unit, Math.min(st.W - 4, x + w + 46), y - 5);
    }
    g.restore();
  }

  function mapStatic(g, W, H) {
    if (!st.engine || typeof st.engine.mapRpmLoad !== 'function') {
      drawEmpty(g, W, H, t({
        ru: 'Карта режимов недоступна: движок не умеет mapRpmLoad()',
        en: 'Engine map unavailable: engine has no mapRpmLoad()' }));
      return null;
    }
    const s = getMap();
    if (!s) {
      drawEmpty(g, W, H, st.mapFail
        ? t({ ru: 'Карта не построена: engine.mapRpmLoad() вернул ошибку',
              en: 'Map failed: engine.mapRpmLoad() returned an error' })
        : t({ ru: 'Карта режимов пуста', en: 'Engine map returned no data' }));
      return null;
    }
    const R = s.rpm, L = s.load, nR = R.length, nL = L.length;
    const m = mapMetric();
    const V = mapValues(s, m);
    if (!V) {
      drawEmpty(g, W, H, t({
        ru: `В карте нет величины «${t(m.name)}»`,
        en: `The map has no “${t(m.name)}” field` }));
      return null;
    }
    const rng = colorRange(V, m.lowIsGood);
    if (!rng) {
      drawEmpty(g, W, H, t({ ru: 'В карте нет ни одного числового значения',
                             en: 'The map contains no numeric values' }));
      return null;
    }
    const v0 = rng.lo, v1 = rng.hi;

    // ── геометрия: поле, строка кнопок, цветовая шкала ──
    const left = 54;
    const cbW = 11, cbGap = 11, cbLab = narrow() ? 30 : 46;
    const right = cbW + cbGap + cbLab;
    const bottom = narrow() ? 88 : 72;
    const btnY = 36, btnH = 17;
    const box = {
      x: left, y: btnY + btnH + 7, w: W - left - right,
      h: H - (btnY + btnH + 7) - bottom,
    };
    if (box.w < 90 || box.h < 60) {
      drawEmpty(g, W, H, t({ ru: 'Мало места для карты режимов',
                             en: 'Not enough space for the engine map' }));
      return null;
    }
    drawMapButtons(g, box.x + box.w, btnY, box.w);

    const exR = cellEdges(R), exL = cellEdges(L);
    const [r0, r1] = extent(exR);
    const [l0, l1] = extent(exL);
    const sx = linScale(r0, r1, box.x, box.x + box.w);
    const sy = linScale(l0 * 100, l1 * 100, box.y + box.h, box.y);

    // ── клетки тепловой карты ──
    const idx = (i, j) => i * nL + j;
    let blankCells = 0;
    for (let i = 0; i < nR; i++) {
      const x0 = sx(exR[i]), x1 = sx(exR[i + 1]);
      if (!num(x0) || !num(x1)) continue;
      for (let j = 0; j < nL; j++) {
        const y0 = sy(exL[j] * 100), y1 = sy(exL[j + 1] * 100);
        if (!num(y0) || !num(y1)) continue;
        const v = V[idx(i, j)];
        if (!num(v)) blankCells++;
        g.fillStyle = rampColor(num(v) ? (v - v0) / (v1 - v0) : NaN);
        g.fillRect(Math.min(x0, x1), Math.min(y0, y1),
          Math.abs(x1 - x0) + 0.7, Math.abs(y1 - y0) + 0.7);
      }
    }

    // ── зона детонации: штриховка поверх клеток ──
    const KI = isArr(s.knockIntegral) && s.knockIntegral.length >= nR * nL
      ? s.knockIntegral : null;
    let knockCells = 0, knockSx = 0, knockSy = 0;
    if (KI) {
      g.save();
      g.beginPath();
      for (let i = 0; i < nR; i++) {
        const x0 = sx(exR[i]), x1 = sx(exR[i + 1]);
        if (!num(x0) || !num(x1)) continue;
        for (let j = 0; j < nL; j++) {
          const k = KI[idx(i, j)];
          if (!num(k) || k < 1) continue;
          const y0 = sy(exL[j] * 100), y1 = sy(exL[j + 1] * 100);
          if (!num(y0) || !num(y1)) continue;
          g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          knockCells++;
          knockSx += (x0 + x1) / 2;
          knockSy += (y0 + y1) / 2;
        }
      }
      if (knockCells) {
        g.clip();
        // затемняем и штрихуем: красная заливка потерялась бы на «горячих» клетках
        g.fillStyle = 'rgba(13,17,23,.30)';
        g.fillRect(box.x, box.y, box.w, box.h);
        g.strokeStyle = 'rgba(255,110,110,.9)';
        g.lineWidth = 1;
        g.beginPath();
        for (let d = -Math.ceil(box.h); d < box.w; d += 6) {
          g.moveTo(box.x + d, box.y + box.h);
          g.lineTo(box.x + d + box.h, box.y);
        }
        g.stroke();
      }
      g.restore();
    }

    // ── изолинии выбранной величины ──
    const get = (i, j) => {
      const v = V[idx(i, j)];
      return num(v) ? v : NaN;
    };
    const gx = fi => {
      const i0 = clamp(Math.floor(fi), 0, nR - 1), i1 = clamp(i0 + 1, 0, nR - 1);
      const a = R[i0], b = R[i1];
      if (!num(a)) return NaN;
      return sx(num(b) ? a + (b - a) * (fi - i0) : a);
    };
    const gy = fj => {
      const j0 = clamp(Math.floor(fj), 0, nL - 1), j1 = clamp(j0 + 1, 0, nL - 1);
      const a = L[j0], b = L[j1];
      if (!num(a)) return NaN;
      return sy((num(b) ? a + (b - a) * (fj - j0) : a) * 100);
    };
    const levels = niceTicks(v0, v1, narrow() ? 3 : 6)
      .filter(v => v > v0 + (v1 - v0) * 0.04 && v < v1 - (v1 - v0) * 0.04);
    g.save();
    g.strokeStyle = 'rgba(15,20,26,.55)';
    g.lineWidth = 1.1;
    const labelSpots = [];
    for (const lv of levels) {
      const segs = contourSegments(get, nR, nL, lv);
      if (!segs.length) continue;
      g.beginPath();
      let bestSeg = null;
      for (const sg of segs) {
        const ax = gx(sg[0]), ay = gy(sg[1]), bx = gx(sg[2]), by = gy(sg[3]);
        if (!num(ax) || !num(ay) || !num(bx) || !num(by)) continue;
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        if (!bestSeg || ay < bestSeg.y) bestSeg = { x: ax, y: ay };
      }
      g.stroke();
      if (bestSeg) labelSpots.push({ v: lv, x: bestSeg.x, y: bestSeg.y });
    }
    g.restore();
    if (!narrow() && box.h > 110) {
      g.save();
      g.font = font(9.5);
      g.fillStyle = 'rgba(230,237,243,.85)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const sp of labelSpots) {
        const x = clamp(sp.x, box.x + 14, box.x + box.w - 14);
        const y = clamp(sp.y + 7, box.y + 7, box.y + box.h - 7);
        g.fillText(f(sp.v, m.digits), x, y);
      }
      g.restore();
    }

    // ── сетка и оси поверх заливки ──
    drawGrid(g, box, sx, sy, niceTicks(r0, r1, narrow() ? 3 : 5), niceTicks(0, 100, 5),
      v => v.toFixed(0), v => v.toFixed(0),
      t({ ru: 'обороты n, об/мин', en: 'speed n, rpm' }),
      t({ ru: 'нагрузка, %', en: 'load, %' }));

    drawColorBar(g, box.x + box.w + cbGap, box.y, cbW, box.h, v0, v1,
      v => f(v, m.digits), t(m.unit), rng.clipped);

    // ── остров экономичности ──
    const best = bestPoint(s);
    if (best) {
      const bx = sx(best.rpm), by = sy(best.load * 100);
      if (num(bx) && num(by)) {
        // тёмная подложка + белое кольцо: отметка видна на любом цвете заливки
        g.save();
        g.strokeStyle = 'rgba(13,17,23,.85)';
        g.lineWidth = 3.6;
        g.beginPath();
        g.arc(bx, by, 7, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = '#fff';
        g.lineWidth = 1.6;
        g.beginPath();
        g.arc(bx, by, 7, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();                                   // перекрестье внутри кольца
        g.moveTo(bx - 4, by); g.lineTo(bx + 4, by);
        g.moveTo(bx, by - 4); g.lineTo(bx, by + 4);
        g.lineWidth = 1.1;
        g.stroke();
        g.restore();
        dot(g, bx, by, 3.4, C.green, '#0d1117');
        if (!narrow()) {
          tag(g, bx + 10, by - 12,
            t({ ru: `остров экономичности: ${f(best.bsfc, 0)} г/(кВт·ч)`,
                en: `economy island: ${f(best.bsfc, 0)} g/(kW·h)` }), C.green, box);
        }
      }
    }
    if (knockCells && !narrow()) {
      tag(g, knockSx / knockCells, knockSy / knockCells,
        t({ ru: 'детонация', en: 'knock' }), C.red, box);
    }

    // ── легенда и цифры в шапке (в тесноте — короткие подписи) ──
    const tight = narrow();
    const items = [
      { color: 'rgba(15,20,26,.85)',
        text: tight
          ? t({ ru: `изолинии, ${t(m.unit)}`, en: `contours, ${t(m.unit)}` })
          : t({ ru: `изолинии: ${t(m.name)}, ${t(m.unit)}`,
                en: `contours: ${t(m.name)}, ${t(m.unit)}` }) },
    ];
    if (knockCells) {
      items.push({ color: C.red,
        text: tight ? t({ ru: 'детонация', en: 'knock' })
                    : t({ ru: 'зона детонации (интеграл ≥ 1)', en: 'knock zone (integral ≥ 1)' }) });
    }
    if (best) {
      items.push({ color: C.green,
        text: tight ? t({ ru: 'мин. расход', en: 'min fuel' })
                    : t({ ru: 'минимальный расход', en: 'minimum fuel consumption' }) });
    }
    items.push({ color: '#fff',
      text: tight ? t({ ru: 'режим', en: 'operating point' })
                  : t({ ru: 'текущий режим', en: 'current operating point' }) });
    if (blankCells && !tight) {
      items.push({ color: 'rgba(120,132,146,.7)',
        text: t({ ru: 'нет данных: величина не определена',
                  en: 'no data: the value is not defined' }) });
    }
    if (rng.clipped && !tight) {
      items.push({ color: rampColor(1),
        text: t({ ru: `вне диапазона шкалы: > ${f(v1, m.digits)} (максимум ${f(rng.mx, m.digits)})`,
                  en: `off scale: > ${f(v1, m.digits)} (maximum ${f(rng.mx, m.digits)})` }) });
    }
    drawLegend(g, box.x + 4, box.y + box.h + 46, items, box.w + right - 4);

    const headBits = [];
    if (best) {
      headBits.push(t({
        ru: `min ${f(best.bsfc, 0)} г/(кВт·ч) при ${Math.round(best.rpm)} об/мин и нагрузке ${f(best.load * 100, 0)} %`,
        en: `min ${f(best.bsfc, 0)} g/(kW·h) at ${Math.round(best.rpm)} rpm, load ${f(best.load * 100, 0)} %` }));
    }
    if (!headerRight(g, 1, headBits.join('  ·  '))) {
      headerRight(g, 1, t({ ru: `сетка ${nR}×${nL}`, en: `grid ${nR}×${nL}` }));
    }

    return { box, sx, sy, R, L, nR, nL, V, KI, m, v0, v1, idx };
  }

  /** Точка минимального расхода: из best движка либо поиском по сетке. */
  function bestPoint(s) {
    const b = s.best;
    if (b && num(b.rpm) && num(b.load)) {
      return { rpm: b.rpm, load: b.load,
        bsfc: num(b.bsfc_g_kWh) ? b.bsfc_g_kWh : NaN };
    }
    const B = s.bsfc_g_kWh;
    const nR = s.rpm.length, nL = s.load.length;
    if (!isArr(B) || B.length < nR * nL) return null;
    let bi = -1, bv = Infinity;
    for (let i = 0; i < nR * nL; i++) {
      if (num(B[i]) && B[i] > 0 && B[i] < bv) { bv = B[i]; bi = i; }
    }
    if (bi < 0) return null;
    const r = s.rpm[Math.floor(bi / nL)], l = s.load[bi % nL];
    return num(r) && num(l) ? { rpm: r, load: l, bsfc: bv } : null;
  }

  /** Маркер текущего режима: только выборка из готовой сетки, без пересчёта карты. */
  function mapDynamic(g, sc) {
    if (!sc) return;
    const rpm = curRpm(), load = curLoad();
    const lines = [];
    const fi = gridPos(sc.R, rpm);
    const fj = gridPos(sc.L, load);
    if (!num(fi) || !num(fj)) {
      const why = t({ ru: 'текущий режим вне диапазона карты',
                      en: 'current point is outside the map range' });
      if (!headerRight(g, 2, why, C.yellow)) drawReadout(g, sc.box, [why], 'left');
      return;
    }
    const x = sc.sx(rpm), y = sc.sy(load * 100);
    if (!num(x) || !num(y)) return;
    // перекрестье рисуется дважды: тёмная подложка снизу, белый пунктир поверх —
    // иначе на жёлтых и красных клетках карты маркер теряется
    g.save();
    const cross = () => {
      g.beginPath();
      g.moveTo(sc.box.x, y);
      g.lineTo(sc.box.x + sc.box.w, y);
      g.moveTo(x, sc.box.y);
      g.lineTo(x, sc.box.y + sc.box.h);
      g.stroke();
    };
    g.strokeStyle = 'rgba(13,17,23,.75)';
    g.lineWidth = 3;
    cross();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.2;
    g.setLineDash([3, 3]);
    cross();
    g.restore();
    dot(g, x, y, 4.2, '#fff', '#0d1117');

    lines.push(rpmText(rpm));
    lines.push(t({ ru: `нагрузка ${f(load * 100, 0)} %`, en: `load ${f(load * 100, 0)} %` }));
    const v = gridSample(sc.V, sc.nL, fi, fj);
    if (num(v)) lines.push(`${t(sc.m.name)}: ${f(v, sc.m.digits)} ${t(sc.m.unit)}`);
    if (sc.KI) {
      const k = gridSample(sc.KI, sc.nL, fi, fj);
      if (num(k) && k >= 1) lines.push(t({ ru: 'детонация', en: 'knock' }));
    }
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) {
      drawReadout(g, sc.box, lines, 'left');
    }
  }

  /* ══════════ конвейер отрисовки ══════════ */

  let scales = null;      // геометрия активного графика (для динамического слоя)
  let curBox = null;

  /** Узкая панель: часть подписей приходится опускать. */
  const narrow = () => st.W < 400;

  function boxFor(W, H) {
    const bottom = narrow() ? 90 : 74;          // деления, подпись оси и легенда
    return { x: 54, y: 34, w: Math.max(10, W - 54 - 14), h: Math.max(10, H - 34 - bottom) };
  }

  function drawStatic() {
    if (!bgCtx) return;
    scales = null;
    curBox = null;
    const { W, H, dpr } = st;
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCtx.clearRect(0, 0, W, H);
    bgCtx.textBaseline = 'alphabetic';

    const c = cyc();
    if (!st.engine) {
      drawEmpty(bgCtx, W, H, t({ ru: 'Двигатель не подключён', en: 'No engine connected' }));
      return;
    }
    // таблицы цикла нужны не всем графикам: свип берёт данные из sweepRpm(),
    // а баланс может показать хотя бы столбики из metrics.balance
    const NEEDS_CYCLE = st.active === 'pv' || st.active === 'torque' ||
      st.active === 'kinematics' || st.active === 'valves';
    if (NEEDS_CYCLE && (!c || !isArr(c.deg))) {
      drawEmpty(bgCtx, W, H, t({ ru: 'Нет таблиц цикла (engine.cycle)',
                                 en: 'No cycle tables (engine.cycle)' }));
      return;
    }
    if (W < 180 || H < 120) { drawEmpty(bgCtx, W, H, t({ ru: 'Мало места для графика', en: 'Not enough space for the chart' })); return; }

    try {
      switch (st.active) {
        case 'pv': {
          if (!isArr(c.V_cm3) || !isArr(c.p_bar)) {
            drawEmpty(bgCtx, W, H, t({ ru: 'Нет данных p–V', en: 'No p–V data' })); break;
          }
          drawTitle(bgCtx,
            t({ ru: 'Индикаторная диаграмма p–V', en: 'Indicator diagram (p–V)' }),
            t({ ru: 'площадь петли — работа за цикл', en: 'loop area is the work per cycle' }) +
            (st.log ? t({ ru: ' · логарифмические оси', en: ' · logarithmic axes' }) : ''));
          curBox = boxFor(W, H);
          scales = pvStatic(bgCtx, curBox);
          break;
        }
        case 'torque': {
          if (!isArr(c.torque_Nm) && !isArr(c.torqueTotal_Nm)) {
            drawEmpty(bgCtx, W, H, t({ ru: 'Нет данных момента', en: 'No torque data' })); break;
          }
          drawTitle(bgCtx, t({ ru: 'Момент на коленчатом валу', en: 'Crankshaft torque' }),
            t({ ru: 'отрицательные участки — затраты на сжатие и газообмен',
                en: 'negative regions are the cost of compression and gas exchange' }));
          curBox = boxFor(W, H);
          scales = torqueStatic(bgCtx, curBox);
          break;
        }
        case 'kinematics': {
          scales = kinStatic(bgCtx, W, H);
          drawTitle(bgCtx, t({ ru: 'Кинематика поршня', en: 'Piston kinematics' }),
            (scales && scales.note) || '');
          break;
        }
        case 'valves': {
          if (!isArr(c.liftIn) && !isArr(c.liftEx) && !isArr(c.xb)) {
            drawEmpty(bgCtx, W, H, t({ ru: 'Нет данных фаз газораспределения',
                                       en: 'No valve timing data' })); break;
          }
          drawTitle(bgCtx, t({ ru: 'Диаграмма фаз газораспределения', en: 'Valve timing diagram' }),
            t({ ru: 'подъём клапанов, тепловыделение по Вибе и перекрытие',
                en: 'valve lift, Wiebe heat release and overlap' }));
          curBox = boxFor(W, H);
          scales = valvesStatic(bgCtx, curBox);
          break;
        }
        case 'energy':
          energyStatic(bgCtx, W, H);
          break;
        case 'sweep': {
          const two = twoStroke();
          drawTitle(bgCtx,
            t({ ru: 'Внешняя скоростная характеристика', en: 'Full-load speed curve' }),
            two ? t({ ru: 'мощность и момент по оборотам, двухтактный',
                      en: 'power and torque versus speed, two-stroke' })
                : t({ ru: 'мощность и момент по оборотам; пунктиром — наполнение и наддув',
                      en: 'power and torque versus speed; dashed — volumetric efficiency and boost' }));
          scales = sweepStatic(bgCtx, W, H);
          break;
        }
        case 'balance': {
          drawTitle(bgCtx, t({ ru: 'Уравновешенность компоновки', en: 'Balance of the layout' }),
            t({ ru: 'неуравновешенные силы инерции и амплитуды первого и второго порядка',
                en: 'unbalanced inertia forces and first/second order amplitudes' }));
          scales = balanceStatic(bgCtx, W, H);
          break;
        }
        case 'map': {
          const m = mapMetric();
          drawTitle(bgCtx, t({ ru: 'Карта режимов двигателя', en: 'Engine operating map' }),
            `${t(m.name)}, ${t(m.unit)}` + (narrow() ? '' : ' · ' +
              t({ ru: 'обороты × нагрузка, изолинии и зона детонации',
                  en: 'speed × load, contours and knock zone' })));
          scales = mapStatic(bgCtx, W, H);
          break;
        }
      }
    } catch (err) {
      // график не должен ронять приложение
      bgCtx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      drawEmpty(bgCtx, W, H, t({ ru: 'Ошибка отрисовки графика', en: 'Chart rendering error' }));
      if (typeof console !== 'undefined') console.error('[charts]', err);
    }
  }

  function drawDynamic(g) {
    if (!st.frame) return;
    try {
      switch (st.active) {
        case 'pv': pvDynamic(g, curBox, scales); break;
        case 'torque': torqueDynamic(g, curBox, scales); break;
        case 'kinematics': kinDynamic(g, scales); break;
        case 'valves': valvesDynamic(g, curBox, scales); break;
        case 'sweep': sweepDynamic(g, scales); break;
        case 'map': mapDynamic(g, scales); break;
        case 'energy': case 'balance': break;
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[charts]', err);
    }
  }

  function render() {
    if (!ctx || st.disposed || !st.W || !st.H) return;
    if (st.staticDirty) { drawStatic(); st.staticDirty = false; }
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.W, st.H);
    if (bgCanvas.width && bgCanvas.height) ctx.drawImage(bgCanvas, 0, 0, st.W, st.H);
    drawDynamic(ctx);
  }

  function measure() {
    const w = holder.clientWidth || root.clientWidth || 360;
    const h = holder.clientHeight || (root.clientHeight ? root.clientHeight - 32 : 0) || 260;
    return [Math.max(120, Math.floor(w)), Math.max(90, Math.floor(h))];
  }

  function resize() {
    if (st.disposed) return;
    const [w, h] = measure();
    const dpr = Math.min((typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1, 2);
    if (w === st.W && h === st.H && dpr === st.dpr) { render(); return; }
    st.W = w; st.H = h; st.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (canvas.style) { canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; }
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    st.staticDirty = true;
    render();
  }

  /* ── клики по кнопкам, нарисованным на самом холсте (карта режимов) ── */

  /** Координаты события в тех же пикселях, в которых рисуется статичный слой. */
  function canvasPos(ev) {
    if (!ev || !num(ev.clientX) || !num(ev.clientY)) return null;
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    if (!r) return null;
    const kx = num(r.width) && r.width > 0 ? st.W / r.width : 1;
    const ky = num(r.height) && r.height > 0 ? st.H / r.height : 1;
    return { x: (ev.clientX - (r.left || 0)) * kx, y: (ev.clientY - (r.top || 0)) * ky };
  }

  /** Кнопка под точкой или null. */
  function hitMapBtn(ev) {
    if (st.active !== 'map' || !mapBtns.length) return null;
    const p = canvasPos(ev);
    if (!p) return null;
    for (const b of mapBtns) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
    }
    return null;
  }

  const onCanvasClick = ev => {
    const b = hitMapBtn(ev);
    if (b) api.setMapMetric(b.key);
  };
  const onCanvasMove = ev => {
    if (!canvas.style) return;
    const want = hitMapBtn(ev) ? 'pointer' : '';
    if (canvas.style.cursor !== want) canvas.style.cursor = want;
  };
  if (canvas.addEventListener) {
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mousemove', onCanvasMove);
  }

  /* ── слежение за размерами ── */
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(holder);
  }
  const onWinResize = () => resize();
  if (typeof addEventListener === 'function') addEventListener('resize', onWinResize);

  /* ══════════ публичный API ══════════ */

  let offLang = null;      // отписка от смены языка (снимается в dispose)

  const api = {
    /** Подключить объект engine из physics.js и пересчитать статичные кривые. */
    setEngine(engine) {
      st.engine = engine || null;
      st.sweep = null; st.sweepPrev = null; st.sweepAt = -1e9;
      st.sweepFail = false; st.sweepWarned = false;
      st.map = null; st.mapFail = false; st.mapEmpty = false; st.mapWarned = false;
      st.staticDirty = true;
      render();
      return api;
    },
    /** Кадр (см. §6 контракта): подсветить текущий угол цикла. */
    update(frame) {
      st.frame = frame || null;
      render();
      return api;
    },
    /** 'pv' | 'torque' | 'kinematics' | 'valves' | 'energy' | 'sweep' | 'balance' | 'map' */
    setActive(name) {
      if (!TABS.some(tb => tb.key === name)) return api;
      st.active = name;
      for (const tb of TABS) {
        const b = tabBtns[tb.key];
        if (b && b.classList) b.classList.toggle('on', tb.key === name);
      }
      if (optEl.classList) optEl.classList.toggle('show', name === 'pv');
      st.staticDirty = true;
      render();
      return api;
    },
    getActive() { return st.active; },
    /** Логарифмические оси на диаграмме p–V. */
    setLogAxes(on) {
      st.log = !!on;
      if (optChk) optChk.checked = st.log;
      st.staticDirty = true;
      render();
      return api;
    },
    /** Пересчитать размеры canvas (вызывать при изменении разметки). */
    resize() { resize(); return api; },
    /**
     * Принудительная перерисовка статичного слоя (после setParams двигателя).
     * Здесь же сбрасывается кэш свипа — только тут и в setEngine он и пересчитывается.
     */
    invalidate() {
      st.sweep = null;
      st.map = null; st.mapFail = false; st.mapEmpty = false;   // карта тоже пересчитается — но один раз
      st.staticDirty = true;
      render();
      return api;
    },
    /**
     * Величина на карте режимов: 'bsfc' | 'power' | 'eff'.
     * Переключение только перерисовывает готовую сетку — mapRpmLoad() не вызывается.
     */
    setMapMetric(key) {
      if (!MAP_METRICS.some(m => m.key === key) || key === st.mapMetric) return api;
      st.mapMetric = key;
      if (st.active === 'map') { st.staticDirty = true; render(); }
      return api;
    },
    getMapMetric() { return st.mapMetric; },
    /** Служебное: сколько миллисекунд занял последний sweepRpm (0, если свипа не было). */
    getSweepMs() { return st.sweepMs || 0; },
    /** Служебное: сколько миллисекунд занял последний mapRpmLoad. */
    getMapMs() { return st.mapMs || 0; },
    dispose() {
      st.disposed = true;
      if (offLang) { offLang(); offLang = null; }
      if (sweepTimer && typeof clearTimeout === 'function') clearTimeout(sweepTimer);
      sweepTimer = null;
      if (ro) ro.disconnect();
      if (typeof removeEventListener === 'function') removeEventListener('resize', onWinResize);
      if (canvas.removeEventListener) {
        canvas.removeEventListener('click', onCanvasClick);
        canvas.removeEventListener('mousemove', onCanvasMove);
      }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      st.engine = null;
      st.frame = null;
      st.sweep = null;
      st.sweepPrev = null;
      st.map = null;
      mapBtns = [];
    },
    /** Служебное: доступ к элементам (интегратору может пригодиться). */
    el: { wrap, canvas, tabs: tabsEl },
  };

  /** Тексты элементов управления по текущему языку. */
  function applyLang() {
    for (const tb of TABS) {
      const b = tabBtns[tb.key];
      if (!b) continue;
      b.textContent = t(tb.label);
      b.title = t(tb.label);
    }
    if (optTxt) optTxt.textContent = t(OPT_LABEL);
  }

  /**
   * Смена языка на лету: подписи вкладок обновляются сразу, а статичный слой
   * помечается грязным и пересобирается — без него подписи осей, легенды
   * и аннотации остались бы на прежнем языке до следующего resize.
   */
  offLang = onLangChange(() => {
    if (st.disposed) return;
    applyLang();
    st.staticDirty = true;
    render();
  });

  applyLang();
  api.setActive('pv');
  resize();
  return api;
}

export default createCharts;
