# 채팅 작업 가이드

사용자는 자연어로 요청하고, ChatGPT가 도구를 선택한다. 이 문서의 코드는 사용자가 매번 직접 입력해야 하는 명령이 아니라 모델과 개발자가 공유하는 실행 계약이다. 아래 JSON의 세션 ID는 설명용이며, 실제 `session_open` 결과로 교체한다.

## 작업을 시작하고 이어가기

먼저 `session_open`을 호출한다.

```json
{"project":".","title":"소스 구조 조사"}
```

결과의 `session.id`를 이후 모든 호출에 사용한다. `write_enabled`, `code_mode_configured`, `native_aside_enabled`를 확인한다. `code_mode_configured: true`는 이미지 이름이 설정되어 있다는 뜻이지 Docker나 실제 이미지가 정상이라는 뜻이 아니다. 도구 실패를 다른 호스트 실행기로 우회하지 않는다.

작업이 길어지면 `session_checkpoint`에 지금까지 확인한 근거·변경 파일·다음 행동을 적는다. 비밀값이나 모델의 내부 사고는 기록하지 않는다. 다음 대화는 `session_open({session_id: ...})` 또는 `session_list`에서 시작한다. 프로젝트가 이동·삭제되어도 세션 메모, 작업 조회·취소는 계속 사용할 수 있다. 재개 응답의 `workspace_validated: false`는 기록만 복원했다는 뜻이며, 실제 파일 작업에서는 경로를 다시 검사한다. 이동한 경로를 자동으로 추적하거나 접근 범위를 넓히지는 않는다.

## 파일을 읽고 수정하기

```json
{"session_id":"실제 세션 ID","path":"src/example.ts"}
```

`read_file`의 결과는 내용, 전체 파일 해시, 전체 바이트 수와 `next_offset`을 담는다. 내용이 잘렸으면 반환된 `next_offset`으로 다음 범위를 읽는다. 바이트 제한 안에서 한글·이모지의 완전한 UTF-8 문자 경계까지만 반환하므로 `offset + limit`을 직접 계산하면 안 된다. 문자 중간 offset, 첫 문자보다 작은 limit, 유효하지 않은 UTF-8 입력은 오류로 반환한다. 수정할 때는 이 해시를 사용한다.

```json
{
  "session_id":"실제 세션 ID",
  "path":"src/example.ts",
  "content":"검토한 새 파일 내용\n",
  "expected_sha256":"read_file에서 받은 64자리 해시"
}
```

`Conflict`는 파일을 다시 읽으라는 뜻이다. 기존 파일을 `absent`로 덮어쓸 수 없다. 파일 수정은 코드 실행이 아니며, 설치·테스트·Git 훅이 자동 실행되지 않는다. 다만 운영 중인 외부 파일 감시 서비스가 소스 변경에 반응할 가능성까지 chat2local이 막는 것은 아니므로 노출할 프로젝트를 신중히 선택한다.

## 반복 작업은 코드 모드로 묶기

`code_mode_read`는 다음과 같은 async JavaScript 본문을 받는다.

```javascript
const listing = await tools.call('glob', { pattern: '**/*.ts' });
if (listing.truncated) throw new Error('Select a smaller project');
const files = listing.files.slice(0, 12);
const summaries = await tools.map(files, async path => {
  const file = await tools.call('read_file', { path });
  return { path, bytes: file.total_bytes, sha256: file.sha256,
    needsMoreReading: file.next_offset !== null };
}, 4);
console.log(`Inspected ${summaries.length} files`);
return summaries;
```

호출 인수에는 `session_id`, `code`, `request_id`, 필요하면 `timeout`을 넣는다. 코드 안에서는 세션 ID를 다시 넣지 않는다. 브로커가 세션과 읽기/쓰기 권한을 고정한다. `tools.call`의 결과는 MCP 텍스트 포장 대신 직접 사용할 수 있는 값이다.

`tools.map`은 최대 8개 동시 실행과 최대 128개 항목을 허용하며 입력 순서로 결과를 돌려준다. 작업 하나의 전체 broker 호출 한도도 128개이므로 파일 읽기와 추가 호출을 함께 계산해야 한다. 결과를 좁혀 반환한다. 모든 도구 호출은 반드시 await한다.

읽기 전용 코드에서 `write_file`이나 `aside_native`를 호출하면 서버 쪽에서 거부한다. JavaScript의 전역 객체를 변형하거나 stdout으로 요청을 직접 보내더라도 서버의 허용 도구와 세션 검사를 생략할 수 없다. 코드 워커의 JavaScript 언어 자체를 보안 샌드박스로 취급하지 않는다.

쓰기 배치는 `code_mode`를 사용한다. 운영자의 쓰기 설정과 사용자의 해당 작업 승인이 전제다.

```javascript
const file = await tools.call('read_file', { path: 'src/example.ts' });
if (file.next_offset !== null) throw new Error('Read the whole file before replacing it');
const updated = file.content.replace('oldValue', 'newValue');
if (updated === file.content) return { changed: false };
return await tools.call('write_file', {
  path: 'src/example.ts', content: updated, expected_sha256: file.sha256
});
```

