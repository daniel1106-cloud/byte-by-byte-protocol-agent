# N03: 평가표와 결과 기록 형식

작업 번호 **N03**, 담당 **권세현**. 본 실험(E1·E2·E3)에서 무엇을 어떻게 채점하고, 결과를 어떤 열로 기록할지 정한 **초안**이다. N07 평가기·N11 채점 기준·N15/N19 집계가 같은 형식을 쓰도록 하는 것이 목적이다.

> **범위.** 이 문서는 형식과 틀이다. 본 실험의 정답·체크리스트 실제 문항·숨은 평가 입력은 N10(김태형)·N11(권세현)에서 비공개 위치에 확정하며, 이 저장소에 넣지 않는다. 아래 체크리스트 문항은 정답을 드러내지 않는 **범주별 일반 틀**이다. 예시 CSV의 값은 형식 설명용이며 측정값이 아니다.

## 1. 평가표

### 1.1 E1 · 복원 정확도 (사전 체크리스트 약 15개)

조건 A(패킷만), 조건 B(패킷+바이너리/REA) 각각 5회, 총 10회를 같은 체크리스트로 채점한다. 실제 문항은 N11에서 정답을 본 뒤 프롬프트를 바꾸지 않는 시점에 고정한다.

| ID | 범주 | 확인할 내용(일반 틀) |
| --- | --- | --- |
| K01 | 메시지 경계 | 메시지 끝을 구분자/길이/연결 종료 중 무엇으로 정하는가 |
| K02 | 메시지 형식 | 헤더·필드의 순서와 위치 |
| K03 | 메시지 형식 | 필드별 크기와 타입 |
| K04 | 메시지 형식 | 바이트 순서(엔디안) |
| K05 | 메시지 형식 | 길이·개수 필드의 의미(무엇을 센 값인가) |
| K06 | 명령 | 명령 식별 방법(코드/문자열)과 전체 명령 목록 |
| K07 | 명령 | 명령별 요청 형식 |
| K08 | 명령 | 명령별 응답 형식 |
| K09 | 명령 | 오류 응답의 형식과 발생 조건 |
| K10 | 상호작용 | 연결 후 메시지 순서(핸드셰이크 여부) |
| K11 | 상호작용 | 한 연결에서 주고받는 메시지 수와 연결 종료 시점 |
| K12 | 상호작용 | 이전 메시지에 따라 달라지는 상태 의존 규칙 |
| K13 | 견고성 | 잘못된 입력(길이 불일치·알 수 없는 명령)에 대한 서버 동작 |
| K14 | 제한 | 최대 크기 등 제한값 |
| K15 | 검증 | 무결성 필드(체크섬 등) 존재와 계산 방식 (범위 조절 시 제외 가능) |

채점 규칙:
- 항목마다 `pass`/`fail`로 기록하고 근거 위치(주장 원문, 대응 정답 항목)를 `notes`에 남긴다. 부분 정답은 사전에 부분 기준을 정하지 않으면 `fail`로 처리한다.
- `evidence_source`에 그 항목을 알아낸 근거를 `packet`/`binary`/`server_query`/`none`으로 적어, B에서 추가된 정보가 어떤 항목을 바꿨는지 보인다.
- 점수는 **절대 개수와 퍼센트를 함께** 보고한다(예: 11/15, 73.3%). 가장 좋은 실행만 고르지 않고 10회 전부와 실패 사례를 유지한다.

### 1.2 E2 · 통신 정확성·견고성

| 유형 | `test_type` | 설명 | 주요 지표 |
| --- | --- | --- | --- |
| 미관찰 입력 | `unseen_input` | 분석에 쓰지 않은 입력으로 실제 서버와 비교 | 응답 정답률, 통신 성공률 |
| 파서 분할·결합 | `parser_chunk` | 1바이트·가변 크기·여러 메시지를 붙인 입력으로 **파서만** 시험 (소켓 없음) | 통과 수 |
| 실제 소켓 통신 | `socket` | 실제 TCP로 서버와 교환 | 통과 수, 오류 유형 |
| 지연·손실 | `delay_loss` | 네트워크 지연·손실 조건에서 실제 통신 | 정상 완료·timeout·연결 실패를 따로 집계 |

