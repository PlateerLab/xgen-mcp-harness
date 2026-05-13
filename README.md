# xgen-mcp-harness

xgen 에 저장된 하네스 워크플로우를 **stdio MCP** 로 노출하는 bridge.
Claude Desktop 같은 stdio-only MCP 클라이언트가 원격 xgen cluster 의 워크플로우를
도구처럼 호출할 수 있게 한다.

원격 cluster 의 Streamable HTTP MCP server (`/api/agentflow/harness/mcp`) 를
직접 지원하는 클라이언트 (Claude Code / Cursor 등) 는 이 bridge 없이 직접 등록 가능.

---

## 동작 흐름

```
[Claude Desktop / 기타 stdio MCP client]
       │  stdin/stdout JSON-RPC (newline-delimited)
       ▼
[xgen-mcp-harness (이 패키지)]
       │  첫 실행 시 OAuth 2.1 + PKCE 로 token 받음
       │  (브라우저 자동으로 xgen 로그인 페이지 열림)
       │  ~/.config/xgen/mcp-harness/token-<host>.json 에 저장
       ▼
[POST https://<host>/api/agentflow/harness/mcp]
       │  Authorization: Bearer <token>
       ▼
[xgen cluster — 사용자의 하네스 워크플로우들이 도구로 노출]
```

토큰 만료 시 자동 refresh, refresh 실패 시 재-OAuth.

---

## 설치 + 등록

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) /
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "xgen-harness": {
      "command": "npx",
      "args": ["-y", "xgen-mcp-harness", "--host", "https://xgen.x2bee.com"]
    }
  }
}
```

처음 실행 시 브라우저가 자동으로 열려 xgen 로그인 후 token 저장.
이후 실행에는 로그인 불필요.

### 단일 워크플로우 모드 (`--workflow`)

특정 워크플로우 하나만 도구로 노출:

```json
"args": ["-y", "xgen-mcp-harness",
         "--host", "https://xgen.x2bee.com",
         "--workflow", "wf_abc123"]
```

cluster 모드에선 사용자의 모든 하네스 + 메타 도구 3개가 합류 (`search_tools` /
`discover_tools` / `discover_prompt`). workflow 모드는 그 1개만 깔끔하게 노출.

---

## CLI 옵션 / 환경변수

| 옵션 / env | 설명 |
|---|---|
| `--host <url>` / `XGEN_HOST` | xgen cluster origin (필수). 예: `https://xgen.x2bee.com` |
| `--workflow <wf_id>` / `XGEN_WORKFLOW` | 특정 워크플로우만 노출 (옵션) |
| `XGEN_TOKEN` | access_token 을 직접 박음 (OAuth flow skip — CI / 자동화용) |
| `XGEN_MCP_DEBUG=1` | stderr 로 debug 로그 |

---

## Token 저장 위치

`~/.config/xgen/mcp-harness/token-<host hash>.json` (XDG)
`%APPDATA%/xgen/mcp-harness/token-<host hash>.json` (Windows)

host 별로 분리되어 여러 cluster 동시 사용 가능. 파일 권한 `0600`.

토큰 폐기:

```bash
rm ~/.config/xgen/mcp-harness/token-*.json
```

---

## 등록되는 MCP 도구

`tools/list` 가 호출되면 다음 도구가 노출:

- 사용자의 각 하네스 워크플로우 (mcp_published == true) → `run_<workflow_name>` 도구 1개
- cluster 모드 한정 메타 도구 3개:
  - `search_tools(query)` — 도구 카탈로그 키워드 검색
  - `discover_tools(tool_name?)` — 상세 schema 조회
  - `discover_prompt(template_type?, name?)` — 등록된 프롬프트 lazy load

각 워크플로우 도구의 input schema:

```json
{ "input": { "type": "string", "description": "워크플로우에 전달될 자연어 질의" } }
```

---

## 로컬 개발 / 테스트

```bash
# 의존성 0 — Node 18+ 만 있으면 됨
git clone <repo>
cd xgen-mcp-harness-stdio
node bin/xgen-mcp-harness.mjs --host http://localhost:3001

# 또는 npm pack 으로 tarball 만들어 로컬 install
npm pack
npm install -g ./xgen-mcp-harness-0.1.0.tgz
xgen-mcp-harness --host http://localhost:3001

# debug 로그
XGEN_MCP_DEBUG=1 xgen-mcp-harness --host https://xgen.x2bee.com
```

stdio bridge 자체 테스트:

```bash
# JSON-RPC 1줄 박아 결과 확인
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  xgen-mcp-harness --host https://xgen.x2bee.com
```

---

## 의존성

Node.js 18+ built-in modules 만 사용 (`node:http`, `node:crypto`, `node:fs/promises`,
`node:child_process`, `node:readline`, 전역 `fetch`). **npm 의존성 0**.
