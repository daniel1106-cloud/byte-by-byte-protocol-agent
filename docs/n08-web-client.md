# N04·N08: 웹 화면과 실제 서버 통신

작업 번호 **N04·N08**, 담당 **유현석**. 공개 연습 자료 N06(`practice/n06`)만 사용한다. **연습 결과는 본 실험 점수가 아니다**(`experiment_score: false`). 본 실험(N10) 자료는 쓰지 않았고 찾지도 않았다.

## 한 일과 범위

| 작업 | 완료 기준(노션) | 이 PR에서 한 일 |
| --- | --- | --- |
| N04 | 개발·배포 환경을 준비하고 입력하면 예시 결과가 표시되는 웹 화면 | `compose.n08.yaml` 한 줄로 재현되는 Docker 실행, 명령 입력 화면, README 예시를 눌러 채우는 예시 표시 |
| N08 | 웹에서 명령 하나를 보내 실제 서버 응답 확인. N06 명세로 클라이언트·웹 실제 통신, N07 결과 표시 | 명세 JSON을 읽는 클라이언트 모듈, 웹에서 실제 연습 서버로 요청·응답 확인, N07 평가 결과 표시 |

**하지 않은 것(남은 일)**

- 호스팅 선택과 공개 URL은 **N20** 범위다. 지금 접속 주소는 로컬 `http://127.0.0.1:8080` 뿐이다. N04의 "배포"는 Docker로 재현 가능한 실행까지만 했다.
- 정의종의 N09 출력(복원 명세)에서 클라이언트를 자동 생성하는 일은 **N12** 범위다. 아래 "명세 JSON 형식"은 N12에서 맞출 초안이다.
- N16은 시작하지 않았다.

## 구성

```
브라우저(호스트) ──127.0.0.1:8080──▶ [컨테이너 n08]
                                       web/server.mjs ─ 127.0.0.1:19006 ─▶ runs/n06/practice-server
                                       └ python3 scripts/n07-evaluate.py --target 127.0.0.1:19006
```

연습 서버는 `127.0.0.1`에만 바인드한다. Docker `-p`로 열어도 호스트 웹앱은 접속할 수 없으므로, 백엔드를 서버와 **같은 컨테이너**에서 실행하고 웹 포트(`127.0.0.1:8080`)만 호스트에 연다. 서버는 `web/server.mjs`가 자식 프로세스로 실행하고 종료할 때 함께 끈다.

| 파일 | 역할 |
| --- | --- |
| `compose.n08.yaml` | N05와 같은 이미지(`byte-by-byte-n05:rea6.8.0`)로 웹+서버를 실행. 호스트에는 `127.0.0.1:8080`만 공개 |
| `web/server.mjs` | 진입점. 연습 서버를 띄우고 웹/API를 연다. 종료 시 서버를 정리 |
| `web/lib/protocol.mjs` | 명세 JSON을 읽어 요청 프레임을 만들고 응답 프레임을 해석 |
| `web/lib/client.mjs` | TCP 클라이언트. 헤더 6바이트와 length까지 모아 읽고, 정상/오류 프레임/EOF/시간 초과를 구분 |
| `web/lib/queue.mjs` | 서버가 순차 처리이므로 서버로 가는 모든 일(요청, 평가)을 한 줄로 세움 |
| `web/lib/evaluate.mjs` | 같은 서버를 N07 평가기(`--target`)로 평가하고 결과 JSON을 읽음 |
| `web/lib/practice-server.mjs` | 연습 서버 프로세스 관리, 바이너리 SHA-256 기록 |
| `web/lib/app.mjs` | HTTP 라우팅과 입력 검증, 보안 규칙 |
| `web/public/` | 화면(`index.html`, `app.js`, `style.css`) |
| `web/spec/n06-practice.json` | README에서 **사람이 옮긴** 연습 명세. 복원 결과가 아님 |
| `web/test/` | 단위·소켓·HTTP·실제 서버 테스트 51개 |

npm 의존성은 없다(Node 내장 모듈만 사용).

## 실행 방법

