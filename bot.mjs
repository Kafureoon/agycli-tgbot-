import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Resvg } from "@resvg/resvg-js";

const execFileAsync = promisify(execFile);

dns.setDefaultResultOrder("ipv4first");
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

const APP_DIR = "/opt/agy-tg-bot";
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const LEDGER_PATH = path.join(APP_DIR, "ledger.json");
const PROFILES_DIR = "/var/lib/agy-profiles";
const SHARED_HOME = "/root";
const SHARED_AGY_DIR = path.join(SHARED_HOME, ".gemini", "antigravity-cli");
const SHARED_OAUTH_PATH = path.join(SHARED_AGY_DIR, "antigravity-oauth-token");
const AGY_BIN = "/root/.local/bin/agy";
const SUB_URL_FILE = "/opt/mihomo/sub.url";
const SUB_INFO_FILE = "/opt/mihomo/sub_info.json";
const UPDATE_SUB_SCRIPT = "/opt/mihomo/update-sub.py";
const UPLOAD_DIR = "/tmp/agy-tg-uploads";
const STATUS_IMG_DIR = "/tmp/agy-tg-status";
const WQY_FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

fs.mkdirSync(APP_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(STATUS_IMG_DIR, { recursive: true, mode: 0o700 });

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode });
}

let cfg = loadJson(CONFIG_PATH, {});
let ledger = loadJson(LEDGER_PATH, { chats: {} });

function saveConfig() {
  saveJson(CONFIG_PATH, cfg, 0o600);
}

function saveLedger() {
  saveJson(LEDGER_PATH, ledger, 0o600);
}

function ensureProfileDir(name) {
  const safe = String(name || "acc1").replace(/[^a-zA-Z0-9_-]/g, "") || "acc1";
  const dir = path.join(PROFILES_DIR, safe);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  if (!cfg.profiles) cfg.profiles = {};
  if (!cfg.profiles[safe]) {
    cfg.profiles[safe] = { createdAt: Date.now(), cooldownUntil: 0, note: "" };
    saveConfig();
  }
  return { name: safe, dir };
}

function getProfileHome(name) {
  return ensureProfileDir(name).dir;
}

function getProfileOAuthPath(name) {
  const safe = String(name || "acc1").replace(/[^a-zA-Z0-9_-]/g, "") || "acc1";
  return path.join(PROFILES_DIR, safe, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function activateProfileInSharedHome(profileName) {
  const srcPath = getProfileOAuthPath(profileName);
  if (!fs.existsSync(srcPath)) return false;
  fs.mkdirSync(SHARED_AGY_DIR, { recursive: true, mode: 0o700 });
  const raw = fs.readFileSync(srcPath, "utf8");
  const tmpPath = `${SHARED_OAUTH_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, raw, { mode: 0o600 });
  fs.renameSync(tmpPath, SHARED_OAUTH_PATH);
  return true;
}

function syncBackProfileFromSharedHome(profileName) {
  if (!fs.existsSync(SHARED_OAUTH_PATH)) return false;
  try {
    const raw = fs.readFileSync(SHARED_OAUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    const expectedEmail = cfg.profiles?.[profileName]?.email;
    const actualEmail = typeof parsed.id_token_email === "string" ? parsed.id_token_email : "";
    if (expectedEmail && actualEmail && expectedEmail.toLowerCase() !== actualEmail.toLowerCase()) {
      return false;
    }
    const dstPath = getProfileOAuthPath(profileName);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dstPath, raw, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isProfileLoggedIn(name) {
  const home = path.join(PROFILES_DIR, name);
  const oauthTok = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const secPath = path.join(home, ".config", "antigravity", "plugin-secrets.json");
  try {
    if (fs.existsSync(oauthTok) && fs.statSync(oauthTok).size > 20) {
      return true;
    }
    if (fs.existsSync(secPath) && fs.statSync(secPath).size > 40) {
      const raw = fs.readFileSync(secPath, "utf8");
      if (raw.includes("refresh_token") || raw.includes("oauth")) {
        return true;
      }
    }
  } catch {}
  return false;
}

function buildAgyEnv(profileName, { isolated = false } = {}) {
  const home = isolated ? getProfileHome(profileName) : SHARED_HOME;
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  if (cfg.proxyEnabled && cfg.proxyUrl) {
    env.HTTP_PROXY = cfg.proxyUrl;
    env.HTTPS_PROXY = cfg.proxyUrl;
    env.ALL_PROXY = cfg.proxyUrl;
    env.http_proxy = cfg.proxyUrl;
    env.https_proxy = cfg.proxyUrl;
    env.all_proxy = cfg.proxyUrl;
    env.NO_PROXY = "127.0.0.1,localhost";
  } else {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
  }
  return env;
}

function trimMiddle(str, max = 60) {
  if (!str) return "";
  const oneLine = String(str).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 3) + "...";
}

function formatDuration(ms) {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function formatBytes(kb) {
  const gb = kb / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(2)}G` : `${Math.round(kb / 1024)}M`;
}

function formatTrafficBytes(bytes = 0) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Short callback token map to stay safely under Telegram's 64-byte callback_data limit
const cbStore = new Map();
let cbSeq = 1;
function makeCb(type, payload) {
  const id = (cbSeq++).toString(36);
  cbStore.set(id, { type, payload, ts: Date.now() });
  if (cbStore.size > 500) {
    const oldest = cbStore.keys().next().value;
    cbStore.delete(oldest);
  }
  return `k:${id}`;
}

function httpJsonRequest(urlStr, method = "GET", bodyObj = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyStr = bodyObj !== null ? JSON.stringify(bodyObj) : null;
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        family: 4,
        agent: false,
        timeout: timeoutMs,
        headers: {
          ...(bodyStr !== null
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr),
              }
            : {}),
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.trim()) {
            resolve({ status: res.statusCode, data: {} });
            return;
          }
          try {
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, data: { raw: text } });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`HTTP timeout (${timeoutMs}ms)`)));
    req.on("error", reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

function httpsJsonPost(urlStr, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "POST",
        family: 4,
        agent: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(new Error(`Invalid JSON from TG (${res.statusCode}): ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`TG request timeout (${timeoutMs}ms)`)));
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsGetBuffer(urlStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "GET",
        family: 4,
        agent: false,
        timeout: timeoutMs,
        headers: { Connection: "close" },
      },
      (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Download timeout (${timeoutMs}ms)`)));
    req.on("error", reject);
    req.end();
  });
}

function httpsJsonPostWithProxy(urlStr, payload, headers = {}, proxyUrl = "", timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyStr = JSON.stringify(payload);
    let settled = false;
    let tunnelSocket = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (tunnelSocket && !tunnelSocket.destroyed) {
        try { tunnelSocket.destroy(); } catch {}
      }
      if (err) reject(err);
      else resolve(val);
    };

    const doHttps = (socket) => {
      tunnelSocket = socket;
      const opts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        agent: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          Connection: "close",
          ...headers,
        },
      };
      if (socket) {
        opts.createConnection = () => socket;
        opts.servername = u.hostname;
      } else {
        opts.family = 4;
      }
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.trim()) {
            return finish(null, { status: res.statusCode, data: {} });
          }
          try {
            finish(null, { status: res.statusCode, data: JSON.parse(text) });
          } catch {
            finish(null, { status: res.statusCode, data: { raw: text } });
          }
        });
        res.on("error", (e) => finish(e));
      });
      req.on("timeout", () => {
        req.destroy(new Error(`HTTPS timeout (${timeoutMs}ms)`));
      });
      req.on("error", (e) => finish(e));
      req.write(bodyStr);
      req.end();
    };

    if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
      const pu = new URL(proxyUrl);
      const preq = http.request({
        host: pu.hostname,
        port: Number(pu.port) || 80,
        method: "CONNECT",
        path: `${u.hostname}:${u.port || 443}`,
        timeout: timeoutMs,
      });
      preq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return finish(new Error(`Proxy CONNECT ${res.statusCode}`));
        }
        doHttps(socket);
      });
      preq.on("timeout", () => {
        preq.destroy(new Error(`Proxy timeout (${timeoutMs}ms)`));
      });
      preq.on("error", (e) => finish(e));
      preq.end();
    } else {
      doHttps(null);
    }
  });
}

const TG_API = `https://api.telegram.org/bot${cfg.botToken}`;
let tgRateLimitUntil = 0;

async function tg(method, body = {}, opts = {}) {
  const isPoll = method === "getUpdates";
  const waitOn429 = !isPoll && opts.waitOn429 !== false;
  const timeoutMs = isPoll ? 45000 : 20000;
  const maxAttempts = isPoll ? 1 : 5;
  let lastErr;
  let rateLimitWaits = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (waitOn429 && tgRateLimitUntil > Date.now()) {
      const waitMs = Math.min(185000, tgRateLimitUntil - Date.now());
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    try {
      const data = await httpsJsonPost(`${TG_API}/${method}`, body, timeoutMs);
      if (!data.ok) {
        const err = new Error(`TG ${method} ${data.error_code}: ${data.description}`);
        err.code = data.error_code;
        err.retryAfter = data.parameters?.retry_after;
        if (err.code === 429 && err.retryAfter) {
          tgRateLimitUntil = Math.max(tgRateLimitUntil, Date.now() + (err.retryAfter + 1) * 1000);
          if (waitOn429 && err.retryAfter <= 180 && rateLimitWaits < 3) {
            rateLimitWaits++;
            attempt--;
            continue;
          }
        }
        throw err;
      }
      return data.result;
    } catch (e) {
      lastErr = e;
      if (typeof e.code === "number") throw e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }
  }
  throw lastErr;
}

function httpsMultipartPhoto(urlStr, chatId, filePath, caption = "", timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const boundary = `----AgyTgBoundary${Date.now().toString(16)}`;
    const fileBuf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`, "utf8"),
    ];
    if (caption) {
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`, "utf8")
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`,
        "utf8"
      ),
      fileBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
    );
    const body = Buffer.concat(parts);
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "POST",
        family: 4,
        agent: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(new Error(`Invalid JSON from TG sendPhoto (${res.statusCode}): ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`TG sendPhoto timeout (${timeoutMs}ms)`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendPhoto(chatId, filePath, caption = "") {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await httpsMultipartPhoto(`${TG_API}/sendPhoto`, chatId, filePath, caption, 30000);
      if (!data.ok) {
        const err = new Error(`TG sendPhoto ${data.error_code}: ${data.description}`);
        err.code = data.error_code;
        throw err;
      }
      return data.result;
    } catch (e) {
      lastErr = e;
      if (typeof e.code === "number") throw e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 400));
    }
  }
  throw lastErr;
}

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function closeUnclosedCodeFence(text) {
  const lines = String(text || "").split("\n");
  let open = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) open = !open;
  }
  return open ? `${text}\n\`\`\`` : text;
}

