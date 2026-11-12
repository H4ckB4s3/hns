// spam.js - lightweight client-side spam heuristics for Cosanostr
// Usage: window.SpamFilter.shouldHide(event)  -> boolean
//        window.SpamFilter.score(event)       -> number (higher = more spammy)
(function () {
  'use strict';

  const SPAM_WORDS = [
    'free crypto', 'airdrop', 'giveaway', 'double your', 'click here to claim',
    'telegram.me/+', 't.me/+', 'dm me to earn', 'guaranteed profit',
    '1000x', '100x gem', 'pump signal', 'presale', 'whitelist spot',
    'onlyfans', 'escort', 'casino bonus', 'betting tips', 'forex signals'
  ];

  const URL_RE = /https?:\/\/[^\s]+/gi;

  // Very small set of confusables that spam uses to dodge keyword filters.
  const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i' };

  function normalize(text) {
    let t = (text || '').toLowerCase();
    // strip zero-width + bidi
    t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
    // collapse confusables
    t = t.replace(/[аеорсхі]/g, ch => CONFUSABLES[ch] || ch);
    // collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function countUrls(text) {
    const m = (text || '').match(URL_RE);
    return m ? m.length : 0;
  }

  function hasNoSpaceRun(text) {
    // a single token of 60+ chars with no whitespace is often spam/paste
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

    // mostly-URL post with almost no text
    const textOnly = raw.replace(URL_RE, '').trim();
    if (urls >= 1 && textOnly.length < 12) s += 2;

    // all-caps shout (only if reasonably long)
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

  window.SpamFilter = { score, shouldHide };
})();
