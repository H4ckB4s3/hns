// spam.js - Cosanostr spam filter + Explore filter panel
// Exposes:
//   window.SpamFilter.shouldHide(event)          -> boolean
//   window.SpamFilter.score(event)               -> number
//   window.ExploreFilter.shouldHide(event, text) -> boolean  (applies user's filter)
//   window.ExploreFilter.open()                  -> opens the filter modal
//   window.ExploreFilter.apply()                 -> reads UI + saves
//   window.ExploreFilter.load()                  -> returns current settings
(function () {
  'use strict';

  // ---- Spam heuristics ----
  const SPAM_WORDS = [
    'free crypto', 'airdrop', 'giveaway', 'double your', 'click here to claim',
    'telegram.me/+', 't.me/+', 'dm me to earn', 'guaranteed profit',
    '1000x', '100x gem', 'pump signal', 'presale', 'whitelist spot',
    'onlyfans', 'escort', 'casino bonus', 'betting tips', 'forex signals'
  ];

  const URL_RE = /https?:\/\/[^\s]+/gi;

  const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i' };

  function normalize(text) {
    let t = (text || '').toLowerCase();
    t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
    t = t.replace(/[аеорсхі]/g, ch => CONFUSABLES[ch] || ch);
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function countUrls(text) {
    const m = (text || '').match(URL_RE);
    return m ? m.length : 0;
  }

  function hasNoSpaceRun(text) {
    return /(^|\s)\S{60,}(\s|$)/.test(text || '');
  }

  function repeatedChars(text) {
    return /(.)\1{7,}/.test(text || '');
  }

  function tooManyHashtags(text) {
    const m = (text || '').match(/#[^\s#]+/g);
    return m ? m.length : 0;
  }

  function score(event) {
    if (!event || typeof event.content !== 'string') return 0;
    const raw = event.content;
    const t = normalize(raw);
    let s = 0;

    for (const w of SPAM_WORDS) {
      if (t.includes(w)) s += 3;
    }

    const urls = countUrls(raw);
    if (urls >= 3) s += 2;
    if (urls >= 6) s += 3;

    const tags = tooManyHashtags(raw);
    if (tags >= 6) s += 2;
    if (tags >= 12) s += 2;

    if (hasNoSpaceRun(raw)) s += 2;
    if (repeatedChars(raw)) s += 2;

    const textOnly = raw.replace(URL_RE, '').trim();
    if (urls >= 1 && textOnly.length < 12) s += 2;

    const letters = raw.replace(/[^A-Za-z]/g, '');
    if (letters.length > 20) {
      const upper = raw.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length > 0.8) s += 1;
    }

    return s;
  }

  function shouldHide(event) {
    return score(event) >= 5;
  }

  // ---- Explore filter (user-saved) ----
  const STORAGE_KEY = 'cosanostr-explore-filter';
  const DEFAULTS = {
    spam: true,
    keywords: [],
    langs: [],       // empty = allow all
    hideCode: false,
    hideNoText: false
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    } catch (e) { return { ...DEFAULTS }; }
  }

  function save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  // Very lightweight language guesser using stopwords — good enough for a filter.
  const LANG_HINTS = {
    en: ['the', 'and', 'is', 'to', 'of', 'you', 'in', 'it', 'that', 'this'],
    de: ['der', 'die', 'und', 'ist', 'nicht', 'ich', 'das', 'mit', 'ein', 'zu'],
    fr: ['le', 'la', 'et', 'les', 'des', 'est', 'une', 'pour', 'dans', 'que'],
    es: ['el', 'la', 'y', 'es', 'que', 'un', 'una', 'los', 'por', 'para'],
    it: ['il', 'la', 'e', 'che', 'non', 'di', 'un', 'una', 'per', 'con'],
    pt: ['o', 'a', 'e', 'que', 'um', 'uma', 'não', 'para', 'com', 'por'],
    nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'ik', 'op']
  };

  function guessLang(text) {
    const t = (text || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ');
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 4) return null;
    let best = null, bestScore = 0;
    for (const [lang, hints] of Object.entries(LANG_HINTS)) {
      let s = 0;
      for (const w of words) if (hints.includes(w)) s++;
      const ratio = s / words.length;
      if (ratio > bestScore) { bestScore = ratio; best = lang; }
    }
    return bestScore >= 0.08 ? best : null;
  }

  function looksLikeCode(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.startsWith('```') && t.endsWith('```')) return true;
    // Multi-line with lots of punctuation typical of code
    const lines = t.split('\n');
    if (lines.length >= 4) {
      const codeish = lines.filter(l =>
        /[{};]|=>|function\s|def\s|class\s|<\w+|#include|import\s|return\s/.test(l)
      ).length;
      if (codeish / lines.length >= 0.4) return true;
    }
    return false;
  }

  function hasOnlyLinkOrImage(text) {
    const stripped = (text || '')
      .replace(URL_RE, '')
      .replace(/\s+/g, '')
      .trim();
    return stripped.length < 3;
  }

  function shouldHideWithConfig(event, text, cfg) {
    if (!event) return false;

    if (cfg.spam && shouldHide(event)) return true;

    const lower = normalize(text || event.content || '');

    if (cfg.keywords && cfg.keywords.length) {
      for (const k of cfg.keywords) {
        if (!k) continue;
        if (lower.includes(k.toLowerCase())) return true;
      }
    }

    if (cfg.langs && cfg.langs.length) {
      const lang = guessLang(text || event.content || '');
      if (lang && !cfg.langs.includes(lang)) return true;
    }

    if (cfg.hideCode && looksLikeCode(text || event.content || '')) return true;

    if (cfg.hideNoText && hasOnlyLinkOrImage(text || event.content || '')) return true;

    return false;
  }

  // ---- UI wiring for the filter modal ----
  function openModal() {
    const modal = document.getElementById('filterModal');
    if (!modal) return;
    const cfg = load();
    const spamEl = document.getElementById('filterEnableSpam');
    const kwEl = document.getElementById('filterKeywords');
    const langEl = document.getElementById('filterLangs');
    const codeEl = document.getElementById('filterHideCode');
    const noTextEl = document.getElementById('filterHideNoText');
    if (spamEl) spamEl.checked = !!cfg.spam;
    if (kwEl) kwEl.value = (cfg.keywords || []).join(', ');
    if (langEl) langEl.value = (cfg.langs || []).join(', ');
    if (codeEl) codeEl.checked = !!cfg.hideCode;
    if (noTextEl) noTextEl.checked = !!cfg.hideNoText;
    modal.classList.add('active');
  }

  function parseList(str) {
    return String(str || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function applyFromUi() {
    const cfg = {
      spam: !!(document.getElementById('filterEnableSpam') || {}).checked,
      keywords: parseList((document.getElementById('filterKeywords') || {}).value),
      langs: parseList((document.getElementById('filterLangs') || {}).value),
      hideCode: !!(document.getElementById('filterHideCode') || {}).checked,
      hideNoText: !!(document.getElementById('filterHideNoText') || {}).checked
    };
    save(cfg);
    const modal = document.getElementById('filterModal');
    if (modal) modal.classList.remove('active');
    // Re-render explore
    if (typeof window.renderExplore === 'function') {
      window.renderExplore();
    }
  }

  function resetFromUi() {
    save({ ...DEFAULTS });
    const modal = document.getElementById('filterModal');
    if (modal) modal.classList.remove('active');
    if (typeof window.renderExplore === 'function') {
      window.renderExplore();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('closeFilter');
    if (closeBtn) closeBtn.onclick = () => {
      const m = document.getElementById('filterModal'); if (m) m.classList.remove('active');
    };
    const applyBtn = document.getElementById('filterApply');
    if (applyBtn) applyBtn.onclick = applyFromUi;
    const resetBtn = document.getElementById('filterReset');
    if (resetBtn) resetBtn.onclick = resetFromUi;
    const modal = document.getElementById('filterModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
  });

  window.SpamFilter = { score, shouldHide };
  window.ExploreFilter = {
    load,
    save,
    shouldHide: shouldHideWithConfig,
    open: openModal,
    apply: applyFromUi,
    reset: resetFromUi
  };
})();
