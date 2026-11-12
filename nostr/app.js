// app.js - Cosanostr Nostr Client

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://purplepag.es'
];

const DEFAULT_DOH_BASE = 'https://api.web3dns.net/?name=';
const DEFAULT_DOH_ENDPOINTS = [DEFAULT_DOH_BASE];

const DEFAULT_NIP05_API = (function () {
  const p = location.protocol === 'https:' ? 'https://cosanostr' :
            location.protocol === 'http:' ? 'http://cosanostr' : 'http://127.0.0.1:3000';
  return p;
})();

const DEFAULT_DNS_SERVERS = [
  { ip: '82.68.70.162', label: 'James Stevens Primary (HNS/DNS/ENS)' },
  { ip: '82.68.70.163', label: 'James Stevens Secondary (HNS/DNS/ENS)' },
  { ip: '51.24.7.1', label: 'EasyHNS (HNS/DNS)' },
  { ip: '9.9.9.9', label: 'Quad9 (DNS)' },
  { ip: '1.1.1.1', label: 'Cloudflare (DNS)' },
  { ip: '8.8.8.8', label: 'Google (DNS)' }
];

let relays = JSON.parse(localStorage.getItem('cosanostr-relays') || 'null') || [...DEFAULT_RELAYS];
let dnsServers = JSON.parse(localStorage.getItem('cosanostr-dns') || 'null') || [...DEFAULT_DNS_SERVERS];
let nip05ApiUrl = localStorage.getItem('cosanostr-nip05-api') || DEFAULT_NIP05_API;

// DoH endpoints list (with one-shot migration from legacy key)
let dohEndpoints = (function () {
  try {
    const list = JSON.parse(localStorage.getItem('cosanostr-doh-endpoints') || 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch (e) {}
  const legacy = localStorage.getItem('cosanostr-doh');
  if (legacy) {
    const m = legacy.match(/^(.*\?name=)/);
    return [m ? m[1] : DEFAULT_DOH_BASE];
  }
  return [...DEFAULT_DOH_ENDPOINTS];
})();

let sockets = [];
let relaysConnecting = null;
let currentUser = null;
let encryptedKey = null;
let theme = localStorage.getItem('cosanostr-theme') || 'dark';
let profileCache = new Map();

// local profile meta (domain + nip05) keyed by pubhex
function loadLocalProfileMeta() {
  try { return JSON.parse(localStorage.getItem('cosanostr-profile-meta') || '{}'); }
  catch (e) { return {}; }
}
function saveLocalProfileMeta(obj) {
  localStorage.setItem('cosanostr-profile-meta', JSON.stringify(obj));
}
function getLocalProfileMeta(hex) {
  if (!hex) return {};
  const all = loadLocalProfileMeta();
  return all[hex] || {};
}

// bookmarks (local)
let bookmarks = (function () {
  try {
    const a = JSON.parse(localStorage.getItem('cosanostr-bookmarks') || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
})();
function saveBookmarks() {
  localStorage.setItem('cosanostr-bookmarks', JSON.stringify(bookmarks));
}
function isBookmarked(id) { return bookmarks.some(b => b.id === id); }
function toggleBookmark(event) {
  const i = bookmarks.findIndex(b => b.id === event.id);
  if (i !== -1) bookmarks.splice(i, 1);
  else bookmarks.unshift({ id: event.id, event, savedAt: Date.now() });
  saveBookmarks();
  refreshBookmarkButtons(event.id);
}
function refreshBookmarkButtons(id) {
  document.querySelectorAll(`.note[data-id="${id}"] .note-action.bookmark`)
    .forEach(b => b.classList.toggle('saved', isBookmarked(id)));
}

const txtCache = new Map();
const TXT_TTL_MS = 5 * 60 * 1000;

let following = loadFollowing();
let currentQrOptions = [];
let activeQrType = 'npub';
let currentQrValue = '';
let homeFeedCursor = null;
let homeFeedHasMore = true;
let homeFeedLoading = false;
let pendingFocusNoteId = null;
let preloadNoteForProfile = null;

const content = document.getElementById('content');
const searchInput = document.getElementById('searchInput');
const loginModal = document.getElementById('loginModal');
const qrModal = document.getElementById('qrModal');
const authNav = document.getElementById('authNav');
const sidebar = document.getElementById('sidebar');

document.documentElement.setAttribute('data-theme', theme);

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
  if (window.QrScanner && window.QrScanner.WORKER_PATH === undefined) {
    try { window.QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js'; } catch (e) {}
  }
  setupNavigation();
  setupSearch();
  setupModals();
  setupMobileMenu();
  setupQrModal();
  setupScannerModal();
  setupNostrLinkDelegation();
  setupRelayCardLink();

  const unlocked = await tryAutoUnlock();
  updateAuthNav();

  await connectRelays();
  showView('home');
  hydrateFollowingMetadata();
  refreshRightFollowingFeed();

  // First-visit / logged-out → prompt login directly.
  if (!unlocked && !currentUser) {
    openLoginModal();
  }
});

function setupRelayCardLink() {
  const c = document.getElementById('relaysCard');
  if (c) c.addEventListener('click', () => showView('settings'));
}

// Global delegated handler for `nostr:npub…` / `nostr:nprofile…` links.
function setupNostrLinkDelegation() {
  content.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.nostr-ref');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const ent = a.dataset.nostr;
    const npub = ent.startsWith('nprofile1') ? nprofileToNpub(ent) : ent;
    if (!npub) return;
    if (window.currentProfileNpub === npub) return;
    showProfile(npub);
  }, true);
}

function setupMobileMenu() {
  const btn = document.getElementById('mobileMenuBtn');
  if (btn) btn.onclick = () => sidebar.classList.toggle('open');
  const logo = document.getElementById('logo');
  if (logo) logo.onclick = () => sidebar.classList.toggle('open');
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const view = el.dataset.view;
      if (!view) return;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      el.classList.add('active');
      showView(view);
      sidebar.classList.remove('open');
    });
  });
}

function updateAuthNav() {
  if (currentUser) {
    authNav.innerHTML = `
      <a class="nav-item" id="logoutNav" style="color:var(--danger);"><svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg><span class="nav-label">Log out</span></a>
      <button id="postBtnNav" class="post-nav-btn">
        <span class="post-nav-label">Post</span>
        <svg class="post-nav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>
        </svg>
      </button>
    `;
    document.getElementById('logoutNav').onclick = logout;
    document.getElementById('postBtnNav').onclick = () => showView('home');
  } else {
    authNav.innerHTML = `<a class="nav-item" id="loginNav"><svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg><span class="nav-label">Log in / Create account</span></a>`;
    document.getElementById('loginNav').onclick = () => openLoginModal();
  }
}

// ========== SEARCH ==========
function setupSearch() {
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => handleSearchInput(), 400);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); performSearch(searchInput.value.trim()); }
  });
  const go = document.getElementById('searchGoBtn');
  if (go) go.onclick = () => performSearch(searchInput.value.trim());
  const scan = document.getElementById('searchScanBtn');
  if (scan) scan.onclick = () => openScanner();
}

async function handleSearchInput() {
  const query = searchInput.value.trim();
  searchInput.classList.remove('valid');
  if (!query) return;

  // 1) npub / nprofile
  if (query.startsWith('npub') || query.startsWith('nprofile')) {
    searchInput.classList.add('valid');
    return;
  }

  // 2) NIP-05 (user@domain)
  if (query.includes('@')) {
    const at = query.lastIndexOf('@');
    const user = query.slice(0, at);
    const host = query.slice(at + 1);
    if (user && host && host.includes('.')) { searchInput.classList.add('valid'); return; }
  }

  // 3) domain TXT (plain domain, *.cosanostr, cosanostr/sld.tld)
  const norm = normalizeDomainQuery(query);
  if (norm && norm.domain.includes('.')) {
    const hasRecord = await checkDomainForNostr(norm.domain);
    if (hasRecord) searchInput.classList.add('valid');
  }
}

// handle `*.cosanostr` and `cosanostr/sld.tld`, plus plain domains
function normalizeDomainQuery(query) {
  if (!query) return null;
  let q = query.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (!q) return null;

  // cosanostr/sld.tld -> sld.tld
  const slash = q.indexOf('/');
  if (slash !== -1) {
    const left = q.slice(0, slash);
    const right = q.slice(slash + 1);
    if (left === 'cosanostr' && right) return { domain: right, displayName: right };
    return null;
  }

  // foo.cosanostr -> foo
  if (q.endsWith('.cosanostr') && q.length > '.cosanostr'.length) {
    const d = q.slice(0, -'.cosanostr'.length);
    return { domain: d, displayName: d };
  }

  // plain domain
  if (q.includes('.') && !q.includes('@')) return { domain: q, displayName: q };
  return null;
}

async function checkDomainForNostr(domain) {
  try {
    const records = await fetchTXTRecords(domain);
    if (!records) return false;
    return records.some(r => extractNpubFromTxt(r));
  } catch (e) { return false; }
}

async function performSearch(query) {
  if (!query) return;

  // 1) npub / nprofile
  if (query.startsWith('npub') || query.startsWith('nprofile')) {
    showProfile(query);
    return;
  }

  // 2) NIP-05 (user@domain)
  if (query.includes('@')) {
    const at = query.lastIndexOf('@');
    const user = query.slice(0, at);
    const host = query.slice(at + 1);
    if (!user || !host) { alert('Invalid identifier'); return; }

    const nip05 = `${user}@${host}`;
    let nip05Npub = null;
    try { nip05Npub = await resolveNip05(user, host); } catch (e) { console.warn(e); }
    if (nip05Npub) { showProfile(nip05Npub, host, nip05); return; }

    // fallback: domain TXT
    let txtDirect = null;
    try { txtDirect = await resolveDomainToNpub(host); } catch (e) { console.warn(e); }
    if (txtDirect) { showProfile(txtDirect, host, nip05); return; }

    alert(`Could not resolve ${query}`);
    return;
  }

  // 3) domain TXT (incl. *.cosanostr and cosanostr/sld.tld)
  const norm = normalizeDomainQuery(query);
  if (norm) {
    const npub = await resolveDomainToNpub(norm.domain);
    if (npub) { showProfile(npub, norm.displayName); return; }
  }

  // 4) free-text note search
  searchNotes(query);
}

// ========== DNS ==========
async function fetchTXTRecords(domain) {
  if (!domain || domain.includes('@')) return null;
  const now = Date.now();
  const hit = txtCache.get(domain);
  if (hit && (now - hit.ts) < TXT_TTL_MS) return hit.records;

  const cacheBuster = Date.now();
  const endpoints = dohEndpoints.length ? dohEndpoints : [DEFAULT_DOH_BASE];
  for (const base of endpoints) {
    const b = base.endsWith('=') || base.endsWith('name=') ? base : base + (base.includes('?') ? '&name=' : '?name=');
    const url = `${b}${encodeURIComponent(domain)}&type=TXT&_=${cacheBuster}`;
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'application/dns-json' }, cache: 'no-store' });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && data.Answer) {
        const records = data.Answer.filter(r => r.type === 16).map(r => String(r.data).replace(/"/g, ''));
        txtCache.set(domain, { records, ts: now });
        return records;
      }
    } catch (e) { console.warn('DoH fetch failed via', base, e.message); }
  }
  return null;
}

function extractNpubFromTxt(rec) {
  if (!rec) return null;
  const m = rec.match(/nostr\s*[:=]\s*(npub1[a-z0-9]+)/i)
         || rec.match(/^(npub1[a-z0-9]{58,})$/i)
         || rec.match(/\b(npub1[a-z0-9]{58,})\b/i);
  if (!m) return null;
  const npub = m[1].toLowerCase();
  return npubToHexLenient(npub) ? npub : null;
}

async function resolveDomainToNpub(domain) {
  const records = await fetchTXTRecords(domain);
  if (!records) return null;
  for (const rec of records) {
    const npub = extractNpubFromTxt(rec);
    if (npub) return npub;
  }
  return null;
}

