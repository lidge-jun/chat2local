# chat2local

**채팅에서 판단하고, 로컬에서 실행한다.**

ChatGPT를 작업의 중심에 두는 로컬 실행 하네스다. 파일을 읽고 수정할 때마다 다른 코딩 에이전트에게 다시 설명하지 않는다. 간단한 작업은 직접 도구로 처리하고, 반복 탐색·병렬 읽기·결과 가공은 JavaScript 코드 모드로 묶는다. 브라우저의 한 번 클릭이나 시각 판단은 필요할 때 Aside를 직접 사용한다.

```text
ChatGPT 대화 — 계획 · 코드 작성 · 검토
       │ MCP / OpenAI Secure MCP Tunnel
       ▼
chat2local — 세션 · 검증 · 권한 · 작업 기록
       ├─ 제한된 파일 읽기 / 해시 기반 파일 수정
       ├─ OS 샌드박스 코드 모드 → 허용된 도구를 프로그램으로 조합
       ├─ OS 샌드박스 명령 실행 → 필터링된 소스 복사본, 자동 원본 반영 없음
       └─ 선택적 Aside 네이티브 / REPL / 독립 서브에이전트
```

**개인용 기본값:** 파일 쓰기와 Aside가 처음부터 활성화된다. Aside 서브에이전트도 기본 `full-access`이며, 별도의 **권한이 큰 호스트 어댑터**다. 읽기 전용으로 제한하려면 `CHAT2LOCAL_ALLOW_WRITE=0`과 `CHAT2LOCAL_ALLOW_ASIDE=0`을 명시한다. 이 저장소를 업데이트하는 것만으로 기존 터널·서비스·인증 파일은 변경되지 않는다.

**코드·셸 실행은 OS 샌드박스에서만 이뤄진다.** macOS에서는 운영체제에 이미 들어 있는 **Seatbelt**(`/usr/bin/sandbox-exec`)를 기본으로 사용하므로 추가 설치가 필요 없다. 그 밖의 플랫폼에서는 운영자가 준비한 Docker 이미지가 필요하다. 백엔드가 없으면 실행은 **실패로 끝나며**, `node:vm`이나 `AsyncFunction` 같은 프로세스 내부 평가로 대체하지 않는다. 두 경로 모두 "기본 전부 차단 후 필요한 것만 허용"이라는 같은 모델을 따르고, 백엔드 선택 방식은 Codex의 `get_platform_sandbox()`와 같다.

| | macOS 기본 | 그 외 |
| --- | --- | --- |
| 백엔드 | Seatbelt (`sandbox-exec`) | Docker |
| 설치 | 불필요 | 이미지 프로비저닝 필요 |
| 네트워크 | 차단 (`deny default`) | 차단 (`--network=none`) |
| 파일 권한 | 커널이 경로 단위로 강제 | 컨테이너 경계 |
| 자원 상한 | 시간·출력 제한 + 일부 `ulimit` (프로세스 수 제한 없음) | cgroup (강한 보장) |

`CHAT2LOCAL_SANDBOX=seatbelt|docker|none`으로 명시 선택할 수 있고, 명시값이 자동 선택보다 항상 우선한다.

Secure MCP Tunnel의 연결 방식과 제공 범위는 OpenAI의 공식 문서를 확인한다. 터널이 있다고 해서 로컬 코드가 자동으로 격리되거나, 공개 배포 심사가 완료되는 것은 아니다.

> 출처: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 1. 처음 설치하기

다음은 **신규 프로비저닝 환경**에서 운영자가 수행하는 절차다. 실제 계정으로 로그인된 개발·도그푸딩 호스트를 에이전트가 검증 환경처럼 사용하지 않는다. 연결된 호스트에서는 install, build, typecheck, 테스트 스위트를 실행하지 않는다.

Bun, Node.js 22 이상, 읽어도 되는 소스 전용 프로젝트 폴더를 준비한다. **macOS에서는 코드 모드에 추가 설치가 필요 없다**: Seatbelt가 운영체제에 포함되어 있다. 그 밖의 플랫폼에서는 로컬 Docker 데몬과 Node가 들어 있는 승인된 이미지가 필요하다. Aside는 브라우저 기능을 사용할 때만 필요하다. Windows 네이티브 실행은 차단되어 있으므로 Linux VM/WSL 안의 작업 폴더와 런타임을 사용한다.