function parseMdTableRow(line) {
  let s = String(line || "").trim();
  if (!s.includes("|")) return null;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isMdTableSep(line) {
  const s = String(line || "").trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  return /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(s) || /^\|?\s*:?-{2,}:?\s*\|?$/.test(s);
}

function mdToTgHtml(mdText) {
  let src = closeUnclosedCodeFence(String(mdText || "").replace(/\r\n/g, "\n"));
  const tokens = [];
  const stash = (html) => {
    const idx = tokens.length;
    tokens.push(html);
    return `\u0000TKN${idx}\u0000`;
  };

  src = src.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
    const cleanCode = code.replace(/\n$/, "");
    if (lang) {
      return stash(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(cleanCode)}</code></pre>`);
    }
    return stash(`<pre>${escapeHtml(cleanCode)}</pre>`);
  });

  src = src.replace(/`([^`\n]+?)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  src = src.replace(/\[([^\]\n]+)\]\((file:\/\/[^\s)]+)\)/g, (_, label) => {
    return stash(`<code>${escapeHtml(label)}</code>`);
  });
  src = src.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    return stash(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
  });

  src = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = src.split("\n");
  const outLines = [];
  let quoteBuf = [];
  const flushQuote = () => {
    if (quoteBuf.length > 0) {
      outLines.push(`<blockquote>${quoteBuf.join("\n")}</blockquote>`);
      quoteBuf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const qm = line.match(/^&gt;\s?(.*)$/);
    if (qm) {
      quoteBuf.push(qm[1]);
      continue;
    }
    flushQuote();

    // Format Markdown tables cleanly for Telegram mobile readability
    if (i + 1 < lines.length && line.includes("|") && isMdTableSep(lines[i + 1])) {
      const headers = parseMdTableRow(line);
      if (headers && headers.length >= 2) {
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          const cells = parseMdTableRow(lines[i]);
          if (!cells) break;
          while (cells.length < headers.length) cells.push("");
          rows.push(cells.slice(0, headers.length));
          i++;
        }
        i--; // step back for outer loop increment
        if (rows.length > 0) {
          const stripOuterBold = (s) => s.replace(/^\*\*([\s\S]+)\*\*$/, "$1").replace(/^__([\s\S]+)__$/, "$1");
          for (const r of rows) {
            const firstCol = stripOuterBold(r[0]);
            if (headers.length === 2) {
              outLines.push(`• <b>${firstCol}</b>：${r[1]}`);
            } else {
              outLines.push(`▸ <b>${firstCol}</b>`);
              for (let c = 1; c < headers.length; c++) {
                if (r[c]) outLines.push(`  • <b>${stripOuterBold(headers[c])}</b>：${r[c]}`);
              }
            }
          }
          continue;
        }
      }
    }

    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      outLines.push("──────────────");
      continue;
    }
    const hm = line.match(/^#{1,6}\s+(.+)$/);
    if (hm) {
      outLines.push(`<b>${hm[1]}</b>`);
      continue;
    }
    const lm = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (lm) {
      outLines.push(`${lm[1]}• ${lm[2]}`);
      continue;
    }
    outLines.push(line);
  }
  flushQuote();
  src = outLines.join("\n");

  src = src.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  src = src.replace(/__([^\n]+?)__/g, "<b>$1</b>");
  src = src.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
  src = src.replace(/(?<!\*)\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*(?!\*)/g, "<i>$1</i>");

  for (let pass = 0; pass < 2; pass++) {
    src = src.replace(/\u0000TKN(\d+)\u0000/g, (_, i) => tokens[Number(i)] ?? "");
  }
  return src;
}

function splitMarkdownSafely(mdText, maxLen = 3000) {
  const src = String(mdText || "").replace(/\r\n/g, "\n");
  if (src.length <= maxLen) return [src];

  const lines = src.split("\n");
  const chunks = [];
  let buf = [];
  let bufLen = 0;
  let openFenceLang = null;

  for (const line of lines) {
    const addLen = line.length + 1;
    if (buf.length > 0 && bufLen + addLen > maxLen) {
      if (openFenceLang !== null) buf.push("```");
      chunks.push(buf.join("\n"));
      buf = [];
      bufLen = 0;
      if (openFenceLang !== null) {
        const reopen = "```" + openFenceLang;
        buf.push(reopen);
        bufLen += reopen.length + 1;
      }
    }
    buf.push(line);
    bufLen += addLen;
    const fm = line.match(/^```([a-zA-Z0-9_+-]*)/);
    if (fm) {
      openFenceLang = openFenceLang === null ? fm[1] || "" : null;
    }
  }
  if (buf.length > 0) chunks.push(buf.join("\n"));
  return chunks.length > 0 ? chunks : [""];
}

async function sendText(chatId, text, extra = {}) {
  const safe = text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  return tg("sendMessage", { chat_id: chatId, text: safe, ...extra });
}

async function sendRichChunk(chatId, rawMd, editMsgId = null) {
  const html = mdToTgHtml(rawMd);
  const useHtml = html.length <= 4050;
  if (editMsgId) {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: editMsgId,
        text: useHtml ? html : rawMd.slice(0, 4000),
        ...(useHtml ? { parse_mode: "HTML", disable_web_page_preview: true } : {}),
      });
      return;
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.includes("message is not modified")) return;
      if (useHtml && msg.includes("400")) {
        try {
          await tg("editMessageText", {
            chat_id: chatId,
            message_id: editMsgId,
            text: rawMd.slice(0, 4000),
          });
          return;
        } catch (e2) {
          if (String(e2.message).includes("message is not modified")) return;
        }
      }
    }
  }
  if (useHtml) {
    try {
      return await tg("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e) {
      if (!String(e.message).includes("400")) throw e;
    }
  }
  return sendText(chatId, rawMd);
}

async function sendLongText(chatId, fullText, firstEditMsgId = null) {
  const chunks = splitMarkdownSafely(fullText || "(空回复)", 2900);
  const finalChunks = [];
  for (const c of chunks) {
    if (mdToTgHtml(c).length > 3950 && c.length > 1400) {
      finalChunks.push(...splitMarkdownSafely(c, 1400));
    } else {
      finalChunks.push(c);
    }
  }
  for (let i = 0; i < finalChunks.length; i++) {
    await sendRichChunk(chatId, finalChunks[i], i === 0 ? firstEditMsgId : null);
  }
}

function getServerMetrics() {
  const memRaw = fs.readFileSync("/proc/meminfo", "utf8");
  const memMap = {};
  for (const line of memRaw.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) memMap[m[1]] = Number(m[2]);
  }
  const memTotal = memMap.MemTotal || 0;
  const memAvail = memMap.MemAvailable || 0;
  const memUsed = Math.max(0, memTotal - memAvail);
  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : 0;

  const disks = [];
  try {
    const dfOut = execFileSync("df", ["-hP", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "overlay"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .slice(1);
    const seenFs = new Set();
    for (const row of dfOut) {
      const parts = row.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const fsName = parts[0];
      const size = parts[1];
      const used = parts[2];
      const avail = parts[3];
      const pct = parseInt(parts[4], 10) || 0;
      const mount = parts.slice(5).join(" ");
      if (!fsName.startsWith("/") || mount.startsWith("/boot") || mount.startsWith("/run") || mount.startsWith("/snap")) {
        continue;
      }
      if (seenFs.has(fsName)) continue;
      seenFs.add(fsName);
      disks.push({ mount, used, avail, size, pct, text: `${used} / ${size} (${pct}%)` });
    }
  } catch {}
  if (disks.length === 0) {
    disks.push({ mount: "/", used: "?", size: "?", pct: 0, text: "未知" });
  }

  let agyVer = "未知";
  try {
    agyVer = execFileSync(AGY_BIN, ["--version"], { encoding: "utf8" }).trim();
  } catch {}

  const upSec = Math.floor(os.uptime());
  const upH = Math.floor(upSec / 3600);
  const upM = Math.floor((upSec % 3600) / 60);
  const loadArr = os.loadavg();
  const loads = loadArr.map((n) => n.toFixed(2)).join(", ");
  const cpus = os.cpus().length;
  const loadPct = Math.min(100, Math.round((loadArr[0] / Math.max(1, cpus)) * 100));

  return {
    hostname: os.hostname(),
    cpus,
    loads,
    loadPct,
    mem: `${formatBytes(memUsed)} / ${formatBytes(memTotal)} (${memPct}%)`,
    memPct,
    disk: disks[0].text,
    diskPct: disks[0].pct,
    disks,
    uptime: `${upH}h ${upM}m`,
    agyVer,
  };
}

function barColor(pct) {
  if (pct >= 85) return "#f43f5e";
  if (pct >= 65) return "#f59e0b";
  return "#10b981";
}

function renderStatusCardPng(data) {
  const disks = Array.isArray(data.disks) && data.disks.length > 0
    ? data.disks.slice(0, 4)
    : [{ mount: "/", text: data.disk || "未知", pct: data.diskPct || 0 }];
  const W = 920;
  const gap = 18;
  const contentW = 840;
  const topCardW = (contentW - gap) / 2; // 411
  const topBarW = topCardW - 36; // 375
  const topY = 120;
  const topH = 102;

  const diskCols = disks.length === 4 ? 2 : disks.length;
  const diskRows = Math.ceil(disks.length / diskCols);
  const diskCardW = Math.floor((contentW - gap * (diskCols - 1)) / diskCols);
  const diskCardH = 94;
  const diskRowGap = 14;
  const diskStartY = topY + topH + 16; // 238
  const diskSectionH = diskRows * diskCardH + (diskRows - 1) * diskRowGap;

  const cfgY = diskStartY + diskSectionH + 16;
  const cfgH = 348;
  const H = cfgY + cfgH + 42;

  const pillColor = data.isBusy ? "#f59e0b" : "#10b981";
  const pillBg = data.isBusy ? "#2a200d" : "#0b2920";
  const pillLabel = data.isBusy ? "BUSY 执行中" : "READY 空闲待命";
  const nowStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

  const loadW = Math.max(4, Math.round((topBarW * Math.min(100, data.loadPct)) / 100));
  const memW = Math.max(4, Math.round((topBarW * Math.min(100, data.memPct)) / 100));

  const diskCardsSvg = disks.map((d, idx) => {
    const col = idx % diskCols;
    const row = Math.floor(idx / diskCols);
    const x = 40 + col * (diskCardW + gap);
    const y = diskStartY + row * (diskCardH + diskRowGap);
    const barW = diskCardW - 36;
    const fillW = Math.max(4, Math.round((barW * Math.min(100, d.pct || 0)) / 100));
    const color = barColor(d.pct || 0);
    const mountLabel = trimMiddle(d.mount || "/", diskCols >= 3 ? 16 : 28);
    const valueText = d.used && d.size
      ? (d.avail && diskCols <= 2 ? `${d.used} / ${d.size} (余 ${d.avail})` : `${d.used} / ${d.size}`)
      : d.text;
    const valueFontSize = diskCols >= 3 ? 16 : 18;
    return `
  <rect x="${x}" y="${y}" width="${diskCardW}" height="${diskCardH}" rx="12" fill="#0b1220" stroke="#1e293b"/>
  <text x="${x + 18}" y="${y + 26}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" fill="#94a3b8">磁盘 (${escapeXml(mountLabel)})</text>
  <text x="${x + diskCardW - 18}" y="${y + 26}" text-anchor="end" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" font-weight="bold" fill="${color}">${d.pct || 0}%</text>
  <text x="${x + 18}" y="${y + 54}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="#f1f5f9">${escapeXml(valueText)}</text>
  <rect x="${x + 18}" y="${y + 70}" width="${barW}" height="8" rx="4" fill="#1e293b"/>
  <rect x="${x + 18}" y="${y + 70}" width="${fillW}" height="8" rx="4" fill="${color}"/>`;
  }).join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="18" fill="#0f172a"/>
  <rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="14" fill="#111827" stroke="#1e293b" stroke-width="1.5"/>
  <text x="44" y="64" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="25" font-weight="bold" fill="#f8fafc">Antigravity CLI · 服务器与节点状态</text>
  <text x="44" y="92" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="14" fill="#94a3b8">${escapeXml(data.hostname)} · ${data.cpus} vCPU · 运行 ${escapeXml(data.uptime)} · ${escapeXml(nowStr)}</text>
  <rect x="${W - 196}" y="44" width="152" height="34" rx="17" fill="${pillBg}" stroke="${pillColor}" stroke-width="1.2"/>
  <text x="${W - 120}" y="66" text-anchor="middle" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="14" font-weight="bold" fill="${pillColor}">${pillLabel}</text>

  <rect x="40" y="${topY}" width="${topCardW}" height="${topH}" rx="12" fill="#0b1220" stroke="#1e293b"/>
  <text x="58" y="${topY + 28}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" fill="#94a3b8">CPU 平均负载 (1m/5m/15m)</text>
  <text x="${40 + topCardW - 18}" y="${topY + 28}" text-anchor="end" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" font-weight="bold" fill="${barColor(data.loadPct)}">${data.loadPct}%</text>
  <text x="58" y="${topY + 58}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="19" font-weight="bold" fill="#f1f5f9">${escapeXml(data.loads)}</text>
  <rect x="58" y="${topY + 76}" width="${topBarW}" height="8" rx="4" fill="#1e293b"/>
  <rect x="58" y="${topY + 76}" width="${loadW}" height="8" rx="4" fill="${barColor(data.loadPct)}"/>

  <rect x="${40 + topCardW + gap}" y="${topY}" width="${topCardW}" height="${topH}" rx="12" fill="#0b1220" stroke="#1e293b"/>
  <text x="${40 + topCardW + gap + 18}" y="${topY + 28}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" fill="#94a3b8">内存占用 (RAM)</text>
  <text x="${40 + topCardW * 2 + gap - 18}" y="${topY + 28}" text-anchor="end" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" font-weight="bold" fill="${barColor(data.memPct)}">${data.memPct}%</text>
  <text x="${40 + topCardW + gap + 18}" y="${topY + 58}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="19" font-weight="bold" fill="#f1f5f9">${escapeXml(data.mem)}</text>
  <rect x="${40 + topCardW + gap + 18}" y="${topY + 76}" width="${topBarW}" height="8" rx="4" fill="#1e293b"/>
  <rect x="${40 + topCardW + gap + 18}" y="${topY + 76}" width="${memW}" height="8" rx="4" fill="${barColor(data.memPct)}"/>
${diskCardsSvg}

  <rect x="40" y="${cfgY}" width="840" height="${cfgH}" rx="12" fill="#0b1220" stroke="#1e293b"/>
  <text x="60" y="${cfgY + 34}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" font-weight="bold" fill="#e2e8f0">运行配置与代理状态</text>

  <text x="60" y="${cfgY + 70}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">AGY CLI 版本:</text>
  <text x="200" y="${cfgY + 70}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#f8fafc">${escapeXml(data.agyVer)}</text>

  <text x="60" y="${cfgY + 104}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">当前账号:</text>
  <text x="200" y="${cfgY + 104}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" font-weight="bold" fill="#38bdf8">${escapeXml(data.accountText)}</text>

  <text x="60" y="${cfgY + 138}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">模型 / 思考:</text>
  <text x="200" y="${cfgY + 138}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#f8fafc">${escapeXml(data.modelText)}</text>

  <text x="60" y="${cfgY + 172}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">模式 / 权限:</text>
  <text x="200" y="${cfgY + 172}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#f8fafc">${escapeXml(data.modeText)}</text>

  <text x="60" y="${cfgY + 206}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">出口代理节点:</text>
  <text x="200" y="${cfgY + 206}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" font-weight="bold" fill="#34d399">${escapeXml(data.proxyText)}</text>

  <text x="60" y="${cfgY + 240}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">工作目录:</text>
  <text x="200" y="${cfgY + 240}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#e2e8f0">${escapeXml(trimMiddle(data.cwd, 58))}</text>

  <text x="60" y="${cfgY + 274}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">当前会话:</text>
  <text x="200" y="${cfgY + 274}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#cbd5e1">${escapeXml(data.convText)}</text>

  <text x="60" y="${cfgY + 308}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#94a3b8">缓存与上下文:</text>
  <text x="200" y="${cfgY + 308}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="15" fill="#fbbf24">${escapeXml(data.cacheText || "暂无统计")}</text>
</svg>`;

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: fs.existsSync(WQY_FONT_PATH) ? [WQY_FONT_PATH] : [],
      loadSystemFonts: true,
      defaultFontFamily: "WenQuanYi Zen Hei",
    },
    fitTo: { mode: "width", value: 920 },
  });
  const outPath = path.join(STATUS_IMG_DIR, `status_${Date.now()}.png`);
  fs.writeFileSync(outPath, resvg.render().asPng());
  return outPath;
}

function stripMdCellText(text = "") {
  return String(text || "")
    .replace(/\[([^\]\n]+)\]\((?:file|https?):\/\/[^\s)]+\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0) || 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f300
  ) {
    return 2;
  }
  return 1;
}

function textDisplayWidth(str) {
  let w = 0;
  for (const ch of String(str || "")) w += charDisplayWidth(ch);
  return w;
}

function wrapTextUnits(text, maxUnits) {
  const s = String(text || "");
  if (!s) return [""];
  const chars = Array.from(s);
  const lines = [];
  let cur = "";
  let curW = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cw = charDisplayWidth(ch);
    if (cur && curW + cw > maxUnits) {
      // Avoid breaking inside an ASCII word if a nearby space exists
      const isAsciiWordChar = /[A-Za-z0-9_./-]/.test(ch);
      const lastChar = cur[cur.length - 1] || "";
      if (isAsciiWordChar && /[A-Za-z0-9_./-]/.test(lastChar)) {
        const sp = cur.lastIndexOf(" ");
        if (sp > Math.max(0, cur.length - 16)) {
          lines.push(cur.slice(0, sp).trimEnd());
          const tail = cur.slice(sp + 1) + ch;
          cur = tail;
          curW = textDisplayWidth(tail);
          continue;
        }
      }
      lines.push(cur.trimEnd());
      cur = ch === " " ? "" : ch;
      curW = ch === " " ? 0 : cw;
    } else {
      cur += ch;
      curW += cw;
    }
  }
  if (cur || lines.length === 0) lines.push(cur.trimEnd());
  return lines;
}

function extractMarkdownTables(mdText) {
  const lines = String(mdText || "").replace(/\r\n/g, "\n").split("\n");
  const tables = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (i + 1 < lines.length && line.includes("|") && isMdTableSep(lines[i + 1])) {
      const rawHeaders = parseMdTableRow(line);
      if (!rawHeaders || rawHeaders.length < 2) continue;
      let title = "";
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        const prev = lines[k].trim();
        if (!prev) continue;
        const hm = prev.match(/^#{1,6}\s+(.+)$/) || prev.match(/^\*\*(.+?)\*\*$/);
        if (hm) title = stripMdCellText(hm[1]);
        break;
      }
      const headers = rawHeaders.map((h) => stripMdCellText(h));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const cells = parseMdTableRow(lines[i]);
        if (!cells) break;
        const clean = [];
        for (let c = 0; c < headers.length; c++) {
          clean.push(stripMdCellText(cells[c] || ""));
        }
        rows.push(clean);
        i++;
      }
      i--;
      if (rows.length > 0) {
        tables.push({ title, headers, rows });
      }
    }
  }
  return tables;
}

