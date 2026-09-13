# chat2local

ChatGPT 웹에서 내 로컬 머신을 자유롭게 통제한다. OpenAI 공식 Secure MCP Tunnel만 사용한다. 회색지대 없음.

## 뭘 하는가

ChatGPT 웹 커넥터(`@chat2local`)로 로컬 도구를 호출한다.

```
@chat2local codex_exec "이 리포 테스트 고쳐줘"
@chat2local spawn_subagent "GitHub 트렌딩 스크랩해서 정리해줘"
@chat2local aside_repl "const p = await openTab('https://example.com'); console.log(await p.title())"
@chat2local exec_command "git status"
@chat2local grep "TODO" src/
```

## 도구

| 도구 | 백엔드 | 용도 |
|------|--------|------|
| `codex_exec` | codex CLI (`codex exec`, ocx 프록시 필요) | 코드 작업, 리포 탐색, 패치 |
| `spawn_subagent` | `aside exec` | 브라우저 에이전트 작업 |
| `aside_repl` | `aside repl` | Playwright JS 직접 실행 |
| `exec_command` | `/bin/zsh -lc` | 일반 셸 명령 |
| `read_file` / `write_file` | fs | 파일 읽기/쓰기 |
| `list_dir` / `grep` / `glob` | fs/grep/find | 탐색 |

### 전제

- **Bun** (`~/.bun/bin/bun`)
- **Aside CLI** (`~/.local/bin/aside`, 로그인됨) - spawn_subagent, aside_repl용
- **codex CLI** (`npm i -g @openai/codex`) + **ocx 프록시** (`ocx service`, 127.0.0.1:10100) - codex_exec용
- **OpenAI API 키** (Platform org, Tunnels Read+Manage/Use 권한)
- **ChatGPT Pro 이상** + Developer mode

codex 바이너리 경로는 `src/tools.ts`의 `CODEX_BINARY`에 하드코딩되어 있다. nvm Node 버전이 바뀌면 갱신한다.

## 설치

```bash
git clone <repo> chat2local
cd chat2local
bun install

# tunnel-client 다운로드 + 프로필 + launchd 등록
bun run bin/setup.ts --api-key "sk-..." --connector-name "chat2local"
```

setup이 하는 것:
1. `~/.chat2local/bin/tunnel-client` 다운로드 + quarantine 제거
2. `~/.chat2local/tunnel/profiles/chat2local.yaml` 생성 (runtime_command = `bun bin/mcp.ts`)
3. `~/Library/LaunchAgents/com.chat2local.plist` 등록 (RunAtLoad + KeepAlive) - 재부팅필도 살아남음

## ChatGPT 연결

1. Platform에서 터널 생성: https://platform.openai.com/settings/organization/tunnels
2. chatgpt.com → Settings → Security and login → Developer mode ON
3. https://chatgpt.com/plugins → + → developer-mode app:
   - Name: `chat2local` (정확히)
   - Connection: Tunnel → 만든 터널 선택
   - Auth: No Authentication
   - Permissions: Allow all actions (또는 도구별 제한)
4. 대화에서 `@chat2local` 멘션

**중요**: Platform org와 ChatGPT 워크스페이스가 같은 계정이어야 터널이 커넥터 폼에 뜬다.

## 관리

```bash
# 상태
launchctl list | grep chat2local
~/.chat2local/bin/tunnel-client runtimes status chat2local --json

# 로그
tail -f ~/.chat2local/logs/tunnel.stdout.log
tail -f ~/.chat2local/logs/tunnel.stderr.log

# 재시작
launchctl kickstart -k gui/$(id -u)/com.chat2local

# 제거
launchctl bootout gui/$(id -u)/com.chat2local
rm ~/Library/LaunchAgents/com.chat2local.plist
rm -rf ~/.chat2local
```

## 로컬 테스트 (터널 없이)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run bin/mcp.ts

echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"codex_exec","arguments":{"prompt":"echo hi"}}}' | bun run bin/mcp.ts
```

## 구조

```
chat2local/
├── bin/
│   ├── mcp.ts      # stdio JSON-RPC MCP 서버
│   └── setup.ts    # 원커맨드 온볼딩
└── src/
    └── tools.ts    # 도구 구현 (codex/aside/fs/shell)
```

```
ChatGPT 웹 --MCP--> OpenAI 터널 서비스 --HTTPS--> tunnel-client (로컬)
                                                      |
                                                     stdio
                                                      |
                                                  bin/mcp.ts
                                                   |   |   |
                                              codex  aside  셸/fs
```

## 보안

- 아웃바운드 전용 터널. 공개 포트 없음.
- 터널 런타임 키는 `~/.chat2local/tunnel/` 로컬에만.
- ChatGPT 대화 내용(도구 결과 포함)은 OpenAI로 간다. 비밀 파일을 읽게 하지 마라.
- Allow all actions는 ChatGPT가 로컬 셸을 만진다는 뜻이다. 인젝션 주의.
