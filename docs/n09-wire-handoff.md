# N05/N09 Gemini 실행과 N12 인계

담당 정의종. Gemini는 사용자가 선택한 공개 연습용 모델이며 수업 지정 모델 확인과 구분한다.
이 작업은 PR #11의 단일 모델 실행기를 재사용한다. 본 실험의 정답·소스·숨은 입력은 모델에 제공하지 않는다.

## 재실행

Node 24, Docker Desktop Linux 엔진, 기존 N05 이미지를 사용한다.
키는 Git 제외 `.env.gemini`에 `GEMINI_API_KEY=...`로 저장한다. 명령 인자·문서·출력에 키를 넣지 않는다.

```powershell
docker compose -f compose.n05.yaml build n05
node --env-file=.env.gemini scripts/gemini-pilot.mjs --execution dry-run
node --env-file=.env.gemini scripts/gemini-pilot.mjs --execution live
```

기본값은 dry-run이며 생성 요청은 0회다. `--phase smoke`는 N05 모델 도구 호출→REA→모델 요약만,
`--phase recover`는 N09 A/B→참조 클라이언트 평가만 실행한다. 생략하면 두 단계를 순서대로 실행한다.
모델 기본값은 `gemini-3.5-flash-lite`이고 `GEMINI_MODEL`로 명시 변경할 수 있다. 모델을 바꾼 시행은 별도 결과로 기록한다.
미커밋 변경이 있는 **로컬 공개 연습**에만 `--allow-dirty`를 추가한다.
기준 실행은 코드·문서를 커밋한 상태로 수행한다. 실제 소스 파일 해시도 별도 저장한다.

각 실행은 `runs/gemini/<UTC-태그>/`에 새 결과를 만든다. 예전 `runs/gemini/run-pilot.mjs`는
이 PC에서만 쓰던 보조 파일이며, 팀원은 위의 버전 관리되는 `scripts/gemini-pilot.mjs`를 사용한다.

## 모델 호출과 입력 경계

- N05: 최대 2회, 호출당 출력4096, 실제 도구 호출ID와 제공사 부가 필드 유지, 원문·토큰 보존.
- N09: A/B 각각 1회, 출력4096, 120초 제한, 자동 재시도0, 분석 중 서버 질의0.
- A는 공개 PCAP만, B는 같은 PCAP+선택 바이너리의 REA/Ghidra 근거를 받는다. 최신 pilot의 B 근거 범위는 아래 프로필로 고정한다.
- 새 pilot은 `tcp-streams-v1` 전처리를 양쪽에 동일하게 적용한다. TCP seq 기준으로 방향별 페이로드를 재조립하고 재전송 중복·누락·충돌을 표시한다. 스트림 전체를 한 응용 메시지라고 단정하지 않는다. 기존 tcpdump 원문도 보존한다. 이 전처리는 기존 raw-dump pilot과 다른 버전이다.
- 공통 프롬프트는 여러 세션에서 응용 필드·길이·엔디안·의미를 추론하도록 요구한다. 정답 상수·필드 크기·연산은 프롬프트에 하드코딩하지 않는다.
- 최신 B pilot은 REA 개요에 더해 `named-procedure-v1`을 사용한다. 고정 정규식으로 함수 인벤토리를 1회 검색하고, 실제 관찰된 비외부 함수 중 최대1개를 1회 디컴파일한다(추가 REA 명령 최대2회). 프로토콜 처리 이름을 우선하고 없으면 main 등을 선택한다. 심볼이 없는 바이너리에서는 대상이 없을 수 있다. A에는 이 근거가 제공되지 않는다. 정답 소스를 열거나 모델이 임의 파일/명령을 지정하는 기능이 아니다.
- 개요·검색·의사코드 원본은 각각 보존한다. 모델에는 원본에서 추출한 정규화 결과와 해시를 묶어 제공하고, 호출 전에 원본/투영/선택 바이너리의 일치를 다시 검증한다. 기존 개요만 공급한 pilot과 다른 도구 프로필이다.
- 원문에 연속해서 존재하지 않는 인용문, 빈 spec, 잘린 응답은 실패로 보존한다.
- 모델에는 공급 원문에서 기계적으로 추출한 짧은 인용 후보도 제공한다. 후보는 원문 substring 대조를 통과한 것만 포함하고 원래 evidence_id를 유지한다. 정답을 추가하거나 반환 인용문을 사후 교정하지 않는다. REA 내부 ev_* ID와 외피의 packet-1/binary-1 ID를 구분하도록 지시한다.
- 한 정상 메시지 유형의 고정 제어 바이트와 가변 응용 인자를 구분하고, 공급 스트림의 모든 바이트를 후보 레이아웃으로 대조하도록 지시한다. 구체 상수·정답 필드는 지침에 추가하지 않는다.