function npubFromNip05Entry(hit) {
  if (!hit) return null;
  if (typeof hit === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(hit)) return NostrCrypto.hexToNpub(hit) || null;
    if (hit.startsWith('npub1') && npubToHexLenient(hit.toLowerCase())) return hit.toLowerCase();
    return null;
  }
  if (typeof hit === 'object') {
    for (const k of ['npub', 'pubkey', 'hex']) {
      const v = hit[k];
      if (typeof v !== 'string') continue;
      if (/^[0-9a-fA-F]{64}$/.test(v)) {
        const npub = NostrCrypto.hexToNpub(v);
        if (npub) return npub;
      }
      if (v.startsWith('npub1') && npubToHexLenient(v.toLowerCase())) return v.toLowerCase();
    }
  }
  return null;
}

async function fetchWellKnownNames(host) {
  const url = `https://${host}/.well-known/nostr.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const body = await resp.json();
    if (body && typeof body === 'object' && body.names && typeof body.names === 'object') return body.names;
    if (body && typeof body === 'object') return body;
  } catch (e) {
    console.warn(`[nip05] fetch failed for ${url}`, e.message);
  }
  return null;
}

function lookupName(names, user, host) {
  if (!names || typeof names !== 'object') return null;
  const keys = [user, `${user}@${host}`];
  for (const k of keys) {
    const hit = names[k];
    if (!hit) continue;
    const npub = npubFromNip05Entry(hit);
    if (npub) return npub;
  }
  return null;
}

async function resolveNip05(user, domain) {
  if (!domain || domain.includes('@')) return null;
  const nip05 = `${user}@${domain}`;

  if (nip05ApiUrl && dnsServers.length) {
    for (const srv of dnsServers) {
      try {
        const resp = await fetch(`${nip05ApiUrl.replace(/\/$/, '')}/api/nip05/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ nip05, dns: srv.ip, allowLocal: !!srv.local })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data && data.hex) {
          const npub = NostrCrypto.hexToNpub(data.hex) || data.npub;
          if (npub) return npub;
        }
        if (data && data.npub) return data.npub;
      } catch (e) {
        console.warn(`[nip05] API resolve failed with ${srv.ip}`, e.message);
      }
    }
  }
  const names = await fetchWellKnownNames(domain);
  if (!names) return null;
  return lookupName(names, user, domain);
}

// ========== FOLLOWING (local) ==========
function loadFollowing() {
  try {
    const raw = localStorage.getItem('cosanostr-following');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(f => f && typeof f.npub === 'string') : [];
  } catch (e) { return []; }
}
function saveFollowing() {
  try { localStorage.setItem('cosanostr-following', JSON.stringify(following)); }
  catch (e) { console.warn('Could not save following', e); }
}
function isFollowing(npub) {
  if (!npub || !Array.isArray(following)) return false;
  return following.some(f => f.npub === npub);
}
function addFollow({ npub, domain = null, nip05 = null }) {
  if (!npub) return;
  if (!Array.isArray(following)) following = [];
  const npubLower = String(npub).toLowerCase();
  const domainLower = domain ? String(domain).toLowerCase() : null;
  const nip05Lower = nip05 ? String(nip05).toLowerCase() : null;
  const next = {
    npub: npubLower, domain: domainLower, nip05: nip05Lower,
    type: domainLower ? 'domain' : (nip05Lower ? 'nip05' : 'npub'),
    addedAt: Date.now()
  };
  const existing = following.find(f => f.npub === npubLower);
  if (existing) {
    const rank = t => t === 'domain' ? 3 : t === 'nip05' ? 2 : 1;
    if (rank(next.type) >= rank(existing.type)) Object.assign(existing, next);
  } else following.push(next);
  saveFollowing();
  const hex = npubToHexLenient(npubLower);
  if (hex && !profileCache.has(hex)) {
    fetchAndCacheProfileMeta(hex).then(() => {
      renderFollowingListIfOpen();
      refreshRightFollowingFeed();
    });
  }
  renderFollowingListIfOpen();
  if (document.querySelector('.nav-item.active[data-view="home"]')) renderHome();
  refreshRightFollowingFeed();
}
function removeFollow(npub) {
  if (!Array.isArray(following)) return;
  const npubLower = String(npub || '').toLowerCase();
  const i = following.findIndex(f => f.npub === npubLower);
  if (i !== -1) { following.splice(i, 1); saveFollowing(); }
  renderFollowingListIfOpen();
  if (document.querySelector('.nav-item.active[data-view="home"]')) renderHome();
  refreshRightFollowingFeed();
}
async function fetchAndCacheProfileMeta(hex) {
  if (!hex) return null;
  if (profileCache.has(hex)) return profileCache.get(hex);
  try {
    const events = await queryRelays({ authors: [hex], kinds: [0], limit: 1 });
    if (!events.length) return null;
    events.sort((a, b) => b.created_at - a.created_at);
    const meta = JSON.parse(events[0].content);
    profileCache.set(hex, meta);
    return meta;
  } catch (e) { return null; }
}
async function hydrateFollowingMetadata() {
  if (!following.length) return;
  const need = [];
  following.forEach(f => {
    const hex = npubToHexLenient(f.npub);
    if (hex && !profileCache.has(hex)) need.push(hex);
  });
  if (!need.length) return;
  await Promise.all(need.map(h => fetchAndCacheProfileMeta(h)));
  renderFollowingListIfOpen();
  refreshRightFollowingFeed();
}
async function hydrateNoteAuthors(events) {
  const need = new Set();
  events.forEach(ev => {
    if (ev.pubkey && !profileCache.has(ev.pubkey)) need.add(ev.pubkey);
  });
  if (!need.size) return;
  try {
    const metas = await queryRelays({ authors: Array.from(need), kinds: [0], limit: 50 });
    metas.sort((a, b) => b.created_at - a.created_at);
    metas.forEach(m => {
      if (profileCache.has(m.pubkey)) return;
      try { profileCache.set(m.pubkey, JSON.parse(m.content)); } catch (e) {}
    });
  } catch (e) {}

  document.querySelectorAll('.note[data-pubkey]').forEach(node => {
    const hex = node.dataset.pubkey;
    const meta = profileCache.get(hex) || {};
    const name = meta.name || meta.display_name;
    const pic = meta.picture;
    if (name) {
      const nameEl = node.querySelector('.note-name');
      if (nameEl) nameEl.textContent = name;
    }
    if (pic) {
      const avatarEl = node.querySelector('.avatar');
      if (avatarEl && !avatarEl.querySelector('img')) {
        avatarEl.innerHTML = `<img src="${escapeAttr(pic)}" onerror="this.style.display='none'">`;
      }
    }
    const handleEl = node.querySelector('.note-handle');
    if (handleEl) {
      const npub = NostrCrypto.hexToNpub(hex);
      if (npub) handleEl.textContent = `@${shortenNpub(npub)}`;
    }
  });
}
function exportFollowing() {
  if (!following.length) { alert('You are not following anyone yet.'); return; }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    following: following.map(f => ({
      npub: f.npub, domain: f.domain || null, nip05: f.nip05 || null,
      type: f.type || (f.domain ? 'domain' : f.nip05 ? 'nip05' : 'npub'),
      addedAt: f.addedAt || Date.now()
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cosanostr-following-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
async function importFollowingFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.following || []);
    if (!Array.isArray(list) || !list.length) { alert('No valid entries in the file.'); return; }
    let added = 0, updated = 0;
    for (const item of list) {
      if (!item || typeof item.npub !== 'string') continue;
      const npub = item.npub.trim().toLowerCase();
      if (!npubToHexLenient(npub)) continue;
      const domain = item.domain ? String(item.domain).toLowerCase() : null;
      const nip05 = item.nip05 ? String(item.nip05).toLowerCase() : null;
      const next = {
        npub, domain, nip05,
        type: domain ? 'domain' : (nip05 ? 'nip05' : 'npub'),
        addedAt: item.addedAt || Date.now()
      };
      const existing = following.find(f => f.npub === npub);
      if (existing) {
        const rank = t => t === 'domain' ? 3 : t === 'nip05' ? 2 : 1;
        if (rank(next.type) >= rank(existing.type)) { Object.assign(existing, next); updated++; }
      } else { following.push(next); added++; }
    }
    saveFollowing();
    renderFollowingListIfOpen();
    if (document.querySelector('.nav-item.active[data-view="home"]')) renderHome();
    refreshRightFollowingFeed();
    hydrateFollowingMetadata();
    alert(`Imported ${added} new, updated ${updated}.`);
  } catch (e) { alert('Import failed: ' + e.message); }
}

// ========== RELAYS ==========
function connectRelay(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    let settled = false, ws;
    try { ws = new WebSocket(url); } catch (e) { return resolve(null); }
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? ws : null);
    };
    const timer = setTimeout(() => { try { ws.close(); } catch(e) {} done(false); }, timeoutMs);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
    ws.addEventListener('message', (e) => { try { handleRelayMessage(e.data); } catch (err) {} });
  });
}
async function connectRelays() {
  if (relaysConnecting) return relaysConnecting;
  const promise = (async () => {
    const liveUrls = new Set(
      sockets.filter(s => s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)
        .map(s => s.url)
    );
    const toOpen = relays.filter(u => !liveUrls.has(u));
    if (toOpen.length) {
      const opened = await Promise.all(toOpen.map(u => connectRelay(u)));
      sockets = sockets.concat(opened.filter(Boolean));
    }
    sockets = sockets.filter(s => s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING);
    updateRelayStatus();
    return sockets.filter(s => s.readyState === WebSocket.OPEN).length;
  })();
  relaysConnecting = promise;
  try { return await promise; }
  finally { if (relaysConnecting === promise) relaysConnecting = null; }
}
function updateRelayStatus() {
  const open = sockets.filter(s => s.readyState === WebSocket.OPEN).length;
  const el = document.getElementById('relayStatus');
  if (el) el.textContent = `${open}/${relays.length} relays connected`;
}
function handleRelayMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg[0] !== 'EVENT') return;
    const event = msg[2];
    if (event.kind === 0) {
      try {
        const meta = JSON.parse(event.content);
        profileCache.set(event.pubkey, meta);
        if (following.some(f => npubToHexLenient(f.npub) === event.pubkey)) {
          renderFollowingListIfOpen();
        }
      } catch (e) {}
      return;
    }
    if (event.kind === 1) {
      const feed = document.getElementById('feed');
      if (!feed) return;
      const onProfile = window.currentProfileHex && window.currentProfileHex === event.pubkey;
      if (onProfile) {
        if (!profilePosts.find(p => p.id === event.id)) {
          profilePosts.push(event);
          profilePosts.sort((a, b) => b.created_at - a.created_at);
          renderNote(event, true);
        }
      } else if (!window.currentProfileHex) {
        const active = document.querySelector('.nav-item.active');
        const view = active ? active.dataset.view : null;
        if (view === 'explore') {
          if (!feed.querySelector(`[data-id="${event.id}"]`) && !(window.SpamFilter && window.SpamFilter.shouldHide(event)))
            renderNote(event);
        } else if (view === 'home') {
          const followed = following.some(f => npubToHexLenient(f.npub) === event.pubkey);
          if (followed && !feed.querySelector(`[data-id="${event.id}"]`)) renderNote(event);
        }
      }
    }
  } catch (e) {}
}
function queryRelays(filter, timeoutMs = 12000) {
  const live = sockets.filter(s => s.readyState === WebSocket.OPEN);
  if (live.length === 0) return Promise.resolve([]);
  return new Promise(resolve => {
    const subId = 'sub-' + Math.random().toString(36).slice(2);
    const listeners = [];
    const events = new Map();
    let pending = live.length, finished = false, timer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      listeners.forEach(fn => fn());
      live.forEach(ws => {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId])); } catch(e) {}
      });
      resolve(Array.from(events.values()));
    };
    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg[0] === 'EVENT' && msg[1] === subId) events.set(msg[2].id, msg[2]);
      else if (msg[0] === 'EOSE' && msg[1] === subId) { if (--pending <= 0) finish(); }
    };
    live.forEach(ws => {
      ws.addEventListener('message', handler);
      listeners.push(() => ws.removeEventListener('message', handler));
      try { ws.send(JSON.stringify(['REQ', subId, filter])); } catch(e) {}
    });
    timer = setTimeout(finish, timeoutMs);
  });
}
function queryRelaysLive(filter, subId = null) {
  const id = subId || 'sub-' + Math.random().toString(36).slice(2);
  sockets.filter(s => s.readyState === 1).forEach(ws => {
    try { ws.send(JSON.stringify(['REQ', id, filter])); } catch(e) {}
  });
  setTimeout(() => {
    sockets.forEach(ws => {
      if (ws.readyState === 1) { try { ws.send(JSON.stringify(['CLOSE', id])); } catch(e) {} }
    });
  }, 10000);
  return id;
}
async function ensureRelaysReady() {
  if (sockets.filter(s => s.readyState === WebSocket.OPEN).length === 0) {
    await connectRelays();
  }
}