function renderMarkdownTablePng(table, index = 0) {
  const W = 1120;
  const padX = 36;
  const contentW = W - padX * 2; // 1048
  const cols = table.headers.length;
  const rows = table.rows.slice(0, 28);

  // Measure proportional column weights from headers + rows
  const maxUnitsPerCol = table.headers.map((h, ci) => {
    let mx = Math.max(4, textDisplayWidth(h));
    for (const r of rows) {
      mx = Math.max(mx, Math.min(54, textDisplayWidth(r[ci] || "")));
    }
    return mx;
  });
  const totalWeight = maxUnitsPerCol.reduce((a, b) => a + b, 0) || cols * 10;
  const minColW = Math.min(120, Math.floor(contentW / cols));
  let colWidths = maxUnitsPerCol.map((w) => Math.max(minColW, Math.round((w / totalWeight) * contentW)));
  const sumW = colWidths.reduce((a, b) => a + b, 0);
  colWidths[colWidths.length - 1] += contentW - sumW;
  // Rebalance if last column shrank below minColW
  if (colWidths[colWidths.length - 1] < minColW) {
    colWidths = maxUnitsPerCol.map((_, idx) =>
      idx === cols - 1 ? contentW - Math.floor(contentW / cols) * (cols - 1) : Math.floor(contentW / cols)
    );
  }

  const colXs = [];
  let curX = padX;
  for (const w of colWidths) {
    colXs.push(curX);
    curX += w;
  }

  const fontSize = cols >= 5 ? 14 : 15;
  const unitPx = fontSize * 0.56;
  const lineH = fontSize + 7;
  const cellPadX = 16;
  const cellPadY = 14;

  const wrapRow = (cells) =>
    cells.map((txt, ci) => {
      const maxUnits = Math.max(6, Math.floor((colWidths[ci] - cellPadX * 2) / unitPx));
      return wrapTextUnits(txt, maxUnits);
    });

  const headerLines = wrapRow(table.headers);
  const headerH = Math.max(...headerLines.map((l) => l.length)) * lineH + cellPadY * 2;

  const rowLayouts = rows.map((r) => {
    const wrapped = wrapRow(r);
    const maxL = Math.max(...wrapped.map((l) => l.length));
    const h = maxL * lineH + cellPadY * 2;
    return { cells: r, wrapped, h };
  });

  const titleH = table.title ? 54 : 24;
  const tableTop = 28 + titleH;
  const tableBodyH = rowLayouts.reduce((a, r) => a + r.h, 0);
  const footerH = table.rows.length > rows.length ? 34 : 20;
  const H = tableTop + headerH + tableBodyH + footerH + 20;

  const svgParts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" rx="18" fill="#070b14"/>`,
    `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="14" fill="#0f172a" stroke="#1e293b" stroke-width="1.5"/>`,
  ];

  if (table.title) {
    svgParts.push(
      `<text x="${padX}" y="58" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="21" font-weight="bold" fill="#f8fafc">${escapeXml(trimMiddle(table.title, 64))}</text>`
    );
  }

  // Table container + header background
  const totalTableH = headerH + tableBodyH;
  svgParts.push(
    `<rect x="${padX}" y="${tableTop}" width="${contentW}" height="${totalTableH}" rx="10" fill="#0b1220" stroke="#1e293b" stroke-width="1.2"/>`,
    `<rect x="${padX}" y="${tableTop}" width="${contentW}" height="${headerH}" rx="10" fill="#172554"/>`,
    `<rect x="${padX}" y="${tableTop + headerH - 8}" width="${contentW}" height="8" fill="#172554"/>`
  );

  // Header texts
  headerLines.forEach((lines, ci) => {
    lines.forEach((ln, li) => {
      const ty = tableTop + cellPadY + fontSize + li * lineH;
      svgParts.push(
        `<text x="${colXs[ci] + cellPadX}" y="${ty}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="${fontSize}" font-weight="bold" fill="#93c5fd">${escapeXml(ln)}</text>`
      );
    });
  });

  // Rows
  let curY = tableTop + headerH;
  rowLayouts.forEach((rl, ri) => {
    if (ri % 2 === 1) {
      svgParts.push(`<rect x="${padX + 1}" y="${curY}" width="${contentW - 2}" height="${rl.h}" fill="#111a2e"/>`);
    }
    svgParts.push(`<line x1="${padX}" y1="${curY}" x2="${padX + contentW}" y2="${curY}" stroke="#1e293b" stroke-width="1"/>`);
    rl.wrapped.forEach((lines, ci) => {
      const rawCell = rl.cells[ci] || "";
      let fill = ci === 0 ? "#f8fafc" : "#cbd5e1";
      const weight = ci === 0 ? "bold" : "normal";
      if (ci === cols - 1 && (rawCell.includes("我们") || rawCell.includes("✅") || rawCell.includes("🟢"))) {
        fill = "#34d399";
      } else if (rawCell.includes("❌") || rawCell.includes("🔴")) {
        fill = "#fb7185";
      }
      lines.forEach((ln, li) => {
        const ty = curY + cellPadY + fontSize + li * lineH;
        svgParts.push(
          `<text x="${colXs[ci] + cellPadX}" y="${ty}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${escapeXml(ln)}</text>`
        );
      });
    });
    curY += rl.h;
  });

  // Vertical column dividers
  for (let ci = 1; ci < cols; ci++) {
    svgParts.push(
      `<line x1="${colXs[ci]}" y1="${tableTop}" x2="${colXs[ci]}" y2="${tableTop + totalTableH}" stroke="#1e293b" stroke-width="1"/>`
    );
  }

  if (table.rows.length > rows.length) {
    svgParts.push(
      `<text x="${padX}" y="${tableTop + totalTableH + 22}" font-family="'WenQuanYi Zen Hei', sans-serif" font-size="13" fill="#94a3b8">注: 表格共 ${table.rows.length} 行，图片展示前 ${rows.length} 行</text>`
    );
  }

  svgParts.push(`</svg>`);

  const resvg = new Resvg(svgParts.join("\n"), {
    font: {
      fontFiles: fs.existsSync(WQY_FONT_PATH) ? [WQY_FONT_PATH] : [],
      loadSystemFonts: true,
      defaultFontFamily: "WenQuanYi Zen Hei",
    },
    fitTo: { mode: "width", value: W },
  });
  const outPath = path.join(STATUS_IMG_DIR, `table_${Date.now()}_${index}.png`);
  fs.writeFileSync(outPath, resvg.render().asPng());
  return outPath;
}