2026-11-17 마지막 공개 pilot에서 실제 A/B 후보를 수정 없이 참조 클라이언트로 실행해 각각15/15를 확인했다(총13,444토큰). 전체 개발 실패와 범위·한계는 [실행 증거](evidence/N05-N09-Gemini-integration-2026-11-17.md)에 기록했다. 정상 프레임 통과가 전체 의미 복원·N11 채점·N12 웹 완료를 뜻하지 않는다.

## 실행 가능한 명세 제안: wire-spec-v1

`spec.format="wire-spec-v1"`, `spec.transport="tcp"`, `request.fields[]`, `response.fields[]`를 사용한다.
현재 참조 클라이언트는 한 종류의 요청/정상 응답을 지원한다. 다른 명령·오류·세션 상태는
`semantics`와 외피의 `unknowns`에 남긴다. 이는 팀원 합의 전의 **버전 명시 인계 규격**이며 N12 웹 통합 완료를 뜻하지 않는다.

| 필드 type | 필수 속성 | 동작 |
| --- | --- | --- |
| const | name, hex | 추론된 고정 바이트 |
| uint | name, bytes, endian | 이름으로 주어진 부호 없는 정수. 폭1/2/4, big 또는 little |
| length | name, bytes, endian, of | 뒤쪽 한 필드의 바이트 수를 인코더가 계산 |
| uint_array | name, bytes, endian | 마지막 필드의 정수 배열. 앞쪽 length가 이 필드를 참조 |
| bytes | name | 마지막 필드의 hex 입력. 앞쪽 length가 이 필드를 참조 |

지원되지 않는 속성·폭·unknown·빈 spec은 실행을 거부한다. 모델이 생성한 코드를 실행하지 않는다.
`wire-spec.mjs`가 선언형 필드만으로 요청/응답 바이트를 만들고 분할·결합 버퍼를 해석한다.

## 참조 통신 평가의 의미

`n12-practice-bridge.mjs`는 실제 모델 결과의 필드 정의와 이름만으로 요청·예상 응답 프레임을 만든다.
별도 공개 정답 파일 `practice/n06/client-vectors.json`의 새 입력5개와 독립 기대값을 사용한다.
이 파일은 **모델 호출 이후 평가 단계에서만 읽으며 모델 입력에 포함하지 않는다**.
각 입력을 한 번에 전송/바이트별 분할/3바이트 뒤 분할하여 총15개 통신 케이스를 N07로 평가한다.
기대값과 다른 프레임은 실패이며 실제 응답을 복원 명세로 디코드한 결과도 보존한다.

```powershell
docker compose -f compose.n05.yaml run --rm n05 node scripts/n12-practice-bridge.mjs --analysis runs/gemini/태그/A-analysis.json --binary runs/gemini/태그/practice-server --out runs/gemini/태그/A-new-client.json
```

이 평가는 공개 연습의 정상 명령과 선택 입력에 대한 연결 증거다. N11 비공개 정답 채점,
오류 규칙 전체, 실제 TCP 분할 보장, 부하 성능, 본 실험 기능 동등성을 입증하지 않는다.
전송 write 분할과 실제 TCP 세그먼트 분할도 구분한다.

## 검증과 인계

공개 연습 실행기는 조건별 첫 시도에 `repeat: 1`을 기록한다. N09 단독 실행에서 계획한 조건과 반복 번호를 지정할 때는 기존 명령에 `--condition A --repeat 1`을 추가한다. 준비 파일을 읽거나 검증하는 단계에서 실패해도 지정한 조건과 번호가 해당 분석 ID에 남는다.

분석이 실패하면 `A-analysis.json` 또는 `B-analysis.json`의 ID·조건·반복 번호·오류를 같은 조건의 `*-client.json`과 `summary.json`에서 확인한다. 이때 클라이언트 결과는 `success: false`, `evaluation_status: "not_run"`이고 TCP 평가 파일은 생성되지 않는다. N09와 N12 행은 같은 시도의 두 단계이므로 분석 시도 수는 고유한 `analysis_run_id`로 센다. 기존 기록에 반복 번호가 없으면 `null`로 남는다.

```powershell
node --test scripts/rea-smoke.test.mjs scripts/rea-detail.test.mjs scripts/n09-contract.test.mjs scripts/n09-prepare.test.mjs scripts/n09-live.test.mjs scripts/n09-check-pair.test.mjs scripts/wire-spec.test.mjs
python -m unittest discover -s scripts -p 'test_*.py'
```

유현석은 이 외피·실행 규격을 검토하고 #9 웹에 N12를 연결한다. 권세현은 analysis_run_id→평가ID 매핑과
정상/실패/오류 집계를 검토하고 N11을 비공개로 고정한다. 김태형은 본 실험 입력 버전·기동과 정답 전달을 확인한다.
N05/N09 완료의 본인 확인, 수업 모델 확인, 팀원 리뷰는 AI 실행 성공과 별도로 기록한다.
