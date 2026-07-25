/**
 * src/charts.js — научные графики симулятора ДВС.
 * Canvas 2D, без внешних библиотек, тёмная тема, поддержка devicePixelRatio.
 *
 * Модуль сам создаёт внутри переданного root свою разметку (вкладки + canvas)
 * и сам следит за размерами. Данные берутся только из объекта engine (physics.js):
 * таблицы engine.cycle.* (шаг 0.5° по углу цикла 0…720) и engine.metrics.
 *
 *   import { createCharts } from './charts.js';
 *   const charts = createCharts(document.getElementById('charts'));
 *   charts.setEngine(engine);
 *   charts.setActive('pv');
 *   charts.update(frame);          // каждый кадр
 */

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

/** Цвета тактов — как в основном интерфейсе. */
const STROKES = [
  { from: 0,   to: 180, color: '#3b82f6', name: 'впуск' },
  { from: 180, to: 360, color: '#a855f7', name: 'сжатие' },
  { from: 360, to: 540, color: '#f97316', name: 'рабочий ход' },
  { from: 540, to: 720, color: '#6b7280', name: 'выпуск' },
];

const G = 9.80665;                       // ускорение свободного падения, м/с²
const FONT_FAMILY = '-apple-system, "Segoe UI", Roboto, sans-serif';
const font = (size, weight) => `${weight ? weight + ' ' : ''}${size}px ${FONT_FAMILY}`;

const num = v => typeof v === 'number' && isFinite(v);
const isArr = a => !!a && typeof a.length === 'number' && a.length > 1;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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

