const http = require("http");
const https = require("https");
const dnsPromises = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const MAX_RESPONSE_SIZE = 65536;
const REQUEST_TIMEOUT = 8000;

// Optional: comma-separated CIDRs that are allowed even if private.
// Example: ALLOW_LOCAL="127.0.0.1/32,192.168.1.0/24,::1/128"
const ALLOW_LOCAL = (process.env.ALLOW_LOCAL || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function ipv4ToNumber(ip) {
  if (net.isIP(ip) !== 4) return null;
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function inIPv4Range(ip, network, bits) {
  const a = ipv4ToNumber(ip), b = ipv4ToNumber(network);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const blocked = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
  ];
  return !blocked.some(([n, b]) => inIPv4Range(ip, n, b));
}

function expandIPv6(ip) {
  if (net.isIP(ip) !== 6) return null;
  let n = ip.toLowerCase();
  if (n.includes(".")) {
    const c = n.lastIndexOf(":");
    const v4 = n.slice(c + 1);
    const num = ipv4ToNumber(v4);
    if (num === null) return null;
    const hi = Math.floor(num / 65536), lo = num % 65536;
    n = n.slice(0, c + 1) + hi.toString(16) + ":" + lo.toString(16);
  }
  const halves = n.split("::");
  if (halves.length > 2) return null;
  const parse = h => h ? h.split(":").map(p => {
    if (!/^[0-9a-f]{1,4}$/.test(p)) throw new Error("bad");
    return parseInt(p, 16);
  }) : [];
  try {
    const L = parse(halves[0]), R = parse(halves[1] || "");
    const missing = 8 - L.length - R.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    return [...L, ...Array(missing).fill(0), ...R];
  } catch { return null; }
}
function isPublicIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return false;
  if ((g[0] & 0xE000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] <= 0x01FF) return false;
  if (g[0] === 0x2001 && g[1] === 0x0DB8) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3FFF && (g[1] & 0xF000) === 0) return false;
  return true;
}

function ipv6ToBigInt(ip) {
  const g = expandIPv6(ip);
  if (!g) return null;
  let n = 0n;
  for (const x of g) n = (n << 16n) | BigInt(x);
  return n;
}
function ipv6InCidr(ip, base, bits) {
  const a = ipv6ToBigInt(ip), b = ipv6ToBigInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (a & mask) === (b & mask);
}
function isAllowedLocal(ip) {
  if (!ALLOW_LOCAL.length) return false;
  for (const cidr of ALLOW_LOCAL) {
    const [base, bitsStr] = cidr.split("/");
    const bits = parseInt(bitsStr, 10);
    if (net.isIP(base) === 4 && net.isIP(ip) === 4 && inIPv4Range(ip, base, bits)) return true;
    if (net.isIP(base) === 6 && net.isIP(ip) === 6 && ipv6InCidr(ip, base, bits)) return true;
    if (!bitsStr && base === ip) return true;
  }
  return false;
}
function isPublicIP(ip, allowLocal) {
  const f = net.isIP(ip);
  if (f === 4) return isPublicIPv4(ip) || (allowLocal && isAllowedLocal(ip));
  if (f === 6) return isPublicIPv6(ip) || (allowLocal && isAllowedLocal(ip));
  return false;
}

async function queryDNS(resolver, domain) {
  const r = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  return r.flatMap(x => x.status === "fulfilled" ? x.value : []);
}
async function resolveDomain(domain, dnsServer, allowLocal) {
  const resolver = new dnsPromises.Resolver();
  resolver.setServers([dnsServer]);
  let addresses = [];
  try {
    addresses = await queryDNS(resolver, domain);
  } catch (e) {
    console.warn("Custom DNS failed for " + domain + " via " + dnsServer + ": " + e.message);
  }
  if (addresses.length) {
    if (addresses.some(ip => !isPublicIP(ip, allowLocal))) throw new Error("Non-public IP address rejected");
    return [...new Set(addresses)];
  }
  try {
    addresses = await queryDNS(dnsPromises, domain);
    if (!addresses.length) throw new Error("No DNS addresses returned");
    if (addresses.some(ip => !isPublicIP(ip, allowLocal))) throw new Error("Non-public IP address rejected");
    console.log("Fell back to system DNS for " + domain + " -> " + addresses.join(", "));
    return [...new Set(addresses)];
  } catch (e) {
    throw new Error("DNS lookup failed: " + e.message);
  }
}