function cleanOldFilesInDir(dirPath, maxAgeMs, filterFn = null) {
  let removed = 0;
  let freedBytes = 0;
  if (!fs.existsSync(dirPath)) return { removed, freedBytes };
  const now = Date.now();
  for (const name of fs.readdirSync(dirPath)) {
    if (filterFn && !filterFn(name)) continue;
    const full = path.join(dirPath, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
        freedBytes += st.size;
        fs.unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return { removed, freedBytes };
}

function runCleanup() {
  const s = cleanOldFilesInDir(STATUS_IMG_DIR, 10 * 60 * 1000, (n) => n.endsWith(".png"));
  const u = cleanOldFilesInDir(UPLOAD_DIR, 24 * 3600 * 1000);
  return { totalRemoved: s.removed + u.removed, freedBytes: s.freedBytes + u.freedBytes };
}

// --- Mihomo / Subscription Helpers ---
async function getProxyState() {
  const api = (cfg.mihomoApi || "http://127.0.0.1:9090").replace(/\/$/, "");
  try {
    const r = await httpJsonRequest(`${api}/proxies/PROXY`, "GET", null, 4000);
    if (r.status === 200 && r.data) {
      let autoNow = "";
      if (r.data.now === "AUTO") {
        const ra = await httpJsonRequest(`${api}/proxies/AUTO`, "GET", null, 3000).catch(() => null);
        if (ra?.status === 200 && ra.data?.now) autoNow = ra.data.now;
      }
      return { ok: true, now: r.data.now || "DIRECT", autoNow, all: r.data.all || [] };
    }
  } catch (e) {
    return { ok: false, error: e.message, now: "未知", autoNow: "", all: [] };
  }
  return { ok: false, error: "Mihomo 未响应", now: "未知", autoNow: "", all: [] };
}

async function switchProxyNode(nodeName) {
  const api = (cfg.mihomoApi || "http://127.0.0.1:9090").replace(/\/$/, "");
  const r = await httpJsonRequest(`${api}/proxies/PROXY`, "PUT", { name: nodeName }, 5000);
  if (r.status >= 400) {
    throw new Error(r.data?.message || `HTTP ${r.status}`);
  }
  return true;
}

async function testNodeDelay(nodeName) {
  const api = (cfg.mihomoApi || "http://127.0.0.1:9090").replace(/\/$/, "");
  const target = encodeURIComponent(nodeName);
  const url = `${api}/proxies/${target}/delay?timeout=5000&url=${encodeURIComponent("https://www.gstatic.com/generate_204")}`;
  try {
    const r = await httpJsonRequest(url, "GET", null, 7000);
    if (r.status === 200 && typeof r.data?.delay === "number") {
      return `${r.data.delay}ms`;
    }
    return "超时";
  } catch {
    return "失败";
  }
}

function getSubInfo() {
  return loadJson(SUB_INFO_FILE, {});
}

async function updateSubscription(newUrl = "") {
  const args = [UPDATE_SUB_SCRIPT];
  if (newUrl) args.push(newUrl);
  const { stdout, stderr } = await execFileAsync("python3", args, { timeout: 45000 });
  return (stdout || stderr || "").trim();
}

// --- Ledger & Failover Helpers ---
function getChatLedger(chatId) {
  const key = String(chatId);
  if (!ledger.chats[key]) {
    ledger.chats[key] = { history: [], sharedConvId: "", profileConvIds: {}, profileSyncedSeq: {}, nextSeq: 1 };
  }
  const ch = ledger.chats[key];
  if (!Array.isArray(ch.history)) ch.history = [];
  if (!ch.profileConvIds || typeof ch.profileConvIds !== "object") ch.profileConvIds = {};
  if (typeof ch.sharedConvId !== "string") ch.sharedConvId = "";
  if (!ch.sharedConvId) {
    const act = cfg.activeProfile || "acc1";
    ch.sharedConvId = ch.profileConvIds[act] || Object.values(ch.profileConvIds).find(Boolean) || "";
  }
  if (typeof ch.nextSeq !== "number" || ch.nextSeq < 1) {
    let seq = 1;
    for (const item of ch.history) {
      if (typeof item.seq !== "number") item.seq = seq;
      seq = Math.max(seq, item.seq + 1);
    }
    ch.nextSeq = seq;
  }
  if (!ch.profileSyncedSeq || typeof ch.profileSyncedSeq !== "object") {
    ch.profileSyncedSeq = {};
    const maxSeq = ch.history.reduce((m, x) => Math.max(m, x.seq || 0), 0);
    for (const p of Object.keys(ch.profileConvIds)) {
      if (ch.profileConvIds[p]) ch.profileSyncedSeq[p] = maxSeq;
    }
  }
  return ch;
}

function clearChatLedger(chatId) {
  const key = String(chatId);
  ledger.chats[key] = { history: [], sharedConvId: "", profileConvIds: {}, profileSyncedSeq: {}, nextSeq: 1 };
  saveLedger();
}

function appendChatTurn(chatId, userText, assistantText, tools = [], profileName = "") {
  const ch = getChatLedger(chatId);
  const seq = ch.nextSeq++;
  ch.history.push({
    seq,
    profile: profileName || "",
    user: String(userText || "").slice(0, 1200),
    assistant: String(assistantText || "").slice(0, 1800),
    tools: tools.slice(0, 12),
    ts: Date.now(),
  });
  if (ch.history.length > 15) {
    ch.history = ch.history.slice(-15);
  }
  if (profileName) {
    ch.profileSyncedSeq[profileName] = seq;
  }
  saveLedger();
}

function buildHandoffPrompt(chatId, rawPrompt, profileName, partialAttempt = null) {
  const ch = getChatLedger(chatId);
  if (partialAttempt) {
    const parts = [];
    parts.push("[任务接力提示：上一个账号执行到一半触发配额/限流，已自动切换到你继续完成]");
    parts.push(`用户本次原始请求: ${rawPrompt}`);
    if (partialAttempt.tools.length > 0) {
      parts.push(`上一账号已执行完成的步骤: ${partialAttempt.tools.map((t) => `${t.name}${t.detail ? `(${t.detail})` : ""}`).join(" -> ")}`);
    }
    if (partialAttempt.streamText) {
      parts.push(`上一账号已输出的部分回复:\n${partialAttempt.streamText.slice(-1200)}`);
    }
    parts.push("注意：当前已直接继承同一份完整本地会话上下文，工作目录里的文件更改也保留在磁盘上。请先核对当前磁盘状态，不要重复已完成的操作，直接接着把剩余任务完成并回复用户。");
    return parts.join("\n\n");
  }
  // In shared HOME mode with an existing sharedConvId, agy natively loads the full local SQLite conversation.
  if (ch.sharedConvId) {
    return rawPrompt;
  }
  const syncedSeq = Number(ch.profileSyncedSeq?.[profileName] || 0);
  const unsynced = ch.history.filter((item) => (item.seq || 0) > syncedSeq);
  const parts = [];
  if (unsynced.length > 0) {
    parts.push("[前序对话摘要（供你接续上下文）]");
    for (const item of unsynced.slice(-8)) {
      const who = item.profile ? `[${item.profile}] ` : "";
      parts.push(`${who}用户: ${item.user}`);
      if (item.tools && item.tools.length > 0) {
        parts.push(`执行工具: ${item.tools.join(" -> ")}`);
      }
      parts.push(`助手: ${item.assistant}`);
    }
    parts.push("---");
    parts.push(`当前用户请求: ${rawPrompt}`);
    return parts.join("\n\n");
  }
  return rawPrompt;
}

function listAvailableProfiles() {
  const names = new Set(Object.keys(cfg.profiles || {}));
  try {
    for (const d of fs.readdirSync(PROFILES_DIR)) {
      if (fs.statSync(path.join(PROFILES_DIR, d)).isDirectory()) names.add(d);
    }
  } catch {}
  return Array.from(names).sort();
}

function pickNextProfile(excludeSet) {
  const now = Date.now();
  const all = listAvailableProfiles();
  for (const name of all) {
    if (excludeSet.has(name)) continue;
    if (!isProfileLoggedIn(name)) continue;
    const meta = cfg.profiles?.[name] || {};
    if (meta.cooldownUntil && meta.cooldownUntil > now) continue;
    return name;
  }
  return null;
}

function isQuotaError(errStr) {
  const s = String(errStr || "").toLowerCase();
  return (
    s.includes("429") ||
    s.includes("quota") ||
    s.includes("resource_exhausted") ||
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("limit exceeded") ||
    s.includes("too many requests") ||
    s.includes("capacity")
  );
}

async function runAgyQuick(profileName, args, timeoutMs = 20000, opts = {}) {
  const env = buildAgyEnv(profileName, { isolated: Boolean(opts.isolated) });
  if (!opts.isolated) activateProfileInSharedHome(profileName);
  const { stdout, stderr } = await execFileAsync(AGY_BIN, args, {
    cwd: fs.existsSync(cfg.cwd) ? cfg.cwd : "/root",
    env,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: stdout || "", stderr: stderr || "" };
}

const CLOUD_CODE_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const profileQuotaCache = new Map();
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const LOAD_ASSIST_TTL_MS = 30 * 60 * 1000;

function readProfileOAuthInfo(profileName) {
  const oauthPath = path.join(PROFILES_DIR, profileName, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const raw = loadJson(oauthPath, null);
  if (!raw || typeof raw !== "object") return { accessToken: "", expiryMs: 0, email: "" };
  const tok = raw.token || raw;
  const accessToken = typeof tok.access_token === "string" ? tok.access_token : "";
  const expiryMs = tok.expiry ? Date.parse(tok.expiry) : Number(tok.expiry_date || 0);
  const email = typeof raw.id_token_email === "string" ? raw.id_token_email : "";
  if (email && cfg.profiles?.[profileName] && !cfg.profiles[profileName].email) {
    cfg.profiles[profileName].email = email;
    saveConfig();
  }
  return { accessToken, expiryMs: Number.isNaN(expiryMs) ? 0 : expiryMs, email };
}

function summarizeModelQuotas(modelsMap) {
  if (!modelsMap || typeof modelsMap !== "object") return [];
  const entries = Object.entries(modelsMap).filter(([id, m]) => {
    if (!m || !m.quotaInfo) return false;
    if (id.startsWith("tab_") || id.endsWith("-image")) return false;
    return true;
  });
  const recommended = entries.filter(([, m]) => m.recommended === true);
  const pool = recommended.length > 0 ? recommended : entries.filter(([, m]) => Boolean(m.displayName));

  const subMap = new Map();
  for (const [id, m] of pool) {
    const qi = m.quotaInfo || {};
    const hasReset = Boolean(qi.resetTime);
    const rawFrac = qi.remainingFraction;
    const frac = typeof rawFrac === "number" ? Math.max(0, Math.min(1, rawFrac)) : (hasReset ? 0 : 1);
    const resetTime = qi.resetTime || "";

    let subLabel = m.displayName || id;
    let family = "other";
    let order = 99;
    if (id.startsWith("gemini-")) {
      family = "gemini";
      if (id.includes("pro") || id.startsWith("gemini-4")) {
        subLabel = "Gemini Pro/4";
        order = 10;
      } else {
        subLabel = "Gemini Flash";
        order = 11;
      }
    } else if (id.startsWith("claude-opus")) {
      family = "claude";
      subLabel = "Claude Opus 5.5";
      order = 20;
    } else if (id.startsWith("claude-sonnet")) {
      family = "claude";
      subLabel = "Claude Sonnet 5.5";
      order = 21;
    } else if (id.startsWith("claude-")) {
      family = "claude";
      subLabel = m.displayName || id;
      order = 22;
    } else if (id.startsWith("gpt-oss")) {
      family = "openai";
      subLabel = "GPT-OSS 120B";
      order = 30;
    }

    if (!subMap.has(subLabel)) {
      subMap.set(subLabel, {
        label: subLabel,
        family,
        order,
        remainingFraction: frac,
        resetTime,
        modelNames: new Set(),
      });
    }
    const item = subMap.get(subLabel);
    if (frac < item.remainingFraction) item.remainingFraction = frac;
    if (resetTime && (!item.resetTime || Date.parse(resetTime) < Date.parse(item.resetTime))) {
      item.resetTime = resetTime;
    }
    item.modelNames.add(m.displayName || id);
  }

  const allSubs = Array.from(subMap.values()).sort((a, b) => a.order - b.order);
  const result = [];

  const mergeFamily = (fam, mergedLabel, fallbackOrder) => {
    const subs = allSubs.filter((x) => x.family === fam);
    if (subs.length === 0) return;
    if (subs.length > 1) {
      const firstKey = `${Math.round(subs[0].remainingFraction * 1000)}|${subs[0].resetTime}`;
      const allSame = subs.every((s) => `${Math.round(s.remainingFraction * 1000)}|${s.resetTime}` === firstKey);
      if (allSame) {
        const names = new Set();
        for (const s of subs) for (const n of s.modelNames) names.add(n);
        result.push({
          label: mergedLabel,
          order: fallbackOrder,
          remainingFraction: subs[0].remainingFraction,
          resetTime: subs[0].resetTime,
          modelNames: Array.from(names),
        });
        return;
      }
    }
    for (const s of subs) {
      result.push({
        label: s.label,
        order: s.order,
        remainingFraction: s.remainingFraction,
        resetTime: s.resetTime,
        modelNames: Array.from(s.modelNames),
      });
    }
  };

  mergeFamily("gemini", "Gemini 系列", 10);
  mergeFamily("claude", "Claude 系列", 20);
  for (const s of allSubs.filter((x) => x.family !== "gemini" && x.family !== "claude")) {
    result.push({
      label: s.label,
      order: s.order,
      remainingFraction: s.remainingFraction,
      resetTime: s.resetTime,
      modelNames: Array.from(s.modelNames),
    });
  }
  return result.sort((a, b) => a.order - b.order);
}

function formatQuotaBar(frac, width = 8) {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatQuotaReset(resetIso, frac) {
  if (frac >= 0.9999) return "满额";
  if (!resetIso) return "";
  const resetMs = Date.parse(resetIso);
  if (Number.isNaN(resetMs)) return "";
  const diffMs = resetMs - Date.now();
  let cd;
  if (diffMs <= 0) {
    cd = "即将重置";
  } else {
    const mins = Math.ceil(diffMs / 60000);
    if (mins < 60) cd = `${mins}m后重置`;
    else if (mins < 24 * 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      cd = m > 0 ? `${h}h${m}m后重置` : `${h}h后重置`;
    } else {
      const d = Math.floor(mins / (24 * 60));
      const h = Math.floor((mins % (24 * 60)) / 60);
      cd = h > 0 ? `${d}d${h}h后重置` : `${d}d后重置`;
    }
  }
  const dt = new Date(resetMs);
  const clock =
    diffMs > 20 * 3600 * 1000
      ? dt.toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : dt.toLocaleTimeString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
  return `${cd} ${clock}`;
}

function formatTokenCount(n = 0) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function calcCacheHitPct(input = 0, cached = 0) {
  const inTok = Math.max(0, Number(input) || 0);
  const caTok = Math.max(0, Number(cached) || 0);
  const totalPrompt = inTok + caTok;
  const hitPct = totalPrompt > 0 ? (caTok / totalPrompt) * 100 : 0;
  return { totalPrompt, hitPct };
}

function formatShortTime(isoOrMs) {
  if (!isoOrMs) return "--:--:--";
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function readConversationCacheStats(profileName, convId) {
  if (!convId) return null;
  const sharedPath = path.join(SHARED_AGY_DIR, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
  const legacyPath = profileName
    ? path.join(PROFILES_DIR, profileName, ".gemini", "antigravity-cli", "brain", convId, ".system_generated", "logs", "transcript.jsonl")
    : "";
  const transcriptPath = fs.existsSync(sharedPath) ? sharedPath : legacyPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const steps = [];
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let missCount = 0;
  let hitCount = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== "PLANNER_RESPONSE") continue;
    if (obj.input_tokens == null && obj.cache_read_tokens == null && obj.output_tokens == null) continue;

    const input = Number(obj.input_tokens || 0);
    const cached = Number(obj.cache_read_tokens || 0);
    const output = Number(obj.output_tokens || 0);
    const { totalPrompt, hitPct } = calcCacheHitPct(input, cached);

    totalInput += input;
    totalCached += cached;
    totalOutput += output;
    if (cached > 0) hitCount++;
    else if (input > 0) missCount++;

    steps.push({
      stepIndex: obj.step_index ?? steps.length,
      model: obj.model || "",
      createdAt: obj.created_at || "",
      input,
      cached,
      output,
      totalPrompt,
      hitPct,
    });
  }

  if (steps.length === 0) return null;
  const { totalPrompt: totalPromptAll, hitPct: overallHitPct } = calcCacheHitPct(totalInput, totalCached);
  return {
    convId,
    stepCount: steps.length,
    steps,
    latestStep: steps[steps.length - 1],
    totalInput,
    totalCached,
    totalOutput,
    totalPromptAll,
    overallHitPct,
    hitCount,
    missCount,
  };
}

async function fetchProfileQuota(profileName, { forceRefresh = false } = {}) {
  if (!isProfileLoggedIn(profileName)) {
    return { loggedIn: false, email: "", tierName: "", buckets: [], error: "" };
  }
  if (!forceRefresh) {
    const cached = profileQuotaCache.get(profileName);
    if (cached && Date.now() - cached.ts < QUOTA_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  let info = readProfileOAuthInfo(profileName);
  if (!info.accessToken || !info.expiryMs || info.expiryMs <= Date.now() + 60_000) {
    await runAgyQuick(profileName, ["models"], 20000, { isolated: true }).catch(() => {});
    info = readProfileOAuthInfo(profileName);
  }
  if (!info.accessToken) {
    return { loggedIn: true, email: info.email || "", tierName: "", buckets: [], error: "未找到 OAuth 凭据" };
  }

  const meta = cfg.profiles?.[profileName] || {};
  const needAssist =
    !meta.tierCheckedAt || Date.now() - meta.tierCheckedAt > LOAD_ASSIST_TTL_MS;

  const proxyUrl = cfg.proxyEnabled && cfg.proxyUrl ? cfg.proxyUrl : "";
  const queryApi = async (token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "antigravity/1.5.12 linux/amd64",
    };
    const modelsPromise = httpsJsonPostWithProxy(`${CLOUD_CODE_BASE}:fetchAvailableModels`, {}, headers, proxyUrl, 9000);
    const assistPromise = needAssist
      ? httpsJsonPostWithProxy(`${CLOUD_CODE_BASE}:loadCodeAssist`, { metadata: { ideType: "ANTIGRAVITY" } }, headers, proxyUrl, 9000)
      : Promise.resolve(null);
    const [modelsRes, assistRes] = await Promise.allSettled([modelsPromise, assistPromise]);
    return { modelsRes, assistRes };
  };

  let { modelsRes, assistRes } = await queryApi(info.accessToken);
  const mStatus = modelsRes.status === "fulfilled" ? modelsRes.value.status : 0;
  if (mStatus === 401 || mStatus === 403) {
    await runAgyQuick(profileName, ["models"], 20000, { isolated: true }).catch(() => {});
    info = readProfileOAuthInfo(profileName);
    if (info.accessToken) {
      ({ modelsRes, assistRes } = await queryApi(info.accessToken));
    }
  }

  if (modelsRes.status === "rejected") {
    return {
      loggedIn: true,
      email: info.email || "",
      tierName: meta.tierName || "",
      buckets: [],
      error: trimMiddle(modelsRes.reason?.message || "请求超时", 60),
    };
  }
  if (modelsRes.value.status >= 400) {
    return {
      loggedIn: true,
      email: info.email || "",
      tierName: meta.tierName || "",
      buckets: [],
      error: `API HTTP ${modelsRes.value.status}`,
    };
  }

  let tierName = meta.tierName || "";
  let availableCredits = meta.availableCredits;
  if (needAssist && assistRes.status === "fulfilled" && assistRes.value && assistRes.value.status < 400) {
    const assistData = assistRes.value.data || {};
    tierName = assistData?.paidTier?.name || assistData?.currentTier?.name || tierName;
    availableCredits = assistData?.availableCredits;
    cfg.profiles[profileName] = {
      ...(cfg.profiles?.[profileName] || {}),
      tierName,
      availableCredits,
      tierCheckedAt: Date.now(),
    };
    saveConfig();
  }
  const buckets = summarizeModelQuotas(modelsRes.value.data?.models);

  const result = {
    loggedIn: true,
    email: info.email || "",
    tierName,
    availableCredits,
    buckets,
    fetchedAt: Date.now(),
    error: "",
  };
  profileQuotaCache.set(profileName, { ts: Date.now(), data: result });
  return result;
}

async function fetchAllProfileQuotas(profileNames, { forceRefresh = false } = {}) {
  const results = [];
  for (let i = 0; i < profileNames.length; i++) {
    const name = profileNames[i];
    if (i > 0 && isProfileLoggedIn(name)) {
      const cached = !forceRefresh && profileQuotaCache.get(name);
      if (!cached || Date.now() - cached.ts >= QUOTA_CACHE_TTL_MS) {
        const jitterMs = 350 + Math.floor(Math.random() * 400);
        await new Promise((r) => setTimeout(r, jitterMs));
      }
    }
    try {
      results.push(await fetchProfileQuota(name, { forceRefresh }));
    } catch (e) {
      results.push({
        loggedIn: isProfileLoggedIn(name),
        email: "",
        tierName: cfg.profiles?.[name]?.tierName || "",
        buckets: [],
        error: trimMiddle(e.message, 60),
      });
    }
  }
  return results;
}

// --- Active Execution & Login State ---
let activeTurn = null;
let pendingLogin = null;

class AgyTurnRunner {
  constructor(chatId, rawPrompt) {
    this.chatId = chatId;
    this.rawPrompt = rawPrompt;
    this.startTime = Date.now();
    this.statusMsgId = null;
    this.phase = "⏳ 正在启动 agy...";
    this.profileName = cfg.activeProfile || "acc1";
    this.thinkingText = "";
    this.streamText = "";
    this.toolHistory = [];
    this.usage = { input: 0, output: 0, thinking: 0, cached: 0 };
    this.lastError = "";
    this.notice = "";
    this.finished = false;
    this.aborted = false;
    this.proc = null;
    this.lastRendered = "";
    this.lastContentKey = "";
    this.lastEditAt = 0;
    this.editing = false;
    this.rateLimitUntil = 0;
    this.timer = null;
    this.typingTimer = null;
  }

  async init() {
    const msg = await sendText(this.chatId, this.renderStatus());
    this.statusMsgId = msg.message_id;
    this.lastRendered = this.renderStatus();
    this.lastContentKey = this.renderContentKey();
    this.lastEditAt = Date.now();
    this.typingTimer = setInterval(() => {
      if (!this.finished && Date.now() >= this.rateLimitUntil && Date.now() >= tgRateLimitUntil) {
        tg("sendChatAction", { chat_id: this.chatId, action: "typing" }, { waitOn429: false }).catch(() => {});
      }
    }, 6000);
    if (Date.now() >= tgRateLimitUntil) {
      tg("sendChatAction", { chat_id: this.chatId, action: "typing" }, { waitOn429: false }).catch(() => {});
    }
    this.timer = setInterval(() => this.flushRender(), 3500);
  }

  renderContentKey() {
    const tools = this.toolHistory.slice(-4).map((t) => `${t.done ? 1 : 0}:${t.name}:${t.detail}`).join("|");
    return `${this.phase}\n${this.profileName}\n${this.notice}\n${this.thinkingText}\n${tools}\n${this.streamText.slice(-400)}`;
  }

  renderStatus() {
    const elapsed = formatDuration(Date.now() - this.startTime);
    const modelLbl = cfg.model || "默认模型";
    const effLbl = cfg.effort || "high";
    const lines = [
      "━━━━━━━━━━━━━━━━━━━━",
      `${this.phase}  ·  ⏱️ ${elapsed}`,
      `👤 ${this.profileName}  ·  🤖 ${modelLbl} (${effLbl})`,
      `📁 ${cfg.cwd}`,
    ];
    if (this.notice) {
      lines.push(`⚠️ ${this.notice}`);
    }
    if (this.thinkingText && !this.streamText) {
      lines.push(`💭 ${trimMiddle(this.thinkingText, 80)}`);
    }
    if (this.toolHistory.length > 0) {
      lines.push("🔧 工具进度:");
      for (const t of this.toolHistory.slice(-4)) {
        const icon = t.done ? "✅" : "⚙️";
        const detail = t.detail ? ` — ${trimMiddle(t.detail, 42)}` : "";
        lines.push(`  ${icon} ${t.name}${detail}`);
      }
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    if (this.streamText) {
      const preview = this.streamText.length > 2800 ? "...\n" + this.streamText.slice(-2800) : this.streamText;
      lines.push("", preview);
    }
    return lines.join("\n");
  }

  async flushRender(force = false) {
    if (this.finished || !this.statusMsgId || this.editing) return;
    const now = Date.now();
    if (!force && (now < this.rateLimitUntil || now < tgRateLimitUntil)) return;
    const contentKey = this.renderContentKey();
    if (!force && contentKey === this.lastContentKey && now - this.lastEditAt < 12000) return;
    const raw = this.renderStatus();
    if (raw === this.lastRendered) return;
    this.editing = true;
    try {
      const html = mdToTgHtml(raw);
      const useHtml = html.length <= 4000;
      try {
        await tg(
          "editMessageText",
          {
            chat_id: this.chatId,
            message_id: this.statusMsgId,
            text: useHtml ? html : raw.slice(0, 4000),
            ...(useHtml ? { parse_mode: "HTML", disable_web_page_preview: true } : {}),
          },
          { waitOn429: false }
        );
      } catch (inner) {
        if (useHtml && String(inner.message).includes("400") && !String(inner.message).includes("not modified")) {
          await tg(
            "editMessageText",
            {
              chat_id: this.chatId,
              message_id: this.statusMsgId,
              text: raw.slice(0, 4000),
            },
            { waitOn429: false }
          );
        } else {
          throw inner;
        }
      }
      this.lastRendered = raw;
      this.lastContentKey = contentKey;
      this.lastEditAt = Date.now();
    } catch (e) {
      if (e.retryAfter) {
        this.rateLimitUntil = Date.now() + (e.retryAfter + 1) * 1000;
      }
    } finally {
      this.editing = false;
    }
  }

  abort() {
    this.aborted = true;
    this.phase = "🛑 正在中止...";
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          try { this.proc.kill("SIGKILL"); } catch {}
        }
      }, 2500);
    }
  }

  stopTimers() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
  }

  runSingleAttempt(profileName, promptText, convId) {
    return new Promise((resolve) => {
      const cwd = fs.existsSync(cfg.cwd) ? cfg.cwd : "/root";
      const args = ["-p", promptText, "--output-format", "stream-json"];
      if (cfg.model) args.push("--model", cfg.model);
      if (cfg.effort) args.push("--effort", cfg.effort);
      if (cfg.mode) args.push("--mode", cfg.mode);
      if (cfg.permMode === "yolo") args.push("--dangerously-skip-permissions");
      else if (cfg.permMode === "sandbox") args.push("--sandbox");
      if (cfg.agent) args.push("--agent", cfg.agent);
      for (const d of cfg.addDirs || []) {
        if (d) args.push("--add-dir", d);
      }
      if (convId) args.push("--conversation", convId);

      activateProfileInSharedHome(profileName);
      const env = buildAgyEnv(profileName);
      this.proc = spawn(AGY_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

      let outBuf = "";
      let errBuf = "";
      let finalResult = null;
      let newConvId = convId || "";
      let attemptText = "";
      const attemptUsage = { input: 0, output: 0, thinking: 0, cached: 0 };

      const handleEvent = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.conversation_id) newConvId = o.conversation_id;
        if (o.init?.conversation_id) newConvId = o.init.conversation_id;

        if (o.event === "init" || o.type === "init") {
          this.phase = "🧠 模型处理中...";
        } else if (o.text_delta || o.delta) {
          const d = o.text_delta || o.delta || "";
          if (typeof d === "string" && d) {
            this.phase = "✍️ 正在回复...";
            attemptText += d;
            this.streamText += d;
          }
        } else if (o.step_update || o.event === "step_update") {
          const su = o.step_update || o;
          const sType = su.step_type || "";
          const state = String(su.state || su.status || "").toLowerCase();
          if (su.thinking || su.thinking_delta) {
            this.phase = "🧠 模型思考中...";
            this.thinkingText = (this.thinkingText + String(su.thinking_delta || su.thinking)).slice(-200);
          }
          if (su.text_delta) {
            this.phase = "✍️ 正在回复...";
            const d = String(su.text_delta);
            attemptText += d;
            this.streamText += d;
          } else if (su.text) {
            this.phase = "✍️ 正在回复...";
            const txt = String(su.text);
            if (txt.length > attemptText.length && txt.startsWith(attemptText)) {
              const extra = txt.slice(attemptText.length);
              attemptText = txt;
              this.streamText += extra;
            } else if (!attemptText) {
              attemptText = txt;
              this.streamText += txt;
            }
          }
          const tName = su.tool_name || su.toolName || su.tool_info?.name || su.step?.tool_name;
          if (tName || sType === "tool") {
            const name = tName || "tool";
            const params = su.tool_info?.parameters || {};
            const detail =
              su.detail ||
              su.label ||
              params.CommandLine ||
              params.command ||
              params.Path ||
              params.path ||
              params.query ||
              "";
            const isDone = state.includes("done") || state.includes("complete") || state.includes("finish");
            const existing = this.toolHistory.findLast?.((x) => x.name === name && !x.done);
            if (isDone && existing) {
              existing.done = true;
              this.phase = "🧠 分析工具结果...";
            } else if (!isDone && !existing) {
              this.phase = `⚙️ 执行工具: ${name}`;
              this.toolHistory.push({ name, detail: String(detail), done: false });
            }
          }
        } else if (o.event === "result" || o.result) {
          const r = o.result || o;
          finalResult = r;
          if (r.conversation_id) newConvId = r.conversation_id;
          if (r.usage) {
            const inTok = r.usage.input_tokens || 0;
            const outTok = r.usage.output_tokens || 0;
            const thTok = r.usage.thinking_tokens || 0;
            const caTok = r.usage.cache_read_tokens || 0;
            attemptUsage.input += inTok;
            attemptUsage.output += outTok;
            attemptUsage.thinking += thTok;
            attemptUsage.cached += caTok;
            this.usage.input += inTok;
            this.usage.output += outTok;
            this.usage.thinking += thTok;
            this.usage.cached += caTok;
          }
        } else if (o.error) {
          errBuf += (errBuf ? "\n" : "") + (typeof o.error === "string" ? o.error : JSON.stringify(o.error));
        }
      };

      this.proc.stdout.on("data", (chunk) => {
        outBuf += chunk.toString("utf8");
        const lines = outBuf.split("\n");
        outBuf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleEvent(JSON.parse(trimmed));
          } catch {
            // Non-JSON line on stdout
            if (trimmed.startsWith("http")) {
              errBuf += trimmed + "\n";
            }
          }
        }
      });

      this.proc.stderr.on("data", (chunk) => {
        errBuf += chunk.toString("utf8");
      });

      this.proc.on("exit", (code, sig) => {
        if (outBuf.trim()) {
          try { handleEvent(JSON.parse(outBuf.trim())); } catch {}
        }
        this.proc = null;
        syncBackProfileFromSharedHome(profileName);
        const ok = !this.aborted && finalResult && finalResult.status !== "ERROR" && (code === 0 || code === null);
        const errMsg = finalResult?.error || errBuf.trim() || (code ? `退出码 ${code}` : "");
        const responseText = finalResult?.response || attemptText || "";
        resolve({ ok, responseText, newConvId, errMsg, code, sig, attemptText, attemptUsage });
      });
    });
  }

  async run() {
    const tried = new Set();
    let currentProfile = cfg.activeProfile || "acc1";
    let partialAttempt = null;
    let finalRes = null;

    while (!this.aborted) {
      tried.add(currentProfile);
      this.profileName = currentProfile;
      this.phase = "🧠 正在请求 agy...";
      await this.flushRender(true);

      const ch = getChatLedger(this.chatId);
      const convId = ch.sharedConvId || "";
      const promptToSend = buildHandoffPrompt(this.chatId, this.rawPrompt, currentProfile, partialAttempt);

      const res = await this.runSingleAttempt(currentProfile, promptToSend, convId);
      profileQuotaCache.delete(currentProfile);
      if (res.attemptUsage && (res.attemptUsage.input || res.attemptUsage.output || res.attemptUsage.thinking || res.attemptUsage.cached)) {
        const prev = cfg.profiles?.[currentProfile]?.usageStats || { turns: 0, input: 0, output: 0, thinking: 0, cached: 0 };
        cfg.profiles[currentProfile] = {
          ...(cfg.profiles?.[currentProfile] || {}),
          usageStats: {
            turns: (prev.turns || 0) + (res.ok ? 1 : 0),
            input: (prev.input || 0) + res.attemptUsage.input,
            output: (prev.output || 0) + res.attemptUsage.output,
            thinking: (prev.thinking || 0) + res.attemptUsage.thinking,
            cached: (prev.cached || 0) + res.attemptUsage.cached,
            lastUsedAt: Date.now(),
          },
        };
        saveConfig();
      }
      if (this.aborted) {
        finalRes = res;
        break;
      }
      if (res.newConvId) {
        ch.sharedConvId = res.newConvId;
        ch.profileConvIds[currentProfile] = res.newConvId;
        saveLedger();
      }
      if (res.ok) {
        finalRes = res;
        break;
      }

      if (isQuotaError(res.errMsg)) {
        cfg.profiles[currentProfile] = {
          ...(cfg.profiles[currentProfile] || {}),
          cooldownUntil: Date.now() + 30 * 60 * 1000,
        };
        saveConfig();
        const nextProfile = pickNextProfile(tried);
        if (nextProfile) {
          this.notice = `账号 ${currentProfile} 限流/额度耗尽，已自动切至 ${nextProfile} 接力`;
          partialAttempt = {
            tools: [...this.toolHistory],
            streamText: res.attemptText || this.streamText,
          };
          currentProfile = nextProfile;
          cfg.activeProfile = nextProfile;
          saveConfig();
          continue;
        }
      }
      finalRes = res;
      break;
    }

    this.finished = true;
    this.stopTimers();

    const elapsedMs = Date.now() - this.startTime;
    const elapsed = formatDuration(elapsedMs);
    if (this.usage.input || this.usage.output || this.usage.cached || this.usage.thinking) {
      const chEnd = getChatLedger(this.chatId);
      cfg.lastTurnUsage = {
        profile: this.profileName,
        model: cfg.model || "默认",
        effort: cfg.effort || "high",
        input: this.usage.input,
        cached: this.usage.cached,
        output: this.usage.output,
        thinking: this.usage.thinking,
        elapsedMs,
        convId: chEnd.sharedConvId || "",
        ts: Date.now(),
      };
      saveConfig();
    }

    const { totalPrompt: turnPromptTok, hitPct: turnHitPct } = calcCacheHitPct(this.usage.input, this.usage.cached);
    const tokParts = [];
    if (turnPromptTok > 0) {
      tokParts.push(`缓存 ${formatTokenCount(this.usage.cached)} (${turnHitPct.toFixed(1)}%)`);
      tokParts.push(`新输入 ${formatTokenCount(this.usage.input)}`);
    }
    if (this.usage.output > 0) tokParts.push(`输出 ${formatTokenCount(this.usage.output)}`);
    if (this.usage.thinking > 0) tokParts.push(`思考 ${formatTokenCount(this.usage.thinking)}`);
    const tokStr = tokParts.length > 0 ? `\n📊 Token: ${tokParts.join(" · ")}` : "";
    const toolNote = this.toolHistory.length > 0
      ? `\n🔧 工具调用: ${this.toolHistory.map((t) => `${t.done ? "✅" : "⚙️"}${t.name}`).join(" → ")}`
      : "";

    let badge = "✅ 完成";
    let body = finalRes?.responseText || this.streamText;

    if (this.aborted) {
      badge = "🛑 已中止";
      body = (body ? body + "\n\n" : "") + "🛑 任务已中止。";
    } else if (!finalRes?.ok) {
      badge = "❌ 出错";
      const errDetail = trimMiddle(finalRes?.errMsg || "agy 执行失败", 300);
      const lowerErr = errDetail.toLowerCase();
      let hint = "";
      if (lowerErr.includes("authentication") || lowerErr.includes("log in")) {
        hint = `\n💡 提示: 账号 ${this.profileName} 未登录或登录已失效，请发送 /login ${this.profileName} 重新授权。`;
      } else if (lowerErr.includes("403") || lowerErr.includes("permission_denied") || lowerErr.includes("disabled") || lowerErr.includes("violation") || lowerErr.includes("suspended")) {
        hint = `\n🛡️ 风控拦截提示: 账号 ${this.profileName} 返回 403/权限受限，已停止自动轮询其余账号以免波及。请先通过 /proxy 检查当前节点 IP 质量后再试。`;
      } else if (isQuotaError(errDetail)) {
        hint = "\n💡 提示: 可用账号均已限流/额度耗尽，可 /login 添加新号或稍后再试。";
      }
      body = `❌ ${errDetail}${hint}` + (body ? `\n\n${body}` : "");
    } else {
      appendChatTurn(
        this.chatId,
        this.rawPrompt,
        body,
        this.toolHistory.map((t) => t.name),
        this.profileName
      );
      if (!body) body = "(模型未返回文本内容)";
    }

    const footer = [
      "────────────────────",
      `${badge} · ⏱️ ${elapsed} · 👤 ${this.profileName} · 🤖 ${cfg.model || "默认"} (${cfg.effort || "high"})${tokStr}${toolNote}`,
    ].join("\n");

    await sendLongText(this.chatId, `${body}\n\n${footer}`, this.statusMsgId);
  }
}

