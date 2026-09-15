# 구현 구조와 후속 작업

## 이번 구현의 중심

ChatGPT가 이미 내린 판단을 또 다른 에이전트에게 재전달하는 경로 대신, 명시적인 실행 계층을 둔다. MCP는 연결 계약, Runtime은 작업 세션과 라우팅, Workspace는 파일 권한 경계, Sandbox는 생성 코드와 명령의 실행 위치를 담당한다.

| 모듈 | 책임 |
|---|---|
| `bin/mcp.ts` | bounded stdio 입력, 시작·종료·미완료 요청 drain |
| `src/server.ts` | MCP SDK 등록, 설명·annotation·이미지 결과 |
| `src/tools.ts` | MCP와 broker가 공유하는 Zod 스키마 |
| `src/runtime.ts` | 세션, 도구 라우팅, 제한된 batch API, Aside 직렬화 |
| `src/policy.ts` | 소스 경로 제한, 파일 해시, compare-and-swap, 스냅샷 |
| `src/store.ts` | private JSON 기록과 단일 프로세스 잠금 |
| `src/jobs.ts` | 중복 요청 방지, 조회·취소·중단 기록 |
| `src/sandbox.ts` | 백엔드 선택(Seatbelt/Docker), 실행 제한, broker frame 처리, 종료·정리 |
| `src/seatbelt-policy.ts` | macOS Seatbelt 프로필 생성과 `-D` 파라미터 바인딩 |
| `src/worker-source.ts` | 컨테이너에서만 실행하는 JavaScript 프로그램 |
| `src/process.ts` | 제한된 환경 상속, 출력 한도, 프로세스 그룹 취소 |
| `bin/setup.ts` | 안전한 launcher 미리보기와 명시적 파일 생성 |

코드 모드의 프로토콜은 `run → call/reply → result/error`의 newline-delimited JSON이다. 워커는 파일 경로나 계정을 선택하는 주체가 아니다. 서버에 고정된 세션의 허용 도구를 호출한다. 워커가 stdout으로 메시지를 위조할 수 있다고 가정하고도 도구 이름·입력·세션·호출 수 제한을 서버에서 검사한다. 코드 워커의 결과는 도구 결과로 취급하며 신뢰할 수 있는 명령으로 승격하지 않는다.

프로세스 작업은 시작 전에 idempotency 키와 입력 지문을 저장한다. 정상 종료는 최종 결과를 기록하고, 비정상 종료 후 복원 시에는 실행 중 상태를 `interrupted`로 바꾼다. 외부 부작용이 있었는지 알 수 없는 일을 자동 replay하지 않는 편을 선택했다. 같은 저널에 두 런타임이 쓰는 것은 허용하지 않는다.

## 참고한 방향과 그대로 가져오지 않은 부분

Chat on Steroids의 채팅 중심 작업 흐름, codex-with-chatgpt의 판단·실행 역할 분리, codex-chatgpt-web의 도구 연결과 세션 수명주기는 설계 참고 대상이다. 이번 변경은 그 프로젝트의 구현을 복사하거나 네이티브 하네스를 자동 연결한 것이 아니다. 연결 기술로 OpenAI 터널을 사용한다는 것과 브리지 전체가 OpenAI 공식 제품이라는 것은 다르다.

참고 프로젝트:

- [Chat on Steroids](https://github.com/totec448-spec/chat-on-steroids)
- [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
- [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)

## 구현된 범위

독립 MCP stdio 서버, 실제 읽기/쓰기 코드 모드, 직접 파일 도구, 비교 해시 기반 편집, 제한된 명령 스냅샷 실행, 선택적 Aside argv/REPL/서브에이전트, 세션 메모, 작업 조회·취소·중복 제출 방지, 작은 이미지와 텍스트 inline 결과, 운영 지침 resource가 있다.

코드 모드는 메모리 보존 REPL이 아니다. 호출마다 새 컨테이너이며 도구 결과·파일과 명시적 작업 메모로 상태를 이어간다. 스크립트 하나가 제한된 도구 조합을 실행하는 기능과, 대화가 끝난 뒤 모델이 무제한으로 판단을 계속하는 자율 실행 루프는 다른 요구다. 후자는 제공하지 않는다.

## 아직 구현하지 않은 범위와 완료 기준

**Native2/기존 하네스 연결.** 현재 하네스가 제공한 정확한 도구 목록·승인·이미지 반환·세션 종료 계약을 어댑터로 받아야 한다. 임의로 하네스 도구를 추측하거나 실패 시 호스트 셸로 우회하지 않는다. 읽기/쓰기·취소·다중 세션 교차 차단 계약 테스트가 완료 기준이다.

**대용량 산출물 전달.** 지금은 워크스페이스의 작은 이미지/텍스트만 inline으로 반환한다. 다음 단계는 content-addressed artifact 저장, 만료·권한·용량 한도, 실제 클라이언트가 읽을 수 있는 전달 경로다. 로컬 파일 경로를 다운로드 링크라고 부르지 않는다.

**채팅 UI.** 작업 카드·diff 검토·산출물 미리보기를 추가할 수 있지만 현재는 텍스트와 structuredContent를 사용한다. UI 없이도 동작하는 것을 유지하고, 실제 ChatGPT 화면에서 읽기·쓰기 승인·취소·재개가 검증되어야 한다.

**더 강한 영속 실행.** 서버 재부팅을 넘는 작업 복원, 연속 로그 저널, 고아 컨테이너 관리, 디스크 쿼터가 다음 과제다. 중단된 외부 행동을 무조건 다시 실행하지 않고 부분 부작용을 다룰 수 있어야 한다.

**macOS/Aside 실환경 검증.** CI에서 통과한 코드가 특정 사용자의 기존 launchd/터널/Aside 계정과 연결된다는 보장은 별도로 검증한다. 도그푸딩 호스트의 인증 상태를 건드리지 않는 전용 테스트 계정·환경을 준비해야 한다.

**성능 측정.** 동일한 작업의 왕복 도구 호출 수·토큰·지연·실패 복구율을 직접 호출과 코드 모드로 비교한다. 측정 전에는 50x 같은 배수를 README에 쓰지 않는다.

## 개인용 활성화와 배포

1.2.0부터 파일 쓰기와 Aside는 개인용 기본값으로 켜져 있고, Aside exec 권한은 `full-access`다. 운영자는 `CHAT2LOCAL_ALLOW_WRITE=0`, `CHAT2LOCAL_ALLOW_ASIDE=0`, `CHAT2LOCAL_ASIDE_PERMISSION=guard`로 제한할 수 있다. `0`/`1` 이외의 활성화 값은 무시하지 않고 시작 오류로 처리한다. MCP 도구 인수로 운영자 제한을 바꾸는 경로는 없다.

CI는 의존성을 포함한 Bun 실행 번들을 별도 아티팩트로 게시한다. 소스 커밋과 해시를 검증하고 복사하면 개인 호스트에서 install/build 없이 배포할 수 있다. 운영 서버 시작과 계정별 커넥터 등록은 번들 검사와 별개이며, 등록·연결을 실제 확인하기 전에는 활성화 완료라고 보고하지 않는다. CI는 두 백엔드를 각각의 러너에서 검증한다. Linux 러너가 Docker 통합을, macOS 러너가 실제 Seatbelt 실행을 확인한다. 사용 가능한 샌드박스 백엔드가 없으면 코드 모드는 실패하며, 프로세스 내부 우회 실행은 어느 경우에도 없다.