// ========== VIEWS ==========
function showView(view) {
  content.innerHTML = '<div class="loader">Loading...</div>';
  switch (view) {
    case 'home':
      window.currentProfileHex = undefined;
      renderHome();
      break;
    case 'explore':
      window.currentProfileHex = undefined;
      renderExplore();
      break;
    case 'notifications':
      window.currentProfileHex = undefined;
      renderNotifications();
      break;
    case 'following':
      window.currentProfileHex = undefined;
      renderFollowingPage();
      break;
    case 'bookmarks':
      window.currentProfileHex = undefined;
      renderBookmarks();
      break;
    case 'profile':
      if (currentUser) showProfile(currentUser.npub);
      else openLoginModal();
      break;
    case 'settings':
      window.currentProfileHex = undefined;
      renderSettings();
      break;
  }
}

async function renderHome() {
  content.innerHTML = `
    <div class="composer">
      <textarea id="noteInput" placeholder="What's happening?"></textarea>
      <div class="composer-actions">
        <button id="postNote">Post</button>
      </div>
    </div>
    <div id="feed"></div>
    <div id="feedSentinel" style="height:1px;"></div>
    <div id="feedLoader" class="loader" style="display:none;">Loading more...</div>
  `;
  document.getElementById('postNote').onclick = postNote;
  homeFeedCursor = null;
  homeFeedHasMore = true;
  homeFeedLoading = false;
  if (!following.length) {
    document.getElementById('feed').innerHTML = '<div class="empty">Follow some accounts to see their posts here.<br>Use the search bar to find a profile, then hit "Follow".</div>';
    return;
  }
  await loadHomePage();
  setupInfiniteScroll();
}
function followedHexList() {
  const set = new Set();
  following.forEach(f => {
    const h = npubToHexLenient(f.npub);
    if (h) set.add(h);
  });
  return Array.from(set);
}
async function loadHomePage() {
  if (!homeFeedHasMore || homeFeedLoading) return;
  homeFeedLoading = true;
  const loader = document.getElementById('feedLoader');
  if (loader) loader.style.display = 'block';
  const authors = followedHexList();
  if (!authors.length) {
    homeFeedHasMore = false;
    homeFeedLoading = false;
    if (loader) loader.style.display = 'none';
    return;
  }
  await ensureRelaysReady();
  const filter = { authors, kinds: [1], limit: 20 };
  if (homeFeedCursor) filter.until = homeFeedCursor;
  const events = await queryRelays(filter);
  if (events.length === 0) homeFeedHasMore = false;
  else {
    events.sort((a, b) => b.created_at - a.created_at);
    const feed = document.getElementById('feed');
    events.forEach(ev => {
      if (feed.querySelector(`[data-id="${ev.id}"]`)) return;
      renderNote(ev, true);
    });
    hydrateNoteAuthors(events);
    const oldest = events[events.length - 1];
    homeFeedCursor = oldest.created_at - 1;
    if (events.length < 20) homeFeedHasMore = false;
  }
  if (loader) loader.style.display = 'none';
  homeFeedLoading = false;
  if (homeFeedHasMore) setupInfiniteScroll();
}
let homeScrollObserver = null;
function setupInfiniteScroll() {
  if (homeScrollObserver) homeScrollObserver.disconnect();
  const sentinel = document.getElementById('feedSentinel');
  if (!sentinel) return;
  homeScrollObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadHomePage();
  }, { rootMargin: '200px' });
  homeScrollObserver.observe(sentinel);
}

async function renderExplore() {
  content.innerHTML = '<div id="feed"></div>';
  await ensureRelaysReady();
  queryRelaysLive({ kinds: [1], limit: 60 });
  setTimeout(() => {
    document.querySelectorAll('#feed .note').forEach(node => {
      if (window.SpamFilter && node._event && window.SpamFilter.shouldHide(node._event)) {
        node.remove();
      }
    });
    const events = Array.from(document.querySelectorAll('.note[data-pubkey]'))
      .map(n => ({ pubkey: n.dataset.pubkey }));
    if (events.length) hydrateNoteAuthors(events);
  }, 2500);
}

async function postNote() {
  if (!currentUser) { openLoginModal(); return; }
  if (currentUser.viewOnly) { alert('View-only account — log in with a secret key to post.'); return; }
  const text = document.getElementById('noteInput').value.trim();
  if (!text) return;
  const event = {
    kind: 1, content: text,
    created_at: Math.floor(Date.now() / 1000), tags: []
  };
  let signed;
  try {
    signed = await signEventAny(event);
  } catch (e) { alert('Signing failed: ' + e.message); return; }
  if (!signed || !signed.sig || signed.sig.length !== 128) {
    alert('Signing failed: could not produce a valid signature.'); return;
  }
  const sent = sockets.filter(s => s.readyState === 1);
  if (!sent.length) { alert('Not connected to any relays — cannot publish.'); return; }
  sent.forEach(ws => { try { ws.send(JSON.stringify(['EVENT', signed])); } catch(e) {} });
  document.getElementById('noteInput').value = '';
  renderNote(signed);
}

async function signEventAny(event) {
  if (currentUser && currentUser.signer === 'nip07') {
    if (!window.nostr) throw new Error('NIP-07 signer unavailable');
    return window.nostr.signEvent(event);
  }
  return NostrCrypto.signEvent(event, currentUser.privHex);
}

// ========== NOTIFICATIONS ==========
async function renderNotifications() {
  if (!currentUser) {
    content.innerHTML = '<div class="empty">Log in to see mentions.</div>';
    return;
  }
  const myHex = currentUser.pubHex;
  const myNpub = currentUser.npub;
  const local = getLocalProfileMeta(myHex);
  const myDomain = local.domain ? String(local.domain).toLowerCase() : null;
  const myNip05 = local.nip05 ? String(local.nip05).toLowerCase() : null;

  content.innerHTML = '<div id="feed"></div>';
  await ensureRelaysReady();

  const authors = followedHexList();
  if (!authors.length) {
    content.innerHTML = '<div class="empty">Follow some accounts to see mentions here.</div>';
    return;
  }

  const pEvents = await queryRelays({ authors, kinds: [1], '#p': [myHex], limit: 50 });
  const allEvents = await queryRelays({ authors, kinds: [1], limit: 100 });
  const seen = new Set(pEvents.map(e => e.id));
  const textMentions = allEvents.filter(ev => {
    if (seen.has(ev.id)) return false;
    const c = (ev.content || '').toLowerCase();
    if (myNpub && c.includes(myNpub.toLowerCase())) return true;
    if (myDomain && c.includes(myDomain)) return true;
    if (myNip05 && c.includes(myNip05)) return true;
    return false;
  });

  const merged = [...pEvents, ...textMentions].sort((a, b) => b.created_at - a.created_at);
  const feed = document.getElementById('feed');
  if (!feed) return;
  if (!merged.length) {
    feed.innerHTML = '<div class="empty">No mentions found.</div>';
    return;
  }
  merged.forEach(ev => renderNote(ev, true));
  hydrateNoteAuthors(merged);
}

// ========== BOOKMARKS ==========
function renderBookmarks() {
  content.innerHTML = `
    <div style="padding:16px; border-bottom:1px solid var(--border); font-weight:700; font-size:1.2rem;">Bookmarks</div>
    <div id="feed"></div>
  `;
  const feed = document.getElementById('feed');
  if (!bookmarks.length) {
    feed.innerHTML = '<div class="empty">No bookmarks yet.</div>';
    return;
  }
  const events = bookmarks.map(b => b.event).sort((a, b) => b.created_at - a.created_at);
  events.forEach(ev => renderNote(ev, true));
  hydrateNoteAuthors(events);
}