// --- Bot Commands Menu ---
async function registerBotCommands() {
  const commands = [
    { command: "status", description: "服务器状态、账号与代理节点卡片" },
    { command: "account", description: "查看与切换 Google 账号池（含模型额度）" },
    { command: "quota", description: "查看各账号模型剩余额度与重置时间" },
    { command: "cache", description: "查看提示词缓存命中率、上下文大小与 Token 明细" },
    { command: "login", description: "登录或添加账号 (/login [名称])" },
    { command: "logout", description: "注销指定账号登录态" },
    { command: "model", description: "查看与切换 agy 模型" },
    { command: "effort", description: "切换思考深度 (low/medium/high/xhigh/max)" },
    { command: "mode", description: "切换执行模式 (auto/accept-edits/plan)" },
    { command: "perm", description: "切换权限模式 (免确认/沙箱/默认)" },
    { command: "agent", description: "查看与切换 agy Agent" },
    { command: "proxy", description: "切换代理节点、测速与查看流量" },
    { command: "sub", description: "查看/更换订阅链接或更新订阅" },
    { command: "cd", description: "查看或切换工作目录" },
    { command: "adddir", description: "管理附加工作目录 (--add-dir)" },
    { command: "new", description: "开启新会话（清空上下文）" },
    { command: "continue", description: "查看或恢复历史会话 ID" },
    { command: "stop", description: "中止当前任务或取消登录" },
    { command: "mcp", description: "管理 MCP 服务器 (查看/启停)" },
    { command: "plugin", description: "管理插件 (查看/启停)" },
    { command: "settings", description: "查看 agy 与当前配置摘要" },
    { command: "update", description: "更新 agy CLI 到最新版" },
    { command: "cleanup", description: "清理临时缓存文件" },
    { command: "help", description: "查看全部指令帮助" },
  ];
  await tg("deleteMyCommands", {}).catch(() => {});
  await tg("setMyCommands", { commands });
}

function isAuthorized(userId) {
  return Array.isArray(cfg.allowedUserIds) && cfg.allowedUserIds.includes(userId);
}

async function startInteractiveLogin(chatId, profileName) {
  if (pendingLogin) {
    try { pendingLogin.proc.kill("SIGTERM"); } catch {}
    pendingLogin = null;
  }
  const { name } = ensureProfileDir(profileName || cfg.activeProfile || "acc1");
  const env = buildAgyEnv(name, { isolated: true });
  const proc = spawn(AGY_BIN, ["acp", "--login"], {
    cwd: fs.existsSync(cfg.cwd) ? cfg.cwd : "/root",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  pendingLogin = {
    profile: name,
    proc,
    chatId,
    urlSent: false,
    buf: "",
    createdAt: Date.now(),
  };

  const handleOutput = (chunk) => {
    if (!pendingLogin || pendingLogin.proc !== proc) return;
    pendingLogin.buf += chunk.toString("utf8");
    const m = pendingLogin.buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/);
    if (m && !pendingLogin.urlSent) {
      pendingLogin.urlSent = true;
      const proxyNote = cfg.proxyEnabled ? "(已启用代理)" : "(服务器直连)";
      sendText(
        chatId,
        `🔐 正在登录账号 [${name}] ${proxyNote}\n\n1️⃣ 请在浏览器打开下面链接完成 Google 登录：\n${m[0]}\n\n2️⃣ 授权后把页面上的授权码（或整个回调 URL）直接回复发给我。\n（发送 /stop 可取消本次登录）`,
        { disable_web_page_preview: true }
      ).catch(() => {});
    }
  };

  proc.stdout.on("data", handleOutput);
  proc.stderr.on("data", handleOutput);

  proc.on("exit", (code) => {
    const wasMine = pendingLogin && pendingLogin.proc === proc;
    const captured = pendingLogin?.buf || "";
    if (wasMine) pendingLogin = null;
    if (code === 0 && isProfileLoggedIn(name)) {
      const emailM = captured.match(/Logged in as\s+([^\s]+@[^\s.]+(?:\.[^\s.]+)+)/i);
      const email = emailM ? emailM[1].replace(/\.$/, "") : "";
      cfg.activeProfile = name;
      cfg.profiles[name] = {
        ...(cfg.profiles[name] || {}),
        ...(email ? { email } : {}),
        loggedInAt: Date.now(),
        cooldownUntil: 0,
      };
      saveConfig();
      activateProfileInSharedHome(name);
      const emailNote = email ? ` (${email})` : "";
      sendText(chatId, `✅ 账号 [${name}]${emailNote} 登录成功并已设为主用账号！\n凭据已存入账号库并同步到共享运行目录，可继续原会话或发送 /model 查看可用模型。`).catch(() => {});
    } else if (wasMine) {
      const tail = trimMiddle(captured.replace(/https:\/\/accounts\.google\.com\/\S+/g, ""), 240);
      sendText(chatId, `❌ 账号 [${name}] 登录未完成 (code=${code})。\n${tail}`).catch(() => {});
    }
  });

  setTimeout(() => {
    if (pendingLogin && pendingLogin.proc === proc && !pendingLogin.urlSent) {
      sendText(chatId, `⚠️ 登录初始化超时，请检查代理或网络。\n输出: ${trimMiddle(pendingLogin.buf, 240)}`).catch(() => {});
    }
  }, 15000);
}

let lastProxyDelayMap = {};
let lastProxyDelayAt = 0;
function isProxyDelayUnavailable(val) {
  return val === "超时" || val === "失败";
}

async function sendProxyPanel(chatId, editMsgId = null, withDelays = false) {
  const ps = await getProxyState();
  const sub = getSubInfo();
  const nodes = ps.all.length > 0 ? ps.all : ["DIRECT", "AUTO", ...(sub.nodes || [])];

  let delayMap = {};
  if (withDelays && ps.ok) {
    const testTargets = nodes.filter((n) => n !== "DIRECT" && n !== "AUTO").slice(0, 40);
    await Promise.all(
      testTargets.map(async (n) => {
        delayMap[n] = await testNodeDelay(n);
      })
    );
    lastProxyDelayMap = delayMap;
    lastProxyDelayAt = Date.now();
  } else if (Date.now() - lastProxyDelayAt < 15 * 60 * 1000) {
    delayMap = lastProxyDelayMap;
  }

  let subSummary = "未获取到订阅信息";
  if (sub.userinfo && sub.userinfo.total) {
    const used = (sub.userinfo.upload || 0) + (sub.userinfo.download || 0);
    const total = sub.userinfo.total;
    const exp = sub.userinfo.expire ? new Date(sub.userinfo.expire * 1000).toLocaleDateString("zh-CN") : "未知";
    subSummary = `已用 ${formatTrafficBytes(used)} / ${formatTrafficBytes(total)} · 到期 ${exp}`;
  } else if (sub.node_count) {
    subSummary = `共 ${sub.node_count} 个节点`;
  }

  const curDesc = ps.now === "AUTO" && ps.autoNow ? `AUTO → ${ps.autoNow}` : ps.now;
  const safetyNote =
    !cfg.proxyEnabled || ps.now === "DIRECT"
      ? "⚠️ 安全提示: 当前未走代理（直连机房 IP），多号更容易触发风控，建议开启并固定节点。"
      : ps.now === "AUTO"
        ? "⚠️ 安全提示: 当前处于 AUTO 自动测速模式，可能定时跨节点切换 IP，建议手动固定一个稳定节点（如 🇹🇼 台湾家宽-Hinet 或 🇺🇸 美国-DMIT）。"
        : "";
  const headerText = [
    `🌐 代理状态: ${cfg.proxyEnabled ? "✅ 已开启 (给 agy 使用)" : "⛔ 已关闭 (服务器直连)"}`,
    `🎯 当前节点: ${curDesc}`,
    `📦 订阅流量: ${subSummary}`,
    `🕒 订阅更新: ${sub.updated_at ? new Date(sub.updated_at * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知"}（每6小时自动更新）`,
    ...(safetyNote ? ["", safetyNote] : []),
    "",
    "点击下方按钮切换节点（红底为测速超时不可用）：",
  ].join("\n");

  const keyboard = [];
  keyboard.push([
    { text: cfg.proxyEnabled ? "🔌 关闭代理 (直连)" : "🔌 开启代理", callback_data: makeCb("proxy_toggle", {}) },
    { text: "⚡ 全节点测速", callback_data: makeCb("proxy_delay", {}) },
    { text: "🔄 更新订阅", callback_data: makeCb("sub_update", {}) },
  ]);

  const specialNodes = nodes.filter((n) => n === "DIRECT" || n === "AUTO");
  if (specialNodes.length > 0) {
    keyboard.push(
      specialNodes.map((node) => {
        const active = ps.now === node ? "✅ " : "";
        return { text: `${active}${node}`, callback_data: makeCb("proxy_sel", node) };
      })
    );
  }

  for (const node of nodes) {
    if (node === "DIRECT" || node === "AUTO") continue;
    const active = ps.now === node ? "✅ " : "";
    const dVal = delayMap[node];
    const dStr = dVal ? ` (${dVal})` : "";
    const label = `${active}${node}${dStr}`.slice(0, 64);
    const unavailable = isProxyDelayUnavailable(dVal);
    const btn = unavailable
      ? { text: label, callback_data: makeCb("proxy_unavail", node), style: "danger" }
      : { text: label, callback_data: makeCb("proxy_sel", node) };
    keyboard.push([btn]);
  }

  const stripStyleKb = (kb) => kb.map((r) => r.map(({ style: _s, ...rest }) => rest));
  const hasStyledBtn = keyboard.some((r) => r.some((b) => Boolean(b.style)));
  if (editMsgId) {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: editMsgId,
        text: headerText,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (e) {
      if (hasStyledBtn && String(e.message || "").includes("400")) {
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: editMsgId,
          text: headerText,
          reply_markup: { inline_keyboard: stripStyleKb(keyboard) },
        }).catch(() => {});
      }
    }
  } else {
    try {
      await sendText(chatId, headerText, { reply_markup: { inline_keyboard: keyboard } });
    } catch (e) {
      if (hasStyledBtn && String(e.message || "").includes("400")) {
        await sendText(chatId, headerText, { reply_markup: { inline_keyboard: stripStyleKb(keyboard) } });
      } else {
        throw e;
      }
    }
  }
}