`parser_chunk`와 `socket`은 섞지 않는다. send 호출 경계를 수신 메시지 경계로 가정하지 않는다. **네트워크 손실률(`loss_pct`)과 응용 메시지 실패율은 별개의 열로 기록한다.**

### 1.3 E3 · 부하에 따른 성능

낮음·중간·높음 요청률에서 반복 측정한다. 클라이언트와 서버는 다른 호스트에 두고 서버 사양·연결 방식·측정 시간·반복 횟수를 기록한다. 지표는 요청률별 p50/p95 지연, 실제 처리율, 오류율이다. 원본과 복원 클라이언트의 성능 곡선이 비슷해도 기능 동등성을 주장하지 않는다.

## 2. 결과 CSV 형식

파일은 세 가지다. 모든 CSV는 UTF-8(BOM 없음), 첫 줄 헤더, 쉼표 구분, 줄바꿈 CRLF 또는 LF, 시각은 ISO 8601 UTC이다(`Z`와 `+00:00` 모두 UTC로 읽는다. N07은 `2026-11-07T11:48:09.104311+00:00`처럼 마이크로초와 `+00:00`을 붙여 쓴다). 값이 없으면 빈 칸이다(`NA`·`-` 쓰지 않음).

| 파일 | 한 줄의 의미 | 쓰는 실험 | 예시 |
| --- | --- | --- | --- |
| `results.csv` | 케이스 하나의 실행 결과 | E1(채점 항목 제외)·E2, 연습 | [`results-example.csv`](examples/results-example.csv) |
| `checklist-results.csv` | 체크리스트 항목 하나의 채점 | E1 | [`checklist-results-example.csv`](examples/checklist-results-example.csv) |
| `load-summary.csv` | 요청률 한 단계의 반복 하나의 집계 | E3 | [`load-summary-example.csv`](examples/load-summary-example.csv) |

값이 없는 **빈 양식(헤더만)** 은 [`templates/`](templates/)에 있다. 팀 노션에는 이 문서와 빈 양식만 공유하고, 정답이 들어간 자료는 이 저장소 밖 비공개 위치에 둔다.

### 2.1 `results.csv`

N07 평가기(`scripts/n07-evaluate.py`)의 `CSV_FIELDS` 11개 열을 **그대로 뒤쪽에 포함**하는 상위 호환 형식이다. 앞쪽의 조건 열만 추가로 채우면 N07 출력과 같은 의미로 읽힌다.

| 열 | 값 | 설명 |
| --- | --- | --- |
| `run_id` | 문자열 | 한 번의 평가 실행(N07 실행 1회). 같은 실행의 모든 줄이 같은 값. 분석 실행과의 연결은 §2.4 |
| `experiment` | `practice`/`E1`/`E2`/`E3` | 연습 결과는 `practice`이며 본 실험 점수가 아니다 |
| `condition` | `A`/`B`/`original`/`practice` | 분석 조건 또는 원본 클라이언트 기준선 |
| `repeat` | 정수 | 같은 조건의 반복 번호(1~5), 해당 없으면 빈 칸 |
| `client_version` | 문자열 | 평가한 클라이언트. 자동 생성이면 그 클라이언트를 만든 분석 실행의 `analysis_run_id`, 사람이 고친 수정본은 `<analysis_run_id>-m1`, `-m2`…, 원본 클라이언트는 `original` (§2.4) |
| `client_origin` | `auto`/`manual`/`original` | 자동 생성, 사람이 수정, 원본. 수동 수정본은 자동 결과와 따로 집계 |
| `test_type` | 1.2의 값 | `unseen_input`/`parser_chunk`/`socket`/`delay_loss` |
| `net_delay_ms` | 숫자 | 주입한 지연, 없으면 0 |
| `loss_pct` | 숫자 | 주입한 패킷 손실률, 없으면 0 |
| `case_id` ~ `description` | N07과 동일 | `case_id, verdict, expected_text, actual_text, expected_hex, actual_hex, first_diff_offset, server_closed, error, elapsed_ms, description` |
| `started_at` | ISO 8601 | 케이스 시작 시각 |
| `code_commit` | 해시 | 평가기 코드 커밋(dirty면 `-dirty` 접미) |
| `notes` | 문자열 | 수동 개입, 재시도 등 |

