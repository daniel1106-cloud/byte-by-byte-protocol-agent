# N12 · 복원 명세를 웹에 연결

작업 번호 **N12**, 담당 **유현석**. #9의 N08 웹(`compose.n08.yaml`)에 세 번째 화면을 더했다.
LLM이 복원한 명세(`wire-spec-v1`, #11)로 실제 서버와 통신하고, 공개 연습 오라클로 N07 평가를 돌린다.
**공개 연습 결과이며 본 실험 점수가 아니다.**

## 무엇을 하나

| 화면 3번 | 동작 |
| --- | --- |
| 분석 선택 | 서버 시작 때 읽은 분석 파일 목록에서 고른다. 조건(A/B)·`analysis_run_id`·`preparation_run_id`·회차·모델·명세 sha256·출처를 표시 |
| 명세·근거 | 요청/응답 필드 표, 모델의 `semantics`·`unknowns`·`observations`(주장·근거 id·원문 인용) |
| 복원 명세로 전송 | 입력 숫자를 복원 명세로 인코딩해 같은 연습 서버(127.0.0.1:19006)로 보내고, 응답을 복원 명세로 해석 |
| 공개 연습 오라클로 평가 | `practice/n06/client-vectors.json`의 새 입력 5개 × 전송 방식 3개 = 15케이스를 만들어 N07(`--target`)로 평가. 실제 응답도 복원 명세로 다시 해석 |

케이스 생성은 `scripts/n12-practice-bridge.mjs`의 `buildPracticeCases`를, 인코딩·디코딩은 `scripts/wire-spec.mjs`를 그대로 쓴다.
모델이 만든 코드는 실행하지 않는다.

## 실행 규칙 (브리지와 같음)

- `success: false`, `model_called` 아님, `runtime.execution_backend`가 `real`이 아닌 분석은 **실행하지 않는다**(화면에 사유 표시).
- `validateWireSpec`을 통과하지 못하는 명세(빈 명세, unknown 종류, 지원 안 되는 속성)는 실행하지 않는다.
- 실행 가능한 모양은 **정수 배열 입력 1개 + 정수 출력 1개**뿐이다. 입력·출력 필드 이름은 모델이 정한다(A: `arguments`/`result_value`, B: `data`/`result`).
- 분석 파일 경로는 서버 시작 때만 정한다. 요청은 목록의 `analysis_id`만 고를 수 있다.

## 결과 구분

| outcome | 뜻 |
| --- | --- |
| `ok` | 응답이 복원 명세대로 끝까지 해석됨 |
| `outside_spec` | **복원 명세 밖 응답.** 바이트는 왔지만 복원 명세로 해석되지 않는다. 네트워크 실패가 아니다. 원본 hex·디코더 메시지·모델의 `unknowns`를 함께 표시 |
| `timeout` / `eof_no_response` / `truncated` / `connection_error` / `connect_failed` | N08과 같은 네트워크 결과 |

### #11 리뷰에서 짚은 두 가지의 처리

1. **서버 오류 응답:** 실제 A/B 명세는 정상 응답 한 종류만 담는다. 연습 서버의 오류 프레임(예: `424201ff000104`, bad length)은 디코더가 `Constant mismatch`로 거절하므로 `outside_spec`으로 표시한다. 오류 응답을 명세에 넣는 것은 `wire-spec-v1` 범위 밖이다.
2. **숫자 개수 상한:** 복원 명세에는 개수 상한이 없다. 웹은 프레임 바이트 한도(4096)에서 나온 상한만 막고(2바이트 정수면 2045개), 서버가 거절할 수 있다고 안내한다. 40개를 보내면 서버가 bad length로 거절하고 `outside_spec`으로 보인다.

## 분석 목록

기본값은 #11 증거에서 **수정 없이 복사한** Gemini pilot 분석 2개다.

| 파일 | 원본 |
| --- | --- |
| `web/spec/n12/practice-gemini-A.json` | `docs/evidence/N05-N09-Gemini-integration-2026-11-17.json` → `final_pilot.conditions[0].analysis` |
| `web/spec/n12/practice-gemini-B.json` | 같은 파일 → `final_pilot.conditions[1].analysis` |

각 파일은 `{ "n12_fixture": {출처·해시}, "analysis": {원본 그대로} }` 모양이다. 테스트가 원본과 같은지, 명세 sha256이 브리지 기록과 같은지 확인한다.

다른 분석(예: E1 결과)을 띄우려면 **저장소 기준 경로**를 `N12_ANALYSES`에 쉼표로 적는다. N09-live 결과 파일(`*-analysis.json`)을 그대로 읽는다.

```powershell
$env:N12_ANALYSES="runs/gemini/태그/A-analysis.json,runs/gemini/태그/B-analysis.json"; docker compose -f compose.n08.yaml up -d --wait
```

`compose.n08.yaml`은 이 변수를 넘기지 않으므로, 컨테이너에서 바꾸려면 `docker compose ... run`의 `-e N12_ANALYSES=...`를 쓴다. 본 실험 결과를 화면에 띄워도 **평가 버튼은 공개 연습 오라클만 쓴다.** 본 실험 채점(N11, 비공개)은 이 화면이 하지 않는다.

## 실행

N08과 같다([N08 실행 문서](n08-web-client.md)). 서버 빌드 후:

```powershell
docker compose -f compose.n08.yaml up -d --wait
```

브라우저에서 `http://127.0.0.1:8080`의 **3. 복원 명세로 통신 (N12)**를 연다.

### 테스트

```powershell
docker compose -f compose.n05.yaml run --rm n05 node --test --test-timeout=120000 "web/test/*.test.mjs"
```

`web/test/recovered.test.mjs` 18개(모의 15, 실제 서버 2, fixture 원본 대조 포함)가 추가돼 웹 테스트는 69개다. 실제 서버 테스트는 Linux + `runs/n06/practice-server`(+ python3)가 있을 때만 돈다.

## 직접 확인할 것

1. `docker compose -f compose.n08.yaml up -d --wait` → `ps`에 `(healthy)`.
2. 화면 3번에 `A · aa60c508`, `B · 80ea5edf` 두 칩이 보이고, A를 고르면 조건 "A · 패킷만", 모델 `gemini-3.5-flash-lite`, `experiment_score false`.
3. A에서 `1 2 3` 전송 → "복원 명세대로 해석된 응답", `result_value = 6`, 요청 `42 42 | 01 01 | 00 06 | 00 01 00 02 00 03`.
4. A에서 `1`을 40번 입력해 전송 → "복원 명세 밖 응답", 응답 `42 42 01 ff 00 01 04`, 디코더 메시지 `Constant mismatch at version_or_type`.
5. A에서 "평가 실행 (15개 케이스)" → 15/15, `all_pass: true`, "실제 응답 전부 복원 명세로 해석됨".
6. B를 골라 3·5번 반복 → `result = 6`, 15/15.
7. `docker compose -f compose.n08.yaml down`.

## 한계

- 연습 프로토콜(SUM)과 pilot 분석 2개로만 확인했다. 본 실험 대상의 명세가 이 실행 가능 모양(정수 배열 입력 1개 + 정수 출력 1개)에 맞지 않으면 웹은 실행을 거부한다. 그때는 모양 규칙을 브리지와 함께 넓혀야 한다.
- 실행 가능 모양 판정을 `web/lib/recovered.mjs`에 브리지와 같은 조건으로 따로 두었다. 둘이 어긋나지 않도록 `wire-spec.mjs`의 공용 함수로 옮기는 것을 제안한다.
- `.github/workflows/keyless-checks.yml`은 `web/` 테스트를 돌리지 않는다. 이제 웹이 `scripts/wire-spec.mjs`를 직접 쓰므로 CI에 웹 테스트를 넣는 것을 제안한다.
- 1·2번 화면(N08)은 바꾸지 않았다.