async function sendAccountPanel(chatId, editMsgId = null, { forceRefresh = true } = {}) {
  const all = listAvailableProfiles();
  let targetMsgId = editMsgId;
  if (!targetMsgId) {
    const waitMsg = await sendText(chatId, "⏳ 正在查询账号池与模型额度...");
    targetMsgId = waitMsg.message_id;
  }

  const quotaResults = await fetchAllProfileQuotas(all, { forceRefresh });

  const now = Date.now();
  const lines = ["👤 Google 账号池（共享会话目录 /root · 独立凭据无缝切号）", ""];
  const keyboard = [];

  all.forEach((name, idx) => {
    const logged = isProfileLoggedIn(name);
    const meta = cfg.profiles?.[name] || {};
    const q = quotaResults[idx];
    const cdSec = meta.cooldownUntil && meta.cooldownUntil > now ? Math.ceil((meta.cooldownUntil - now) / 1000) : 0;
    const isAct = cfg.activeProfile === name;
    const status = !logged ? "未登录" : cdSec > 0 ? `冷却中(${cdSec}s)` : "就绪";
    const emailStr = meta.email || q?.email || "";
    const emailTag = emailStr ? ` (${emailStr})` : "";
    const tierTag = q?.tierName ? ` · ${q.tierName}` : "";

    lines.push(`${isAct ? "👉" : "•"} ${name}${emailTag}${tierTag} · ${status}`);
    if (logged) {
      if (q?.error) {
        lines.push(`  ⚠️ 额度查询失败: ${q.error}`);
      } else if (q?.buckets?.length > 0) {
        for (const b of q.buckets) {
          const remPct = Math.round(b.remainingFraction * 100);
          const usedPct = 100 - remPct;
          const bar = formatQuotaBar(b.remainingFraction, 8);
          const resetInfo = formatQuotaReset(b.resetTime, b.remainingFraction);
          const detailParts = [`已用${usedPct}%`];
          if (resetInfo && resetInfo !== "满额") detailParts.push(resetInfo);
          else if (resetInfo === "满额") detailParts.push("满额");
          lines.push(`  • ${b.label}: ${bar} ${remPct}% (${detailParts.join(" · ")})`);
        }
      } else {
        lines.push("  • 额度: 暂无可用数据");
      }
    }

    const row = [{ text: `${isAct ? "✅ " : ""}切换 ${name}`, callback_data: makeCb("acc_use", name) }];
    row.push({ text: logged ? `🔄 重登 ${name}` : `🔑 登录 ${name}`, callback_data: makeCb("acc_login", name) });
    keyboard.push(row);
  });

  const nextName = `acc${all.length + 1}`;
  keyboard.push([
    { text: "🔄 刷新额度", callback_data: makeCb("acc_refresh", {}) },
    { text: "📊 详细额度", callback_data: makeCb("acc_quota", {}) },
  ]);
  keyboard.push([{ text: `➕ 新增并登录 ${nextName}`, callback_data: makeCb("acc_login", nextName) }]);
  lines.push("", "提示: 也可用 /login <名称> 添加新号，/quota 查看详细额度。");

  const text = lines.join("\n").slice(0, 4000);
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: targetMsgId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  }).catch(() => {});
}

async function sendQuotaPanel(chatId, targetArg = "", editMsgId = null, { forceRefresh = true } = {}) {
  const all = listAvailableProfiles();
  const filterName = targetArg.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  const targets = filterName ? all.filter((n) => n === filterName) : all;
  if (filterName && targets.length === 0) {
    return sendText(chatId, `❌ 未找到账号 [${filterName}]，可用账号: ${all.join(", ")}`);
  }

  let targetMsgId = editMsgId;
  if (!targetMsgId) {
    const waitMsg = await sendText(chatId, "⏳ 正在拉取模型剩余额度...");
    targetMsgId = waitMsg.message_id;
  }

  const results = await fetchAllProfileQuotas(targets, { forceRefresh });

  const lines = ["📊 模型额度与用量详情", ""];
  targets.forEach((name, idx) => {
    const meta = cfg.profiles?.[name] || {};
    const q = results[idx];
    const isAct = cfg.activeProfile === name;
    const emailStr = meta.email || q?.email || "";
    const headerParts = [`${isAct ? "👉" : "•"} ${name}${emailStr ? ` (${emailStr})` : ""}`];
    if (q?.tierName) headerParts.push(q.tierName);
    lines.push(headerParts.join(" · "));

    if (!q?.loggedIn) {
      lines.push("  未登录（发送 /login " + name + " 授权）");
    } else if (q.error) {
      lines.push(`  ⚠️ 查询失败: ${q.error}`);
    } else if (q.buckets.length === 0) {
      lines.push("  暂无模型额度数据");
    } else {
      for (const b of q.buckets) {
        const remPct = (b.remainingFraction * 100).toFixed(1).replace(/\.0$/, "");
        const usedPct = ((1 - b.remainingFraction) * 100).toFixed(1).replace(/\.0$/, "");
        const bar = formatQuotaBar(b.remainingFraction, 10);
        const resetInfo = formatQuotaReset(b.resetTime, b.remainingFraction);
        lines.push(`  • ${b.label}: ${bar} 剩 ${remPct}% (已用 ${usedPct}%)`);
        if (resetInfo) lines.push(`    ⏱️ ${resetInfo}`);
      }
      if (Array.isArray(q.availableCredits) && q.availableCredits.length > 0) {
        const credText = q.availableCredits
          .map((c) => `${c.creditType || "Credits"}: ${c.creditAmount ?? ""}`)
          .filter(Boolean)
          .join(", ");
        if (credText) lines.push(`  💳 可用积分: ${credText}`);
      }
    }

    const st = meta.usageStats;
    if (st && (st.input || st.output || st.cached)) {
      const { hitPct } = calcCacheHitPct(st.input || 0, st.cached || 0);
      const thPart = st.thinking ? ` · 思考 ${formatTokenCount(st.thinking)}` : "";
      lines.push(
        `  📈 本机统计: ${st.turns || 0} 轮 · 缓存 ${formatTokenCount(st.cached || 0)} (${hitPct.toFixed(1)}%) · 新输入 ${formatTokenCount(st.input || 0)} · 输出 ${formatTokenCount(st.output || 0)}${thPart}`
      );
    }
    lines.push("");
  });

  const updTime = new Date().toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  lines.push(`🕒 更新时间: ${updTime}`);

  const keyboard = [
    [
      { text: "🔄 刷新额度", callback_data: makeCb("quota_refresh", filterName) },
      { text: "👤 账号面板", callback_data: makeCb("quota_acc", {}) },
    ],
  ];

  await tg("editMessageText", {
    chat_id: chatId,
    message_id: targetMsgId,
    text: lines.join("\n").slice(0, 4000),
    reply_markup: { inline_keyboard: keyboard },
  }).catch(() => {});
}

