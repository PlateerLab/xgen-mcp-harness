#!/usr/bin/env node
/**
 * @xgen/mcp-harness — stdio MCP bridge.
 *
 * stdin/stdout 의 JSON-RPC 를 받아 원격 xgen cluster 의 `/api/agentflow/harness/mcp`
 * (Streamable HTTP MCP server) 로 forward. Claude Desktop 같은 stdio-only MCP
 * 클라이언트가 호스팅된 하네스 워크플로우를 도구로 쓸 수 있게 한다.
 *
 * Token 은 OAuth 2.1 + PKCE 로 첫 실행 시 받아 ~/.config/xgen/mcp-harness/token.json 에 저장.
 * 401 받으면 refresh_token grant 로 갱신. refresh 도 실패하면 재-OAuth.
 *
 * 사용:
 *   xgen-mcp-harness --host https://xgen.x2bee.com
 *   xgen-mcp-harness --host http://localhost:3001 --workflow <wf_id>   # 단일 워크플로우 mode
 *
 * 환경변수:
 *   XGEN_HOST            기본 host (없으면 --host 필수)
 *   XGEN_TOKEN           access_token 직접 박기 (OAuth flow skip)
 *   XGEN_MCP_DEBUG=1     stderr 로 debug 로그
 *
 * 의존성 0 (Node 18+ built-in only).
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ─── CLI args + env ──────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const HOST = (getArg("--host") || process.env.XGEN_HOST || "").replace(/\/+$/, "");
const WORKFLOW_ID = getArg("--workflow") || process.env.XGEN_WORKFLOW || "";
const DEBUG = !!process.env.XGEN_MCP_DEBUG;

if (!HOST) {
  console.error("error: --host <url> (or XGEN_HOST env) is required");
  console.error("example: xgen-mcp-harness --host https://xgen.x2bee.com");
  process.exit(2);
}

const MCP_BASE = WORKFLOW_ID
  ? `${HOST}/api/agentflow/harness/mcp/${WORKFLOW_ID}`
  : `${HOST}/api/agentflow/harness/mcp`;
const OAUTH_AUTHORIZE = `${HOST}/api/agentflow/harness/mcp/oauth/authorize`;
const OAUTH_TOKEN = `${HOST}/api/agentflow/harness/mcp/oauth/token`;

const TOKEN_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
                       "xgen", "mcp-harness");
// host 별로 token 파일 분리 (여러 cluster 쓰는 사용자 지원)
const TOKEN_FILE = join(TOKEN_DIR, `token-${hostHash(HOST)}.json`);

function hostHash(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
function dlog(...a) { if (DEBUG) console.error("[xgen-mcp]", ...a); }

// ─── token persistence ──────────────────────────────────────────
async function loadToken() {
  if (process.env.XGEN_TOKEN) {
    return { access_token: process.env.XGEN_TOKEN, refresh_token: null, _env: true };
  }
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function saveToken(tok) {
  if (tok._env) return;
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tok, null, 2), "utf8");
  try { await chmod(TOKEN_FILE, 0o600); } catch {}
}

// ─── PKCE helpers ───────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function genPKCE() {
  const verifier = b64url(randomBytes(48));               // 64-char URL-safe
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function genState() { return b64url(randomBytes(16)); }

// ─── OAuth flow (PKCE + loopback callback) ──────────────────────
function openBrowser(url) {
  const p = platform();
  const cmd = p === "darwin" ? "open"
            : p === "win32"  ? "cmd"
            :                  "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    console.error(`browser 자동 실행 실패 — 직접 열기: ${url}`);
  }
}

async function runOAuthFlow() {
  const { verifier, challenge } = genPKCE();
  const state = genState();

  // 1) callback 서버 listen (port 결정)
  const server = createServer();
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", res);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 2) authorize URL 만들고 브라우저 띄움
  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", "xgen-mcp-stdio");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "harness:invoke");

  console.error(`\nxgen MCP 로그인이 필요합니다.`);
  console.error(`브라우저에서 다음 URL 이 자동으로 열립니다:`);
  console.error(`  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  // 3) callback 대기 (5분 timeout)
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timeout (5분)"));
    }, 5 * 60 * 1000);

    server.on("request", (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1`);
      if (u.pathname !== "/callback") {
        res.writeHead(404); res.end("not found"); return;
      }
      const c = u.searchParams.get("code");
      const s = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h2>OAuth error</h2><p>${escapeHtml(err)}</p><p>${escapeHtml(u.searchParams.get("error_description") || "")}</p>`);
        clearTimeout(t); server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!c || s !== state) {
        res.writeHead(400); res.end("invalid callback");
        clearTimeout(t); server.close();
        reject(new Error("state mismatch or missing code"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>xgen MCP — 로그인 완료</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:48px}</style>
<h2>로그인 완료</h2><p>터미널로 돌아가서 작업을 계속하세요. 이 창은 닫아도 됩니다.</p>
<script>setTimeout(()=>window.close(),1500)</script>`);
      clearTimeout(t); server.close();
      resolve(c);
    });
  });

  // 4) code → access_token 교환
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: "xgen-mcp-stdio",
    redirect_uri: redirectUri,
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json" },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`token exchange failed: HTTP ${resp.status} ${txt}`);
  }
  const tok = await resp.json();
  if (!tok.access_token) throw new Error("token response missing access_token");
  await saveToken(tok);
  console.error("로그인 완료 — token 저장됨.\n");
  return tok;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── refresh token grant ────────────────────────────────────────
async function refreshToken(tok) {
  if (!tok?.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token,
    client_id: "xgen-mcp-stdio",
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    dlog(`refresh failed HTTP ${resp.status}`);
    return null;
  }
  const newTok = await resp.json();
  if (!newTok.access_token) return null;
  await saveToken(newTok);
  dlog("token refreshed");
  return newTok;
}

// ─── MCP JSON-RPC forwarding ────────────────────────────────────
async function callRemote(rpcMsg, token) {
  const resp = await fetch(MCP_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": `Bearer ${token.access_token}`,
    },
    body: JSON.stringify(rpcMsg),
  });

  if (resp.status === 401) {
    // refresh 시도
    const refreshed = await refreshToken(token);
    if (refreshed) {
      const resp2 = await fetch(MCP_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "authorization": `Bearer ${refreshed.access_token}`,
        },
        body: JSON.stringify(rpcMsg),
      });
      if (resp2.ok) return { tok: refreshed, json: await resp2.json() };
    }
    // refresh 실패 → 재-OAuth
    const fresh = await runOAuthFlow();
    const resp3 = await fetch(MCP_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "authorization": `Bearer ${fresh.access_token}`,
      },
      body: JSON.stringify(rpcMsg),
    });
    if (!resp3.ok) throw new Error(`upstream HTTP ${resp3.status} after re-auth`);
    return { tok: fresh, json: await resp3.json() };
  }

  if (resp.status === 204) return { tok: token, json: null };
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`upstream HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return { tok: token, json: await resp.json() };
}

// ─── main stdio loop ────────────────────────────────────────────
async function main() {
  let tok = await loadToken();
  if (!tok) {
    dlog("no stored token, running OAuth flow");
    tok = await runOAuthFlow();
  }

  // stdin 의 JSON-RPC 를 줄 단위로 읽음 (MCP stdio transport 표준 — newline-delimited)
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      dlog("parse error:", e.message, "line:", trimmed.slice(0, 200));
      return;
    }
    try {
      const { tok: newTok, json } = await callRemote(msg, tok);
      tok = newTok;
      if (json !== null) {
        process.stdout.write(JSON.stringify(json) + "\n");
      }
      // json === null (HTTP 204) — notification 응답 없음
    } catch (e) {
      dlog("call failed:", e.message);
      // RPC error 응답 (msg.id 있을 때만)
      if (msg && msg.id !== undefined && msg.id !== null) {
        const err = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: String(e.message || e) },
        };
        process.stdout.write(JSON.stringify(err) + "\n");
      }
    }
  });

  rl.on("close", () => { dlog("stdin closed, exiting"); process.exit(0); });
}

main().catch((e) => {
  console.error("fatal:", e.message || e);
  process.exit(1);
});
