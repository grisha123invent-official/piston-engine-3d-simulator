/**
 * Тексты теории и подсказок на двух языках.
 * Разметку карточек собирает main.js — здесь только содержание.
 */
import { t } from './i18n.js?v=6';

/** Карточки четырёхтактного цикла. */
export const STAGES_4 = [
  {
    color: 'var(--intake)',
    title: { ru: '1 · ВПУСК — 0…180°', en: '1 · INTAKE — 0…180°' },
    body: {
      ru: `Поршень идёт от ВМТ вниз, <b>впускной клапан открыт</b> (открывается за ~20° до ВМТ).
        Разрежение засасывает свежий заряд, форсунка впрыскивает топливо — смесь стехиометрическая,
        ~14,7 кг воздуха на 1 кг бензина. Сколько заряда реально влезло, показывает
        <b>коэффициент наполнения</b>: он зависит от оборотов, дросселя и настройки впускного тракта.`,
      en: `The piston moves down from TDC with the <b>intake valve open</b> (it opens ~20° before TDC).
        The vacuum draws in a fresh charge and the injector adds fuel — a stoichiometric mixture,
        about 14.7 kg of air per 1 kg of gasoline. How much charge actually made it in is the
        <b>volumetric efficiency</b>: it depends on engine speed, throttle and intake tuning.`,
    },
    note: {
      ru: 'Клапан закрывается на ~50° позже НМТ — поток по инерции продолжает наполнять цилиндр.',
      en: 'The valve closes ~50° after BDC — the incoming flow keeps filling the cylinder by inertia.',
    },
  },
  {
    color: 'var(--compress)',
    title: { ru: '2 · СЖАТИЕ — 180…360°', en: '2 · COMPRESSION — 180…360°' },
    body: {
      ru: `Оба клапана закрыты, смесь сжимается в ε раз. Процесс близок к адиабатному:
        <b>p·V<sup>γ</sup> ≈ const</b>, газ разогревается сам. За несколько десятков градусов до ВМТ
        проскакивает искра — <b>опережение</b> нужно потому, что сгорание занимает время,
        а максимум давления должен прийтись на 10–15° после ВМТ.`,
      en: `Both valves are closed and the mixture is compressed by the ratio ε. The process is nearly
        adiabatic — <b>p·V<sup>γ</sup> ≈ const</b> — so the gas heats up on its own. The spark fires
        a few dozen degrees before TDC: <b>ignition advance</b> is needed because combustion takes
        time, and peak pressure must land 10–15° after TDC.`,
    },
    note: {
      ru: 'Момент на этом такте отрицательный: двигатель живёт за счёт маховика.',
      en: 'Torque is negative during this stroke: the engine lives off the flywheel.',
    },
  },
  {
    color: 'var(--power)',
    title: { ru: '3 · РАБОЧИЙ ХОД — 360…540°', en: '3 · POWER — 360…540°' },
    body: {
      ru: `Доля сгоревшего топлива описывается <b>функцией Вибе</b>. Давление и температура достигают
        максимума, газы толкают поршень вниз — единственный такт, где совершается полезная работа.
        Момент считается с учётом конечной длины шатуна:
        <b>M = F·r·(sin θ + λ·sin 2θ / 2)</b>.`,
      en: `The burned mass fraction follows the <b>Wiebe function</b>. Pressure and temperature peak,
        and the expanding gas drives the piston down — the only stroke that produces useful work.
        Torque accounts for the finite connecting rod length:
        <b>M = F·r·(sin θ + λ·sin 2θ / 2)</b>.`,
    },
    note: {
      ru: 'Площадь петли на диаграмме p–V — это и есть работа за цикл.',
      en: 'The area enclosed by the p–V loop is exactly the work per cycle.',
    },
  },
  {
    color: '#9aa8b8',
    title: { ru: '4 · ВЫПУСК — 540…720°', en: '4 · EXHAUST — 540…720°' },
    body: {
      ru: `Выпускной клапан открывается за ~50° до НМТ: остаточное давление само выбрасывает первую
        порцию газов. Поршень выталкивает остальное. У ВМТ — <b>перекрытие клапанов</b>:
        оба приоткрыты, уходящий поток помогает затянуть свежую смесь.`,
      en: `The exhaust valve opens ~50° before BDC: residual pressure blows the first portion of gas
        out by itself. The piston pushes out the rest. Around TDC there is <b>valve overlap</b>:
        both valves are cracked open and the outgoing flow helps pull in fresh mixture.`,
    },
    note: {
      ru: 'За цикл коленвал делает 2 оборота, распредвалы — 1: смотри, как цепь крутит их вдвое медленнее.',
      en: 'Per cycle the crankshaft turns twice and the camshafts once — watch the chain halve the speed.',
    },
  },
];