async function sendCachePanel(chatId, targetArg = "", editMsgId = null) {
  const all = listAvailableProfiles();
  const activeProf = cfg.activeProfile || all[0] || "acc1";
  const reqProf = String(targetArg || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (reqProf && !all.includes(reqProf)) {
    return sendText(chatId, `❌ 未找到账号 [${reqProf}]，可用账号: ${all.join(", ")}`);
  }
  const viewProf = reqProf || activeProf;
  const ch = getChatLedger(chatId);
  const convId = ch.sharedConvId || ch.profileConvIds[viewProf] || "";
  const convStats = readConversationCacheStats(viewProf, convId);

  const cacheBadge = (pct, cached) => {
    if (cached <= 0) return "🔴";
    if (pct >= 70) return "🟢";
    return "🟡";
  };

  const lines = [`🧠 提示词缓存与 Token 观测 (${viewProf}${viewProf === activeProf ? " · 当前使用" : ""})`, ""];

  if (convId) {
    lines.push(`💬 会话 ID: ${convId}`);
  } else {
    lines.push("💬 会话 ID: (暂无活跃会话)");
  }

  if (convStats) {
    const ls = convStats.latestStep;
    const latestIcon = cacheBadge(ls.hitPct, ls.cached);
    lines.push(
      `📐 当前上下文窗口: ${formatTokenCount(ls.totalPrompt)} tok (${latestIcon} 最近步命中 ${ls.hitPct.toFixed(1)}% · 缓存 ${formatTokenCount(ls.cached)} + 新输入 ${formatTokenCount(ls.input)})`,
      `📦 本会话累计 (${convStats.stepCount} 次模型请求):`,
      `  • 综合命中率: ${convStats.overallHitPct.toFixed(1)}% (命中 ${convStats.hitCount} 次 / 冷未命中 ${convStats.missCount} 次)`,
      `  • 缓存读取: ${formatTokenCount(convStats.totalCached)} · 新输入: ${formatTokenCount(convStats.totalInput)} · 输出: ${formatTokenCount(convStats.totalOutput)}`,
      "",
      "🔍 最近请求逐次缓存明细 (新→旧):"
    );
    const recent = convStats.steps.slice(-7).reverse();
    for (const s of recent) {
      const icon = cacheBadge(s.hitPct, s.cached);
      const tStr = formatShortTime(s.createdAt);
      const missTag = s.cached === 0 && s.input > 0 ? " 未命中" : "";
      lines.push(
        `  ${icon} #${s.stepIndex} ${tStr} · ${formatTokenCount(s.cached)}/${formatTokenCount(s.totalPrompt)} (${s.hitPct.toFixed(1)}%${missTag}) · 出 ${formatTokenCount(s.output)}`
      );
    }
  } else {
    lines.push("  (该账号当前对话暂无 transcript 缓存记录)");
  }

  const lt = cfg.lastTurnUsage;
  if (lt && (lt.input || lt.output || lt.cached)) {
    const { hitPct: ltHit } = calcCacheHitPct(lt.input || 0, lt.cached || 0);
    const ltIcon = cacheBadge(ltHit, lt.cached || 0);
    const ltThink = lt.thinking ? ` · 思考 ${formatTokenCount(lt.thinking)}` : "";
    lines.push(
      "",
      `⚡ 最近完整一轮 (${lt.profile} · ${lt.model || "默认"} · ${formatDuration(lt.elapsedMs || 0)} · ${formatShortTime(lt.ts)}):`,
      `  ${ltIcon} 缓存 ${formatTokenCount(lt.cached || 0)} (${ltHit.toFixed(1)}%) · 新输入 ${formatTokenCount(lt.input || 0)} · 输出 ${formatTokenCount(lt.output || 0)}${ltThink}`
    );
  }

  lines.push("", "👥 全账号池累计统计:");
  let sumTurns = 0;
  let sumIn = 0;
  let sumCached = 0;
  let sumOut = 0;
  let sumThink = 0;
  for (const name of all) {
    const st = cfg.profiles?.[name]?.usageStats;
    const tag = name === activeProf ? "👉" : "•";
    if (!st || !(st.input || st.output || st.cached)) {
      lines.push(`  ${tag} ${name}: 暂无统计`);
      continue;
    }
    sumTurns += st.turns || 0;
    sumIn += st.input || 0;
    sumCached += st.cached || 0;
    sumOut += st.output || 0;
    sumThink += st.thinking || 0;
    const { hitPct } = calcCacheHitPct(st.input || 0, st.cached || 0);
    const thStr = st.thinking ? ` · 思 ${formatTokenCount(st.thinking)}` : "";
    lines.push(
      `  ${tag} ${name}: ${st.turns || 0}轮 · 命中 ${hitPct.toFixed(1)}% · 缓 ${formatTokenCount(st.cached || 0)} · 入 ${formatTokenCount(st.input || 0)} · 出 ${formatTokenCount(st.output || 0)}${thStr}`
    );
  }
  if (sumIn || sumCached || sumOut) {
    const { hitPct: allHit } = calcCacheHitPct(sumIn, sumCached);
    const allTh = sumThink ? ` · 思 ${formatTokenCount(sumThink)}` : "";
    lines.push(
      `  Σ 合计: ${sumTurns}轮 · 命中 ${allHit.toFixed(1)}% · 缓 ${formatTokenCount(sumCached)} · 入 ${formatTokenCount(sumIn)} · 出 ${formatTokenCount(sumOut)}${allTh}`
    );
  }

  lines.push(
    "",
    "💡 说明: 🔴0%多因间隔过久/服务重启/切换账号导致服务端缓存过期重建；连续工具调用会恢复 🟢 高命中。",
    `🕒 更新时间: ${formatShortTime(Date.now())}`
  );

  const profButtons = all.map((name) => ({
    text: `${name === viewProf ? "📍 " : ""}${name}`,
    callback_data: makeCb("cache_view", name),
  }));
  const keyboard = [];
  for (let i = 0; i < profButtons.length; i += 4) {
    keyboard.push(profButtons.slice(i, i + 4));
  }
  keyboard.push([
    { text: "🔄 刷新缓存", callback_data: makeCb("cache_view", viewProf) },
    { text: "📊 账号额度", callback_data: makeCb("cache_quota", {}) },
  ]);

  const text = lines.join("\n").slice(0, 4000);
  if (editMsgId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text,
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
  } else {
    await sendText(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

let cachedModelGroups = [];

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function groupModelsByBase(models) {
  const groupsMap = new Map();
  for (const m of models) {
    const labelMatch = m.label.match(/^(.+?)\s*\((Minimal|Low|Medium|High|XHigh|Max)\)$/i);
    const idMatch = m.id.match(/^(.+?)-(minimal|low|medium|high|xhigh|max)$/i);
    let baseName = m.label;
    let effortLabel = "";
    let effortVal = "";
    if (labelMatch) {
      baseName = labelMatch[1].trim();
      effortLabel = labelMatch[2];
      effortVal = effortLabel.toLowerCase();
    } else if (idMatch) {
      baseName = m.label;
      effortVal = idMatch[2].toLowerCase();
      effortLabel = effortVal.toUpperCase();
    }
    if (!groupsMap.has(baseName)) {
      groupsMap.set(baseName, { baseName, variants: [] });
    }
    groupsMap.get(baseName).variants.push({
      id: m.id,
      label: m.label,
      effortLabel,
      effortVal,
    });
  }
  const groups = Array.from(groupsMap.values());
  for (const g of groups) {
    g.variants.sort((a, b) => {
      const ia = EFFORT_ORDER.indexOf(a.effortVal);
      const ib = EFFORT_ORDER.indexOf(b.effortVal);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }
  return groups;
}

async function fetchModelGroups(profileName) {
  const { stdout } = await runAgyQuick(profileName, ["models"], 25000);
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Fetching") && !l.startsWith("Available") && !l.startsWith("---"));
  const models = [];
  for (const l of lines) {
    const [idPart, labelPart] = l.split("\t");
    const id = (idPart || "").trim();
    const label = (labelPart || id).trim();
    if (id && !models.some((x) => x.id === id)) {
      models.push({ id, label });
    }
  }
  const groups = groupModelsByBase(models);
  if (groups.length > 0) cachedModelGroups = groups;
  return { groups, rawStdout: stdout };
}

async function sendModelFamilyPanel(chatId, groups, editMsgId = null) {
  const keyboard = [
    [{ text: `${!cfg.model ? "✅ " : ""}恢复默认模型`, callback_data: makeCb("model_set", { id: "", label: "默认", effortVal: "" }) }],
  ];
  let row = [];
  for (const g of groups) {
    const isCurrent = g.variants.some((v) => v.id === cfg.model);
    const title = `${isCurrent ? "✅ " : ""}${g.baseName}`;
    const cbData =
      g.variants.length === 1
        ? makeCb("model_set", { id: g.variants[0].id, label: g.variants[0].label, effortVal: g.variants[0].effortVal })
        : makeCb("model_family", g);
    row.push({ text: title, callback_data: cbData });
    if (row.length === 2) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) keyboard.push(row);

  const curLabel = cfg.model || "默认";
  const text = `🤖 当前模型: ${curLabel}\n请先选择模型系列（选完后可再选思考强度）：`;
  if (editMsgId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text,
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
  } else {
    await sendText(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
}

async function sendModelEffortPanel(chatId, group, editMsgId) {
  const effortRow = group.variants.map((v) => ({
    text: `${cfg.model === v.id ? "✅ " : ""}${v.effortLabel || v.label}`,
    callback_data: makeCb("model_set", { id: v.id, label: v.label, effortVal: v.effortVal }),
  }));
  const keyboard = [];
  for (let i = 0; i < effortRow.length; i += 4) {
    keyboard.push(effortRow.slice(i, i + 4));
  }
  keyboard.push([{ text: "⬅️ 返回模型列表", callback_data: makeCb("model_back", {}) }]);

  const text = `🤖 已选模型: ${group.baseName}\n🧠 请选择思考强度：`;
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: editMsgId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  }).catch(() => {});
}

async function handleCommand(msg, cmd, argText) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (cmd === "start" || cmd === "help") {
    return sendText(
      chatId,
      [
        "🤖 Antigravity CLI (`agy`) Telegram 控制台已就绪",
        "",
        "💬 直接发文字 / 图片 / 文件即可对话执行任务。",
        "",
        "👤 账号与多号接力：",
        "/account — 查看账号池、模型额度与切换账号",
        "/quota [账号] — 查看模型剩余额度与重置倒计时",
        "/cache [账号] — 查看提示词缓存命中率、上下文与 Token 明细",
        "/login [名称] — 在 TG 内交互登录新号 (如 /login acc2)",
        "/logout [名称] — 清除账号登录态",
        "",
        "🧠 模型与执行控制：",
        "/model [模型] — 查看与切换模型",
        "/effort [等级] — 思考深度 (low/medium/high/xhigh/max)",
        "/mode [模式] — 执行模式 (auto/accept-edits/plan)",
        "/perm — 权限模式 (免确认/沙箱/默认)",
        "/agent [名称] — 切换 agy Agent",
        "",
        "🌐 代理与订阅控制（仅对 agy 生效）：",
        "/proxy — 查看流量、测速与切换节点 (含 DIRECT/AUTO)",
        "/sub [新链接] — 查看/更换订阅或立即更新",
        "",
        "📁 会话与工具生态：",
        "/cd [路径] · /adddir [路径] — 管理工作目录",
        "/new · /continue [ID] · /stop — 会话控制",
        "/mcp · /plugin · /settings · /update · /status · /cleanup",
      ].join("\n")
    );
  }

  if (cmd === "pair") {
    const code = argText.trim();
    if (!code) return sendText(chatId, "用法: /pair <配对码>");
    if (isAuthorized(userId)) return sendText(chatId, "✅ 你已经是已授权管理员。");
    if (code === cfg.pairCode) {
      cfg.allowedUserIds = Array.from(new Set([...(cfg.allowedUserIds || []), userId]));
      saveConfig();
      return sendText(chatId, `✅ 绑定成功！管理员 ID: ${userId}`);
    }
    return sendText(chatId, "❌ 配对码错误。");
  }

  if (!isAuthorized(userId)) {
    return sendText(chatId, "⛔ 无权限访问此机器人。");
  }

  if (cmd === "stop" || cmd === "cancel") {
    let did = false;
    if (pendingLogin) {
      try { pendingLogin.proc.kill("SIGTERM"); } catch {}
      pendingLogin = null;
      did = true;
      await sendText(chatId, "🛑 已取消当前登录流程。");
    }
    if (activeTurn && !activeTurn.finished) {
      activeTurn.abort();
      did = true;
      await sendText(chatId, "🛑 已发送中止信号...");
    }
    if (!did) return sendText(chatId, "ℹ️ 当前没有正在执行的任务或登录。");
    return;
  }

  if (cmd === "status") {
    const m = getServerMetrics();
    const ps = await getProxyState();
    const curProf = cfg.activeProfile || "acc1";
    const logged = isProfileLoggedIn(curProf);
    const ch = getChatLedger(chatId);
    const activeConvId = ch.sharedConvId || ch.profileConvIds[curProf] || "";
    const convId = activeConvId || "(新会话)";
    const convStats = readConversationCacheStats(curProf, activeConvId);
    const profStats = cfg.profiles?.[curProf]?.usageStats;
    const cacheParts = [];
    if (profStats && (profStats.input || profStats.cached)) {
      const { hitPct } = calcCacheHitPct(profStats.input || 0, profStats.cached || 0);
      cacheParts.push(`总命中 ${hitPct.toFixed(1)}% (${formatTokenCount(profStats.cached || 0)})`);
    }
    if (convStats?.latestStep) {
      cacheParts.push(
        `上下文 ${formatTokenCount(convStats.latestStep.totalPrompt)} (最近步 ${convStats.latestStep.hitPct.toFixed(1)}%)`
      );
    }
    const cacheText = cacheParts.join(" · ") || "暂无统计 (发 /cache 查看详情)";
    const proxyDesc = !cfg.proxyEnabled
      ? "已关闭 (服务器直连)"
      : ps.now === "AUTO" && ps.autoNow
        ? `AUTO → ${ps.autoNow}`
        : ps.now;

    try {
      const imgPath = renderStatusCardPng({
        ...m,
        isBusy: Boolean(activeTurn && !activeTurn.finished),
        accountText: `${curProf} (${logged ? "已登录" : "未登录，请 /login"})`,
        modelText: `${cfg.model || "默认"} · 思考 ${cfg.effort || "high"}`,
        modeText: `${cfg.mode || "auto"} · 权限 ${cfg.permMode || "yolo"}`,
        proxyText: proxyDesc,
        cwd: cfg.cwd,
        convText: `${convId} (公共账本 ${ch.history.length} 轮)`,
        cacheText,
      });
      return await sendPhoto(chatId, imgPath, `🖥️ ${m.hostname} · ${curProf} · ${proxyDesc}`);
    } catch (e) {
      const diskSummary = (m.disks || []).map((d) => `${d.mount}: ${d.text}`).join(" | ") || m.disk;
      return sendText(
        chatId,
        [
          `🖥️ ${m.hostname} (${m.cpus}核) | 运行 ${m.uptime}`,
          `📊 负载: ${m.loads} | 内存: ${m.mem}`,
          `💾 磁盘: ${diskSummary}`,
          `🤖 agy: ${m.agyVer}`,
          `👤 账号: ${curProf} (${logged ? "已登录" : "未登录"})`,
          `🎯 模型: ${cfg.model || "默认"} | 思考: ${cfg.effort || "high"} | 模式: ${cfg.mode || "auto"}`,
          `🌐 代理: ${proxyDesc}`,
          `📁 目录: ${cfg.cwd}`,
          `🧠 缓存: ${cacheText}`,
        ].join("\n")
      );
    }
  }

  if (cmd === "account" || cmd === "accounts") {
    const force = argText.trim().toLowerCase() === "refresh";
    return sendAccountPanel(chatId, null, { forceRefresh: force });
  }

  if (cmd === "quota" || cmd === "usage") {
    const tokens = argText.trim().split(/\s+/).filter(Boolean);
    const force = tokens.includes("refresh");
    const target = tokens.filter((t) => t !== "refresh").join(" ");
    return sendQuotaPanel(chatId, target, null, { forceRefresh: force });
  }

  if (cmd === "cache" || cmd === "stats") {
    return sendCachePanel(chatId, argText.trim());
  }

  if (cmd === "login") {
    const target = argText.trim().replace(/[^a-zA-Z0-9_-]/g, "") || cfg.activeProfile || "acc1";
    return startInteractiveLogin(chatId, target);
  }

  if (cmd === "logout") {
    const target = argText.trim().replace(/[^a-zA-Z0-9_-]/g, "") || cfg.activeProfile || "acc1";
    const home = path.join(PROFILES_DIR, target);
    for (const p of [
      path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      path.join(home, ".gemini", "antigravity-cli", "cache", "acp-auth-state.json"),
      path.join(home, ".config", "antigravity", "plugin-secrets.json"),
      ...(cfg.activeProfile === target ? [SHARED_OAUTH_PATH] : []),
    ]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    profileQuotaCache.delete(target);
    if (cfg.profiles?.[target]) {
      cfg.profiles[target].cooldownUntil = 0;
      delete cfg.profiles[target].loggedInAt;
      delete cfg.profiles[target].email;
      saveConfig();
    }
    return sendText(chatId, `🗑️ 已清除账号 [${target}] 的本地登录凭据。`);
  }

  if (cmd === "proxy" || cmd === "nodes") {
    return sendProxyPanel(chatId);
  }

  if (cmd === "sub" || cmd === "subupdate") {
    const urlArg = argText.trim();
    if (!urlArg && cmd === "sub") {
      const curUrl = fs.existsSync(SUB_URL_FILE) ? fs.readFileSync(SUB_URL_FILE, "utf8").trim() : "(未配置)";
      const sub = getSubInfo();
      return sendText(
        chatId,
        [
          `📡 当前订阅链接:\n${curUrl}`,
          `📦 节点数: ${sub.node_count || 0}`,
          "",
          "• 发送 `/subupdate` 立即拉取更新节点",
          "• 发送 `/sub https://新订阅链接` 更换订阅并更新",
        ].join("\n"),
        { disable_web_page_preview: true }
      );
    }
    const waitMsg = await sendText(chatId, "⏳ 正在拉取并校验订阅...");
    try {
      const out = await updateSubscription(urlArg);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `✅ 订阅更新完成：\n${out}`,
      });
    } catch (e) {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `❌ 订阅更新失败: ${e.message}`,
      });
    }
    return;
  }

  if (cmd === "model") {
    const arg = argText.trim();
    if (arg) {
      cfg.model = arg === "default" ? "" : arg;
      saveConfig();
      return sendText(chatId, `✅ 当前模型已设为: ${cfg.model || "默认"}`);
    }
    const curProf = cfg.activeProfile || "acc1";
    if (!isProfileLoggedIn(curProf)) {
      return sendText(chatId, `⚠️ 当前账号 [${curProf}] 尚未登录，请先发送 /login ${curProf} 登录后即可拉取可用模型列表；或直接发 /model <模型名> 手动指定。`);
    }
    try {
      const { groups, rawStdout } = await fetchModelGroups(curProf);
      if (groups.length === 0) {
        return sendText(chatId, `当前模型: ${cfg.model || "默认"}\n\n${rawStdout.slice(0, 2000)}`);
      }
      return await sendModelFamilyPanel(chatId, groups);
    } catch (e) {
      return sendText(chatId, `❌ 获取模型列表失败: ${trimMiddle(e.message, 200)}`);
    }
  }

  if (cmd === "effort") {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    const arg = argText.trim().toLowerCase();
    if (!arg) {
      const cur = cfg.effort || "high";
      const row = levels.map((lv) => ({ text: `${lv === cur ? "✅ " : ""}${lv}`, callback_data: makeCb("effort_set", lv) }));
      return sendText(chatId, `🧠 当前思考深度: ${cur}`, {
        reply_markup: { inline_keyboard: [row.slice(0, 3), row.slice(3)] },
      });
    }
    if (!levels.includes(arg)) return sendText(chatId, `❌ 可选值: ${levels.join(", ")}`);
    cfg.effort = arg;
    saveConfig();
    return sendText(chatId, `✅ 思考深度已切换为: ${arg}`);
  }

  if (cmd === "mode") {
    const modes = ["auto", "accept-edits", "plan"];
    const arg = argText.trim().toLowerCase();
    if (!arg) {
      const cur = cfg.mode || "auto";
      const row = modes.map((m) => ({ text: `${m === cur ? "✅ " : ""}${m}`, callback_data: makeCb("mode_set", m) }));
      return sendText(chatId, `⚙️ 当前执行模式: ${cur}`, { reply_markup: { inline_keyboard: [row] } });
    }
    if (!modes.includes(arg)) return sendText(chatId, `❌ 可选值: ${modes.join(", ")}`);
    cfg.mode = arg;
    saveConfig();
    return sendText(chatId, `✅ 执行模式已切换为: ${arg}`);
  }

  if (cmd === "perm") {
    const perms = [
      { id: "yolo", label: "免确认 (--dangerously-skip-permissions)" },
      { id: "sandbox", label: "沙箱模式 (--sandbox)" },
      { id: "default", label: "默认无额外参数" },
    ];
    const arg = argText.trim().toLowerCase();
    if (!arg) {
      const cur = cfg.permMode || "yolo";
      const buttons = perms.map((p) => [{ text: `${p.id === cur ? "✅ " : ""}${p.label}`, callback_data: makeCb("perm_set", p.id) }]);
      return sendText(chatId, `🛡️ 当前权限模式: ${cur}`, { reply_markup: { inline_keyboard: buttons } });
    }
    if (!perms.some((p) => p.id === arg)) return sendText(chatId, "❌ 可选: yolo, sandbox, default");
    cfg.permMode = arg;
    saveConfig();
    return sendText(chatId, `✅ 权限模式已切换为: ${arg}`);
  }

  if (cmd === "agent") {
    const arg = argText.trim();
    if (arg) {
      cfg.agent = arg === "default" ? "" : arg;
      saveConfig();
      return sendText(chatId, `✅ Agent 已设为: ${cfg.agent || "默认"}`);
    }
    const curProf = cfg.activeProfile || "acc1";
    const { stdout } = await runAgyQuick(curProf, ["agents"]).catch((e) => ({ stdout: e.message }));
    const agents = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (agents.length === 0) {
      return sendText(chatId, `🤖 当前 Agent: ${cfg.agent || "默认"}\n(暂无自定义 Agent)`);
    }
    const buttons = [[{ text: `${!cfg.agent ? "✅ " : ""}默认`, callback_data: makeCb("agent_set", "") }]];
    for (const a of agents.slice(0, 12)) {
      const name = a.split(/\s+/)[0];
      buttons.push([{ text: `${cfg.agent === name ? "✅ " : ""}${a}`, callback_data: makeCb("agent_set", name) }]);
    }
    return sendText(chatId, `🤖 当前 Agent: ${cfg.agent || "默认"}`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (cmd === "cd") {
    const target = argText.trim();
    if (!target) {
      const candidates = ["/root/workspace", "/opt", "/root"].filter((d) => fs.existsSync(d));
      const buttons = candidates.map((d) => [{ text: `${cfg.cwd === d ? "✅ " : ""}${d}`, callback_data: makeCb("cd_set", d) }]);
      return sendText(chatId, `📁 当前工作目录: ${cfg.cwd}\n发 /cd <路径> 或点按钮切换：`, {
        reply_markup: { inline_keyboard: buttons },
      });
    }
    const resolved = path.resolve(cfg.cwd, target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return sendText(chatId, `❌ 目录不存在: ${resolved}`);
    }
    cfg.cwd = resolved;
    saveConfig();
    return sendText(chatId, `✅ 工作目录已切换为: ${resolved}`);
  }

  if (cmd === "adddir") {
    const arg = argText.trim();
    cfg.addDirs = cfg.addDirs || [];
    if (!arg) {
      const list = cfg.addDirs.length > 0 ? cfg.addDirs.map((d) => `• ${d}`).join("\n") : "(无)";
      return sendText(chatId, `📂 附加工作目录 (--add-dir):\n${list}\n\n用法: /adddir <路径> 添加，/adddir clear 清空`);
    }
    if (arg === "clear") {
      cfg.addDirs = [];
      saveConfig();
      return sendText(chatId, "🗑️ 已清空所有附加工作目录。");
    }
    const resolved = path.resolve(cfg.cwd, arg);
    if (!fs.existsSync(resolved)) return sendText(chatId, `❌ 路径不存在: ${resolved}`);
    if (!cfg.addDirs.includes(resolved)) cfg.addDirs.push(resolved);
    saveConfig();
    return sendText(chatId, `✅ 已添加附加目录: ${resolved}`);
  }

  if (cmd === "new") {
    if (activeTurn && !activeTurn.finished) {
      return sendText(chatId, "⚠️ 当前有任务在跑，请先 /stop 中止后再 /new。");
    }
    clearChatLedger(chatId);
    return sendText(chatId, "🆕 已开启全新会话，全部账号上下文账本已清空。");
  }

  if (cmd === "continue") {
    const arg = argText.trim();
    const ch = getChatLedger(chatId);
    const curProf = cfg.activeProfile || "acc1";
    if (!arg) {
      const convId = ch.sharedConvId || ch.profileConvIds[curProf] || "(暂无)";
      return sendText(chatId, `💬 当前共享会话 ID: ${convId}\n发送 /continue <会话ID> 可手动绑定历史 conversation ID。`);
    }
    ch.sharedConvId = arg;
    ch.profileConvIds[curProf] = arg;
    saveLedger();
    return sendText(chatId, `✅ 已绑定共享会话 ID: ${arg}`);
  }

  if (cmd === "mcp") {
    const curProf = cfg.activeProfile || "acc1";
    const parts = argText.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && ["enable", "disable", "remove"].includes(parts[0])) {
      try {
        const { stdout, stderr } = await runAgyQuick(curProf, ["mcp", parts[0], parts[1]]);
        return sendText(chatId, `✅ mcp ${parts[0]} ${parts[1]}:\n${stdout || stderr || "完成"}`);
      } catch (e) {
        return sendText(chatId, `❌ 操作失败: ${e.message}`);
      }
    }
    const { stdout, stderr } = await runAgyQuick(curProf, ["mcp", "list"]).catch((e) => ({ stdout: "", stderr: e.message }));
    return sendText(chatId, `🔌 MCP 服务器 (${curProf}):\n${stdout || stderr || "(无)"}\n\n操作用法: /mcp enable <名> 或 /mcp disable <名>`);
  }

  if (cmd === "plugin") {
    const curProf = cfg.activeProfile || "acc1";
    const parts = argText.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && ["enable", "disable", "install", "uninstall"].includes(parts[0])) {
      try {
        const { stdout, stderr } = await runAgyQuick(curProf, ["plugin", parts[0], parts[1]], 30000);
        return sendText(chatId, `✅ plugin ${parts[0]} ${parts[1]}:\n${stdout || stderr || "完成"}`);
      } catch (e) {
        return sendText(chatId, `❌ 操作失败: ${e.message}`);
      }
    }
    const { stdout, stderr } = await runAgyQuick(curProf, ["plugin", "list"]).catch((e) => ({ stdout: "", stderr: e.message }));
    return sendText(chatId, `🧩 已安装插件 (${curProf}):\n${stdout || stderr || "(无)"}\n\n操作用法: /plugin enable|disable|install|uninstall <名>`);
  }

  if (cmd === "settings") {
    const curProf = cfg.activeProfile || "acc1";
    const settingsFile = path.join(SHARED_AGY_DIR, "settings.json");
    const rawSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "(使用默认配置)";
    return sendText(
      chatId,
      [
        `⚙️ 当前配置 (${curProf})`,
        `• 模型: ${cfg.model || "默认"}`,
        `• 思考深度: ${cfg.effort || "high"}`,
        `• 模式: ${cfg.mode || "auto"} | 权限: ${cfg.permMode || "yolo"}`,
        `• Agent: ${cfg.agent || "默认"}`,
        `• 工作目录: ${cfg.cwd}`,
        `• 附加目录: ${(cfg.addDirs || []).join(", ") || "(无)"}`,
        `• 代理: ${cfg.proxyEnabled ? cfg.proxyUrl : "关闭"}`,
        "",
        `📄 settings.json:\n${rawSettings.slice(0, 1500)}`,
      ].join("\n")
    );
  }

  if (cmd === "update") {
    const curProf = cfg.activeProfile || "acc1";
    const waitMsg = await sendText(chatId, "⏳ 正在检查并更新 agy CLI...");
    try {
      const { stdout, stderr } = await runAgyQuick(curProf, ["update"], 60000);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `✅ 更新结果:\n${(stdout || stderr || "已是最新版").slice(0, 3500)}`,
      });
    } catch (e) {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `❌ 更新失败: ${e.message}`,
      });
    }
    return;
  }

  if (cmd === "cleanup") {
    const r = runCleanup();
    return sendText(chatId, `🧹 清理完成：删除 ${r.totalRemoved} 个临时文件，释放 ${r.freedBytes} 字节。`);
  }

  return sendText(chatId, `❓ 未知指令 /${cmd}，发送 /help 查看全部可用指令。`);
}