PowerShell, 저장소 루트. 필요한 것: Git, Docker Desktop(Linux 엔진이 실제로 도는 상태). N05 이미지 설치는 [실행법](rea-smoke.md)을 따른다.

```powershell
# 1) N05 이미지 (이미 있으면 생략. 처음에는 수 분, 수백 MB~수 GB)
docker compose -f compose.n05.yaml build n05

# 2) 연습 서버 빌드 (runs/는 Git에서 제외됨)
New-Item -ItemType Directory -Force runs/n06 | Out-Null
docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c
docker compose -f compose.n05.yaml run --rm n05 sh -c 'sha256sum runs/n06/practice-server'

# 3) 웹 + 서버 실행 (healthy가 될 때까지 기다림)
docker compose -f compose.n08.yaml up -d --wait

# 4) 브라우저에서 http://127.0.0.1:8080 을 연다

# 5) 끝낼 때 (서버 프로세스도 함께 정리됨)
docker compose -f compose.n08.yaml down
```

- 서버 바이너리가 없으면 화면 맨 위 상태 줄과 `/api/health`에 `binary_missing`과 빌드 안내가 나오고, 전송은 HTTP 503으로 거절된다.
- 로그: `docker compose -f compose.n08.yaml logs n08` (JSON 한 줄씩).
- 포트 8080이 이미 쓰이면 `compose.n08.yaml`의 `ports` 앞쪽 숫자를 바꾼다.

## 화면에서 하는 일

1. **명령 보내기**: 숫자 1~32개(각 0~65535)를 입력하고 전송. 요청 hex와 응답 hex(필드별로 나눠 표시), 해석한 합계 또는 오류 코드, 연결 상태(연결됨, 서버가 연결을 닫음), 소요 시간을 보여 준다. README 예시 5개는 칩으로 입력칸에 채울 수 있고(실제 서버 응답이 아니라 README 표에서 옮긴 값임을 화면에 표시), 전송 결과가 README 예시의 기대 응답과 같은지 비교해 알려 준다.
2. **N07 평가 결과**: "평가 실행"을 누르면 위와 **같은 서버**를 `practice/n06/cases.json`(21개)으로 평가한다. 요약, 케이스별 verdict, 기대/실제 hex, `first_diff_offset`, 오류를 표시한다. "연습 결과, 본 실험 점수 아님"을 눈에 띄게 표시하고, JSON의 `experiment_score`가 `false`가 아니면 경고한다.

판정 규칙: N07 JSON의 `success: true`는 **평가 절차가 끝났다는 뜻**일 뿐이다. 통과 여부는 `summary.all_pass`와 케이스별 `verdict`로 표시한다. 종료 코드 1은 "불일치가 있다"일 수도 "평가가 중간에 멈췄다"일 수도 있어서, 백엔드가 결과 JSON을 읽고 구분한다(`all_pass` / `completed_with_mismatch` / `run_failed` / `timeout`).

## API

| 요청 | 설명 |
| --- | --- |
| `GET /api/health` | 연습 서버 상태(state, pid, SHA-256), 큐 길이, 평가기 존재 여부 |
| `GET /api/spec` | 사용 중인 명세 JSON |
| `POST /api/send` | 본문 `{"numbers":[1,2,3]}`만 허용. 서버로 요청 하나를 보내고 결과를 돌려줌 |
| `POST /api/evaluate` | 본문 없음(`{}`). 같은 서버를 N07 평가기로 평가 |
| `GET /api/evaluate/latest` | 마지막 평가(메모리, 재시작하면 사라짐) |

`/api/send`의 `result.outcome`: `ok`(정상 응답), `error_frame`(서버가 오류 프레임을 보냄), `timeout`(응답이 끝까지 안 옴), `eof_no_response`(응답 없이 서버가 연결을 닫음), `truncated`(응답이 도중에 끊김), `protocol_violation`(명세와 다른 응답), `connection_error`, `connect_failed`. 네트워크 문제는 HTTP 200 안의 `outcome`으로, 입력 오류는 400, 서버 없음은 503, 대기 초과는 429로 돌려준다.

## 설계 결정

