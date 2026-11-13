// spam.js - Cosanostr spam filter + Explore filter panel
// Exposes:
//   window.SpamFilter.shouldHide(event)          -> boolean
//   window.SpamFilter.score(event)               -> number
//   window.ExploreFilter.shouldHide(event,text,cfg) -> boolean
//   window.ExploreFilter.open() / apply() / reset() / load()
(function () {
  'use strict';

  // ---------- Heuristics ----------
  const SPAM_WORDS = [
    'free crypto', 'airdrop', 'giveaway', 'double your', 'click here to claim',
    'telegram.me/+', 't.me/+', 'dm me to earn', 'guaranteed profit',
    '1000x', '100x gem', 'pump signal', 'presale', 'whitelist spot',
    'onlyfans', 'escort', 'casino bonus', 'betting tips', 'forex signals'
  ];

  const URL_RE = /https?:\/\/[^\s]+/gi;
  const BASE64_CHARS = /[A-Za-z0-9+/=]/;

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

  // ---- Base64 / encoded-blob detector ----
  // Matches long runs that are essentially base64 noise with no word structure.
  function looksLikeEncodedBlob(text) {
    if (!text || text.length < 180) return false;
    const trimmed = text.trim();

    // Case 1: one long unbroken run of base64-ish characters
    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
      const noWs = trimmed.replace(/\s+/g, '');
      if (noWs.length >= 180) {
        // count how many are actual base64 chars — should be ~100%
        let b64 = 0;
        for (const ch of noWs) if (BASE64_CHARS.test(ch)) b64++;
        const ratio = b64 / noWs.length;
        // high b64 ratio, very few real words → blob
        const wordMatches = noWs.match(/[A-Za-z]{3,}/g) || [];
        const bigWords = wordMatches.filter(w => /[aeiouAEIOU]/.test(w) && w.length >= 4);
        if (ratio > 0.95 && bigWords.length <= Math.floor(noWs.length / 200)) {
          return true;
        }
      }
    }

    // Case 2: multiple lines of base64 separated by whitespace
    const lines = trimmed.split(/\s+/).filter(Boolean);
    if (lines.length >= 3) {
      const longLines = lines.filter(l => l.length >= 60 && /^[A-Za-z0-9+/=]+$/.test(l));
      if (longLines.length >= 3 &&
          longLines.join('').length / trimmed.replace(/\s+/g, '').length > 0.8) {
        return true;
      }
    }

    // Case 3: JSON-ish blob with no human-readable content
    if (/^\{.*\}$/.test(trimmed) && trimmed.length > 120) {
      const inner = trimmed.replace(/[{}[\]":,]/g, ' ');
      const words = inner.match(/[A-Za-z]{4,}/g) || [];
      if (words.length < 6) return true;
    }

    return false;
  }

  // ---- No natural language (mostly symbols/digits) ----
  function looksLikeNoNaturalLanguage(text) {
    if (!text || text.length < 40) return false;
    const stripped = text.replace(/https?:\/\/\S+/g, '').trim();
    if (stripped.length < 40) return false;
    const letters = stripped.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/g) || [];
    const vowels = stripped.match(/[aeiouAEIOU\u00C0-\u024F\u0400-\u04FF]/g) || [];
    if (letters.length === 0) return true;
    const vowelRatio = vowels.length / letters.length;
    // Real languages have ~30–50% vowels in letters; below 15% strongly suggests noise.
    if (letters.length >= 30 && vowelRatio < 0.12) return true;
    return false;
  }

  // ---- Code-ish ----
  function looksLikeCode(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.startsWith('```') && t.endsWith('```')) return true;
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

  // ---- Simple language guesser ----
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

  // ---------- Score (spam heuristics) ----------
  function score(event) {
    if (!event || typeof event.content !== 'string') return 0;
    const raw = event.content;
    const t = normalize(raw);
    let s = 0;

    for (const w of SPAM_WORDS) {
      if (t.includes(w)) s += 3;
    }

    if (countUrls(raw) >= 3) s += 2;
    if (countUrls(raw) >= 6) s += 3;

    const tags = tooManyHashtags(raw);
    if (tags >= 6) s += 2;
    if (tags >= 12) s += 2;

    if (hasNoSpaceRun(raw)) s += 2;
    if (repeatedChars(raw)) s += 2;

    if (countUrls(raw) >= 1 && raw.replace(URL_RE, '').trim().length < 12) s += 2;

    const letters = raw.replace(/[^A-Za-z]/g, '');
    if (letters.length > 20) {
      const upper = raw.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length > 0.8) s += 1;
    }

    // Base64 blob / no natural language / code also count as spam by default
    if (looksLikeEncodedBlob(raw)) s += 6;
    if (looksLikeNoNaturalLanguage(raw)) s += 4;
    if (looksLikeCode(raw)) s += 3;

    return s;
  }

  function shouldHide(event) {
    return score(event) >= 5;
  }

  // ---------- Explore filter config ----------
  const STORAGE_KEY = 'cosanostr-explore-filter';
  const DEFAULTS = {
    spam: true,
    hideBlobs: true,
    hideNoNaturalLanguage: true,
    hideCode: false,
    hideNoText: false,
    keywords: [],
    keywordsSubstring: false,
    langs: []
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

  function matchKeywords(lower, cfg) {
    if (!cfg.keywords || !cfg.keywords.length) return false;
    for (const k of cfg.keywords) {
      if (!k) continue;
      const kk = k.toLowerCase();
      if (cfg.keywordsSubstring) {
        if (lower.includes(kk)) return true;
      } else {
        // whole-word match
        const re = new RegExp('(^|[^\\p{L}\\p{N}_])' + kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\p{L}\\p{N}_]|$)', 'u');
        if (re.test(lower)) return true;
      }
    }
    return false;
  }

  function shouldHideWithConfig(event, text, cfg) {
    if (!event) return false;
    const raw = text || event.content || '';

    // blobs, no-natural-language, and code have their own toggles
    if (cfg.hideBlobs && looksLikeEncodedBlob(raw)) return true;
    if (cfg.hideNoNaturalLanguage && looksLikeNoNaturalLanguage(raw)) return true;
    if (cfg.hideCode && looksLikeCode(raw)) return true;
    if (cfg.hideNoText && hasOnlyLinkOrImage(raw)) return true;

    // general spam heuristics
    if (cfg.spam && shouldHide(event)) return true;

    const lower = normalize(raw);
    if (matchKeywords(lower, cfg)) return true;

    if (cfg.langs && cfg.langs.length) {
      const lang = guessLang(raw);
      if (lang && !cfg.langs.includes(lang)) return true;
    }
    return false;
  }

  // ---------- Modal ----------
  function openModal() {
    const modal = document.getElementById('filterModal');
    if (!modal) return;
    const cfg = load();
    const $ = id => document.getElementById(id);

    if ($('filterEnableSpam')) $('filterEnableSpam').checked = !!cfg.spam;
    if ($('filterHideBlobs')) $('filterHideBlobs').checked = !!cfg.hideBlobs;
    if ($('filterHideNoNatural')) $('filterHideNoNatural').checked = !!cfg.hideNoNaturalLanguage;
    if ($('filterHideCode')) $('filterHideCode').checked = !!cfg.hideCode;
    if ($('filterHideNoText')) $('filterHideNoText').checked = !!cfg.hideNoText;
    if ($('filterKeywords')) $('filterKeywords').value = (cfg.keywords || []).join(', ');
    if ($('filterKeywordsSubstring')) $('filterKeywordsSubstring').checked = !!cfg.keywordsSubstring;
    if ($('filterLangs')) $('filterLangs').value = (cfg.langs || []).join(', ');

    modal.classList.add('active');
  }

  function parseList(str) {
    return String(str || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function applyFromUi() {
    const $ = id => document.getElementById(id);
    const cfg = {
      spam: !!($('filterEnableSpam') || {}).checked,
      hideBlobs: !!($('filterHideBlobs') || {}).checked,
      hideNoNaturalLanguage: !!($('filterHideNoNatural') || {}).checked,
      hideCode: !!($('filterHideCode') || {}).checked,
      hideNoText: !!($('filterHideNoText') || {}).checked,
      keywords: parseList(($('filterKeywords') || {}).value),
      keywordsSubstring: !!($('filterKeywordsSubstring') || {}).checked,
      langs: parseList(($('filterLangs') || {}).value)
    };
    save(cfg);
    const modal = document.getElementById('filterModal');
    if (modal) modal.classList.remove('active');
    if (typeof window.renderExplore === 'function') window.renderExplore();
  }

  function resetFromUi() {
    save({ ...DEFAULTS });
    const modal = document.getElementById('filterModal');
    if (modal) modal.classList.remove('active');
    if (typeof window.renderExplore === 'function') window.renderExplore();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    if ($('closeFilter')) $('closeFilter').onclick = () => {
      const m = document.getElementById('filterModal'); if (m) m.classList.remove('active');
    };
    if ($('filterApply')) $('filterApply').onclick = applyFromUi;
    if ($('filterReset')) $('filterReset').onclick = resetFromUi;
    const modal = document.getElementById('filterModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
  });

  window.SpamFilter = { score, shouldHide, looksLikeEncodedBlob, looksLikeNoNaturalLanguage, looksLikeCode };
  window.ExploreFilter = {
    load, save, shouldHide: shouldHideWithConfig, open: openModal, apply: applyFromUi, reset: resetFromUi
  };
})();