async function handleCallback(cb) {
  const userId = cb.from.id;
  const chatId = cb.message?.chat?.id;
  if (!chatId || !isAuthorized(userId)) {
    return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "无权限", show_alert: true });
  }
  const data = cb.data || "";
  if (!data.startsWith("k:")) return;
  const entry = cbStore.get(data.slice(2));
  if (!entry) {
    return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "按钮已过期，请重新发送指令", show_alert: true });
  }

  try {
    const { type, payload } = entry;
    if (type === "proxy_sel") {
      await switchProxyNode(payload);
      cfg.proxyEnabled = true;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `已切到 ${payload}` });
      await sendProxyPanel(chatId, cb.message.message_id, false);
    } else if (type === "proxy_unavail") {
      await tg("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: `⛔ 节点 [${payload}] 测速超时不可用，无法选择。如需重测请点「⚡ 全节点测速」。`,
        show_alert: true,
      });
    } else if (type === "proxy_toggle") {
      cfg.proxyEnabled = !cfg.proxyEnabled;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: cfg.proxyEnabled ? "代理已开启" : "代理已关闭" });
      await sendProxyPanel(chatId, cb.message.message_id, false);
    } else if (type === "proxy_delay") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在测速，请稍候..." });
      await sendProxyPanel(chatId, cb.message.message_id, true);
    } else if (type === "sub_update") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在更新订阅..." });
      await updateSubscription();
      lastProxyDelayMap = {};
      lastProxyDelayAt = 0;
      await sendProxyPanel(chatId, cb.message.message_id, false);
    } else if (type === "acc_use") {
      ensureProfileDir(payload);
      cfg.activeProfile = payload;
      saveConfig();
      activateProfileInSharedHome(payload);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `已切换到 ${payload}` });
      await sendAccountPanel(chatId, cb.message.message_id, { forceRefresh: false });
    } else if (type === "acc_refresh") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在刷新模型额度..." });
      await sendAccountPanel(chatId, cb.message.message_id, { forceRefresh: true });
    } else if (type === "acc_quota") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在加载详细额度..." });
      await sendQuotaPanel(chatId, "", cb.message.message_id, { forceRefresh: false });
    } else if (type === "quota_refresh") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在刷新额度..." });
      await sendQuotaPanel(chatId, typeof payload === "string" ? payload : "", cb.message.message_id, { forceRefresh: true });
    } else if (type === "quota_acc") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      await sendAccountPanel(chatId, cb.message.message_id, { forceRefresh: false });
    } else if (type === "cache_view") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "已刷新缓存统计" });
      await sendCachePanel(chatId, typeof payload === "string" ? payload : "", cb.message.message_id);
    } else if (type === "cache_quota") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "正在加载账号额度..." });
      await sendQuotaPanel(chatId, "", cb.message.message_id, { forceRefresh: false });
    } else if (type === "acc_login") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `准备登录 ${payload}...` });
      await startInteractiveLogin(chatId, payload);
    } else if (type === "model_family") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      await sendModelEffortPanel(chatId, payload, cb.message.message_id);
    } else if (type === "model_back") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      let groups = cachedModelGroups;
      if (!groups || groups.length === 0) {
        const res = await fetchModelGroups(cfg.activeProfile || "acc1");
        groups = res.groups;
      }
      await sendModelFamilyPanel(chatId, groups, cb.message.message_id);
    } else if (type === "model_set") {
      const modId = typeof payload === "string" ? payload : payload.id || "";
      const modLabel = typeof payload === "string" ? payload || "默认" : payload.label || modId || "默认";
      const effVal = typeof payload === "object" && payload.effortVal ? payload.effortVal : "";
      cfg.model = modId;
      if (effVal) cfg.effort = effVal;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `已切换: ${modLabel}` });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `✅ 当前模型已切换为: ${modLabel}${modId ? `\n🆔 ${modId}` : ""}`,
      });
    } else if (type === "effort_set") {
      cfg.effort = payload;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `思考深度: ${payload}` });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `✅ 思考深度已切换为: ${payload}` });
    } else if (type === "mode_set") {
      cfg.mode = payload;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `模式: ${payload}` });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `✅ 执行模式已切换为: ${payload}` });
    } else if (type === "perm_set") {
      cfg.permMode = payload;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `权限: ${payload}` });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `✅ 权限模式已切换为: ${payload}` });
    } else if (type === "agent_set") {
      cfg.agent = payload;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Agent: ${payload || "默认"}` });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `✅ Agent 已切换为: ${payload || "默认"}` });
    } else if (type === "cd_set") {
      cfg.cwd = payload;
      saveConfig();
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `目录: ${payload}` });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `✅ 工作目录已切换为: ${payload}` });
    }
  } catch (e) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `失败: ${e.message}`, show_alert: true }).catch(() => {});
  }
}

async function downloadTgFile(fileId, suggestedName) {
  const info = await tg("getFile", { file_id: fileId });
  const fileUrl = `https://api.telegram.org/file/bot${cfg.botToken}/${info.file_path}`;
  let buf;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      buf = await httpsGetBuffer(fileUrl, 45000);
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  if (!buf) throw lastErr;
  const ext = path.extname(info.file_path) || "";
  const safeName = `${Date.now()}_${(suggestedName || "file").replace(/[^\w.-]/g, "_")}${suggestedName ? "" : ext}`;
  const dest = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(dest, buf);
  return dest;
}

async function handlePromptMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!isAuthorized(userId)) {
    return sendText(chatId, "⛔ 无权限访问此机器人。");
  }

  // If waiting for interactive OAuth code / callback URL in Telegram
  if (pendingLogin && pendingLogin.chatId === chatId && msg.text) {
    const codeText = msg.text.trim();
    await sendText(chatId, "⏳ 正在提交授权码完成登录，请稍候...");
    try {
      pendingLogin.proc.stdin.write(codeText + "\n");
      pendingLogin.proc.stdin.end();
    } catch (e) {
      await sendText(chatId, `❌ 提交失败: ${e.message}`);
    }
    return;
  }

  if (activeTurn && !activeTurn.finished) {
    return sendText(chatId, "⚠️ 上一个任务还在处理中，请稍候或发送 /stop 中止。");
  }

  const curProf = cfg.activeProfile || "acc1";
  if (!isProfileLoggedIn(curProf)) {
    const fallback = pickNextProfile(new Set());
    if (fallback) {
      cfg.activeProfile = fallback;
      saveConfig();
    } else {
      return sendText(chatId, `⚠️ 当前账号 [${curProf}] 尚未登录，请先发送 /login ${curProf} 在 Telegram 内完成授权。`);
    }
  }

  let promptText = (msg.text || msg.caption || "").trim();
  try {
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const filePath = await downloadTgFile(largest.file_id, "");
      promptText = `@${filePath} ${promptText || "请查看这张图片并回答"}`.trim();
    } else if (msg.document) {
      const filePath = await downloadTgFile(msg.document.file_id, msg.document.file_name);
      promptText = `@${filePath} ${promptText || "请查看这个文件"}`.trim();
    }
  } catch (e) {
    return sendText(chatId, `❌ 接收附件失败: ${e.message}`);
  }
  if (!promptText) return;

  const runner = new AgyTurnRunner(chatId, promptText);
  activeTurn = runner;
  await runner.init();
  await runner.run();
}

function migrateToSharedHomeOnStartup() {
  const sharedConvDir = path.join(SHARED_AGY_DIR, "conversations");
  const sharedBrainDir = path.join(SHARED_AGY_DIR, "brain");
  fs.mkdirSync(sharedConvDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sharedBrainDir, { recursive: true, mode: 0o700 });

  const activeProf = cfg.activeProfile || "acc1";
  let ledgerChanged = false;
  for (const chatId of Object.keys(ledger.chats || {})) {
    const ch = getChatLedger(chatId);
    const convId = ch.sharedConvId;
    if (!convId) continue;
    if (ledger.chats[chatId].sharedConvId !== convId) {
      ledger.chats[chatId].sharedConvId = convId;
      ledgerChanged = true;
    }
    const targetDb = path.join(sharedConvDir, `${convId}.db`);
    if (!fs.existsSync(targetDb)) {
      const candidates = [activeProf, ...listAvailableProfiles().filter((p) => p !== activeProf)];
      for (const prof of candidates) {
        const profAgy = path.join(PROFILES_DIR, prof, ".gemini", "antigravity-cli");
        const srcDb = path.join(profAgy, "conversations", `${convId}.db`);
        if (fs.existsSync(srcDb)) {
          for (const ext of ["", "-wal", "-shm"]) {
            const sFile = `${srcDb}${ext}`;
            if (fs.existsSync(sFile)) {
              fs.copyFileSync(sFile, `${targetDb}${ext}`);
              try { fs.chmodSync(`${targetDb}${ext}`, 0o600); } catch {}
            }
          }
          const srcBrain = path.join(profAgy, "brain", convId);
          const dstBrain = path.join(sharedBrainDir, convId);
          if (fs.existsSync(srcBrain) && !fs.existsSync(dstBrain)) {
            fs.cpSync(srcBrain, dstBrain, { recursive: true });
          }
          const sharedSumDb = path.join(SHARED_AGY_DIR, "conversation_summaries.db");
          const srcSumDb = path.join(profAgy, "conversation_summaries.db");
          const sharedSumSize = fs.existsSync(sharedSumDb) ? fs.statSync(sharedSumDb).size : 0;
          if (fs.existsSync(srcSumDb) && sharedSumSize <= 8192) {
            for (const ext of ["", "-wal", "-shm"]) {
              if (fs.existsSync(`${srcSumDb}${ext}`)) {
                fs.copyFileSync(`${srcSumDb}${ext}`, `${sharedSumDb}${ext}`);
                try { fs.chmodSync(`${sharedSumDb}${ext}`, 0o600); } catch {}
              }
            }
          }
          console.log(`[agy-tg-bot] migrated conversation ${convId} from ${prof} to ${SHARED_HOME}`);
          break;
        }
      }
    }
  }
  if (ledgerChanged) saveLedger();
  activateProfileInSharedHome(activeProf);
}

async function pollLoop() {
  ensureProfileDir(cfg.activeProfile || "acc1");
  migrateToSharedHomeOnStartup();
  await registerBotCommands().catch((e) => console.error("setMyCommands warn:", e.message));
  runCleanup();
  setInterval(() => runCleanup(), 10 * 60 * 1000);
  console.log("[agy-tg-bot] started, cwd=", cfg.cwd, "activeProfile=", cfg.activeProfile);

  let offset = 0;
  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          handleCallback(u.callback_query).catch((e) => console.error("cb err:", e));
          continue;
        }
        const m = u.message;
        if (!m || !m.from) continue;
        const txt = (m.text || "").trim();
        const cmdMatch = txt.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
        if (cmdMatch) {
          handleCommand(m, cmdMatch[1].toLowerCase(), cmdMatch[2] || "").catch((e) => {
            console.error("cmd err:", e);
            sendText(m.chat.id, `❌ 指令执行出错: ${e.message}`).catch(() => {});
          });
        } else {
          handlePromptMessage(m).catch((e) => {
            console.error("prompt err:", e);
            sendText(m.chat.id, `❌ 处理消息出错: ${e.message}`).catch(() => {});
          });
        }
      }
    } catch (e) {
      console.error("[poll error]", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

pollLoop().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