function fetchNostrJson(domain, name, addresses, allowLocal) {
  return new Promise((resolve, reject) => {
    let index = 0, completed = false;
    const fail = e => { if (completed) return; completed = true; reject(e || new Error("All connections failed (HTTPS+HTTP)")); };
    const succeed = d => { if (completed) return; completed = true; resolve(d); };

    function tryProtocol(ip, useHttps, onFail) {
      if (!isPublicIP(ip, allowLocal)) return onFail(new Error("Non-public connection IP rejected"));
      const mod = useHttps ? https : http;
      const port = useHttps ? 443 : 80;
      let done = false;
      const attemptFail = e => {
        if (done || completed) return;
        done = true;
        if (e) console.warn((useHttps ? "HTTPS" : "HTTP") + " failed for " + ip + ": " + e.message);
        onFail();
      };
      const opts = {
        host: ip, port,
        path: "/.well-known/nostr.json?name=" + encodeURIComponent(name),
        agent: false,
        headers: { Accept: "application/json", Host: domain }
      };
      if (useHttps) { opts.servername = domain; opts.rejectUnauthorized = false; }
      const req = mod.get(opts, res => {
        if (res.statusCode !== 200) { res.resume(); return attemptFail(new Error("HTTP status " + res.statusCode)); }
        let body = "", size = 0;
        res.setEncoding("utf8");
        res.on("data", c => {
          size += Buffer.byteLength(c);
          if (size > MAX_RESPONSE_SIZE) { req.destroy(); attemptFail(new Error("Response too large")); return; }
          body += c;
        });
        res.on("end", () => {
          if (done || completed) return;
          try { const d = JSON.parse(body); done = true; succeed(d); }
          catch { attemptFail(new Error("Invalid JSON response")); }
        });
        res.on("error", attemptFail);
      });
      req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error("Connection timeout")));
      req.on("error", attemptFail);
    }

    function attempt() {
      if (completed) return;
      if (index >= addresses.length) return fail(new Error("All connections failed (HTTPS+HTTP)"));
      const ip = addresses[index++];
      tryProtocol(ip, true, () => { if (!completed) tryProtocol(ip, false, attempt); });
    }
    attempt();
  });
}

async function resolveNip05(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid request");
  const { nip05, dns: dnsServer, allowLocal } = input;

  if (typeof nip05 !== "string" || nip05.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(nip05))
    throw new Error("Invalid NIP-05");

  if (typeof dnsServer !== "string" || !isPublicIP(dnsServer, !!allowLocal))
    throw new Error("Invalid or non-public DNS server IP");

  const [name, rawDomain] = nip05.split("@");
  const username = name.toLowerCase();
  const domain = rawDomain.toLowerCase();

  if (!/^[a-z0-9._-]+$/.test(username)) throw new Error("Invalid username");
  if (domain.length > 253 || domain.endsWith(".") || domain.indexOf("..") !== -1)
    throw new Error("Invalid domain");

  let addresses;
  if (input.ip !== undefined && input.ip !== null && input.ip !== "") {
    if (typeof input.ip !== "string" || !isPublicIP(input.ip, !!allowLocal))
      throw new Error("Invalid or non-public override IP");
    addresses = [input.ip];
    console.log("Using direct IP " + input.ip + " for " + domain);
  } else {
    addresses = await resolveDomain(domain, dnsServer, !!allowLocal);
  }

  const data = await fetchNostrJson(domain, username, addresses, !!allowLocal);
  const registered = data && data.names && data.names[username];
  if (typeof registered !== "string" || !/^[0-9a-f]{64}$/i.test(registered))
    throw new Error("Name not found or invalid pubkey in nostr.json");

  const hex = registered.toLowerCase();
  let relays = [];
  if (data.relays) relays = data.relays[registered] || data.relays[hex] || [];

  return { valid: true, nip05, hex, dnsServer, resolvedIPs: addresses, relays };
}

const server = http.createServer((req, res) => {
  console.log(new Date().toISOString() + " " + req.method + " " + req.url);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }
  if (req.method !== "POST" || req.url !== "/api/nip05/resolve")
    return send(res, 404, { error: "Not found" });

  let body = "";
  req.on("data", c => {
    body += c;
    if (Buffer.byteLength(body) > 10000) {
      send(res, 413, { valid: false, error: "Request body too large" });
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (res.destroyed || res.writableEnded) return;
    try {
      const input = JSON.parse(body);
      send(res, 200, await resolveNip05(input));
    } catch (e) {
      console.error("Resolve error:", e.message);
      if (!res.destroyed && !res.writableEnded)
        send(res, 400, { valid: false, error: e.message });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("NIP-05 DNS API running on http://127.0.0.1:" + PORT);
  if (ALLOW_LOCAL.length) console.log("ALLOW_LOCAL:", ALLOW_LOCAL.join(", "));
  else console.log("ALLOW_LOCAL not set — private IPs are rejected.");
});