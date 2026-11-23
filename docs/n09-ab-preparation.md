# N09: GLM 없이 A/B 입력·출력 준비

담당 정의종. A=패킷만, B=같은 패킷+선택 바이너리의 REA/Ghidra 근거.
현재 구현 범위는 **입력 준비와 명시적인 모의 출력**이다. 모델 API는 호출하지 않는다.
수업 GLM은 2026-11-13 사용자 전달 기준 다음 주 수령 예정이며, 정확한 배포일·모델 ID는 미확정이다.

## 실행

저장소 루트, Docker Desktop Linux 엔진과 기존 N05 이미지가 필요하다.
N05 이미지는 tcpdump를 포함하도록 다시 빌드한다: `docker compose -f compose.n05.yaml build n05`.
원본 결과는 Git 제외 `runs/n09/`에 매번 새 이름으로 남긴다. Node 내장 모듈만 사용한다.

```powershell
New-Item -ItemType Directory -Force runs/n09 | Out-Null
$runTag = Get-Date -Format 'yyyyMMdd-HHmmss'
node --test scripts/rea-smoke.test.mjs scripts/n09-contract.test.mjs scripts/n09-prepare.test.mjs
docker compose -f compose.n05.yaml run --rm n05 node scripts/n09-prepare.mjs --condition A --pcap practice/n06/normal-sessions.pcap --out "runs/n09/A-$runTag.json"
docker compose -f compose.n05.yaml run --rm n05 node scripts/n09-prepare.mjs --condition B --pcap practice/n06/normal-sessions.pcap --binary runs/n06/practice-server --out "runs/n09/B-$runTag.json"
```

B에 필요한 연습 서버가 없으면 먼저 빌드한다.

```powershell
New-Item -ItemType Directory -Force runs/n06 | Out-Null
docker compose -f compose.n05.yaml run --rm n05 gcc -O0 -fno-inline -Wall -Wextra -o runs/n06/practice-server practice/n06/server.c
```

`--execution mock`을 붙이면 같은 준비 과정을 실행한 뒤 **빈 spec의 모의 결과**를 추가한다.
모의 모드도 A에서 tcpdump, B에서 tcpdump와 REA가 설치돼 있어야 한다.
설치 없이 검증하는 것은 위의 Node 모의 테스트다.
`--experiment E1`은 대상 구분용이고 점수를 만들지 않는다.
본 실험 입력은 N10 PR #7의 버전을 확정한 후에만 교체하며, 여기서는 분석하지 않았다.

기대 결과: `success:true`는 준비 절차 성공이다.
항상 `model_called:false`, `experiment_score:false`, `n09_complete:false`다.
실제 수업 모델 연결과 출력 검증 전에는 N05/N09 전체 완료로 표시하지 않는다.

## A/B 차단과 공통 규격

- A는 `--binary`를 받으면 **파일을 읽거나 결과를 만들기 전에** 거부한다. REA도 호출하지 않는다.
- B는 명시적으로 선택한 바이너리만 N05의 `rea-only`로 분석한다. doctor, Ghidra Evidence 형식, 입력 SHA-256 대조는 기존 N05 로직을 재사용한다.
- 양쪽에 같은 PCAP와 같은 tcpdump 옵션을 쓴다. 모델에 공급할 패킷 근거 상한은 각각 65,536바이트다. B의 추가 REA 근거는 24,576바이트이며 잘림 여부와 원본 해시를 남긴다.
- 시스템 프롬프트와 **예정 모델 예산**은 같다: 최대 모델 호출 2회, 호출당 출력 4,096토큰, 호출당 120초, 서버 질의 0회. 현재 모델 호출은 0회다. 실제 제공사 지원과 비용을 확인한 뒤 본 실험 전에 버전을 고정한다.
- README·소스·정답·숨은 평가 입력을 자동 탐색하거나 첨부하지 않는다. REA 원문 안의 경로나 문자열 자체는 B의 바이너리 근거에 포함될 수 있다.
- `request.json`은 오프라인 템플릿이다. 모델 ID·endpoint·제공사별 토큰 매개변수가 없는 상태이며 API에 그대로 보내는 파일이 아니다.
- 같은 PCAP 해시·프롬프트 해시·예산인지 확인해야 한 쌍으로 비교할 수 있다. B에 증거가 추가되므로 입력 토큰 수까지 같다는 의미는 아니다.

