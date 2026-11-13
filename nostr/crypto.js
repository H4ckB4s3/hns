// crypto.js - Cosanostr crypto utilities
// Self-contained. No external scripts. Defines window.NostrCrypto even on
// error, so callers always get a clear message instead of "not defined".

(function () {
  'use strict';

  // ---- Safe wrappers ----
  const _webcrypto = (function () {
    try { if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto; } catch (e) {}
    try { if (typeof window !== 'undefined' && window.crypto) return window.crypto; } catch (e) {}
    try { if (typeof self !== 'undefined' && self.crypto) return self.crypto; } catch (e) {}
    return null;
  })();

  function _randomBytes(length) {
    const out = new Uint8Array(length);
    if (_webcrypto && typeof _webcrypto.getRandomValues === 'function') {
      try { _webcrypto.getRandomValues(out); return out; } catch (e) {}
    }
    for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  function _hexToBytes(hex) {
    if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function _bytesToHex(maybeBytesOrHex) {
    if (typeof maybeBytesOrHex === 'string') {
      if (/^[0-9a-fA-F]+$/.test(maybeBytesOrHex) && maybeBytesOrHex.length % 2 === 0) {
        return maybeBytesOrHex.toLowerCase();
      }
      return Array.from(maybeBytesOrHex)
        .map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
    }
    return Array.from(maybeBytesOrHex)
      .map(b => (typeof b === 'number' ? b : 0).toString(16).padStart(2, '0'))
      .join('');
  }

  function _sha256(bytes) {
    if (!_webcrypto || !_webcrypto.subtle) {
      return Promise.reject(new Error('SHA-256 unavailable (needs https:// or http://localhost)'));
    }
    return _webcrypto.subtle.digest('SHA-256', bytes).then(h => new Uint8Array(h));
  }

  // ============================================================
  // BigInt via constructor — avoids `…n` literal parse issues
  // ============================================================
  const BIG0 = BigInt(0);
  const BIG1 = BigInt(1);
  const BIG2 = BigInt(2);
  const BIG3 = BigInt(3);
  const BIG4 = BigInt(4);
  const BIG7 = BigInt(7);
  const BIG8 = BigInt(8);
  const BIG31 = BigInt(31);
  const BIG32 = BigInt(32);
  const BIG255 = BigInt(255);

  // Field prime: 2^256 - 2^32 - 977
  const P = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
  // Curve order
  const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  // Generator
  const Gx = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
  const Gy = BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8');

  function mod(a, m) {
    const r = a % m;
    return r >= BIG0 ? r : r + m;
  }

  function invMod(a, m) {
    // Extended Euclidean
    let old_r = mod(a, m), r = m;
    let old_s = BIG1, s = BIG0;
    while (r !== BIG0) {
      const q = old_r / r;
      [old_r, r] = [r, old_r - q * r];
      [old_s, s] = [s, old_s - q * s];
    }
    return mod(old_s, m);
  }

  function powMod(base, exp, m) {
    let result = BIG1;
    base = mod(base, m);
    while (exp > BIG0) {
      if (exp & BIG1) result = mod(result * base, m);
      base = mod(base * base, m);
      exp >>= BIG1;
    }
    return result;
  }

  function pointAdd(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    const x1 = a[0], y1 = a[1];
    const x2 = b[0], y2 = b[1];
    if (x1 === x2) {
      if (mod(y1 + y2, P) === BIG0) return null;
      const lam = mod(BIG3 * x1 * x1 * invMod(BIG2 * y1, P), P);
      const x3 = mod(lam * lam - BIG2 * x1, P);
      const y3 = mod(lam * (x1 - x3) - y1, P);
      return [x3, y3];
    }
    const lam = mod((y2 - y1) * invMod(x2 - x1, P), P);
    const x3 = mod(lam * lam - x1 - x2, P);
    const y3 = mod(lam * (x1 - x3) - y1, P);
    return [x3, y3];
  }

  function pointMul(k, point) {
    k = mod(k, N);
    if (k === BIG0) return null;
    let result = null;
    let addend = point;
    while (k > BIG0) {
      if (k & BIG1) result = pointAdd(result, addend);
      addend = pointAdd(addend, addend);
      k >>= BIG1;
    }
    return result;
  }

  function bytesToBigInt(bytes) {
    let out = BIG0;
    for (const b of bytes) out = (out << BIG8) | BigInt(b);
    return out;
  }

  function bigIntToBytes32(n) {
    const out = new Uint8Array(32);
    let v = n;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & BIG255);
      v >>= BIG8;
    }
    return out;
  }

  function pubKeyFromPriv(privHex) {
    const privBytes = _hexToBytes(privHex);
    if (!privBytes || privBytes.length !== 32) throw new Error('Invalid privKey');
    const d = bytesToBigInt(privBytes);
    if (d <= BIG0 || d >= N) throw new Error('Invalid scalar');
    const point = pointMul(d, [Gx, Gy]);
    if (!point) throw new Error('Invalid point');
    return bigIntToBytes32(point[0]);
  }

  function taggedHash(tag, ...msgs) {
    const tagBytes = new TextEncoder().encode(tag);
    return _sha256(tagBytes).then(tagHash => {
      const len = msgs.reduce((a, m) => a + m.length, 0);
      const buf = new Uint8Array(32 + 32 + len);
      buf.set(tagHash, 0);
      buf.set(tagHash, 32);
      let off = 64;
      for (const m of msgs) { buf.set(m, off); off += m.length; }
      return _sha256(buf);
    });
  }

  function schnorrSign(msgHex, privHex) {
    const msg = _hexToBytes(msgHex);
    const privBytes = _hexToBytes(privHex);
    if (!privBytes || privBytes.length !== 32) return Promise.reject(new Error('Invalid privKey'));

    const d0 = bytesToBigInt(privBytes);
    if (d0 <= BIG0 || d0 >= N) return Promise.reject(new Error('Invalid scalar'));

    const point = pointMul(d0, [Gx, Gy]);
    const d = (point[1] & BIG1) === BIG1 ? mod(N - d0, N) : d0;
    const px = bigIntToBytes32(point[0]);
    const aux = _randomBytes(32);

    return taggedHash('BIP0340/aux', aux).then(auxHash => {
      const t = new Uint8Array(32);
      const dBytes = bigIntToBytes32(d);
      for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];
      return taggedHash('BIP0340/nonce', t, px, msg);
    }).then(rand => {
      const k0 = bytesToBigInt(rand) % N;
      if (k0 === BIG0) throw new Error('Schnorr: k0 zero');
      const R = pointMul(k0, [Gx, Gy]);
      const k = (R[1] & BIG1) === BIG1 ? mod(N - k0, N) : k0;
      const Rx = bigIntToBytes32(R[0]);
      return taggedHash('BIP0340/challenge', Rx, px, msg).then(eBytes => {
        const e = bytesToBigInt(eBytes) % N;
        const sigScalar = mod(k + e * d, N);
        const sig = new Uint8Array(64);
        sig.set(Rx, 0);
        sig.set(bigIntToBytes32(sigScalar), 32);
        return sig;
      });
    });
  }

  // ============================================================
  // Bech32
  // ============================================================
  const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  function bech32HrpExpand(hrp) {
    const high = [], low = [];
    for (let i = 0; i < hrp.length; i++) {
      const c = hrp.charCodeAt(i);
      high.push(c >> 5);
      low.push(c & 31);
    }
    return high.concat([0]).concat(low);
  }
  function bech32CreateChecksum(hrp, dataWords) {
    const values = bech32HrpExpand(hrp).concat(dataWords).concat([0,0,0,0,0,0]);
    const polymod = bech32Polymod(values) ^ 1;
    const result = [];
    for (let i = 0; i < 6; i++) result.push((polymod >> (5 * (5 - i))) & 31);
    return result;
  }
  function bech32VerifyChecksum(hrp, fullWords) {
    return bech32Polymod(bech32HrpExpand(hrp).concat(fullWords)) === 1;
  }
  function bech32ConvertBits(data, fromBits, toBits, pad) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
      if (value < 0 || (value >> fromBits) !== 0) return null;
      acc = (acc << fromBits) | value;
      bits += fromBits;
      while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
    }
    if (pad) {
      if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
      return null;
    }
    return ret;
  }
  function bech32Encode(prefix, dataBytes) {
    const dataWords = bech32ConvertBits(Array.from(dataBytes), 8, 5, true);
    if (!dataWords) throw new Error('bech32 encode failed');
    const checksum = bech32CreateChecksum(prefix, dataWords);
    return prefix + '1' + dataWords.concat(checksum).map(w => ALPHABET[w]).join('');
  }
  function bech32Decode(bech) {
    if (typeof bech !== 'string') return null;
    bech = bech.toLowerCase();
    const pos = bech.lastIndexOf('1');
    if (pos < 1 || pos + 7 > bech.length) return null;
    const prefix = bech.slice(0, pos);
    const dataPart = bech.slice(pos + 1);
    if (dataPart.length < 6) return null;
    const words = [];
    for (const c of dataPart) {
      const idx = ALPHABET.indexOf(c);
      if (idx === -1) return null;
      words.push(idx);
    }
    if (!bech32VerifyChecksum(prefix, words)) return null;
    const payloadWords = words.slice(0, -6);
    const bytes = bech32ConvertBits(payloadWords, 5, 8, false);
    if (!bytes) return null;
    return { prefix, bytes };
  }

  // ============================================================
  // Public API
  // ============================================================
  const Crypto = {
    _status: { ok: false, reason: null },

    bech32Encode(prefix, dataBytes) { return bech32Encode(prefix, dataBytes); },
    bech32Decode(bech) { return bech32Decode(bech); },

    npubToHex(npub) {
      if (!npub || typeof npub !== 'string' || !npub.startsWith('npub1')) return null;
      const dec = bech32Decode(npub);
      if (!dec || dec.prefix !== 'npub' || !dec.bytes || dec.bytes.length < 32) return null;
      return dec.bytes.slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    nsecToHex(nsec) {
      if (!nsec || typeof nsec !== 'string' || !nsec.startsWith('nsec1')) return null;
      const dec = bech32Decode(nsec);
      if (!dec || dec.prefix !== 'nsec' || !dec.bytes || dec.bytes.length < 32) return null;
      return dec.bytes.slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    hexToNpub(hex) {
      if (!hex || typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      try { return bech32Encode('npub', hex.match(/.{1,2}/g).map(h => parseInt(h, 16))); }
      catch (e) { console.error('hexToNpub failed', e); return null; }
    },
    hexToNsec(hex) {
      if (!hex || typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      try { return bech32Encode('nsec', hex.match(/.{1,2}/g).map(h => parseInt(h, 16))); }
      catch (e) { console.error('hexToNsec failed', e); return null; }
    },

    async generatePrivateKey() {
      if (!this._status.ok) throw new Error(this._status.reason || 'Crypto not initialized');
      const priv = _randomBytes(32);
      if (priv.every(b => b === 0)) priv[31] = 1;
      return _bytesToHex(priv);
    },

    async getPublicKey(privHex) {
      if (!privHex || typeof privHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(privHex)) {
        console.error('getPublicKey: invalid privHex', privHex);
        return null;
      }
      if (!this._status.ok) { console.error('getPublicKey:', this._status.reason); return null; }
      try {
        const xOnly = pubKeyFromPriv(privHex);
        return _bytesToHex(xOnly);
      } catch (e) {
        console.error('getPublicKey failed', e);
        return null;
      }
    },

    async getEventId(event) {
      const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
      const bytes = new TextEncoder().encode(serialized);
      const hash = await _sha256(bytes);
      return _bytesToHex(hash);
    },

    async signEvent(event, privHex) {
      if (!this._status.ok) throw new Error(this._status.reason || 'Crypto not initialized');
      if (!event.pubkey) {
        const pub = await this.getPublicKey(privHex);
        if (!pub) throw new Error('Could not derive pubkey');
        event.pubkey = pub;
      }
      const id = await this.getEventId(event);
      event.id = id;
      const sigBytes = await schnorrSign(id, privHex);
      event.sig = _bytesToHex(sigBytes);
      return event;
    },

    _requireSubtle() {
      if (!_webcrypto || !_webcrypto.subtle) {
        throw new Error('Web Crypto (crypto.subtle) is unavailable. Use https:// or http://localhost.');
      }
      return _webcrypto.subtle;
    },
    async deriveKey(password, salt) {
      const subtle = this._requireSubtle();
      const km = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      return subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    },
    async encryptPrivateKey(privHex, password) {
      const subtle = this._requireSubtle();
      const salt = _randomBytes(16);
      const iv = _randomBytes(12);
      const key = await this.deriveKey(password, salt);
      const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(privHex));
      return { salt: _bytesToHex(salt), iv: _bytesToHex(iv), data: _bytesToHex(new Uint8Array(ciphertext)) };
    },
    async decryptPrivateKey(encrypted, password) {
      const subtle = this._requireSubtle();
      const salt = _hexToBytes(encrypted.salt);
      const iv = _hexToBytes(encrypted.iv);
      const data = _hexToBytes(encrypted.data);
      const key = await this.deriveKey(password, salt);
      try {
        const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        return new TextDecoder().decode(decrypted);
      } catch (e) {
        throw new Error('Wrong password or corrupted data');
      }
    }
  };

  // Mark status
  try {
    // Small self-test to catch broken internals at definition time.
    const testPriv = '0000000000000000000000000000000000000000000000000000000000000001';
    const pub = pubKeyFromPriv(testPriv);
    if (!pub || pub.length !== 32) throw new Error('secp256k1 self-test failed (bad pubkey)');
    Crypto._status = { ok: true, reason: null };
  } catch (e) {
    console.error('[crypto.js] init error:', e);
    Crypto._status = { ok: false, reason: 'Crypto init failed: ' + e.message };
  }

  // Expose unconditionally, so callers always see NostrCrypto
  window.NostrCrypto = Crypto;

  if (!Crypto._status.ok) {
    console.error('[crypto.js] NOT OK:', Crypto._status.reason);
  } else {
    console.log('[crypto.js] ready');
  }
})();
