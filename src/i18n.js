/**
 * Переключение языка интерфейса. Модули не держат общего словаря:
 * каждый хранит свои строки парами { ru, en } и достаёт их через t().
 *
 * Язык берётся из ссылки (?lang=en), затем из localStorage, затем из языка браузера.
 */

const LANGS = ['ru', 'en'];
const KEY = 'engine-sim-lang';
const listeners = new Set();

function initial(){
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* приватный режим — просто игнорируем */ }
  return (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let lang = initial();

/** Текущий язык: 'ru' | 'en'. */
export function getLang(){ return lang; }

/** Сменить язык и оповестить подписчиков. */
export function setLang(next){
  if (!LANGS.includes(next) || next === lang) return lang;
  lang = next;
  try { localStorage.setItem(KEY, lang); } catch { /* не критично */ }
  document.documentElement.lang = lang;
  listeners.forEach(cb => { try { cb(lang); } catch (e) { console.warn(e); } });
  return lang;
}

/** Подписка на смену языка; возвращает функцию отписки. */
export function onLangChange(cb){
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Выбор строки по текущему языку: t({ ru: 'Обороты', en: 'Speed' }).
 * Терпит отсутствие перевода и обычную строку вместо пары.
 */
export function t(dict){
  if (typeof dict === 'string') return dict;
  if (!dict) return '';
  return dict[lang] ?? dict.ru ?? dict.en ?? '';
}

/**
 * Проставляет тексты в разметке: элементы с data-ru / data-en.
 * data-html="1" — вставлять как HTML, иначе как текст.
 */
export function applyDom(root = document){
  root.querySelectorAll('[data-ru]').forEach(el => {
    const s = el.dataset[lang] ?? el.dataset.ru;
    if (s === undefined) return;
    if (el.dataset.html === '1') el.innerHTML = s;
    else el.textContent = s;
  });
  root.querySelectorAll('[data-ru-title]').forEach(el => {
    el.title = (lang === 'en' ? el.dataset.enTitle : el.dataset.ruTitle) || el.dataset.ruTitle || '';
  });
}

/** Число с локальным десятичным разделителем. */
export function num(v, digits = 1){
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return lang === 'ru' ? s.replace('.', ',') : s;
}

document.documentElement.lang = lang;