```bash
# 신규 설치/격리된 프로비저닝 환경에서만
 git clone https://github.com/lidge-jun/chat2local.git
 cd chat2local
 bun install --frozen-lockfile --ignore-scripts
```

이미 로그인된 Mac에 소스만 갱신한 경우에는 위 명령을 자동 실행하지 않는다. 기존 런타임에 새 의존성이 설치되어 있는지, 어디에서 설치·실행을 검증할지는 운영자가 결정한다. 이번 버전은 새로운 패키지 의존성을 추가하지 않는다.

### 로그인된 개인 Mac에는 CI 번들로 배포

개인 Mac에서 의존성 install/build를 반복하지 않도록 CI가 `chat2local-runtime-<commit>` 산출물을 만든다. `chat2local.mjs`, `manifest.json`, `SHA256SUMS`가 들어 있고, 별도의 `node_modules` 없이 기존 Bun으로 실행한다. CI에서 실제 MCP 초기화·파일 읽기·쓰기와 명시적 비활성화 설정을 검사한다. 이 번들 검사는 Aside/Docker를 실행하거나 ChatGPT에 연결하는 테스트는 아니다.

성공한 CI의 산출물을 새 버전 폴더에 받아 manifest의 `source_commit`과 SHA-256을 확인한다. 터널 runtime command는 기존 Bun의 절대 경로와 이 번들의 절대 경로로 지정한다. 미리 설치된 Bun은 필요하며, 계정 로그인·전용 터널·개발자 앱 등록은 별도 절차다. 기존 Native2 터널을 새 앱에 재사용하거나 덮어쓰지 않는다.

### 개인용 기본값으로 시작

```bash
export CHAT2LOCAL_WORKSPACE=/absolute/path/to/source-project
export CHAT2LOCAL_STATE_DIR=/absolute/path/outside-project/chat2local-state
bun run start
```

이 명령은 MCP stdio 서버를 실행한다. 터미널에 자연어를 입력하는 프로그램이 아니다. MCP 클라이언트 또는 tunnel-client가 표준 입출력으로 연결한다. 워크스페이스와 상태 폴더는 서로 안에 들어갈 수 없다. 홈 디렉터리 전체를 워크스페이스로 지정할 수 없다.

### 코드 모드 준비

**macOS(Seatbelt, 기본값)** — 준비할 것이 없다. 런타임이 `/usr/bin/sandbox-exec`을 확인하고 실행 때마다 정책을 새로 만든다. 절대 경로만 사용하므로 PATH에 심어둔 가짜 `sandbox-exec`이 끼어들 수 없다.

```bash
# 선택 사항. 자동 선택을 명시적으로 고정하고 싶을 때만.
 export CHAT2LOCAL_SANDBOX=seatbelt
```

**그 밖의 플랫폼(Docker)** — 운영자가 승인한 Node 이미지를 미리 준비하고 `CHAT2LOCAL_WORKER_IMAGE`를 설정한다. 운영 배포에서는 검토한 이미지의 digest를 고정하는 편이 좋다. 런타임은 `--pull=never`를 사용하므로 이미지를 자동 다운로드하지 않는다.

```bash
# 운영자가 승인한 프로비저닝 환경에서만 수행
 docker pull node:22-alpine
 export CHAT2LOCAL_WORKER_IMAGE=node:22-alpine
```

두 백엔드 모두 네트워크를 차단하고, 호스트 인증 파일이나 Docker 소켓을 노출하지 않으며, 파일 접근은 서버 쪽의 제한된 도구 호출로만 제공한다. 코드 모드 워커는 프로젝트 폴더 자체에 대한 읽기 권한조차 갖지 않는다. 모든 파일 접근이 브로커 RPC를 거치기 때문이다.

다만 **둘 다 무결점 보안 경계라고 주장하지 않으며, 두 경계는 성질이 다르다.** 컨테이너는 별도 이미지와 cgroup 자원 상한을 제공하고, Seatbelt는 운영자 본인 사용자로 실행되며 호스트의 PATH 도구가 보이는 대신 커널 정책으로 파일·네트워크 권한을 강제한다. 위협 모델과 별도 호스트 어댑터의 예외는 [보안 문서](docs/security.md)를 읽는다.

### 파일 쓰기는 기본 활성화

```bash
export CHAT2LOCAL_ALLOW_WRITE=1
```