- **메시지 경계를 가정하지 않는다.** `data` 이벤트 하나를 응답 하나로 보지 않고, 헤더 6바이트를 모은 뒤 헤더의 length만큼 더 모아 프레임을 완성한다. 응답을 1바이트씩 보내는 소켓 테스트로 확인했다.
- **서버는 순차 처리이고 수신 중 유휴 제한이 없다**([practice/n06/README.md](../practice/n06/README.md)의 한계). 멈춘 클라이언트 하나가 다른 연결을 막을 수 있으므로 백엔드는 모든 요청과 평가를 한 줄로 세우고(`queue.mjs`), 요청마다 3초 제한을 둔다. 제한이 지나면 소켓을 닫아 서버를 풀어 준다.
- **접속 대상은 고정이다.** 사용자는 host, port, 경로를 넘길 수 없다(`/api/send` 본문에 `numbers` 외 필드가 있으면 400). 평가기는 인자 배열로만 실행하고(shell 없음) 결과 파일은 서버가 만든 이름(`runs/n08/eval-web-<UTC시각>-<난수>.json`)을 쓴다. N07은 기존 결과를 덮어쓰지 않고 거부하므로 실행마다 새 이름이 필요하다.
- **서버가 입력을 다시 검증한다**(정수, 0~65535, 1~32개). 화면의 검사는 편의용이다.
- **로컬 전용 방어**: `Host`가 `localhost`/`127.0.0.1`/`[::1]`이 아니면 403(DNS 재바인딩 방어), POST의 `Origin`이 같은 출처가 아니면 403, `Content-Type: application/json`만 허용, 본문 4 KB 제한, CSP로 인라인 스크립트 금지. 화면은 서버가 준 문자열을 `textContent`로만 넣는다.
- **어떤 서버였는지 기록한다.** `--target` 모드의 N07 JSON에는 바이너리 해시가 없으므로, 백엔드가 서버 바이너리의 SHA-256과 PID를 응답과 화면에 함께 보여 준다.

## 명세 JSON 형식 (N12에서 N09 출력과 맞출 초안)

`web/spec/n06-practice.json`. **README에서 사람이 옮긴 것이고 `source.restored_from_traffic: false`, `experiment_score: false`다.**

| 키 | 내용 |
| --- | --- |
| `format`, `name`, `classification` | 형식 이름(`n08-draft-1`), 이름, `practice` |
| `experiment_score` | 항상 `false`(연습) |
| `source` | `kind`(`human-transcribed`), `restored_from_traffic`, 옮겨 온 문서와 절 |
| `transport` | `protocol: tcp`, `byte_order: big`, 연결당 요청 하나, 서버가 응답 뒤 닫음, 기본 포트, 바인드 주소 |
| `header` | `size`와 `fields[]`. 각 필드: `name`, `offset`, `size`, `kind`(`const` + `value` hex / `type` / `length`) |
| `messages.request[]` | `type`(hex), `name`, `payload`: `layout: array`, `element: u16`, `min_count`, `max_count` |
| `messages.response[]` | `type`(hex), `name`, `role`(`result`/`error`), `payload`: `layout: fields`, `fields[]`(`name`, `kind`: `u8`/`u16`/`u32`, 선택 `values`: hex→뜻) |
| `server_behavior[]` | 서버 동작 설명(검사 순서, EOF 처리 등) |
| `examples[]` | 입력, 요청 hex, 응답 hex, 메모 |

클라이언트는 이 JSON의 `header.fields`로 요청 헤더를 만들고(상수는 그대로, type은 요청 type, length는 payload 바이트 수), 응답 헤더를 해석해 `messages.response[]`에서 type을 찾고 length를 검증한 뒤 payload 필드를 읽는다. N09가 이 구조(헤더 필드 목록, 메시지별 type, payload 필드 종류와 값 의미)로 출력하면 클라이언트 코드는 그대로 쓸 수 있다. 바뀌어야 할 부분(예: 가변 길이 필드, 문자열, 여러 메시지)은 N12에서 정한다.

## 테스트