/** Карточки двухтактного цикла. */
export const STAGES_2 = [
  {
    color: 'var(--power)',
    title: {
      ru: '1 · РАБОЧИЙ ХОД, ВЫПУСК И ПРОДУВКА — 0…180°',
      en: '1 · POWER, BLOWDOWN AND SCAVENGING — 0…180°',
    },
    body: {
      ru: `После вспышки у ВМТ газы толкают поршень вниз. Примерно на 104° поршень своей юбкой
        <b>открывает выпускное окно</b> — давление падает, начинается свободный выпуск. Ещё через 18°
        открываются <b>продувочные окна</b>, и свежая смесь, сжатая в кривошипной камере, врывается
        в цилиндр, разворачивается по петле и выталкивает остатки выхлопа.`,
      en: `After ignition at TDC the gas drives the piston down. At about 104° the piston skirt
        <b>uncovers the exhaust port</b> — pressure drops and blowdown begins. Some 18° later the
        <b>transfer ports</b> open and fresh mixture, pre-compressed in the crankcase, rushes in,
        loops around and pushes the remaining exhaust out.`,
    },
    note: {
      ru: `Часть свежей смеси уходит прямо в выпуск — короткое замыкание продувки. Отсюда высокая
        литровая мощность, но плохая экономичность и грязный выхлоп.`,
      en: `Part of the fresh charge escapes straight into the exhaust — short-circuiting. Hence the
        high specific output but poor economy and dirty exhaust.`,
    },
  },
  {
    color: 'var(--compress)',
    title: {
      ru: '2 · СЖАТИЕ И НАПОЛНЕНИЕ КАРТЕРА — 180…360°',
      en: '2 · COMPRESSION AND CRANKCASE FILLING — 180…360°',
    },
    body: {
      ru: `Поршень идёт вверх, закрывает продувочные и выпускное окна и сжимает смесь. Одновременно
        под поршнем <b>растёт разрежение в кривошипной камере</b>, и она наполняется свежей смесью
        через впускное окно. У ВМТ — искра, и цикл повторяется.`,
      en: `The piston rises, closes the transfer and exhaust ports and compresses the mixture. At the
        same time <b>vacuum builds in the crankcase</b> below it, drawing fresh mixture in through the
        inlet. At TDC the spark fires and the cycle repeats.`,
    },
    note: {
      ru: 'Рабочий ход происходит каждый оборот, а не через один: клапанов, распредвалов и цепи здесь нет вообще.',
      en: 'There is a power stroke every revolution: no valves, no camshafts and no timing chain at all.',
    },
  },
];