미설정도 위의 `1`과 같다. 끄려면 운영자가 서비스 환경에 `0`을 넣는다. 모델은 도구 인수로 운영자의 제한을 해제할 수 없다. `0`/`1` 이외의 값은 시작 오류로 처리한다. 각 수정은 `read_file`이 반환한 `sha256`을 `expected_sha256`으로 제공해야 한다. 새 파일은 `absent`를 사용한다. 부모 디렉터리는 미리 존재해야 하며, 삭제·임의 디렉터리 생성 기능은 제공하지 않는다.

### Aside도 기본 활성화

```bash
export CHAT2LOCAL_ALLOW_ASIDE=1
# 이미 기본값은 1이다. 끄려면 0을 사용한다.
# PATH 검색 대신 승인한 CLI 절대 경로를 지정할 수 있다.
export CHAT2LOCAL_ASIDE_BINARY=/absolute/path/to/aside
```

**중요:** Aside 어댑터는 사용자 계정의 호스트 CLI를 실행한다. Docker 코드 워커와 달리 호스트·브라우저 권한을 갖고 있고, 파일 도구의 워크스페이스 제한이 Aside 자체의 기능을 격리하지는 않는다. 개인 사용 편의를 위해 기본적으로 켜져 있으므로, 필요 없는 환경에서는 `CHAT2LOCAL_ALLOW_ASIDE=0`으로 끈다. 서브에이전트 권한을 줄이려면 `CHAT2LOCAL_ASIDE_PERMISSION=guard`를 지정한다. 모든 Aside 호출은 직렬 실행되어 같은 브라우저를 동시에 조작하는 충돌을 줄인다. CLI 자체의 계정·호스트·네이티브 옵션은 `aside_native`의 argv로 그대로 전달할 수 있다.

## 2. ChatGPT 연결

터널 ID와 런타임 키는 운영자가 OpenAI의 현재 관리 화면에서 준비한다. 키를 채팅에 붙이거나 도구 인수로 보내지 않는다. 기존의 임의 바이너리 다운로드·quarantine 해제·launchd 자동 등록은 제거했다. 공식 tunnel-client의 설치와 프로필 생성 절차를 사용한다.