// ========== FOLLOWING PAGE ==========
function renderFollowingPage() {
  loadFollowing();
  content.innerHTML = `
    <div id="followingPage"></div>
    <div class="following-toolbar">
      <button id="exportFollowingBtn" class="secondary">Export following</button>
      <button id="importFollowingBtn" class="secondary">Import following</button>
      <input type="file" id="importFollowingFile" accept="application/json,.json" style="display:none;">
    </div>
  `;
  renderFollowingListIfOpen();
  document.getElementById('exportFollowingBtn').onclick = exportFollowing;
  const fileInput = document.getElementById('importFollowingFile');
  document.getElementById('importFollowingBtn').onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importFollowingFromFile(f);
    fileInput.value = '';
  };
  hydrateFollowingMetadata();
  refreshRightFollowingFeed();
}
function followingHandle(f) {
  if (f.domain) return `@${String(f.domain).toLowerCase()}`;
  if (f.nip05) return String(f.nip05).toLowerCase();
  return `@${shortenNpub(String(f.npub || '').toLowerCase())}`;
}
function renderFollowingListIfOpen() {
  const wrap = document.getElementById('followingPage');
  if (!wrap) return;
  if (!following.length) {
    wrap.innerHTML = '<div class="empty">You are not following anyone yet.</div>';
    return;
  }
  wrap.innerHTML = following.map(f => {
    const hex = npubToHexLenient(f.npub);
    const meta = profileCache.get(hex) || {};
    const displayName = meta.name || meta.display_name || (f.npub || '').slice(0, 12) + '...';
    const pic = meta.picture || null;
    const handle = followingHandle(f);
    const nip05Badge = f.nip05
      ? `<span class="nip05-badge">${escapeHtml(f.nip05)}</span>`
      : '';

    return `
      <div class="following-item" data-npub="${escapeAttr(f.npub)}">
        <div class="avatar">${pic ? `<img src="${escapeAttr(pic)}" onerror="this.style.display='none'">` : escapeHtml(displayName[0].toUpperCase())}</div>
        <div class="fi-body">
          <div class="fi-name">${escapeHtml(displayName)}${nip05Badge}</div>
          <div class="fi-handle">${escapeHtml(handle)}</div>
        </div>
        <div class="fi-actions">
          <button class="secondary unfollow" data-npub="${escapeAttr(f.npub)}">Unfollow</button>
        </div>
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('.following-item').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const npub = el.dataset.npub;
      const f = following.find(x => x.npub === npub);
      if (!f) return;
      showProfile(f.npub, f.domain, f.nip05);
    });
  });
  wrap.querySelectorAll('.unfollow').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFollow(btn.dataset.npub);
    });
  });
}

async function refreshRightFollowingFeed() {
  const box = document.getElementById('rightFollowingFeed');
  if (!box) return;
  loadFollowing();
  if (!following.length) {
    box.innerHTML = '<p style="color:var(--text-secondary); font-size:0.9rem;">Follow some accounts to see their latest notes here.</p>';
    return;
  }
  const authors = followedHexList();
  await ensureRelaysReady();
  const events = await queryRelays({ authors, kinds: [1], limit: 7 });
  if (!events.length) {
    box.innerHTML = '<p style="color:var(--text-secondary); font-size:0.9rem;">No recent notes from followed accounts.</p>';
    return;
  }
  events.sort((a, b) => b.created_at - a.created_at);
  const top = events.slice(0, 7);
  box.innerHTML = top.map(ev => {
    const meta = profileCache.get(ev.pubkey) || {};
    const displayName = meta.name || meta.display_name
      || shortenNpub(NostrCrypto.hexToNpub(ev.pubkey) || '');
    const { text } = splitNoteContent(ev.content || '');
    const preview = (text || ev.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    return `
      <div class="rf-note" data-npubhex="${escapeAttr(ev.pubkey)}" data-noteid="${escapeAttr(ev.id)}">
        <div class="rf-author">@${escapeHtml(displayName)}</div>
        <div class="rf-content">${escapeHtml(preview)}</div>
      </div>
    `;
  }).join('');
  box.querySelectorAll('.rf-note').forEach((el, idx) => {
    el.addEventListener('click', async () => {
      const ev = top[idx];
      const np = NostrCrypto.hexToNpub(ev.pubkey);
      if (!np) return;
      pendingFocusNoteId = ev.id;
      preloadNoteForProfile = ev;
      if (window.currentProfileNpub === np) {
        const existing = document.querySelector(`.note[data-id="${ev.id}"]`);
        if (existing) {
          existing.classList.add('note-focused');
          try { existing.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
          setTimeout(() => existing.classList.remove('note-focused'), 2200);
          pendingFocusNoteId = null;
          preloadNoteForProfile = null;
          return;
        }
      }
      showProfile(np);
    });
  });
  hydrateNoteAuthors(top.map(ev => ({ pubkey: ev.pubkey })));
}

// ========== PROFILE ==========
let profilePosts = [];

async function showProfile(identifier, domain = null, nip05 = null) {
  const seedNote = preloadNoteForProfile;
  preloadNoteForProfile = null;
  profilePosts = [];
  if (seedNote && seedNote.pubkey) profilePosts.push(seedNote);

  let npub = identifier;
  if (!npub.startsWith('npub1') && npub.includes('.')) {
    domain = domain || npub.replace(/^https?:\/\//, '').split('/')[0];
    npub = await resolveDomainToNpub(domain);
    if (!npub) { content.innerHTML = '<div class="empty">No npub found in TXT records for this domain</div>'; return; }
  }
  const hex = npubToHexLenient(npub);
  if (!hex) { content.innerHTML = '<div class="empty">Invalid npub</div>'; return; }

  window.currentProfileHex = hex;
  window.currentProfileNpub = npub;
  window.currentProfileDomain = domain;
  window.currentProfileNip05 = nip05;
  window.currentProfileRecords = [];

  const cachedMeta = profileCache.get(hex) || {};
  renderProfileContent(npub, domain, cachedMeta, nip05, { skeleton: true });

  const openBefore = sockets.filter(s => s.readyState === WebSocket.OPEN).length;
  if (openBefore < Math.max(1, Math.ceil(relays.length / 2))) {
    await connectRelays();
  }

  const metaPromise = queryRelays({ authors: [hex], kinds: [0], limit: 1 });
  const postsPromise = queryRelays({ authors: [hex], kinds: [1], limit: 100 });
  const contactsPromise = queryRelays({ authors: [hex], kinds: [3], limit: 1 });
  const earliestPromise = queryRelays({ authors: [hex], kinds: [1], limit: 100 }).then(list => {
    if (!list.length) return null;
    return Math.min(...list.map(e => e.created_at));
  });

  const localMeta = getLocalProfileMeta(hex);
  const effectiveDomain = domain || localMeta.domain || (localMeta.nip05 ? localMeta.nip05.split('@')[1] : null);
  const txtPromise = (effectiveDomain && !effectiveDomain.includes('@'))
    ? fetchTXTRecords(effectiveDomain)
    : Promise.resolve(null);

  metaPromise.then((metaEvents) => {
    if (window.currentProfileHex !== hex) return;
    if (!metaEvents.length) return;
    metaEvents.sort((a, b) => b.created_at - a.created_at);
    try {
      const meta = JSON.parse(metaEvents[0].content);
      profileCache.set(hex, meta);
      renderProfileContent(npub, domain, meta, nip05);
    } catch (e) {}
  });

  txtPromise.then((records) => {
    if (window.currentProfileHex !== hex) return;
    if (!records) return;
    window.currentProfileRecords = records;
    const meta = profileCache.get(hex) || {};
    renderProfileContent(npub, domain, meta, nip05, { skipPosts: true });
  });

  let postEvents = await postsPromise;
  if (postEvents.length === 0 && openBefore < Math.max(1, Math.ceil(relays.length / 2))) {
    await connectRelays();
    postEvents = await queryRelays({ authors: [hex], kinds: [1], limit: 100 });
  }
  const seen = new Set();
  const deduped = [];
  for (const ev of profilePosts) { if (seen.has(ev.id)) continue; seen.add(ev.id); deduped.push(ev); }
  for (const ev of postEvents) { if (seen.has(ev.id)) continue; seen.add(ev.id); deduped.push(ev); }
  deduped.sort((a, b) => b.created_at - a.created_at);
  profilePosts = deduped;

  const contactEvents = await contactsPromise;
  const followingList = extractFollowingFromContacts(contactEvents, hex);
  window.currentProfileFollowing = followingList;

  let followersList = [];
  try {
    const fEvents = await queryRelays({ kinds: [3], '#p': [hex], limit: 500 });
    const set = new Set();
    fEvents.forEach(ev => {
      if (ev.pubkey === hex) return;
      if (!(ev.tags || []).some(t => t[0] === 'p' && t[1] === hex)) return;
      set.add(ev.pubkey);
    });
    followersList = Array.from(set);
  } catch (e) {}
  window.currentProfileFollowers = followersList;

  const earliest = await earliestPromise;
  const earliestMeta = metaPromise.then(list => {
    if (!list || !list.length) return null;
    return Math.min(...list.map(e => e.created_at));
  });
  const metaEarliest = await earliestMeta;
  const candidates = [earliest, metaEarliest].filter(x => typeof x === 'number');
  window.currentProfileJoined = candidates.length ? Math.min(...candidates) : null;

  if (window.currentProfileHex !== hex) return;

  const txtRecords = await txtPromise;
  if (txtRecords) window.currentProfileRecords = txtRecords;
  const meta = profileCache.get(hex) || {};
  renderProfileContent(npub, domain, meta, nip05);
}

function extractFollowingFromContacts(events, hex) {
  if (!events || !events.length) return [];
  events.sort((a, b) => b.created_at - a.created_at);
  const ev = events[0];
  if (!ev || !Array.isArray(ev.tags)) return [];
  const set = new Set();
  ev.tags.forEach(t => {
    if (t[0] === 'p' && t[1] && /^[0-9a-f]{64}$/.test(t[1])) set.add(t[1]);
  });
  return Array.from(set);
}

function shortenNpub(npub) {
  if (!npub) return '';
  const s = String(npub);
  if (s.length <= 18) return s;
  return s.slice(0, 13) + '…';
}
function escapeWithLinks(text) {
  if (!text) return '';
  let esc = escapeHtml(text);
  esc = esc.replace(/(https?:\/\/[^\s]+)/g, (url) =>
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
  esc = esc.replace(/\bnostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)\b/gi, (full, entity) =>
    `<a href="nostr:${escapeAttr(entity)}" class="nostr-ref" data-nostr="${escapeAttr(entity)}">${escapeHtml(full)}</a>`);
  return esc;
}
function bindNostrLinks(_root) { /* delegated */ }
function nprofileToNpub(nprofile) {
  try {
    const decoded = NostrCrypto.bech32Decode(nprofile);
    if (!decoded || !decoded.bytes) return null;
    const bytes = decoded.bytes;
    let i = 0;
    while (i + 2 <= bytes.length) {
      const type = bytes[i], len = bytes[i + 1];
      const val = bytes.slice(i + 2, i + 2 + len);
      if (type === 0 && val.length === 32) {
        const hex = val.map(b => b.toString(16).padStart(2, '0')).join('');
        return NostrCrypto.hexToNpub(hex) || null;
      }
      i += 2 + len;
    }
  } catch (e) {}
  return null;
}
function isSimpleClick(noteEl) {
  if (noteEl._dragged) { noteEl._dragged = false; return false; }
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.toString().length > 0) return false;
  return true;
}

function renderProfileContent(npub, domain, meta, nip05, opts = {}) {
  const localMeta = getLocalProfileMeta(npubToHexLenient(npub));
  const displayDomain = domain || localMeta.domain || null;
  const displayNip05 = nip05 || localMeta.nip05 || null;

  const name = meta.name || meta.display_name || (displayDomain || npub.slice(0, 16));
  const pic = meta.picture || null;
  const bio = meta.about || '';
  const records = window.currentProfileRecords || [];
  const isOwn = currentUser && currentUser.npub === npub;

  let handle;
  if (displayNip05) handle = String(displayNip05).toLowerCase();
  else if (displayDomain) handle = `@${String(displayDomain).toLowerCase()}`;
  else handle = `@${shortenNpub(String(npub).toLowerCase())}`;

  let coverStyle = '';
  const bg = getRecord(records, 'bg');
  if (bg) {
    const bgUrl = bg.startsWith('http') ? bg : `https://${bg}`;
    coverStyle = `background-image: url('${bgUrl}');`;
  }

  let extraHtml = records.length ? renderExtraRecords(records) : '';
  const follows = isFollowing(String(npub).toLowerCase());
  const followBtnHtml = isOwn ? '' : `
    <button class="btn-follow ${follows ? 'following' : ''}" id="followBtn">
      ${follows ? 'Following' : 'Follow'}
    </button>`;
  const editBtnHtml = isOwn ? `<button id="editProfileBtn">Edit profile</button>` : '';

  const npubDisplay = shortenNpub(npub);

  const followingCount = (window.currentProfileFollowing || []).length;
  const followerCount = (window.currentProfileFollowers || []).length;
  const joinedTs = window.currentProfileJoined;
  const joinedHtml = joinedTs
    ? `<div class="profile-joined">Joined ${new Date(joinedTs * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>`
    : '';

  content.innerHTML = `
    <div class="profile-header">
      <div class="profile-cover" style="${coverStyle}"></div>
      <div class="profile-top-row">
        <div class="profile-avatar-large">${pic ? `<img src="${escapeHtml(pic)}" onerror="this.parentElement.innerHTML='⚡'">` : '⚡'}</div>
        <div class="profile-top-actions">
          ${followBtnHtml}
          ${editBtnHtml}
        </div>
      </div>
      <div class="profile-name">${escapeHtml(name)}</div>
      <div class="profile-handle">${escapeHtml(handle)}</div>
      <div class="profile-counts">
        <span><strong>${followingCount}</strong> Following</span>
        <span><strong>${followerCount}</strong> Followers</span>
      </div>
      <div class="npub-row">
        <div class="profile-npub" title="${escapeAttr(npub)}" data-copy="${escapeAttr(npub)}">${escapeHtml(npubDisplay)}</div>
        <button class="qr-plain-btn" id="profileQrBtn" title="Show QR">
          <img src="img/qr.png" alt="QR" onerror="this.outerHTML='QR'">
        </button>
      </div>
      ${bio ? `<div class="profile-bio">${escapeWithLinks(bio)}</div>` : ''}
      ${joinedHtml}
      ${extraHtml}
      <div id="editFormContainer"></div>
    </div>
    <div id="feed"></div>
  `;

  bindNostrLinks(content);

  const copyEl = document.querySelector('.profile-npub[data-copy]');
  if (copyEl) copyEl.onclick = () => copyToClipboard(copyEl.dataset.copy);
  const qrBtn = document.getElementById('profileQrBtn');
  if (qrBtn) qrBtn.onclick = () => openQR();

  const followBtnEl = document.getElementById('followBtn');
  if (followBtnEl) {
    followBtnEl.onclick = (e) => {
      e.stopPropagation();
      if (isFollowing(String(npub).toLowerCase())) {
        removeFollow(npub);
      } else {
        addFollow({ npub, domain: displayDomain, nip05: displayNip05 });
      }
      renderProfileContent(npub, domain, meta, nip05);
    };
  }

  const feed = document.getElementById('feed');
  if (feed) {
    const ownPosts = profilePosts.filter(p => p.pubkey === window.currentProfileHex);
    if (opts.skeleton) {
      const loader = document.createElement('div');
      loader.className = 'loader';
      loader.textContent = 'Loading notes...';
      feed.appendChild(loader);
    } else if (opts.skipPosts) {
      if (ownPosts.length) ownPosts.forEach(ev => renderNote(ev, true));
      else {
        const loader = document.createElement('div');
        loader.className = 'loader';
        loader.textContent = 'Loading notes...';
        feed.appendChild(loader);
      }
    } else {
      if (ownPosts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No notes found.';
        feed.appendChild(empty);
      } else ownPosts.forEach(ev => renderNote(ev, true));
    }
  }

  if (isOwn && document.getElementById('editProfileBtn')) {
    document.getElementById('editProfileBtn').onclick = () => showEditForm(meta);
  }

  if (pendingFocusNoteId) {
    const target = document.querySelector(`.note[data-id="${pendingFocusNoteId}"]`);
    if (target) {
      target.classList.add('note-focused');
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      setTimeout(() => { if (target) target.classList.remove('note-focused'); }, 2200);
      pendingFocusNoteId = null;
    }
  }
}

function showEditForm(meta) {
  const container = document.getElementById('editFormContainer');
  const local = getLocalProfileMeta(currentUser.pubHex);
  container.innerHTML = `
    <div class="edit-form">
      <h3>Edit profile</h3>
      <input type="text" id="editName" placeholder="Display name" value="${escapeAttr(meta.name || meta.display_name || '')}">
      <textarea id="editAbout" placeholder="Bio" rows="3">${escapeHtml(meta.about || '')}</textarea>
      <input type="text" id="editPicture" placeholder="Profile picture URL" value="${escapeAttr(meta.picture || '')}">
      <input type="text" id="editDomain" placeholder="Domain (e.g. example.com or myname)" value="${escapeAttr(local.domain || '')}">
      <input type="text" id="editNip05" placeholder="NIP-05 (e.g. user@example.com)" value="${escapeAttr(local.nip05 || '')}">
      <button id="saveProfile">Save</button>
      <button class="secondary" id="cancelEdit" style="margin-left:8px;">Cancel</button>
    </div>
  `;
  document.getElementById('saveProfile').onclick = saveProfile;
  document.getElementById('cancelEdit').onclick = () => { container.innerHTML = ''; };
}

async function saveProfile() {
  if (!currentUser) return;
  if (currentUser.viewOnly) { alert('View-only account — cannot edit profile.'); return; }
  const name = document.getElementById('editName').value.trim();
  const about = document.getElementById('editAbout').value.trim();
  const picture = document.getElementById('editPicture').value.trim();
  const domain = document.getElementById('editDomain').value.trim().toLowerCase();
  const nip05 = document.getElementById('editNip05').value.trim().toLowerCase();

  const allLocal = loadLocalProfileMeta();
  allLocal[currentUser.pubHex] = { domain: domain || null, nip05: nip05 || null };
  saveLocalProfileMeta(allLocal);

  const contentObj = { name, about, picture };
  const event = { kind: 0, content: JSON.stringify(contentObj), created_at: Math.floor(Date.now() / 1000), tags: [] };
  try {
    const signed = await signEventAny(event);
    sockets.filter(s => s.readyState === 1).forEach(ws => {
      try { ws.send(JSON.stringify(['EVENT', signed])); } catch(e) {}
    });
    profileCache.set(currentUser.pubHex, contentObj);
    document.getElementById('editFormContainer').innerHTML = '';
    alert('Profile update published');
    showProfile(currentUser.npub);
  } catch (e) { alert('Could not publish profile: ' + e.message); }
}

// ---- Note rendering ----
function looksLikeImageUrl(url) {
  if (!url) return false;
  if (/\.(?:jpg|jpeg|png|gif|webp|avif|bmp|svg)(?:\?[^\s]*)?$/i.test(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const imageHosts = [
      'nostr.build', 'image.nostr.build', 'void.cat', 'primal.net',
      'blossom.primal.net', 'media.nostr.band', 'i.imgur.com', 'imgur.com',
      'pbs.twimg.com', 'cdn.discordapp.com', 'media.discordapp.net',
      'files.catbox.moe', 'i.ibb.co'
    ];
    return imageHosts.some(h => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}
function extractYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
      }
      const m = u.pathname.match(/^\/(shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
    if (host === 'youtube-nocookie.com') {
      const m = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}
function splitNoteContent(raw) {
  if (!raw) return { text: '', image: null, youtube: null };
  const urls = raw.match(/https?:\/\/[^\s]+/g);
  if (!urls) return { text: raw, image: null, youtube: null };
  let text = raw, image = null, youtube = null;
  for (const u of urls) {
    const trimmed = u.replace(/[),.;]+$/, '');
    if (!youtube) {
      const ytId = extractYouTubeId(trimmed);
      if (ytId) { youtube = ytId; text = text.replace(u, '').trim(); continue; }
    }
    if (!image && looksLikeImageUrl(trimmed)) {
      image = trimmed;
      text = text.replace(u, '').trim();
    }
  }
  return { text, image, youtube };
}

const reactState = new Map();

function renderNote(event, skipPrepend = false) {
  const feed = document.getElementById('feed');
  if (!feed) return;
  if (event.id && feed.querySelector(`[data-id="${event.id}"]`)) return;
  const placeholder = feed.querySelector('.empty');
  if (placeholder) placeholder.remove();
  const loader = feed.querySelector('.loader');
  if (loader) loader.remove();

  const meta = profileCache.get(event.pubkey) || {};
  const name = meta.name || meta.display_name || shortenNpub(NostrCrypto.hexToNpub(event.pubkey) || '');
  const pic = meta.picture || null;
  const time = new Date(event.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const { text, image, youtube } = splitNoteContent(event.content || '');
  const contentHtml = escapeWithLinks(text);

  const mediaHtml = [];
  if (youtube) mediaHtml.push(`<div class="note-embed"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtube)}" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`);
  if (image) mediaHtml.push(`<div class="note-media"><img src="${escapeAttr(image)}" loading="lazy" alt="" referrerpolicy="no-referrer"></div>`);

  const npubDisplay = shortenNpub(NostrCrypto.hexToNpub(event.pubkey) || '');
  const bookmarked = isBookmarked(event.id);

  const note = document.createElement('div');
  note.className = 'note';
  note._event = event;
  if (event.id) note.dataset.id = event.id;
  note.dataset.pubkey = event.pubkey;
  note.innerHTML = `
    <div class="avatar">${pic ? `<img src="${escapeAttr(pic)}" onerror="this.style.display='none'">` : escapeHtml((name[0] || '?').toUpperCase())}</div>
    <div class="note-body">
      <div class="note-header">
        <span class="note-name">${escapeHtml(name)}</span>
        <span class="note-handle">@${escapeHtml(npubDisplay)}</span>
        <span class="note-time">· ${time}</span>
      </div>
      ${contentHtml ? `<div class="note-content">${contentHtml}</div>` : ''}
      ${mediaHtml.join('')}
      <div class="note-actions">
        <button class="note-action reply" title="Reply">
          <svg viewBox="0 0 24 24"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg>
        </button>
        <button class="note-action repost" title="Repost">
          <svg viewBox="0 0 24 24"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg>
          <span class="count"></span>
        </button>
        <button class="note-action like" title="Like">
          <svg viewBox="0 0 24 24"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>
          <span class="count"></span>
        </button>
        <button class="note-action zap" title="Zap">
          <svg viewBox="0 0 24 24"><path d="M13 2L4.09 12.11a1 1 0 0 0 .76 1.65H10l-1 8 8.91-10.11a1 1 0 0 0-.76-1.65H13l1-8z"/></svg>
        </button>
        <button class="note-action bookmark ${bookmarked ? 'saved' : ''}" title="Bookmark">
          <svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>
        </button>
      </div>
    </div>
  `;

  let mouseDownX = 0, mouseDownY = 0;
  note.addEventListener('mousedown', (e) => {
    mouseDownX = e.clientX; mouseDownY = e.clientY;
    note._dragged = false;
  });
  note.addEventListener('mouseup', (e) => {
    const dx = Math.abs(e.clientX - mouseDownX);
    const dy = Math.abs(e.clientY - mouseDownY);
    if (dx > 5 || dy > 5) note._dragged = true;
  });
  note.onclick = (e) => {
    if (e.target.closest('.note-action') || e.target.closest('.note-media') || e.target.closest('.note-embed') || e.target.closest('a')) return;
    if (!isSimpleClick(note)) return;
    const np = NostrCrypto.hexToNpub(event.pubkey);
    if (np) showProfile(np);
  };

  note.querySelectorAll('.note-action').forEach(b => {
    b.addEventListener('click', (e) => e.stopPropagation());
  });
  note.querySelector('.note-action.reply').onclick = () => alert('Replies are not implemented yet.');
  note.querySelector('.note-action.repost').onclick = () => doRepost(event, note);
  note.querySelector('.note-action.like').onclick = () => doLike(event, note);
  note.querySelector('.note-action.zap').onclick = () => alert('Zaps are not implemented yet.');
  note.querySelector('.note-action.bookmark').onclick = () => {
    toggleBookmark(event);
    refreshBookmarkButtons(event.id);
  };

  if (skipPrepend) feed.appendChild(note);
  else feed.prepend(note);

  loadReactionState(event.id, note);
}

async function loadReactionState(eventId, noteEl) {
  if (!eventId) return;
  if (reactState.has(eventId)) {
    applyReactionState(noteEl, reactState.get(eventId));
    return;
  }
  try {
    const [reactions, reposts] = await Promise.all([
      queryRelays({ kinds: [7], '#e': [eventId], limit: 200 }),
      queryRelays({ kinds: [6], '#e': [eventId], limit: 200 })
    ]);
    const myHex = currentUser ? currentUser.pubHex : null;
    const likedByMe = myHex
      ? reactions.some(r => r.pubkey === myHex && (r.content === '+' || r.content === '' || r.content === '❤' || r.content === '🤍'))
      : false;
    const repostedByMe = myHex ? reposts.some(r => r.pubkey === myHex) : false;
    const likers = new Set();
    reactions.forEach(r => {
      if (r.content === '+' || r.content === '' || r.content === '❤' || r.content === '🤍' || r.content === '👍') likers.add(r.pubkey);
    });
    const reposters = new Set();
    reposts.forEach(r => reposters.add(r.pubkey));
    const state = { likes: likers.size, likedByMe, reposts: reposters.size, repostedByMe };
    reactState.set(eventId, state);
    applyReactionState(noteEl, state);
  } catch (e) {}
}

function applyReactionState(noteEl, state) {
  const likeBtn = noteEl.querySelector('.note-action.like');
  const repostBtn = noteEl.querySelector('.note-action.repost');
  if (likeBtn) {
    likeBtn.querySelector('.count').textContent = state.likes ? String(state.likes) : '';
    likeBtn.style.color = state.likedByMe ? 'var(--like)' : '';
  }
  if (repostBtn) {
    repostBtn.querySelector('.count').textContent = state.reposts ? String(state.reposts) : '';
    repostBtn.style.color = state.repostedByMe ? 'var(--repost)' : '';
  }
}

async function doLike(event, noteEl) {
  if (!currentUser) { openLoginModal(); return; }
  if (currentUser.viewOnly) { alert('View-only account — cannot react.'); return; }
  const state = reactState.get(event.id);
  if (state && state.likedByMe) {
    try {
      const mine = await queryRelays({ kinds: [7], authors: [currentUser.pubHex], '#e': [event.id], limit: 20 });
      const target = mine[0];
      if (!target) return;
      const del = {
        kind: 5,
        content: 'unlike',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', target.id]]
      };
      const signed = await signEventAny(del);
      sockets.filter(s => s.readyState === 1).forEach(ws => {
        try { ws.send(JSON.stringify(['EVENT', signed])); } catch(e) {}
      });
      state.likedByMe = false;
      state.likes = Math.max(0, state.likes - 1);
      applyReactionState(noteEl, state);
    } catch (e) { alert('Unlike failed: ' + e.message); }
    return;
  }
  try {
    const reaction = {
      kind: 7,
      content: '+',
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', event.id],
        ['p', event.pubkey]
      ]
    };
    const signed = await signEventAny(reaction);
    sockets.filter(s => s.readyState === 1).forEach(ws => {
      try { ws.send(JSON.stringify(['EVENT', signed])); } catch(e) {}
    });
    if (!state) {
      reactState.set(event.id, { likes: 1, likedByMe: true, reposts: 0, repostedByMe: false });
    } else {
      state.likedByMe = true;
      state.likes = (state.likes || 0) + 1;
    }
    applyReactionState(noteEl, reactState.get(event.id));
  } catch (e) { alert('Like failed: ' + e.message); }
}

async function doRepost(event, noteEl) {
  if (!currentUser) { openLoginModal(); return; }
  if (currentUser.viewOnly) { alert('View-only account — cannot repost.'); return; }
  const state = reactState.get(event.id);
  if (state && state.repostedByMe) return alert('Already reposted.');
  try {
    const repost = {
      kind: 6,
      content: JSON.stringify(event),
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', event.id],
        ['p', event.pubkey]
      ]
    };
    const signed = await signEventAny(repost);
    sockets.filter(s => s.readyState === 1).forEach(ws => {
      try { ws.send(JSON.stringify(['EVENT', signed])); } catch(e) {}
    });
    if (!state) {
      reactState.set(event.id, { likes: 0, likedByMe: false, reposts: 1, repostedByMe: true });
    } else {
      state.repostedByMe = true;
      state.reposts = (state.reposts || 0) + 1;
    }
    applyReactionState(noteEl, reactState.get(event.id));
  } catch (e) { alert('Repost failed: ' + e.message); }
}

function renderExtraRecords(records) {
  const socialItems = [], walletItems = [];
  const socialMap = {
    x: { icon: 'img/x.png', url: v => `https://x.com/${v}` },
    tg: { icon: 'img/tg.png', url: v => `https://t.me/${v}` },
    gh: { icon: 'img/gh.png', url: v => `https://github.com/${v}` },
    mail: { icon: 'img/mail.png', url: v => `mailto:${v}` },
    wa: { icon: 'img/wa.png', url: v => `https://wa.me/${v}` },
    sn: { icon: 'img/sn.png', url: v => `https://signal.me/#p/${v}` },
    url: { icon: 'img/link.png', url: v => v.startsWith('http') ? v : `https://${v}` },
    ig: { icon: 'img/ig.png', url: v => `https://instagram.com/${v}` },
    yt: { icon: 'img/yt.png', url: v => `https://youtube.com/${v}` },
    bsky: { icon: 'img/bsky.png', url: v => `https://bsky.app/profile/${v}` }
  };
  for (const [key, cfg] of Object.entries(socialMap)) {
    const val = getRecord(records, key);
    if (val) socialItems.push(`<div class="social-icon" title="${key}" data-open="${escapeAttr(cfg.url(val))}"><img src="${cfg.icon}" alt="${key}" onerror="this.style.display='none'"></div>`);
  }
  const wallets = ['btc','ln','eth','hns','xmr','zec','bat'];
  wallets.forEach(w => {
    const val = getRecord(records, w);
    if (val) walletItems.push(`<div class="wallet-icon" title="${w}" data-copy="${escapeAttr(val)}"><img src="img/${w}.png" alt="${w}" onerror="this.style.display='none'"></div>`);
  });
  if (!socialItems.length && !walletItems.length) return '';
  let html = '<div class="links-section">';
  if (socialItems.length) html += `<div class="links-group"><div class="links-label">Socials</div><div class="social-icons">${socialItems.join('')}</div></div>`;
  if (walletItems.length) html += `<div class="links-group"><div class="links-label">Wallets</div><div class="wallet-icons">${walletItems.join('')}</div></div>`;
  html += '</div>';
  return html;
}
function getRecord(records, prefix) {
  if (!records || !records.length) return null;
  const rec = records.find(r => r.startsWith(prefix + ':') || r.startsWith(prefix + '='));
  return rec ? rec.split(/[:=]/).slice(1).join(':') : null;
}

document.addEventListener('click', (e) => {
  const openEl = e.target.closest && e.target.closest('[data-open]');
  if (openEl) { window.open(openEl.dataset.open, '_blank', 'noopener'); return; }
  const copyEl = e.target.closest && e.target.closest('[data-copy]');
  if (copyEl && !copyEl.classList.contains('profile-npub')) {
    copyToClipboard(copyEl.dataset.copy);
  }
});

// ========== QR ==========
function buildQrOptions() {
  const npub = window.currentProfileNpub;
  const records = window.currentProfileRecords || [];
  const localMeta = getLocalProfileMeta(window.currentProfileHex);
  const domain = window.currentProfileDomain || localMeta.domain || null;
  const nip05 = window.currentProfileNip05 || localMeta.nip05 || null;
  const opts = [];
  if (domain) opts.push({ type: 'domain', label: 'Name', value: `https://${domain}` });
  if (nip05) opts.push({ type: 'nip05', label: 'NIP-05', value: nip05 });
  if (npub) opts.push({ type: 'npub', label: 'Npub', value: npub });

  const socialMap = {
    x: { label: 'X', icon: 'img/x.png', url: v => `https://x.com/${v}` },
    tg: { label: 'Telegram', icon: 'img/tg.png', url: v => `https://t.me/${v}` },
    gh: { label: 'GitHub', icon: 'img/gh.png', url: v => `https://github.com/${v}` },
    mail: { label: 'Email', icon: 'img/mail.png', url: v => `mailto:${v}` },
    wa: { label: 'WhatsApp', icon: 'img/wa.png', url: v => `https://wa.me/${v}` },
    sn: { label: 'Signal', icon: 'img/sn.png', url: v => `https://signal.me/#p/${v}` },
    url: { label: 'Website', icon: 'img/link.png', url: v => v.startsWith('http') ? v : `https://${v}` },
    ig: { label: 'Instagram', icon: 'img/ig.png', url: v => `https://instagram.com/${v}` },
    yt: { label: 'YouTube', icon: 'img/yt.png', url: v => `https://youtube.com/${v}` },
    bsky: { label: 'Bluesky', icon: 'img/bsky.png', url: v => `https://bsky.app/profile/${v}` }
  };
  for (const [key, cfg] of Object.entries(socialMap)) {
    const val = getRecord(records, key);
    if (val) opts.push({ type: key, label: cfg.label, icon: cfg.icon, value: cfg.url(val) });
  }
  const walletMap = { btc: 'BTC', ln: 'LN', eth: 'ETH', hns: 'HNS', xmr: 'XMR', zec: 'ZEC', bat: 'BAT', sol: 'SOL', ada: 'ADA', dot: 'DOT' };
  for (const [key, label] of Object.entries(walletMap)) {
    const val = getRecord(records, key);
    if (val) opts.push({ type: key, label, icon: `img/${key}.png`, value: val });
  }
  return opts;
}
function setupQrModal() {
  document.getElementById('closeQr').onclick = () => qrModal.classList.remove('active');
  const valEl = document.getElementById('qrValue');
  valEl.onclick = () => { if (currentQrValue) copyToClipboard(currentQrValue); };
  qrModal.addEventListener('click', (e) => { if (e.target === qrModal) qrModal.classList.remove('active'); });
}
function renderQrCanvas(text) {
  const canvas = document.getElementById('qrCanvas');
  canvas.innerHTML = '';
  if (!text) return;
  if (typeof QRCode !== 'undefined') {
    new QRCode(canvas, { text, width: 220, height: 220, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    const c = canvas.querySelector('canvas');
    if (c) { c.style.width = '100%'; c.style.height = 'auto'; }
  }
}
function updateQrSelection(type) {
  activeQrType = type;
  const opt = currentQrOptions.find(o => o.type === type);
  currentQrValue = opt ? opt.value : '';
  document.getElementById('qrValue').textContent = currentQrValue || '—';
  renderQrCanvas(currentQrValue);
  document.querySelectorAll('.qr-primary-option').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
  document.querySelectorAll('.qr-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.type === type));
}
function rebuildQrUi() {
  const primary = document.getElementById('qrPrimaryOptions');
  primary.innerHTML = '';
  ['domain', 'nip05', 'npub'].forEach(t => {
    const o = currentQrOptions.find(x => x.type === t);
    if (!o) return;
    const btn = document.createElement('button');
    btn.className = 'qr-primary-option';
    btn.dataset.type = t;
    btn.textContent = o.label;
    btn.onclick = () => updateQrSelection(t);
    primary.appendChild(btn);
  });
  const socials = document.getElementById('qrSocials');
  const wallets = document.getElementById('qrWallets');
  socials.innerHTML = ''; wallets.innerHTML = '';
  const socialKeys = ['x','tg','gh','mail','wa','sn','url','ig','yt','bsky'];
  const walletKeys = ['btc','ln','eth','hns','xmr','zec','bat','sol','ada','dot'];
  currentQrOptions.forEach(opt => {
    if (!opt.icon) return;
    const el = document.createElement('div');
    el.className = 'qr-chip';
    el.dataset.type = opt.type;
    el.title = opt.label;
    const img = document.createElement('img');
    img.src = opt.icon; img.alt = opt.label;
    img.onerror = () => { img.style.display = 'none'; };
    el.appendChild(img);
    el.onclick = () => updateQrSelection(opt.type);
    if (socialKeys.includes(opt.type)) socials.appendChild(el);
    else if (walletKeys.includes(opt.type)) wallets.appendChild(el);
  });
}
function openQR() {
  const meta = profileCache.get(window.currentProfileHex) || {};
  const pic = meta.picture || null;
  const localMeta = getLocalProfileMeta(window.currentProfileHex);
  const name = meta.name || meta.display_name || window.currentProfileDomain || localMeta.domain || (window.currentProfileNpub || '').slice(0, 12);
  const avatar = document.getElementById('qrAvatar');
  avatar.innerHTML = pic ? `<img src="${escapeHtml(pic)}" onerror="this.parentElement.innerHTML='⚡'">` : '⚡';
  document.getElementById('qrName').textContent = name;
  currentQrOptions = buildQrOptions();
  rebuildQrUi();
  const first = currentQrOptions.find(o => o.type === 'domain') ||
                currentQrOptions.find(o => o.type === 'nip05') ||
                currentQrOptions.find(o => o.type === 'npub');
  updateQrSelection(first ? first.type : 'npub');
  qrModal.classList.add('active');
}

// ========== QR SCANNER ==========
let scannerInstance = null;
function setupScannerModal() {
  const modal = document.getElementById('scannerModal');
  const closeBtn = document.getElementById('closeScanner');
  const statusEl = document.getElementById('scannerStatus');
  if (!modal) return;
  closeBtn.onclick = () => stopScanner();
  modal.addEventListener('click', (e) => { if (e.target === modal) stopScanner(); });

  function stopScanner() {
    if (scannerInstance) {
      try { scannerInstance.stop(); scannerInstance.destroy(); } catch (e) {}
      scannerInstance = null;
    }
    const v = document.getElementById('scannerVideo');
    if (v && v.srcObject) { try { v.srcObject.getTracks().forEach(t => t.stop()); } catch (e) {} v.srcObject = null; }
    modal.classList.remove('active');
    if (statusEl) statusEl.textContent = 'Starting camera…';
  }
  window.stopScanner = stopScanner;
}
function openScanner() {
  if (typeof QrScanner === 'undefined') {
    alert('QR scanner not available. Download qr-scanner.js and qr-scanner-worker.min.js.');
    return;
  }
  const modal = document.getElementById('scannerModal');
  const statusEl = document.getElementById('scannerStatus');
  const video = document.getElementById('scannerVideo');
  modal.classList.add('active');
  if (statusEl) statusEl.textContent = 'Requesting camera…';
  try {
    if (QrScanner.WORKER_PATH === undefined) QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';
    scannerInstance = new QrScanner(
      video,
      (result) => {
        const value = typeof result === 'string' ? result : (result && result.data) || '';
        if (!value) return;
        searchInput.value = value;
        searchInput.dispatchEvent(new Event('input'));
        window.stopScanner();
        performSearch(value.trim());
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true
      }
    );
    scannerInstance.start()
      .then(() => { if (statusEl) statusEl.textContent = 'Point the camera at a QR code.'; })
      .catch(err => { if (statusEl) statusEl.textContent = 'Camera error: ' + err.message; });
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Scanner error: ' + e.message;
  }
}

// ========== SETTINGS ==========
function renderSettings() {
  let accountHtml = '';
  if (currentUser) {
    const nsec = currentUser.privHex ? NostrCrypto.hexToNsec(currentUser.privHex) : null;
    const viewOnly = !!currentUser.viewOnly;
    accountHtml = `
      <div class="settings-section">
        <h3>Account${viewOnly ? ' (view only)' : ''}</h3>
        <div style="margin-bottom:8px; font-size:0.85rem; color:var(--text-secondary);">npub</div>
        <div class="profile-npub" style="margin-bottom:12px;" title="${escapeAttr(currentUser.npub)}" data-copy-settings="${escapeAttr(currentUser.npub)}">${escapeHtml(shortenNpub(currentUser.npub))}</div>
        ${viewOnly ? '<p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">You are logged in without a secret key. Posting, liking, and reposting are disabled.</p>' : `
          <div style="margin-bottom:8px; font-size:0.85rem; color:var(--text-secondary);">nsec (keep secret!)</div>
          <div class="profile-npub" style="margin-bottom:12px;" title="${escapeAttr(nsec || '')}" data-copy-settings="${escapeAttr(nsec || '')}">${escapeHtml(nsec || '(unavailable)')}</div>
        `}
        <button id="logoutBtn" class="secondary">Log out</button>
      </div>
    `;
  } else {
    accountHtml = `
      <div class="settings-section">
        <h3>Account</h3>
        <p style="color:var(--text-secondary); font-size:0.9rem; margin-bottom:16px;">Not logged in.</p>
        <button id="settingsLoginBtn">Log in / Create account</button>
      </div>
    `;
  }

  content.innerHTML = `
    <div class="settings-section">
      <h3>Appearance</h3>
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="themeToggle" ${theme === 'dark' ? 'checked' : ''}> Dark mode
      </label>
    </div>
    <div class="settings-section">
      <h3>Relays</h3>
      <div id="relayList"></div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <input type="text" id="newRelay" placeholder="wss://relay.example.com">
        <button id="addRelay">Add</button>
      </div>
      <button id="resetRelays" class="secondary" style="margin-top:8px;">Reset to defaults</button>
    </div>
    <div class="settings-section">
      <h3>DoH endpoints (TXT records)</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Tried in order. Only the base prefix is stored; the client appends domain &amp; type.</p>
      <div id="dohList"></div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <input type="text" id="newDoh" placeholder="https://api.example.com/?name=">
        <button id="addDoh">Add</button>
      </div>
      <button id="resetDoh" class="secondary" style="margin-top:8px;">Reset to defaults</button>
    </div>
    <div class="settings-section">
      <h3>NIP-05 DNS</h3>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Custom DNS IPs for resolving NIP-05 and HNS. Tried in order. Tick "local" for your own node.</p>
      <div id="dnsList"></div>
      <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <input type="text" id="newDnsIp" placeholder="IP (e.g. 1.1.1.1)" style="flex:1; min-width:140px;">
        <input type="text" id="newDnsLabel" placeholder="Label (optional)" style="flex:2; min-width:180px;">
        <label style="display:flex; align-items:center; gap:4px; font-size:0.8rem; color:var(--text-secondary);"><input type="checkbox" id="newDnsLocal"> local</label>
        <button id="addDns">Add</button>
      </div>
      <button id="resetDns" class="secondary" style="margin-top:8px;">Reset to defaults</button>
    </div>
    <div class="settings-section">
      <h3>NIP-05 API URL</h3>
      <input type="text" id="nip05ApiInput" value="${escapeAttr(nip05ApiUrl)}" placeholder="http://cosanostr">
      <button id="saveNip05Api">Save</button>
      <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Backend that performs custom-DNS NIP-05 lookups (run NIP05.js).</p>
    </div>
    ${accountHtml}
  `;

  document.getElementById('themeToggle').onchange = (e) => {
    theme = e.target.checked ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cosanostr-theme', theme);
  };

  renderRelayList();
  renderDohList();
  renderDnsList();

  document.getElementById('addRelay').onclick = () => {
    const url = document.getElementById('newRelay').value.trim();
    if (url && url.startsWith('wss://') && !relays.includes(url)) {
      relays.push(url); saveRelays(); renderRelayList();
      document.getElementById('newRelay').value = '';
      connectRelays();
    }
  };
  document.getElementById('resetRelays').onclick = () => { relays = [...DEFAULT_RELAYS]; saveRelays(); renderRelayList(); connectRelays(); };

  document.getElementById('addDoh').onclick = () => {
    const base = document.getElementById('newDoh').value.trim();
    if (base && !dohEndpoints.includes(base)) {
      dohEndpoints.push(base);
      saveDoh();
      renderDohList();
      document.getElementById('newDoh').value = '';
    }
  };
  document.getElementById('resetDoh').onclick = () => {
    dohEndpoints = [...DEFAULT_DOH_ENDPOINTS];
    saveDoh();
    renderDohList();
  };

  document.getElementById('addDns').onclick = () => {
    const ip = document.getElementById('newDnsIp').value.trim();
    const label = document.getElementById('newDnsLabel').value.trim() || ip;
    const local = document.getElementById('newDnsLocal').checked;
    if (ip && /^[\d.]+$/.test(ip) && !dnsServers.some(s => s.ip === ip)) {
      dnsServers.push({ ip, label, local });
      saveDns();
      renderDnsList();
      document.getElementById('newDnsIp').value = '';
      document.getElementById('newDnsLabel').value = '';
      document.getElementById('newDnsLocal').checked = false;
    } else alert('Enter a valid unique IPv4 address');
  };
  document.getElementById('resetDns').onclick = () => {
    dnsServers = [...DEFAULT_DNS_SERVERS];
    saveDns();
    renderDnsList();
  };
  document.getElementById('saveNip05Api').onclick = () => {
    nip05ApiUrl = document.getElementById('nip05ApiInput').value.trim();
    localStorage.setItem('cosanostr-nip05-api', nip05ApiUrl);
    alert('Saved');
  };

  document.querySelectorAll('[data-copy-settings]').forEach(el => {
    el.onclick = () => copyToClipboard(el.dataset.copySettings);
  });

  if (currentUser) document.getElementById('logoutBtn').onclick = logout;
  else document.getElementById('settingsLoginBtn').onclick = () => openLoginModal();
}

function renderRelayList() {
  const list = document.getElementById('relayList');
  if (!list) return;
  list.innerHTML = relays.map((r, i) => `
    <div class="relay-item">
      <input type="text" value="${escapeAttr(r)}" data-index="${i}" class="relay-edit">
      <div class="relay-actions">
        <button class="secondary" style="padding:6px 10px;" data-move-relay="${i}" data-dir="-1">↑</button>
        <button class="secondary" style="padding:6px 10px;" data-move-relay="${i}" data-dir="1">↓</button>
        <button class="secondary" style="padding:6px 10px; color:var(--danger);" data-del-relay="${i}">✕</button>
      </div>
    </div>
  `).join('');
  document.querySelectorAll('.relay-edit').forEach(input => {
    input.onchange = (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      relays[idx] = e.target.value.trim();
      saveRelays(); connectRelays();
    };
  });
  list.querySelectorAll('[data-move-relay]').forEach(btn => {
    btn.onclick = () => moveRelay(parseInt(btn.dataset.moveRelay, 10), parseInt(btn.dataset.dir, 10));
  });
  list.querySelectorAll('[data-del-relay]').forEach(btn => {
    btn.onclick = () => deleteRelay(parseInt(btn.dataset.delRelay, 10));
  });
}
function moveRelay(i, dir) { const j = i + dir; if (j < 0 || j >= relays.length) return; [relays[i], relays[j]] = [relays[j], relays[i]]; saveRelays(); renderRelayList(); connectRelays(); }
function deleteRelay(i) { relays.splice(i, 1); saveRelays(); renderRelayList(); connectRelays(); }
function saveRelays() { localStorage.setItem('cosanostr-relays', JSON.stringify(relays)); }

function renderDohList() {
  const list = document.getElementById('dohList');
  if (!list) return;
  list.innerHTML = dohEndpoints.map((d, i) => `
    <div class="dns-item">
      <div class="dns-ip" style="font-family:monospace; flex:1;">${escapeHtml(d)}</div>
      <div class="relay-actions">
        <button class="secondary" style="padding:6px 10px;" data-move-doh="${i}" data-dir="-1">↑</button>
        <button class="secondary" style="padding:6px 10px;" data-move-doh="${i}" data-dir="1">↓</button>
        <button class="secondary" style="padding:6px 10px; color:var(--danger);" data-del-doh="${i}">✕</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-move-doh]').forEach(btn => {
    btn.onclick = () => moveDoh(parseInt(btn.dataset.moveDoh, 10), parseInt(btn.dataset.dir, 10));
  });
  list.querySelectorAll('[data-del-doh]').forEach(btn => {
    btn.onclick = () => deleteDoh(parseInt(btn.dataset.delDoh, 10));
  });
}
function moveDoh(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= dohEndpoints.length) return;
  [dohEndpoints[i], dohEndpoints[j]] = [dohEndpoints[j], dohEndpoints[i]];
  saveDoh(); renderDohList();
}
function deleteDoh(i) { dohEndpoints.splice(i, 1); saveDoh(); renderDohList(); }
function saveDoh() { localStorage.setItem('cosanostr-doh-endpoints', JSON.stringify(dohEndpoints)); }

function renderDnsList() {
  const list = document.getElementById('dnsList');
  if (!list) return;
  list.innerHTML = dnsServers.map((s, i) => `
    <div class="dns-item">
      <div class="dns-ip">${escapeHtml(s.ip)}${s.local ? ' <span style="font-size:0.68rem; color:var(--accent);">(local)</span>' : ''}</div>
      <div class="dns-label">${escapeHtml(s.label)}</div>
      <div class="relay-actions">
        <button class="secondary" style="padding:6px 10px;" data-move-dns="${i}" data-dir="-1">↑</button>
        <button class="secondary" style="padding:6px 10px;" data-move-dns="${i}" data-dir="1">↓</button>
        <button class="secondary" style="padding:6px 10px; color:var(--danger);" data-del-dns="${i}">✕</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-move-dns]').forEach(btn => {
    btn.onclick = () => moveDns(parseInt(btn.dataset.moveDns, 10), parseInt(btn.dataset.dir, 10));
  });
  list.querySelectorAll('[data-del-dns]').forEach(btn => {
    btn.onclick = () => deleteDns(parseInt(btn.dataset.delDns, 10));
  });
}
function moveDns(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= dnsServers.length) return;
  [dnsServers[i], dnsServers[j]] = [dnsServers[j], dnsServers[i]];
  saveDns(); renderDnsList();
}
function deleteDns(i) { dnsServers.splice(i, 1); saveDns(); renderDnsList(); }
function saveDns() { localStorage.setItem('cosanostr-dns', JSON.stringify(dnsServers)); }

// ========== LOGIN ==========
const PANEL_OPTIONS = 'loginOptions';
const PANEL_IMPORT = 'importForm';
const PANEL_PASSWORD = 'passwordForm';
const PANEL_UNLOCK = 'unlockPanel';

function showPanel(id) {
  [PANEL_OPTIONS, PANEL_IMPORT, PANEL_PASSWORD, PANEL_UNLOCK].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.style.display = (p === id) ? 'block' : 'none';
  });
}
function getModalContent() { return loginModal.querySelector('.modal-content'); }
function ensurePanel(id) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.id = id; getModalContent().appendChild(el); }
  return el;
}
function rebuildOptionsPanel() {
  const opts = ensurePanel(PANEL_OPTIONS);
  const nip07 = !!window.nostr;
  opts.innerHTML = `
    <p style="margin-bottom:20px; color:var(--text-secondary); font-size:0.95rem;">Create a new account or log in</p>
    <button id="generateKeyBtn" style="width:100%; margin-bottom:10px;">Create new account</button>
    <button class="secondary" id="importKeyBtn" style="width:100%; margin-bottom:10px;">I already have an account (nsec)</button>
    <button class="secondary" id="viewOnlyBtn" style="width:100%; margin-bottom:10px;">View-only (npub)</button>
    ${nip07 ? `<button id="nip07Btn" style="width:100%;">Sign in with browser extension</button>` : ''}
  `;
  document.getElementById('generateKeyBtn').onclick = startCreateAccount;
  document.getElementById('importKeyBtn').onclick = () => showPanel(PANEL_IMPORT);
  document.getElementById('viewOnlyBtn').onclick = () => startViewOnlyLogin();
  if (nip07) document.getElementById('nip07Btn').onclick = startNip07Login;
}
function rebuildImportPanel() {
  const p = ensurePanel(PANEL_IMPORT);
  p.innerHTML = `
    <p style="margin-bottom:16px; color:var(--text-secondary); font-size:0.9rem;">Paste your nsec and choose a password to encrypt it locally</p>
    <input type="password" id="nsecInput" placeholder="nsec1..." style="margin-bottom:12px;">
    <input type="password" id="importPassword" placeholder="Password" style="margin-bottom:16px;">
    <button id="doImport" style="width:100%;">Log in</button>
    <button id="backFromImport" class="secondary" style="width:100%; margin-top:8px;">← Back</button>
  `;
  document.getElementById('doImport').onclick = doImport;
  document.getElementById('backFromImport').onclick = () => showPanel(PANEL_OPTIONS);
}
function rebuildPasswordPanel() {
  const p = ensurePanel(PANEL_PASSWORD);
  p.innerHTML = `
    <p style="color:var(--text-secondary); font-size:0.9rem; margin-bottom:12px;">Choose a password to encrypt your new key locally</p>
    <input type="password" id="newPassword" placeholder="Password" style="margin-bottom:16px;">
    <button id="saveNewKey" style="width:100%;">Save &amp; finish</button>
    <button id="backFromPassword" class="secondary" style="width:100%; margin-top:8px;">← Back</button>
  `;
  document.getElementById('saveNewKey').onclick = saveNewKey;
  document.getElementById('backFromPassword').onclick = () => { currentUser = null; showPanel(PANEL_OPTIONS); };
}

