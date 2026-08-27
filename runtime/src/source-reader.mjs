import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b))
    || (a === 203 && b === 0) || a >= 224;
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family !== 6) return true;
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return privateIpv4(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
    || /^fe[89ab]/.test(value) || value.startsWith("2001:db8:") || value.startsWith("2001:10:");
}

function safeUrl(input) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Source must be a public HTTP(S) URL without credentials or a custom port.");
  }
  if (url.hostname === "localhost" || net.isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    throw new Error("Private network sources are not allowed.");
  }
  return url;
}

async function safeLookup(hostname, options, callback) {
  try {
    const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some((item) => isPrivateAddress(item.address))) {
      throw new Error("Source hostname resolves to a private or reserved address.");
    }
    const family = typeof options === "object" ? options.family : 0;
    const selected = answers.find((item) => !family || item.family === family) || answers[0];
    callback(null, selected.address, selected.family);
  } catch (error) {
    callback(error);
  }
}

function requestOnce(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      lookup: safeLookup,
      headers: {
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": "PACT-SourceReader/0.2",
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error(`Source exceeds ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(12_000, () => request.destroy(new Error("Source request timed out.")));
    request.on("error", reject);
    request.end();
  });
}

function readable(raw, contentType) {
  const value = raw.toString("utf8");
  if (!contentType.includes("html")) return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 60_000);
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ").trim().slice(0, 60_000);
}

export async function readSource(input) {
  let url = safeUrl(input);
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await requestOnce(url, 200_000);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error("Source redirect has no destination.");
      url = safeUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Source returned HTTP ${response.status}.`);
    const contentType = String(response.headers["content-type"] || "text/plain").toLowerCase();
    return {
      url: url.toString(),
      text: readable(response.body, contentType),
      sha256: createHash("sha256").update(response.body).digest("hex"),
      fetchedAt: new Date().toISOString(),
    };
  }
  throw new Error("Source redirected too many times.");
}