/** Линейная интерполяция таблицы цикла по углу 0…720. */
function sampleAt(arr, deg) {
  if (!isArr(arr)) return NaN;
  const n = arr.length, step = 720 / (n - 1);
  const d = ((deg % 720) + 720) % 720;
  const x = d / step;
  const i0 = clamp(Math.floor(x), 0, n - 1);
  const i1 = clamp(i0 + 1, 0, n - 1);
  const a = arr[i0], b = arr[i1];
  if (!num(a)) return NaN;
  if (!num(b)) return a;
  return a + (b - a) * (x - i0);
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
  for (const t of ticksY) {
    const y = Math.round(sy(t)) + 0.5;
    if (y < box.y - 1 || y > box.y + box.h + 1) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right';
    ctx.fillText(fmtY(t), box.x - 6, y);
  }
  // вертикальные линии
  ctx.textBaseline = 'top';
  for (const t of ticksX) {
    const x = Math.round(sx(t)) + 0.5;
    if (x < box.x - 1 || x > box.x + box.w + 1) continue;
    ctx.strokeStyle = C.gridSoft;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.h);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(fmtX(t), x, box.y + box.h + 5);
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

/** Фоновые полосы четырёх тактов по оси углов (подписи — если хватает ширины). */
function drawStrokeBands(ctx, box, sx, withNames) {
  ctx.save();
  ctx.font = font(9.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const s of STROKES) {
    const x0 = sx(s.from), x1 = sx(s.to);
    ctx.fillStyle = s.color + '12';
    ctx.fillRect(x0, box.y, x1 - x0, box.h);
    if (withNames && x1 - x0 > ctx.measureText(s.name).width + 10) {
      ctx.fillStyle = s.color + '99';
      ctx.fillText(s.name, (x0 + x1) / 2, box.y + 3);
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
  { key: 'pv',         label: 'p–V' },
  { key: 'torque',     label: 'Момент' },
  { key: 'kinematics', label: 'Кинематика' },
  { key: 'valves',     label: 'Фазы ГРМ' },
  { key: 'energy',     label: 'Энергия' },
];

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
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'engch-tab';
    b.textContent = t.label;
    b.title = t.label;
    b.addEventListener('click', () => api.setActive(t.key));
    tabsEl.appendChild(b);
    tabBtns[t.key] = b;
  }

  // переключатель логарифмических осей — только для p–V
  const optEl = document.createElement('label');
  optEl.className = 'engch-opt';
  const optChk = document.createElement('input');
  optChk.type = 'checkbox';
  const optTxt = document.createElement('span');
  optTxt.textContent = 'лог. оси';
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
  const curDeg = () => (st.frame && num(st.frame.deg) ? ((st.frame.deg % 720) + 720) % 720 : null);

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
      'объём V, см³', 'давление p, бар');

    // ── ВМТ / НМТ ──
    g.save();
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.strokeStyle = C.axis;
    g.font = font(10);
    g.textBaseline = 'top';
    for (const [v, name] of [[vmin, 'ВМТ'], [vmax, 'НМТ']]) {
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

    // ── идеальный цикл Отто пунктиром ──
    const eps = num(par().eps) ? par().eps : (vmax / Math.max(vmin, 1e-6));
    const gam = 1.35;
    const p1 = num(sampleAt(P, num(par().ivc) ? par().ivc : 230)) ? sampleAt(P, num(par().ivc) ? par().ivc : 230) : 1;
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

    // ── петля по тактам ──
    const step = 720 / (n - 1);
    for (const s of STROKES) {
      const i0 = clamp(Math.round(s.from / step), 0, n - 1);
      const i1 = clamp(Math.round(s.to / step), 0, n - 1);
      polyline(g, V, P, sx, sy, i0, i1, s.color, 1.9);
    }

    // ── характерные точки ──
    const p = par();
    const soc = num(p.sparkAdvance_deg)
      ? 360 - p.sparkAdvance_deg
      : firstBurnDeg(c);
    const pmaxDeg = m && num(m.pmax_deg) ? m.pmax_deg : argMaxAbs(P) * step;
    const pts = [
      { deg: num(p.ivc) ? p.ivc : 230, name: 'закр. впуска', color: C.blue },
      { deg: soc, name: p.fuel === 'diesel' ? 'впрыск' : 'искра', color: C.yellow },
      { deg: pmaxDeg, name: `p max ${f(sampleAt(P, pmaxDeg), 1)} бар`, color: C.red },
      { deg: num(p.evo) ? p.evo : 490, name: 'откр. выпуска', color: C.gray },
    ];
    for (const pt of pts) {
      if (!num(pt.deg)) continue;
      const vv = sampleAt(V, pt.deg), pp = sampleAt(P, pt.deg);
      if (!num(vv) || !num(pp)) continue;
      const x = sx(vv), y = sy(pp);
      dot(g, x, y, 3, pt.color);
      if (!narrow()) tag(g, x + 7, y - 9, `${pt.name} · ${Math.round(pt.deg)}°`, pt.color, box);
    }

    // ── легенда и работа цикла ──
    const wrk = m && num(m.workPerCycle_J) ? m.workPerCycle_J : NaN;
    drawLegend(g, box.x + 4, box.y + box.h + 47, [
      { color: C.blue, text: 'реальный цикл (заливка = работа)' },
      { color: C.green, text: 'идеальный цикл Отто', dash: [5, 4] },
    ], box.w);
    const lines = [];
    if (num(wrk)) lines.push(`работа ${f(wrk, 1)} Дж/цил.`);
    if (m && num(m.imep_bar)) lines.push(`p_i ${f(m.imep_bar, 2)} бар`);
    if (m && num(m.effIndicated)) lines.push(`КПД инд. ${f(m.effIndicated * 100, 1)} %`);
    if (m && num(m.effOtto)) lines.push(`Отто ${f(m.effOtto * 100, 1)} %`);
    headerRight(g, 1, lines.join('  ·  '));

    return { sx, sy };
  }

  /** Угол начала сгорания по таблице Вибе, если параметров нет. */
  function firstBurnDeg(c) {
    if (!c || !isArr(c.xb)) return NaN;
    const step = 720 / (c.xb.length - 1);
    for (let i = 0; i < c.xb.length; i++) if (num(c.xb[i]) && c.xb[i] > 0.002) return i * step;
    return NaN;
  }

  function pvDynamic(g, box, sc) {
    const d = curDeg();
    const c = cyc();
    if (d === null || !c || !sc) return;
    const v = sampleAt(c.V_cm3, d), p = sampleAt(c.p_bar, d);
    if (!num(v) || !num(p)) return;
    const x = sc.sx(v), y = sc.sy(p);
    dot(g, x, y, 4.5, '#ffffff', C.orange);
    const T = sampleAt(c.T_K, d);
    const lines = [
      `θ = ${d.toFixed(0)}°`,
      `p = ${f(p, 2)} бар`,
      `V = ${f(v, 1)} см³`,
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

    const sx = linScale(0, 720, box.x, box.x + box.w);
    const sy = linScale(mn - pad, mx + pad, box.y + box.h, box.y);
    drawGrid(g, box, sx, sy, [0, 180, 360, 540, 720], niceTicks(mn - pad, mx + pad, 5),
      v => v.toFixed(0), v => v.toFixed(Math.abs(mx) < 20 ? 1 : 0),
      'угол цикла θ, град', 'момент M, Н·м');
    drawStrokeBands(g, box, sx, !narrow());

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
    if (main) fillAroundZero(g, box, D, main, sx, sy, y0);

    if (T1) polyline(g, D, T1, sx, sy, 0, D.length - 1, C.blue, 1.6);
    if (TT && cyl > 1) polyline(g, D, TT, sx, sy, 0, D.length - 1, C.orange, 2.0);

    // средний момент (индикаторный) и эффективный
    const avg = main ? mean(main) : NaN;
    const m = met();
    if (num(avg)) {
      dashedH(g, box, sy(avg), C.green, [6, 4]);
      if (!narrow()) tag(g, box.x + box.w - 6, sy(avg) - 9, `средний ${f(avg, 1)} Н·м`, C.green, box, 'right');
    }
    if (m && num(m.brakeTorque_Nm)) {
      dashedH(g, box, sy(m.brakeTorque_Nm), C.gray, [3, 3]);
      if (!narrow()) {
        tag(g, box.x + 6, sy(m.brakeTorque_Nm) + 10,
          `эффективный ${f(m.brakeTorque_Nm, 1)} Н·м (за вычетом трения)`, C.gray, box);
      }
    }

    const items = [{ color: C.blue, text: 'один цилиндр' }];
    if (TT && cyl > 1) items.push({ color: C.orange, text: `сумма ${cyl} цил.` });
    items.push({ color: C.green, text: 'средний момент', dash: [6, 4] });
    drawLegend(g, box.x + 4, box.y + box.h + 47, items, box.w);

    const lines = [];
    if (num(par().rpm)) lines.push(`${Math.round(par().rpm)} об/мин`);
    if (m && num(m.brakePower_kW)) lines.push(`${f(m.brakePower_kW, 1)} кВт`);
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

  function fillAroundZero(g, box, D, arr, sx, sy, y0) {
    for (const sign of [1, -1]) {
      g.save();
      g.beginPath();
      g.moveTo(sx(0), y0);
      for (let i = 0; i < arr.length; i++) {
        const v = num(arr[i]) ? arr[i] : 0;
        const use = sign > 0 ? Math.max(v, 0) : Math.min(v, 0);
        g.lineTo(sx(D[i]), sy(use));
      }
      g.lineTo(sx(720), y0);
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
      const v = sampleAt(c.torque_Nm, d);
      dot(g, x, sc.sy(v), 3.5, C.blue, '#fff');
      lines.push(`1 цил.: ${f(v, 1)} Н·м`);
    }
    if (isArr(c.torqueTotal_Nm) && num(par().cylinders) && par().cylinders > 1) {
      const v = sampleAt(c.torqueTotal_Nm, d);
      dot(g, x, sc.sy(v), 4, C.orange, '#fff');
      lines.push(`сумма: ${f(v, 1)} Н·м`);
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
    if (!boxes) { drawEmpty(g, W, H, 'Мало места для графика'); return null; }
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

    let note = 'перемещение, скорость и ускорение поршня по углу цикла';
    const panels = [
      { data: S,  color: C.blue,   title: 'перемещение от ВМТ, мм', zero: false },
      { data: Vv, color: C.purple, title: 'скорость, м/с',          zero: true },
      { data: Av, color: C.orange, title: 'ускорение, м/с²',        zero: true },
    ];

    const scales = [];
    panels.forEach((p, i) => {
      const box = boxes[i];
      if (!p.data) {
        g.save();
        g.strokeStyle = C.grid;
        g.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
        g.restore();
        centerText(g, box.x + box.w / 2, box.y + box.h / 2, `нет данных: ${p.title}`);
        scales.push(null);
        return;
      }
      let [mn, mx] = extent(p.data);
      if (p.zero) { const a = Math.max(Math.abs(mn), Math.abs(mx)) * 1.15 || 1; mn = -a; mx = a; }
      else { mn = 0; mx = mx * 1.08 || 1; }
      const sx = linScale(0, 720, box.x, box.x + box.w);
      const sy = linScale(mn, mx, box.y + box.h, box.y);
      const showX = i === 2;
      drawGrid(g, box, sx, sy, [0, 180, 360, 540, 720], niceTicks(mn, mx, 3),
        v => (showX ? v.toFixed(0) : ''),
        v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(Math.abs(mx) < 20 ? 1 : 0)),
        showX && !boxes.tight ? 'угол цикла θ, град' : '', '');
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
      const step = 720 / (Vv.length - 1);
      const b = boxes[1];
      const x = scales[1].sx(i * step), y = scales[1].sy(Vv[i]);
      dot(g, x, y, 3, C.purple);
      tag(g, x + 7, y, `макс. |v| = ${f(Math.abs(Vv[i]), 2)} м/с при ${Math.round(i * step % 360)}°`, C.purple, b);
      const mps = met() && num(met().meanPistonSpeed_ms) ? met().meanPistonSpeed_ms : NaN;
      if (num(mps) && b.h > 54) tag(g, b.x + 6, b.y + 11, `средняя скорость поршня ${f(mps, 2)} м/с`, C.text, b);
    }
    if (Av && scales[2]) {
      // экстремумы ускорения лежат в мёртвых точках; знак зависит от соглашения,
      // поэтому берём значения по углу, а не по знаку
      const b = boxes[2];
      const aT = sampleAt(Av, 360), aB = sampleAt(Av, 180);
      if (num(aT) && num(aB)) {
        const xT = scales[2].sx(360), yT = scales[2].sy(aT);
        const xB = scales[2].sx(180), yB = scales[2].sy(aB);
        dot(g, xT, yT, 3, C.orange);
        dot(g, xB, yB, 3, C.gray);
        tag(g, xT + 7, yT + (aT > aB ? -2 : 2),
          `ВМТ: |a| = ${f(Math.abs(aT), 0)} м/с² = ${f(Math.abs(aT) / G, 0)} g`, C.orange, b);
        tag(g, xB + 7, yB + (aT > aB ? 2 : -2),
          `НМТ: |a| = ${f(Math.abs(aB), 0)} м/с² = ${f(Math.abs(aB) / G, 0)} g`, C.gray, b);
        // ключевой учебный вывод — в подзаголовок графика
        const ratio = Math.abs(aB) > 1e-6 ? Math.abs(aT / aB) : NaN;
        note = `у ВМТ ускорение в ${f(ratio, 2)} раза больше, чем у НМТ` +
          (num(lambda) ? ` — влияние конечной длины шатуна, λ = r/L = ${f(lambda, 3)}` : '');
      }
    }
    if (S && scales[0] && boxes[0].h > 54) {
      tag(g, boxes[0].x + 6, boxes[0].y + 11, `ход поршня S = ${f(stroke_mm, 0)} мм`, C.blue, boxes[0]);
    }
    return { boxes, scales, note };
  }

  function kinDynamic(g, sc) {
    const d = curDeg();
    if (d === null || !sc) return;
    const units = ['мм', 'м/с', 'м/с²'];
    const names = ['s', 'v', 'a'];
    const vals = [];
    sc.scales.forEach((s, i) => {
      if (!s) return;
      const x = s.sx(d);
      vline(g, s.box, x);
      const v = sampleAt(s.data, d);
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
    const sx = linScale(0, 720, box.x, box.x + box.w);
    const sy = linScale(0, 1.08, box.y + box.h, box.y);
    drawGrid(g, box, sx, sy, [0, 180, 360, 540, 720], [0, 0.25, 0.5, 0.75, 1],
      v => v.toFixed(0), v => (v * 100).toFixed(0),
      'угол цикла θ, град', 'подъём клапана и доля сгоревшего, %');
    drawStrokeBands(g, box, sx, !narrow());

    const LI = isArr(c.liftIn) ? c.liftIn : null;
    const LE = isArr(c.liftEx) ? c.liftEx : null;
    const XB = isArr(c.xb) ? c.xb : null;

    // ── зона перекрытия клапанов ──
    if (LI && LE) {
      g.save();
      g.fillStyle = 'rgba(46,160,67,.20)';
      const n = Math.min(LI.length, LE.length);
      const step = 720 / (n - 1);
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
              `перекрытие клапанов ≈ ${Math.round((i - runStart) * step)}°`, C.green, box);
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
    const soc = num(p.sparkAdvance_deg) ? 360 - p.sparkAdvance_deg : firstBurnDeg(c);
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
      const nm = p.fuel === 'diesel' ? 'впрыск' : 'искра';
      tag(g, x + 6, box.y + 26,
        `${nm} ${Math.round(soc)}° (${f(360 - soc, 0)}° до ВМТ)`, C.yellow, box);
    }

    // ── фазы: подписи открытия/закрытия ──
    const phases = [
      { deg: p.ivo, txt: 'откр. впуск', color: C.blue },
      { deg: p.ivc, txt: 'закр. впуск', color: C.blue },
      { deg: p.evo, txt: 'откр. выпуск', color: C.orange },
      { deg: p.evc, txt: 'закр. выпуск', color: C.orange },
    ];
    g.save();
    g.font = font(9.5);
    g.textBaseline = 'bottom';
    let lastTxtX = -1e9;
    const ordered = phases.filter(ph => num(ph.deg))
      .sort((a, b) => ((a.deg % 720) + 720) % 720 - ((b.deg % 720) + 720) % 720);
    for (const ph of ordered) {
      if (!num(ph.deg)) continue;
      const x = sx(((ph.deg % 720) + 720) % 720);
      g.strokeStyle = ph.color + '66';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, box.y + box.h);
      g.lineTo(x, box.y + box.h - 7);
      g.stroke();
      if (narrow()) continue;                       // на узкой панели подписи не влезают
      const txt = `${ph.txt} ${Math.round(ph.deg)}°`;
      const tw = g.measureText(txt).width;
      const cx = clamp(x, box.x + tw / 2 + 2, box.x + box.w - tw / 2 - 2);
      if (cx - tw / 2 < lastTxtX + 6) continue;     // не наезжать на предыдущую подпись
      lastTxtX = cx + tw / 2;
      g.fillStyle = ph.color;
      g.textAlign = 'center';
      g.fillText(txt, cx, box.y + box.h - 9);
    }
    g.restore();

    drawLegend(g, box.x + 4, box.y + box.h + 47, [
      { color: C.blue, text: 'впускной клапан' },
      { color: C.orange, text: 'выпускной клапан' },
      { color: C.red, text: 'сгорело топлива (Вибе)', dash: [5, 3] },
      { color: C.green, text: 'перекрытие' },
    ], box.w);

    return { sx, sy };
  }

  function valvesDynamic(g, box, sc) {
    const d = curDeg();
    const c = cyc();
    if (d === null || !c || !sc) return;
    const x = sc.sx(d);
    vline(g, box, x);
    const lines = [`θ = ${d.toFixed(0)}°`];
    if (isArr(c.liftIn)) {
      const v = sampleAt(c.liftIn, d);
      if (num(v)) { dot(g, x, sc.sy(v), 3.2, C.blue, '#fff'); lines.push(`впуск: ${(v * 100).toFixed(0)} %`); }
    }
    if (isArr(c.liftEx)) {
      const v = sampleAt(c.liftEx, d);
      if (num(v)) { dot(g, x, sc.sy(v), 3.2, C.orange, '#fff'); lines.push(`выпуск: ${(v * 100).toFixed(0)} %`); }
    }
    if (isArr(c.xb)) {
      const v = sampleAt(c.xb, d);
      if (num(v)) lines.push(`сгорело: ${(v * 100).toFixed(0)} %`);
    }
    if (!headerRight(g, 2, lines.join('  ·  '), C.bright)) drawReadout(g, box, lines, 'left');
  }

  /* ══════════ 5. Энергетический баланс ══════════ */

  function energyStatic(g, W, H) {
    const m = met();
    const e = m && m.energy ? m.energy : null;
    if (!e) { drawEmpty(g, W, H, 'Нет данных энергетического баланса'); return; }

    const parts = [
      { key: 'work_pct',     name: 'Полезная работа',      color: C.green },
      { key: 'exhaust_pct',  name: 'Потери с выхлопом',    color: C.orange },
      { key: 'coolant_pct',  name: 'Отвод в охлаждение',   color: C.blue },
      { key: 'friction_pct', name: 'Механическое трение',  color: C.purple },
    ].map(p => ({ ...p, val: num(e[p.key]) ? Math.max(0, e[p.key]) : 0 }));

    const total = parts.reduce((s, p) => s + p.val, 0) || 100;

    const left = 16, right = 16;
    const bw = W - left - right;
    const by = 46;
    const bh = Math.min(52, Math.max(26, H * 0.18));
    if (bw < 60) { drawEmpty(g, W, H, 'Слишком узко'); return; }

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
    for (let t = 0; t <= 100; t += 10) {
      const px = left + (t / 100) * bw;
      g.beginPath();
      g.moveTo(px, by + bh);
      g.lineTo(px, by + bh + 4);
      g.stroke();
      if (t % 20 === 0) g.fillText(t + ' %', px, by + bh + 6);
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
    if (num(m.brakePower_kW)) rows.push(['Эффективная мощность', `${f(m.brakePower_kW, 1)} кВт`]);
    if (num(m.indPower_kW)) rows.push(['Индикаторная мощность', `${f(m.indPower_kW, 1)} кВт`]);
    if (num(m.brakeTorque_Nm)) rows.push(['Эффективный момент', `${f(m.brakeTorque_Nm, 1)} Н·м`]);
    if (num(m.effBrake)) rows.push(['Эффективный КПД', `${f(m.effBrake * 100, 1)} %`]);
    if (num(m.bsfc_g_kWh)) rows.push(['Удельный расход', `${f(m.bsfc_g_kWh, 0)} г/(кВт·ч)`]);
    if (num(m.volEff)) rows.push(['Коэф. наполнения', `${f(m.volEff * 100, 0)} %`]);
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

    drawTitle(g, 'Энергетический баланс двигателя',
      'куда уходит теплота сгорания топлива, % от подведённой');
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
    if (!st.engine) { drawEmpty(bgCtx, W, H, 'Двигатель не подключён'); return; }
    if (st.active !== 'energy' && (!c || !isArr(c.deg))) {
      drawEmpty(bgCtx, W, H, 'Нет таблиц цикла (engine.cycle)');
      return;
    }
    if (W < 180 || H < 120) { drawEmpty(bgCtx, W, H, 'Мало места для графика'); return; }

    try {
      switch (st.active) {
        case 'pv': {
          if (!isArr(c.V_cm3) || !isArr(c.p_bar)) {
            drawEmpty(bgCtx, W, H, 'Нет данных p–V'); break;
          }
          drawTitle(bgCtx, 'Индикаторная диаграмма p–V',
            `площадь петли — работа за цикл${st.log ? ' · логарифмические оси' : ''}`);
          curBox = boxFor(W, H);
          scales = pvStatic(bgCtx, curBox);
          break;
        }
        case 'torque': {
          if (!isArr(c.torque_Nm) && !isArr(c.torqueTotal_Nm)) {
            drawEmpty(bgCtx, W, H, 'Нет данных момента'); break;
          }
          drawTitle(bgCtx, 'Момент на коленчатом валу',
            'отрицательные участки — затраты на сжатие и газообмен');
          curBox = boxFor(W, H);
          scales = torqueStatic(bgCtx, curBox);
          break;
        }
        case 'kinematics': {
          scales = kinStatic(bgCtx, W, H);
          drawTitle(bgCtx, 'Кинематика поршня', (scales && scales.note) || '');
          break;
        }
        case 'valves': {
          if (!isArr(c.liftIn) && !isArr(c.liftEx) && !isArr(c.xb)) {
            drawEmpty(bgCtx, W, H, 'Нет данных фаз газораспределения'); break;
          }
          drawTitle(bgCtx, 'Диаграмма фаз газораспределения',
            'подъём клапанов, тепловыделение по Вибе и перекрытие');
          curBox = boxFor(W, H);
          scales = valvesStatic(bgCtx, curBox);
          break;
        }
        case 'energy':
          energyStatic(bgCtx, W, H);
          break;
      }
    } catch (err) {
      // график не должен ронять приложение
      bgCtx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      drawEmpty(bgCtx, W, H, 'Ошибка отрисовки графика');
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
        case 'energy': break;
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

  /* ── слежение за размерами ── */
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(holder);
  }
  const onWinResize = () => resize();
  if (typeof addEventListener === 'function') addEventListener('resize', onWinResize);

  /* ══════════ публичный API ══════════ */

  const api = {
    /** Подключить объект engine из physics.js и пересчитать статичные кривые. */
    setEngine(engine) {
      st.engine = engine || null;
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
    /** 'pv' | 'torque' | 'kinematics' | 'valves' | 'energy' */
    setActive(name) {
      if (!TABS.some(t => t.key === name)) return api;
      st.active = name;
      for (const t of TABS) {
        const b = tabBtns[t.key];
        if (b && b.classList) b.classList.toggle('on', t.key === name);
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
    /** Принудительная перерисовка статичного слоя (после setParams двигателя). */
    invalidate() { st.staticDirty = true; render(); return api; },
    dispose() {
      st.disposed = true;
      if (ro) ro.disconnect();
      if (typeof removeEventListener === 'function') removeEventListener('resize', onWinResize);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      st.engine = null;
      st.frame = null;
    },
    /** Служебное: доступ к элементам (интегратору может пригодиться). */
    el: { wrap, canvas, tabs: tabsEl },
  };

  api.setActive('pv');
  resize();
  return api;
}

export default createCharts;