// Show login modal. If a stored encrypted key exists, jump straight to unlock;
// otherwise show the options panel.
function openLoginModal() {
  const hasStored = !!localStorage.getItem('cosanostr-encrypted-key');
  if (hasStored) { tryAutoUnlock(); return; }

  rebuildOptionsPanel();
  rebuildImportPanel();
  rebuildPasswordPanel();
  ensurePanel(PANEL_UNLOCK).style.display = 'none';
  showPanel(PANEL_OPTIONS);
  loginModal.classList.add('active');
}

async function tryAutoUnlock() {
  // View-only session takes priority (no password involved).
  const viewOnly = localStorage.getItem('cosanostr-view-only');
  if (viewOnly) {
    try {
      const v = JSON.parse(viewOnly);
      if (v && v.npub && v.pubHex) {
        currentUser = { npub: v.npub, pubHex: v.pubHex, privHex: null, viewOnly: true };
        loginModal.classList.remove('active');
        updateAuthNav();
        return true;
      }
    } catch (e) { localStorage.removeItem('cosanostr-view-only'); }
  }

  const stored = localStorage.getItem('cosanostr-encrypted-key');
  if (!stored) {
    encryptedKey = null;
    currentUser = null;
    return false;
  }

  try { encryptedKey = JSON.parse(stored); }
  catch (e) {
    localStorage.removeItem('cosanostr-encrypted-key');
    encryptedKey = null;
    return false;
  }

  rebuildOptionsPanel(); rebuildImportPanel(); rebuildPasswordPanel();
  const u = ensurePanel(PANEL_UNLOCK);

  u.innerHTML = `
    <div class="unlock-wrap">
      <div class="unlock-title">Enter password to unlock</div>
      <div class="pw-dots" id="pwDots"></div>
      <input type="password" id="unlockPassword" class="pw-hidden-input"
             inputmode="numeric" autocomplete="off" autocorrect="off"
             autocapitalize="off" spellcheck="false" aria-label="Password">
      <div class="pin-pad" id="pinPad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<div class="pin-key" data-key="${n}">${n}</div>`).join('')}
        <div class="pin-key secondary" data-key="back">⌫</div>
        <div class="pin-key" data-key="0">0</div>
        <div class="pin-key secondary" data-key="done">↵</div>
      </div>
      <div class="pin-actions">
        <button id="forgetAccountBtn" class="secondary" style="flex:1;">Forget</button>
        <button id="unlockBtn" style="flex:1;">Unlock</button>
      </div>
      <button id="unlockBackBtn" class="secondary" style="width:100%;">Use a different account</button>
    </div>
  `;

  const input = u.querySelector('#unlockPassword');
  const dots = u.querySelector('#pwDots');
  const unlockBtn = u.querySelector('#unlockBtn');
  const forgetBtn = u.querySelector('#forgetAccountBtn');
  const backBtn = u.querySelector('#unlockBackBtn');

  function renderDots() {
    const len = input.value.length;
    const count = Math.max(4, Math.min(8, len));
    dots.innerHTML = Array.from({ length: count }, (_, i) =>
      `<div class="pw-dot ${i < len ? 'filled' : ''}"></div>`
    ).join('');
  }
  renderDots();

  const doFocus = () => { try { input.focus({ preventScroll: true }); } catch (e) {} };
  doFocus(); setTimeout(doFocus, 60); setTimeout(doFocus, 220);

  input.addEventListener('input', renderDots);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); unlockBtn.click(); }
  });
  dots.addEventListener('click', doFocus);

  u.querySelectorAll('.pin-key').forEach(key => {
    key.addEventListener('click', (e) => {
      e.preventDefault();
      const k = key.dataset.key;
      if (k === 'back') input.value = input.value.slice(0, -1);
      else if (k === 'done') { unlockBtn.click(); return; }
      else input.value += k;
      renderDots();
      input.focus();
    });
  });

  unlockBtn.onclick = async () => {
    const pass = input.value;
    if (!pass) { input.focus(); return; }
    try {
      const priv = await NostrCrypto.decryptPrivateKey(encryptedKey, pass);
      const pub = await NostrCrypto.getPublicKey(priv);
      if (!pub) throw new Error('Could not derive public key');
      currentUser = { privHex: priv, pubHex: pub, npub: NostrCrypto.hexToNpub(pub) };
      loginModal.classList.remove('active');
      updateAuthNav();
      showView('home');
      return true;
    } catch (e) {
      alert('Failed to decrypt: ' + e.message);
      input.value = '';
      renderDots();
      input.focus();
      return false;
    }
  };
  forgetBtn.onclick = () => {
    localStorage.removeItem('cosanostr-encrypted-key');
    encryptedKey = null; currentUser = null;
    showPanel(PANEL_OPTIONS);
  };
  backBtn.onclick = () => showPanel(PANEL_OPTIONS);

  showPanel(PANEL_UNLOCK);
  loginModal.classList.add('active');
  setTimeout(doFocus, 320);
  return true;
}

async function startCreateAccount() {
  try {
    const priv = await NostrCrypto.generatePrivateKey();
    const pub = await NostrCrypto.getPublicKey(priv);
    if (!pub) { alert('Could not generate key.'); return; }
    const npub = NostrCrypto.hexToNpub(pub);
    if (!npub) { alert('Could not encode npub.'); return; }
    currentUser = { privHex: priv, pubHex: pub, npub };
    rebuildPasswordPanel();
    showPanel(PANEL_PASSWORD);
  } catch (e) { alert('Key generation failed: ' + e.message); }
}
async function saveNewKey() {
  if (!currentUser) { alert('Session lost, please start over.'); showPanel(PANEL_OPTIONS); return; }
  const pass = document.getElementById('newPassword').value;
  if (!pass) return alert('Password required');
  try {
    const enc = await NostrCrypto.encryptPrivateKey(currentUser.privHex, pass);
    localStorage.setItem('cosanostr-encrypted-key', JSON.stringify(enc));
    localStorage.removeItem('cosanostr-view-only');
    encryptedKey = enc;
    loginModal.classList.remove('active');
    updateAuthNav();
    const nsec = NostrCrypto.hexToNsec(currentUser.privHex);
    alert('Account created!\n\nnpub:\n' + currentUser.npub + '\n\nnsec (SECRET):\n' + (nsec || '(unavailable)'));
    showView('home');
  } catch (e) { alert('Could not save account: ' + e.message); }
}
async function doImport() {
  const nsec = document.getElementById('nsecInput').value.trim();
  const pass = document.getElementById('importPassword').value;
  if (!pass) return alert('Password required');
  if (!nsec.startsWith('nsec1')) return alert('Invalid nsec');
  const priv = NostrCrypto.nsecToHex(nsec);
  if (!priv) return alert('Invalid nsec (bad checksum or format)');
  const pub = await NostrCrypto.getPublicKey(priv);
  if (!pub) return alert('Could not derive public key');
  const npub = NostrCrypto.hexToNpub(pub);
  if (!npub) return alert('Could not encode npub');
  currentUser = { privHex: priv, pubHex: pub, npub };
  try {
    const enc = await NostrCrypto.encryptPrivateKey(priv, pass);
    localStorage.setItem('cosanostr-encrypted-key', JSON.stringify(enc));
    localStorage.removeItem('cosanostr-view-only');
    encryptedKey = enc;
  } catch (e) { alert('Could not save account: ' + e.message); return; }
  loginModal.classList.remove('active');
  updateAuthNav();
  alert('Logged in as ' + npub);
  showView('home');
}

function startViewOnlyLogin() {
  const p = ensurePanel('viewOnlyPanel');
  p.innerHTML = `
    <p style="margin-bottom:12px; color:var(--text-secondary); font-size:0.9rem;">Paste an npub to browse. No signing.</p>
    <input type="text" id="viewOnlyNpub" placeholder="npub1...">
    <button id="doViewOnly" style="width:100%; margin-top:8px;">Continue</button>
    <button id="backFromViewOnly" class="secondary" style="width:100%; margin-top:8px;">← Back</button>
  `;
  [PANEL_OPTIONS, PANEL_IMPORT, PANEL_PASSWORD, PANEL_UNLOCK].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  p.style.display = 'block';
  document.getElementById('backFromViewOnly').onclick = () => { p.style.display = 'none'; showPanel(PANEL_OPTIONS); };
  document.getElementById('doViewOnly').onclick = async () => {
    const npub = document.getElementById('viewOnlyNpub').value.trim();
    const hex = npubToHexLenient(npub);
    if (!hex) return alert('Invalid npub');
    currentUser = { npub: npub.toLowerCase(), pubHex: hex, privHex: null, viewOnly: true };
    localStorage.setItem('cosanostr-view-only', JSON.stringify({ npub: currentUser.npub, pubHex: hex }));
    localStorage.removeItem('cosanostr-encrypted-key');
    encryptedKey = null;
    p.style.display = 'none';
    loginModal.classList.remove('active');
    updateAuthNav();
    showView('home');
  };
}

async function startNip07Login() {
  if (!window.nostr) return alert('No signer extension detected.');
  try {
    const pubHex = await window.nostr.getPublicKey();
    if (!pubHex) return alert('Signer returned no pubkey.');
    const npub = NostrCrypto.hexToNpub(pubHex);
    currentUser = { pubHex, npub, privHex: null, signer: 'nip07' };
    localStorage.removeItem('cosanostr-encrypted-key');
    localStorage.removeItem('cosanostr-view-only');
    encryptedKey = null;
    loginModal.classList.remove('active');
    updateAuthNav();
    showView('home');
  } catch (e) { alert('NIP-07 login failed: ' + e.message); }
}

// Always-present close button + backdrop + Esc, wired once.
function setupModals() {
  const closeLogin = document.getElementById('closeLogin');
  if (closeLogin) closeLogin.onclick = () => loginModal.classList.remove('active');
  loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) loginModal.classList.remove('active');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && loginModal.classList.contains('active')) {
      loginModal.classList.remove('active');
    }
  });
}

function logout() {
  currentUser = null;
  encryptedKey = null;
  localStorage.removeItem('cosanostr-encrypted-key');
  localStorage.removeItem('cosanostr-view-only');
  updateAuthNav();
  showView('home');
}

// ========== UTILS ==========
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }
function copyToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => alert('Copied')).catch(() => legacyCopy(text));
  } else legacyCopy(text);
  function legacyCopy(t) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, t.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      alert(ok ? 'Copied' : 'Copy failed');
    } catch (e) { alert('Copy failed'); }
  }
}
function searchNotes(query) {
  content.innerHTML = `<div class="empty">Searching for notes containing "${escapeHtml(query)}"...</div><div id="feed"></div>`;
  queryRelaysLive({ kinds: [1], limit: 20 });
}
function npubToHexLenient(npub) {
  if (!npub) return null;
  const s = String(npub).trim().toLowerCase();
  if (!s.startsWith('npub1')) return null;
  const strict = NostrCrypto.npubToHex(s);
  if (strict) return strict;
  const pos = s.lastIndexOf('1');
  if (pos < 0) return null;
  const data = s.slice(pos + 1, s.length - 6);
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let value = 0, bits = 0;
  const out = [];
  for (const ch of data) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); value &= (1 << bits) - 1; }
  }
  const hex = out.map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.length >= 64 ? hex.slice(0, 64) : null;
}

window.copyToClipboard = copyToClipboard;
window.openQR = openQR;
window.showProfile = showProfile;
window.openScanner = openScanner;