준비 결과의 공통 필드:
`schema_version, task, run_id, condition, execution, experiment, classification, input, budget, usage, runtime, stages, evidence, spec, observations, unknowns, verification`.
실행마다 코드 커밋·dirty, 입력 해시, 명령·시각·성공/실패 단계와 원문 파일 경로가 남는다.
실패나 기존 결과를 덮어쓰지 않는다.

## N12 인계

`request.json`의 증거 ID는 `packet-1`, B 추가 증거는 `binary-1`이다.
향후 모델 출력은 다음 공통 외피로 받는다.

```json
{
  "spec": {},
  "observations": [
    { "claim": "한 가지 관찰 또는 가설", "evidence_id": "packet-1", "quote": "공급 근거에 실제로 존재하는 12자 이상의 원문" }
  ],
  "unknowns": ["확인되지 않은 필드나 상태 규칙"]
}
```

`validateOutput`은 필수 형식과 해당 증거에 인용문이 존재하는지만 검사한다.
인용문이 주장을 의미상 뒷받침하는지, 명세가 정답인지는 별도 검토·N11 채점이 필요하다.
준비 결과 `spec:null`과 모의 결과 `spec:{}`는 실행 가능한 복원 명세가 아니다.
N08의 사람이 옮긴 N06 명세와 이 외피를 자동으로 호환된다고 가정하지 않는다.
현석은 N12에서 명세 버전·필수 필드·unknown 처리 규칙을 맞춘 뒤 실행해야 한다.

## 한계와 후속 검증

tcpdump의 패킷별 hex는 TCP 스트림 재조립 결과가 아니다. 재전송·중복·캡처 누락을 구분해야 한다.
REA의 `binary_overview`는 전체 역공학이 아니다. 실제 프로토콜 복원에는 함수 검색·디컴파일 등 추가 도구가 필요할 수 있다.
이 도구 선택·호출 예산은 GLM 연동 후 N09/N13에서 별도로 검증한다.
본 실험 A/B 5회씩의 점수, 클라이언트 자동 생성, 부하 측정은 아직 수행하지 않았다.

본인 확인: 의종이 위 명령으로 A/B 실제 준비 결과와 해시를 확인한 뒤 `docs/ai-usage.md`를 갱신한다.

## 이번 실행과 직접 확인

[2026-11-13 증거](evidence/N09-2026-11-13.md)와 [최종 CI](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/actions/runs/43405177497)에 실제 A/B·REA, 회귀와 TCP 실행 결과를 남겼다.
N05 이미지에 tcpdump를 추가했으므로 기존 이미지가 있어도 `docker compose -f compose.n05.yaml build n05`로 재빌드한다.

저장소의 모든 변경을 커밋한 상태에서 아래를 실행하면 실제 A/B 쌍을 같은 컨테이너에서 확인할 수 있다.
공개 연습 서버를 빌드하며 본 실험 입력은 쓰지 않는다. 각 실행은 새 태그를 사용한다.

```powershell
New-Item -ItemType Directory -Force runs/n09 | Out-Null
$runTag = Get-Date -Format 'yyyyMMdd-HHmmss'
$pairCommands = @'
git config --global --add safe.directory /work
gcc -O0 -fno-inline -Wall -Wextra -o runs/n09/practice-server practice/n06/server.c
node scripts/n09-prepare.mjs --condition A --pcap practice/n06/normal-sessions.pcap --out "runs/n09/A-$1.json"
node scripts/n09-prepare.mjs --condition B --pcap practice/n06/normal-sessions.pcap --binary runs/n09/practice-server --out "runs/n09/B-$1.json"
node scripts/n09-check-pair.mjs "runs/n09/A-$1.json" "runs/n09/B-$1.json" "runs/n09/pair-$1.json"
'@
docker compose -f compose.n05.yaml run --rm n05 bash -euo pipefail -c $pairCommands n09 $runTag
```

기대 결과는 A/B `success:true`와 `N09_PAIR_SUMMARY`의 모든 checks가 true인 것이다.
모델 호출0회·실험점수false·semantic_review/human_execution_check pending은 유지된다.
사람이 실행·코드·근거를 확인한 기록은 AI 사용 기록 마지막 칸에 별도로 남긴다.