/** Примечания под карточками. */
export const NOTES = {
  colors: {
    ru: `<b>Цвета газа:</b>
      <span class="dot" style="background:#4a9eff"></span>смесь
      <span class="dot" style="background:#b26bff"></span>сжатие
      <span class="dot" style="background:#ff8a3c"></span>горение
      <span class="dot" style="background:#8b98a8"></span>выхлоп<br>
      <b>Жидкости:</b> жёлтые капли — впрыск, янтарные частицы — масло (насос → шейки → стенки
      цилиндра → поддон), сине-красный поток — антифриз в рубашке. В полезную работу уходит лишь
      около трети энергии топлива.`,
    en: `<b>Gas colours:</b>
      <span class="dot" style="background:#4a9eff"></span>mixture
      <span class="dot" style="background:#b26bff"></span>compression
      <span class="dot" style="background:#ff8a3c"></span>combustion
      <span class="dot" style="background:#8b98a8"></span>exhaust<br>
      <b>Fluids:</b> yellow droplets are injected fuel, amber particles are engine oil (pump →
      journals → cylinder walls → sump), the blue-to-red stream is coolant in the water jacket.
      Only about a third of the fuel energy ends up as useful work.`,
  },
  knock: {
    ru: `<b>Детонация.</b> Подними степень сжатия, наддув или опережение — и несгоревшая смесь
      самовоспламенится от сжатия раньше фронта пламени (критерий Ливенгуда–Ву). Появится вспышка,
      ударная волна и характерный металлический стук в звуке. Лечится высоким октановым числом,
      поздним зажиганием, интеркулером или меньшей нагрузкой.`,
    en: `<b>Knock.</b> Raise the compression ratio, boost or ignition advance and the unburned end gas
      will auto-ignite ahead of the flame front (Livengood–Wu criterion). You get a flash, a shock wave
      and the characteristic metallic rattle in the sound. Cures: higher octane, retarded timing,
      an intercooler or less load.`,
  },
};

/** Подсказки под графиками. */
export const CHART_HINTS = {
  pv: {
    ru: 'Площадь замкнутой петли — работа за цикл. Пунктир — идеальный цикл при той же степени сжатия: разница и есть потери на теплоотдачу, газообмен и реальное сгорание.',
    en: 'The enclosed area is the work per cycle. The dashed line is the ideal cycle at the same compression ratio: the gap is the loss to heat transfer, gas exchange and real combustion.',
  },
  torque: {
    ru: 'Момент от одного цилиндра большую часть цикла отрицательный — вал крутит маховик. У многоцилиндрового рабочие ходы перекрываются, и суммарная кривая почти не проваливается.',
    en: 'A single cylinder produces negative torque for most of the cycle — the flywheel keeps the crank turning. With more cylinders the power strokes overlap and the total curve barely dips.',
  },
  kinematics: {
    ru: 'Из-за конечной длины шатуна ускорение поршня у ВМТ заметно больше, чем у НМТ. Инерционные силы растут как квадрат оборотов — отсюда предел по оборотам.',
    en: 'Because the connecting rod is finite in length, piston acceleration at TDC is much higher than at BDC. Inertia forces grow with the square of engine speed — hence the rev limit.',
  },
  valves: {
    ru: 'Видна зона перекрытия клапанов у ВМТ и то, что сгорание начинается ещё до ВМТ — за счёт опережения зажигания.',
    en: 'You can see the valve overlap around TDC and that combustion starts before TDC thanks to ignition advance.',
  },
  energy: {
    ru: 'В полезную работу превращается лишь около трети энергии топлива: остальное уносит выхлоп, забирает охлаждение и съедает трение.',
    en: 'Only about a third of the fuel energy becomes useful work: the rest leaves with the exhaust, goes into the coolant and is eaten by friction.',
  },
  sweep: {
    ru: 'Внешняя скоростная характеристика. Двигай длину впускного тракта — резонансный горб наполнения, а с ним и пик момента, поедет по оборотам.',
    en: 'Full-load speed curve. Drag the intake runner length and the resonance hump in volumetric efficiency — and with it the torque peak — moves across the rev range.',
  },
  balance: {
    ru: 'Неуравновешенные силы инерции. У одноцилиндрового велик первый порядок, у рядной четвёрки он погашен, но остаётся второй, у V8 с крестообразным валом уравновешены оба.',
    en: 'Unbalanced inertia forces. A single cylinder has a large first-order force; an inline-four cancels it but keeps the second order; a cross-plane V8 balances both.',
  },
};