```powershell
# 호스트 Node 24: 단위·가짜 서버 소켓·HTTP 테스트 44개 통과, 실제 서버 테스트 7개는 건너뜀(Linux 필요)
node --test "web/test/*.test.mjs"

# N05 컨테이너(Linux): 실제 연습 서버 테스트 포함 51개. 기대 결과: tests 51, pass 51, fail 0
docker compose -f compose.n05.yaml run --rm n05 node --test --test-timeout=120000 "web/test/*.test.mjs"
```

- 가짜 서버(진짜 TCP 소켓)로: 응답을 1바이트씩 보냄, 헤더 중간에서 나눔, 오류 프레임, 응답 없는 EOF, 응답 도중 EOF, 응답이 멈춤(시간 초과), 연결 거절, 명세와 다른 응답, 프레임 뒤 추가 바이트, 응답 뒤 리셋.
- 실제 서버로: README 정상 5세션, 32개 최대, 오류 프레임 6종(코드 1~4), 요청을 1바이트씩 쪼개 보내기, 헤더 도중 EOF, 웹 API 경로 `1 2 3 → sum=6`, 웹 경로로 N07 평가 21/21.

## 직접 확인할 것 (본인 확인용 — 이 문서의 결과는 AI 실행이 아니라 아래를 직접 실행해 보라는 안내)

[AI 사용 기록](ai-usage.md)의 N04·N08 행은 `확인 필요`다. 아래를 직접 실행해 본 뒤 본인이 본 값만 그 칸에 적는다.

1. `docker compose -f compose.n08.yaml up -d --wait` → 컨테이너가 `healthy`가 된다. `docker compose -f compose.n08.yaml ps`로 확인.
2. 브라우저 `http://127.0.0.1:8080` → 맨 위에 "연습 서버: 실행 중 · 127.0.0.1:19006", 바이너리 sha256 `d6cd6d971030…`.
3. 입력칸에 `1 2 3` 전송 → 요청 hex `424201010006000100020003`, 응답 hex `42420181000400000006`, 화면에 `합계 = 6`, "README 예시의 기대 응답과 일치합니다".
4. 입력칸에 `65535 65535` → 응답 `4242018100040001fffe`(합계 131070).
5. "평가 실행" → "평가 완료 · 전부 통과", 총 21 / 통과 21 / 실패 0 / 오류 0, `all_pass: true`, 상단에 "연습 결과, 본 실험 점수 아님".
6. 같은 서버를 명령줄로도 평가: `docker compose -f compose.n08.yaml exec n08 sh -c 'python3 scripts/n07-evaluate.py --cases practice/n06/cases.json --target 127.0.0.1:19006 --out runs/n08/eval-cli-$(date +%Y%m%d-%H%M%S).json'` → 요약 21/21, 종료 코드 0(`echo $LASTEXITCODE`).
7. `docker compose -f compose.n08.yaml down` 뒤 `docker ps -a`에 이 프로젝트의 컨테이너가 없다.

## 한계

- 연습 명세는 사람이 README에서 옮겼다. 분석으로 복원한 명세가 아니고, 본 실험 점수와 무관하다.
- 서버가 순차 처리라 동시 접속과 부하는 측정하지 않았다. 백엔드의 직렬화는 이 서버 때문에 필요한 것이다.
- 응답의 끝을 "프레임 하나를 모음"으로 판단하고 연결 종료를 짧게(0.5초) 지켜본다. 한 연결에서 여러 메시지를 주고받는 프로토콜은 지원하지 않는다.
- 화면은 로컬 주소에서만 연다. 공개 URL과 호스팅은 N20.
- 브라우저 표시 확인은 한 번의 실행에서 Claude 내장 브라우저로 한 것이다. 사람이 직접 보는 확인은 위 "직접 확인할 것"에 남겨 둔다.

## 발표에서 설명할 핵심

TCP에는 메시지 경계가 없으므로 헤더를 모으고 length만큼 더 읽어야 한다. 서버가 순차 처리이고 유휴 제한이 없어서 웹 백엔드가 요청을 직렬화하고 시간 제한을 둔다. 루프백 전용 서버는 같은 컨테이너에서만 닿는다. "평가 절차 완료"와 "전부 통과"는 다르다.