`verdict`는 `pass`(바이트 정확히 일치) / `fail`(서버가 닫을 때까지 받았지만 기대와 다름, `first_diff_offset` 기록) / `error`(바이트 비교까지 가지 못함)이다. `elapsed_ms`는 연결 시작부터 서버 종료/수신 완료까지의 시간이다.

**error의 의미.** `error`는 "비교 불가"이지 "환경 문제"와 같은 말이 아니다. `error` 열에는 N07의 `error.type`(`connect_timeout`, `timeout`, `response_too_large`, `ConnectionResetError` 등)을 적는다. 원인은 두 갈래다.

- 환경: 서버 미기동·연결 실패, 네트워크 조건 때문의 리셋·시간 초과.
- 명세: 복원 클라이언트가 틀린 길이·구분자를 보내 서버가 입력을 더 기다리다 `timeout`이 나는 경우, 응답을 끝까지 읽지 못하게 만드는 경우. (연습 예: 개행 없는 `PING`은 서버가 계속 기다려 `timeout`.)

원인을 가르는 규칙: 같은 환경·같은 케이스 순서로 **기준 실행**(원본 클라이언트 또는 정답 케이스)을 함께 돌린다. 기준 실행은 `pass`인데 복원 클라이언트만 `error`면 명세 원인, 기준 실행도 `error`면 환경 원인으로 보고 `notes`에 `cause=spec` 또는 `cause=env`로 적는다. N07은 실행 전체에 같은 `notes`를 쓰므로, `cause=`는 기준 실행과 대조한 뒤 후처리로 해당 `error` 줄에 덧붙인다. 집계는 `pass`/`fail`/`error`를 따로 내고 `error`는 원인별로 다시 나눈다. `fail`과 `error`를 하나의 "실패"로 합치지 않는다.

**텍스트 열(`expected_text`, `actual_text`) 표현.** 판정과 `first_diff_offset`은 **바이트(hex 열) 기준**이며, 텍스트 열은 사람이 읽기 위한 표시다. N07은 바이트를 Latin-1로 읽은 뒤 Python `unicode_escape`로 바꾼다. 출력 가능한 ASCII는 그대로, 개행·CR·탭은 `\n`·`\r`·`\t` 두 글자, 역슬래시는 `\\`, 나머지 바이트는 `\xNN`이다. 그래서 CSV 칸 안에 실제 줄바꿈 문자는 들어가지 않는다(예: `PONG\n`). 이진 프로토콜은 대부분 `\xNN`으로 보이므로 hex 열을 기준으로 읽는다. `first_diff_offset`은 바이트 위치이며 텍스트 열의 글자 위치가 아니다. `error`인 줄도 기대 열은 케이스에서 채우고, 실제 열은 오류 전까지 받은 바이트(없으면 빈 칸)다. `error`인 줄의 `first_diff_offset`은 받다 만 바이트와의 비교라 해석하지 않는다. `server_closed`는 N07 출력 그대로 `True`/`False`다.

### 2.2 `checklist-results.csv`

| 열 | 설명 |
| --- | --- |
| `run_id`, `condition`, `repeat` | 어떤 분석 실행의 채점인지. `run_id` = 채점한 분석 실행의 `analysis_run_id` (§2.4) |
| `item_id` | `K01`~ (본 실험 문항 ID는 N11에서 확정) |
| `result` | `pass`/`fail` |
| `evidence_source` | `packet`/`binary`/`server_query`/`none` |
| `claim_ref` | 분석 결과 JSON에서 해당 주장을 찾을 위치(예: `spec.request.fields[2]`), 주장이 없으면 빈 칸 |
| `intervention` | 사람이 개입했으면 `yes`, 아니면 `no` (개입 내용은 `notes`) |
| `notes` | 실패 이유, 부분 정답 설명 |

집계 시 `run_id`별 `pass` 개수와 전체 문항 수를 함께 낸다.

### 2.3 `load-summary.csv`