> 출처: [OpenAI tunnel-client 설치 및 시작 안내](https://github.com/openai/tunnel-client)

먼저 설정 미리보기를 확인한다. 프로젝트 루트는 실행한 터미널의 현재 경로가 아니라 `bin/setup.ts` 파일 위치로 계산된다.

```bash
bun run setup --workspace /absolute/source/project --tunnel-id tunnel_YOUR_ID
```

출력 내용을 확인한 뒤 운영자가 `--write`를 붙이면 `.chat2local-local/mcp.sh`만 생성된다. 기존 파일은 덮어쓰지 않으며 API 키·터널 프로필·launchd 서비스는 수정하지 않는다.

```bash
bun run setup --workspace /absolute/source/project --tunnel-id tunnel_YOUR_ID --write
```

출력되는 `tunnel-client init`, `doctor`, `run` 명령을 운영자가 실행하고 실제 준비 상태를 확인한다. `CONTROL_PLANE_API_KEY`는 tunnel-client 쪽에만 설정한다. ChatGPT에서 커넥터를 연결한 뒤 `session_open`을 실제 호출해야 전체 연결이 확인된 것이다. 같은 터널 ID에 stdio 런타임 두 개를 겹쳐 실행하지 않는다.

> 출처: [tunnel-client 온보딩](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)

ChatGPT의 계정·워크스페이스에서 터널과 개발자 연결을 사용할 수 있는지도 별도로 확인해야 한다. 설치 스크립트는 로그인·사용자 승인·연결 가능 여부를 우회하지 않는다. **실행 코드를 푸시했다는 사실은 ChatGPT 커넥터 실연결을 검증했다는 뜻이 아니다.**

## 3. 실제로는 채팅에서 이렇게 사용한다

> “이 프로젝트 구조를 먼저 파악하고, 인증 정보를 읽지 않은 채 관련 소스만 정리해줘.”

모델은 `session_open`으로 세션을 만들고 권한을 확인한다. 파일 몇 개는 `read_file`로 직접 읽는다. 반복 읽기가 유리하면 `code_mode_read`로 묶고 `job_get`으로 결과를 받는다. 사용자가 코드 모드 문법을 외울 필요는 없다.

> “방금 읽은 파일의 오류를 수정해줘. 테스트는 호스트에서 실행하지 마.”

모델은 수정 내용을 검토하고 현재 파일 해시를 넣어 `write_file`을 호출한다. 원본이 그사이 바뀌었다면 충돌 오류가 나므로 다시 읽는다. 검증 명령은 Docker 이미지에 필요한 도구가 준비되어 있을 때만 `exec_command`로 실행한다.

> “현재 조사 내용을 기록하고, 다음 대화에서 이어갈 수 있게 해줘.”

`session_checkpoint`는 작업 메모를 저장한다. 다음에는 `session_list`로 세션을 찾거나 기존 세션 ID를 `session_open`에 전달한다. 모델의 내부 사고나 실행 중 JavaScript 메모리가 복구되는 기능은 아니다.

상세 호출 예제, 취소와 재시도 규칙은 [채팅 작업 가이드](docs/workflows.md)에 있다.

---

## 도구 참조

| 구분 | 도구 | 실행 범위 |
|---|---|---|
| 세션 | `session_open`, `session_list`, `session_checkpoint`, `capabilities` | 개인 상태 저널 |
| 파일 | `read_file`, `list_dir`, `glob`, `grep` | 선택한 소스 폴더, 민감 경로 제외 |
| 수정 | `write_file` | 개인용 기본 활성화 + 파일 해시 비교, 운영자 비활성화 가능 |
| 결과 | `artifact_read` | PNG/JPEG/WebP 실제 이미지 또는 UTF-8 텍스트 |
| 코드 모드 | `code_mode_read`, `code_mode` | Docker 워커 + 서버 측 도구 검증 |
| 명령 | `exec_command` | 필터링된 복사본, 격리된 임시 파일시스템 |
| 네이티브 | `aside_native`, `aside_repl`, `spawn_subagent` | 개인용 기본 활성화, 권한이 큰 호스트 Aside |
| 작업 제어 | `job_get`, `job_cancel` | 같은 세션의 작업만 조회·취소 |

`grep`은 정규식이 아닌 **문자열 검색**이다. `glob`은 `*`, `**`, `?`를 지원한다. 잘린 결과는 `truncated`, `next_offset`, 제외된 항목은 `omitted`/`skipped`로 확인한다. 모든 입력 스키마와 기본값은 Zod로 검증되며 MCP SDK에 동일한 스키마가 노출된다.

MCP 초기화·프로토콜 협상·notification 처리는 기존 수제 JSON-RPC 대신 이미 의존성에 있던 공식 TypeScript SDK를 사용한다. 내부 작업 ID는 이 앱의 작업 API이지 MCP의 표준 Tasks 기능을 구현했다고 주장하는 것은 아니다.

> 출처: [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## 이전 버전과 달라진 점

빈 MCP 스키마, 적용되지 않던 기본값, 잘못 계산하던 setup 경로, 비동기 응답보다 먼저 종료하던 stdin 처리, shell 문자열 보간 검색, 개인 Codex 바이너리 하드코딩을 교체했다. 실제 실행을 하지 않던 `code_mode(action,target,...)`는 `code_mode(code,...)`로 바뀌었다. 기존 커넥터의 도구 스키마를 새로 고쳐야 한다.

기본 워크스페이스는 더 이상 특정 사용자의 `~/developer/new/700_projects`가 아니다. 운영자 설정 또는 실행 디렉터리를 사용한다. 호스트 셸 실행 및 `codex_exec`의 자동 Codex/ocx 재위임 경로는 제거했다. Codex Native2의 현재 하네스 도구 연결·승인 UI를 재사용하는 기능은 아직 구현되지 않았다. 별도 코딩 에이전트를 필수로 두지 않는 것이 이번 버전의 의도다.

## 검증과 남은 범위

검증은 [격리 CI](.github/workflows/ci.yml)에서 수행한다. 의존성 설치는 lifecycle script를 끈 frozen lockfile 방식이다. 핵심 정책·파일·작업 테스트, 실제 MCP SDK 클라이언트/stdio EOF 테스트, Docker 워커 RPC·쓰기 제한·스냅샷·타임아웃 테스트를 나누었다. Docker 통합 테스트는 명시적으로 켜지 않으면 skip된다. skip는 성공적인 통합 검증으로 집계하지 않는다.

아직 없는 기능은 ChatGPT 내장 diff/작업 카드 UI, 대용량 다운로드 전달, 모든 네이티브 이미지 형식의 자동 중계, Codex Native2 하네스 연결, 명령 결과 파일의 자동 원본 반영, 재부팅 뒤 작업 프로세스 자체의 복원이다. 구체적인 범위는 [아키텍처와 후속 작업](docs/architecture.md)에 정리했다.