여러 파일 쓰기는 트랜잭션이 아니다. 세 번째 수정에서 실패해도 앞선 두 파일이 자동으로 원복되지 않는다. 실패 후 현재 파일들을 다시 읽고 복구 여부를 판단한다.

## 긴 작업과 중복 요청

코드 모드·명령·직접 Aside 호출은 `job_id` 역할의 `id`를 즉시 돌려준다. `job_get`에 `job_id`로 전달한다.

```json
{"session_id":"실제 세션 ID","job_id":"실제 작업 ID","cursor":0,"wait_ms":1000}
```

상태는 `running`, `succeeded`, `failed`, `cancelled`, `interrupted` 중 하나다. `events`와 `next_cursor`를 이용해 로그를 나누어 읽는다. 실제 `result`는 작업이 완료되었을 때 확인한다. 성공 상태가 아닌 결과를 성공이라고 설명하지 않는다.

연결 응답을 놓쳤을 때 같은 작업을 재요청한다면 **동일한 request_id와 동일한 입력**을 사용한다. 같은 세션의 키에 다른 코드·명령을 넣으면 충돌한다. 완료되거나 실패한 작업도 같은 키로 자동 재실행되지 않는다. 이 보장은 같은 상태 저널 내의 중복 제출 방지이며 외부 시스템 전체의 exactly-once 보장이 아니다.

`job_cancel`은 중단을 요청한다. 이후 상태를 다시 확인한다. 이미 반영된 파일 수정이나 브라우저 행동은 남아 있을 수 있다. 서버가 정상 종료하면 활성 작업을 취소하고 기록을 닫는다. 강제 종료 후 남은 `running` 기록은 재시작 때 `interrupted`로 바뀌며 자동 재실행하지 않는다. 강제 종료가 남긴 컨테이너는 운영자가 Docker에서 확인·정리해야 한다.

로그는 최근 실행 프로세스 메모리에서 제한적으로 유지되고 작업 종료 시 저널에 저장된다. 강제 종료 직전의 모든 로그가 복원되는 기능은 아니다. 저널은 세션 128개, 작업 512개 한도로 운영하며, 한도에 도달하면 런타임을 멈춘 뒤 운영자가 이전 상태를 보관하고 새로운 상태 디렉터리를 지정한다. 런타임이 원본 프로젝트를 삭제하면서 자동 정리하지 않는다.

## 명령을 실행할 때

`exec_command`는 선택된 프로젝트의 허용된 파일만 복사한 읽기 전용 스냅샷을 컨테이너에 전달한다. 컨테이너 내부의 임시 작업 공간으로 다시 복사한 뒤 명령을 실행한다.

```json
{"session_id":"실제 세션 ID","request_id":"inspect-package-v1","command":"node --version && ls","timeout":10000}
```

실제 프로젝트, 홈, 키체인, 브라우저 프로필, Docker 소켓을 마운트하지 않는다. `.env`, `.git`, 키 파일, 링크, `node_modules`, `dist` 등은 스냅샷에서 제외된다. 의존성·검증 도구는 승인한 Docker 이미지에 미리 준비되어 있어야 한다. 네트워크가 없으므로 일반적인 온라인 install은 성공하지 않는다.

명령의 파일 변경과 생성물은 컨테이너 종료 후 사라지고 원본에 자동 적용되지 않는다. 반환되는 것은 stdout/stderr와 실행 상태다. 변경할 소스는 검토한 `write_file`로 따로 반영한다. 대용량 빌드·쓰기 공간이 큰 테스트·Docker-in-Docker는 이 제한된 워커의 지원 범위가 아니다.

## Aside와 이미지

처음 보는 페이지에서 다음 행동을 판단하거나 단일 버튼을 누르는 일은 코드 배치로 억지로 묶지 않는다. 운영자가 허용한 경우 `aside_repl` 또는 `aside_native`를 직접 사용한다. `aside_native`는 정확한 argv를 셸 문자열이 아닌 배열로 전달한다.

코드 모드에서도 `tools.call('aside_native', {args: [...]})`로 동일한 어댑터를 호출할 수 있지만, **쓰기/외부 작업 배치에서만** 가능하다. 읽기 전용 도구로 위장하지 않는다. Native2가 현재 채팅에 제공하는 모든 도구가 이 서버에도 자동 연결되는 것은 아니다.

`artifact_read`는 승인한 워크스페이스 안의 PNG/JPEG/WebP를 실제 MCP image content로 돌려준다. 호스트 경로만 보여주는 것과 다르다. 512 KiB inline 한도가 있으며 PDF·ZIP·대용량 파일 전송 또는 ChatGPT 다운로드 첨부 생성은 아직 구현하지 않았다. Aside가 다른 곳에 저장한 이미지라면 그 경로가 곧바로 허용되는 것은 아니다.