/** Названия тактов для указателя и шкалы. */
export const STROKE_NAMES_4 = [
  { ru: 'ВПУСК', en: 'INTAKE', color: '#4a9eff' },
  { ru: 'СЖАТИЕ', en: 'COMPRESSION', color: '#b26bff' },
  { ru: 'РАБОЧИЙ ХОД', en: 'POWER', color: '#ff8a3c' },
  { ru: 'ВЫПУСК', en: 'EXHAUST', color: '#8b98a8' },
];
export const STROKE_NAMES_2 = [
  { ru: 'РАБОЧИЙ ХОД И ПРОДУВКА', en: 'POWER AND SCAVENGING', color: '#ff8a3c' },
  { ru: 'СЖАТИЕ И НАПОЛНЕНИЕ КАРТЕРА', en: 'COMPRESSION AND CRANKCASE FILLING', color: '#b26bff' },
];
export const TIMELINE_4 = [
  { ru: 'Впуск', en: 'Intake' }, { ru: 'Сжатие', en: 'Compression' },
  { ru: 'Рабочий ход', en: 'Power' }, { ru: 'Выпуск', en: 'Exhaust' },
];
export const TIMELINE_2 = [
  { ru: 'Рабочий ход · выпуск · продувка', en: 'Power · blowdown · scavenging' },
  { ru: 'Сжатие · наполнение картера', en: 'Compression · crankcase filling' },
];

/** Строки интерфейса, которые собираются в JS. */
export const UI = {
  play: { ru: 'Пуск', en: 'Run' },
  pause: { ru: 'Пауза', en: 'Pause' },
  cycleOf: { ru: 'из 720° · оборот', en: 'of 720° · revolution' },
  cycle360: { ru: 'цикл 360° · один оборот', en: '360° cycle · one revolution' },
  realtime: { ru: 'реальная скорость', en: 'real time' },
  slowed: { ru: 'замедлено в', en: 'slowed' },
  times: { ru: 'раз', en: 'times' },
  cycleLasts: { ru: 'в реальности цикл длится', en: 'the real cycle lasts' },
  fourStroke: { ru: 'Четырёхтактный', en: 'Four-stroke' },
  twoStroke: { ru: 'Двухтактный', en: 'Two-stroke' },
  petrol: { ru: 'бензин', en: 'petrol' },
  diesel: { ru: 'дизель', en: 'diesel' },
  boosted: { ru: 'с наддувом', en: 'boosted' },
  naturally: { ru: 'атмосферный', en: 'naturally aspirated' },
  knockTitle: { ru: 'Детонация.', en: 'Knock.' },
  knockBody: {
    ru: `Несгоревшая смесь самовоспламеняется от сжатия (критерий Ливенгуда–Ву ≥ 1).
      Уменьши степень сжатия, наддув или опережение зажигания, либо возьми топливо
      с бо́льшим октановым числом.`,
    en: `The unburned end gas is auto-igniting under compression (Livengood–Wu integral ≥ 1).
      Lower the compression ratio, the boost or the ignition advance, or use fuel with
      a higher octane rating.`,
  },
  braking: { ru: '— торможение двигателем', en: '— engine braking' },
  knockYes: { ru: 'есть, с', en: 'yes, from' },
  knockNo: { ru: 'нет', en: 'no' },
  boostNone: { ru: 'атмосферный', en: 'naturally aspirated' },
  withIC: { ru: ', интеркулер', en: ', intercooler' },
  withoutIC: { ru: ', без охлаждения', en: ', no charge cooling' },
  none: { ru: 'нет', en: 'none' },
  panelOpen: { ru: 'Теория', en: 'Theory' },
  panelClose: { ru: 'Закрыть', en: 'Close' },
  hp: { ru: 'л.с.', en: 'hp' },
  units: {
    kw: { ru: 'кВт', en: 'kW' },
    nm: { ru: 'Н·м', en: 'N·m' },
    bar: { ru: 'бар', en: 'bar' },
    rpm: { ru: 'об/мин', en: 'rpm' },
    deg: { ru: '°', en: '°' },
    litre: { ru: 'л', en: 'L' },
    joule: { ru: 'Дж', en: 'J' },
    ms: { ru: 'м/с', en: 'm/s' },
    gkwh: { ru: 'г/(кВт·ч)', en: 'g/(kW·h)' },
    at: { ru: 'при', en: 'at' },
    ms_: { ru: 'мс', en: 'ms' },
    mm: { ru: 'мм', en: 'mm' },
  },
};

/** Короткий помощник: t() поверх словаря выше. */
export const tr = t;