| 열 | 설명 |
| --- | --- |
| `run_id`, `condition`, `repeat`, `client_version`, `client_origin` | 어느 클라이언트의 측정인지 |
| `load_level` | `low`/`medium`/`high` |
| `offered_rps` | 시도한 요청률(초당 요청) |
| `completed_rps` | 실제 처리율(성공 응답 기준) |
| `duration_s` | 측정 시간 |
| `requests_sent`, `requests_ok`, `requests_error` | 요청 수 |
| `error_rate` | `requests_error / requests_sent` |
| `p50_ms`, `p95_ms` | 정상 응답 지연 분위수 |
| `server_spec`, `link` | 서버 사양, 클라이언트-서버 연결 방식(다른 호스트 여부 포함) |
| `started_at`, `code_commit`, `notes` | 시각, 코드 커밋, 비고 |

### 2.4 `run_id` 연결 규칙

ID는 세 종류이며 섞지 않는다. 분석 쪽 이름은 N09 결과 JSON(PR #11 기준, 아직 병합 전)을 따른다. 병합 때 이름이 바뀌면 이 절을 함께 고친다. N09 결과 JSON 맨 위의 `run_id`는 `analysis_run_id`와 같은 값이며, 아래의 평가 `run_id`와는 다르다.

| ID | 만드는 곳 | 뜻 | 어디에 적나 |
| --- | --- | --- | --- |
| `preparation_run_id` | N09 입력 준비 | A/B 입력 묶음 1개. 여러 분석 실행이 재사용할 수 있다 | 기록용(분석 결과 JSON 안) |
| `analysis_run_id` | N09 모델 실행 | 분석(모델 호출) 1회 = E1의 반복 1회. 실패한 실행도 ID를 가진다 | `checklist-results.csv`의 `run_id`, `results.csv`·`load-summary.csv`의 `client_version` |
| 평가 `run_id` | N07·E3 측정 | 클라이언트 1개를 평가한 실행 1회 | `results.csv`·`load-summary.csv`의 `run_id` |

- 한 분석 실행에서 나온 클라이언트를 여러 조건(`socket`, `delay_loss`…)으로 평가하면 평가 `run_id`는 여러 개지만 `client_version`은 같은 `analysis_run_id`다. 그래서 E1 점수와 E2/E3 결과는 `analysis_run_id`로 이어 붙인다.
- `condition`은 분석 결과 JSON의 값을 그대로 옮긴다. N09 결과에는 `repeat`가 없으므로, 실행자가 E1 실행 기록(조건별 1~5번과 `analysis_run_id` 대응표)에 적은 번호를 쓴다.
- 분석이 실패해 클라이언트를 만들 수 없으면 E1 행은 남기고(전 문항 `fail`, 실패 단계는 `notes`), E2·E3 행은 만들지 않고 집계표에 "클라이언트 없음" 실행 수를 따로 적는다.
- 평가 `run_id`는 N07 결과 파일 이름과 같게 둔다(덮어쓰기 금지 규칙과 함께 중복 방지).

## 3. 운영 규칙(요약)

1. 연습 결과(`experiment=practice`)는 본 실험 점수에 넣지 않는다.
2. 매 실행의 모든 줄을 보존한다. 실패·수동 개입도 지우지 않는다.
3. 같은 `run_id`의 결과 파일을 덮어쓰지 않는다(N07 평가기와 같은 규칙).
4. 정답을 본 뒤 체크리스트 문항·채점 기준을 바꾸지 않는다. 변경이 필요하면 새 버전으로 구분한다.
5. 그래프에는 원본 CSV, 조건, 실행 스크립트, 그래프 생성 명령을 연결한다.

## 4. 다음 단계와 확인되지 않은 것

- **N07 연결:** 현재 `scripts/n07-evaluate.py`(PR #2)는 `results.csv`의 N07 11개 열만 출력한다. 조건 열을 채워 쓰도록 하는 확장은 N11에서 한다. 이 PR은 평가기를 수정하지 않는다.
- **체크리스트 문항:** 위 K01~K15는 일반 틀이다. 실제 문항·개수는 N10 자료가 확정된 뒤 N11에서 정하고, 사전 고정 시점을 기록한다.
- **E3 지표 정의:** `completed_rps`와 p50/p95의 계산 대상(정상 응답만)은 이 초안의 제안이며 N19 설계 때 팀과 확정한다.
- 예시 CSV는 형식 확인용으로 만들었고, 실제 측정은 하지 않았다.
