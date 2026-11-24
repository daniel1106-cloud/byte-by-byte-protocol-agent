// N04·N08 화면. 서버가 준 문자열은 모두 textContent로 넣는다(HTML로 해석하지 않는다).
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  let body = {};
  try { body = await response.json(); } catch { /* JSON이 아닌 응답 */ }
  return { status: response.status, body };
}
const post = (path, payload) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

let spec = null;

// ---------------------------------------------------------------- 서버 상태
async function refreshStatus() {
  const { body } = await api("/api/health");
  const box = $("server-status");
  const server = body.server ?? {};
  box.replaceChildren();
  if (server.state === "running") {
    box.className = "status ok";
    box.append(
      el("strong", { text: "연습 서버: 실행 중" }),
      document.createTextNode(` · ${server.host}:${server.port} (컨테이너 안에서만 접속 가능) · pid ${server.pid}`),
      document.createTextNode(` · 바이너리 ${server.binary} sha256 ${String(server.sha256).slice(0, 12)}…`),
    );
  } else {
    box.className = "status bad";
    box.append(el("strong", { text: `연습 서버: ${server.state ?? "알 수 없음"}` }), document.createTextNode(` · ${server.message ?? ""}`));
  }
}

// ---------------------------------------------------------------- 바이트 표시
function fieldClass(name) {
  if (["magic", "version", "type", "length"].includes(name)) return `f-${name}`;
  return "f-payload";
}
function renderBytes(container, fields, fallbackHex) {
  container.replaceChildren();
  if (!fields?.length) {
    container.append(el("span", { class: "muted", text: fallbackHex ? fallbackHex.match(/../g).join(" ") : "(받은 바이트 없음)" }));
    return;
  }
  for (const field of fields) {
    const meaning = field.meaning ? ` (${field.meaning})` : "";
    container.append(el("span", { class: `byte ${fieldClass(field.name)}`, title: `${field.name} = ${field.value}${meaning}`, text: field.hex.match(/../g).join(" ") }));
  }
}
function fact(list, label, value) {
  list.append(el("dt", { text: label }), el("dd", { text: String(value) }));
}

// ---------------------------------------------------------------- 1. 명령 보내기
function parseNumbers(text) {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { error: "숫자를 1개 이상 입력하세요." };
  if (parts.length > 32) return { error: `숫자는 최대 32개입니다 (입력: ${parts.length}개).` };
  const numbers = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { error: `"${part}"은(는) 0 이상의 정수가 아닙니다.` };
    const value = Number(part);
    if (value > 65535) return { error: `${part}은(는) 65535보다 큽니다.` };
    numbers.push(value);
  }
  return { numbers };
}

function showResult(result, server) {
  $("result").hidden = false;
  const kind = result.ok ? "ok" : result.outcome === "error_frame" ? "warn" : "bad";
  $("outcome").replaceChildren(el("span", { class: `pill ${kind}`, text: result.outcome_text }));

  const decoded = result.response.decoded;
  let headline = result.violation ?? result.error_message ?? result.outcome_text;
  if (decoded?.message === "SUM_RESPONSE") headline = `합계 = ${decoded.values.sum}`;
  else if (decoded?.message === "ERROR") headline = `오류 코드 ${decoded.values.code} — ${decoded.meanings.code ?? "명세에 없는 코드"}`;
  else if (decoded) headline = decoded.text;
  $("interpretation").textContent = headline;

  const facts = $("facts");
  facts.replaceChildren();
  fact(facts, "접속 대상", `${result.connection.host}:${result.connection.port} (서버에 고정)`);
  fact(facts, "연결", result.connection.connected ? "연결됨" : `연결 실패${result.connection.error_code ? ` (${result.connection.error_code})` : ""}`);
  fact(facts, "서버가 연결을 닫음", result.connection.closed_by_server === null ? "해당 없음" : result.connection.closed_by_server ? "예 (EOF 확인)" : "아니오 (제한 시간 안에 닫지 않음)");
  fact(facts, "받은 바이트", result.response.bytes_received);
  fact(facts, "소요 시간", `${result.elapsed_ms} ms`);
  fact(facts, "서버 바이너리", `${server.binary} · sha256 ${String(server.sha256).slice(0, 12)}…`);

  renderBytes($("request-bytes"), result.request.fields, result.request.hex);
  renderBytes($("response-bytes"), decoded?.fields, result.response.hex);

  const example = spec.examples.find((item) => item.request_hex === result.request.hex);
  const check = $("example-check");
  if (!example) {
    check.className = "hint";
    check.textContent = "이 입력은 README 예시 표에 없습니다.";
  } else if (result.response.frame_hex === example.response_hex) {
    check.className = "hint";
    check.textContent = `README 예시의 기대 응답(${example.response_hex})과 일치합니다.`;
  } else {
    check.className = "hint bad";
    check.textContent = `README 예시의 기대 응답은 ${example.response_hex}인데 실제로는 ${(result.response.frame_hex ?? result.response.hex) || "(없음)"}입니다.`;
  }
  $("notes").replaceChildren(...result.notes.map((note) => el("li", { text: note })));
}

$("send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const hint = $("input-error");
  const parsed = parseNumbers($("numbers").value);
  if (parsed.error) { hint.hidden = false; hint.className = "hint bad"; hint.textContent = parsed.error; $("result").hidden = true; return; }
  hint.hidden = true;
  const button = $("send-button");
  button.disabled = true;
  try {
    const { status, body } = await post("/api/send", { numbers: parsed.numbers });
    if (status === 200) showResult(body.result, body.server);
    else { hint.hidden = false; hint.className = "hint bad"; hint.textContent = `${body.message ?? "요청 실패"} (HTTP ${status})`; $("result").hidden = true; }
  } catch (error) {
    hint.hidden = false; hint.className = "hint bad"; hint.textContent = `백엔드에 연결하지 못했습니다: ${error.message}`;
  } finally {
    button.disabled = false;
    refreshStatus();
  }
});

// ---------------------------------------------------------------- 2. N07 평가
function pill(verdict) {
  return el("span", { class: `pill ${verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "error"}`, text: verdict });
}

function showEvaluation(evaluation) {
  $("eval-result").hidden = false;
  const result = evaluation.result;
  const banner = $("eval-banner");
  if (result && result.experiment_score !== false) {
    banner.className = "banner alert";
    banner.textContent = `평가 JSON의 experiment_score가 ${result.experiment_score}입니다. 연습 평가라면 false여야 합니다. 확인 필요.`;
  } else {
    banner.className = "banner";
    banner.textContent = "연습 결과, 본 실험 점수 아님 (experiment_score: false · 공개 연습 명세 N06)";
  }

  const chips = $("eval-summary");
  chips.replaceChildren();
  const statusKind = evaluation.status === "all_pass" ? "pass" : evaluation.status === "completed_with_mismatch" ? "warn" : "bad";
  chips.append(el("span", { class: `pill ${statusKind}`, text: evaluation.status_text }));
  if (result?.summary) {
    const s = result.summary;
    for (const [label, value] of [["총", s.total], ["통과", s.pass], ["실패", s.fail], ["오류", s.error], ["pass_rate", s.pass_rate], ["all_pass", s.all_pass]]) {
      chips.append(el("span", { class: "chip static", text: `${label}: ${value}` }));
    }
  }

  const facts = $("eval-facts");
  facts.replaceChildren();
  fact(facts, "대상 서버", `${evaluation.target} · ${evaluation.server.binary} · sha256 ${String(evaluation.server.sha256).slice(0, 12)}…`);
  fact(facts, "종료 코드", `${evaluation.exit_code}${evaluation.signal ? ` (signal ${evaluation.signal})` : ""}`);
  fact(facts, "소요 시간", `${evaluation.duration_ms} ms`);
  fact(facts, "결과 JSON (백엔드 컨테이너 안)", evaluation.out_file);
  if (result) {
    fact(facts, "task / stage / success", `${result.task} / ${result.stage} / ${result.success}`);
    fact(facts, "started_at → finished_at", `${result.started_at} → ${result.finished_at}`);
  }
  if (evaluation.error_message) fact(facts, "실패 사유", evaluation.error_message);
  if (evaluation.stderr_tail) fact(facts, "stderr 끝부분", evaluation.stderr_tail);

  renderEvaluationRows(result?.results ?? []);
}

function renderEvaluationRows(rows) {
  const onlyBad = $("only-bad").checked;
  const body = $("eval-table").querySelector("tbody");
  body.replaceChildren();
  for (const row of rows) {
    if (onlyBad && row.verdict === "pass") continue;
    body.append(el("tr", {},
      el("td", { title: row.description ?? "", text: row.case_id }),
      el("td", {}, pill(row.verdict)),
      el("td", { text: row.elapsed_ms }),
      el("td", { class: "hex", text: row.expected_hex === "" ? "(응답 없음)" : row.expected_hex }),
      el("td", { class: "hex", text: row.actual_hex === "" ? "(응답 없음)" : row.actual_hex }),
      el("td", { text: row.first_diff_offset ?? "" }),
      el("td", { text: row.error ? `${row.error.type}: ${row.error.message}` : "" }),
    ));
  }
}

let lastRows = [];
$("only-bad").addEventListener("change", () => renderEvaluationRows(lastRows));

$("eval-button").addEventListener("click", async () => {
  const button = $("eval-button");
  button.disabled = true;
  $("eval-progress").textContent = "평가 중… (케이스마다 서버 응답을 기다립니다)";
  try {
    const { status, body } = await post("/api/evaluate", {});
    if (status === 200) { lastRows = body.evaluation.result?.results ?? []; showEvaluation(body.evaluation); $("eval-progress").textContent = ""; }
    else $("eval-progress").textContent = `${body.message ?? "평가 요청 실패"} (HTTP ${status})`;
  } catch (error) {
    $("eval-progress").textContent = `백엔드에 연결하지 못했습니다: ${error.message}`;
  } finally {
    button.disabled = false;
    refreshStatus();
  }
});

// ---------------------------------------------------------------- 3. 복원 명세 (N12)
const n12 = { analyses: [], selected: null, latest: {} };

function selectedAnalysis() {
  return n12.analyses.find((a) => a.id === n12.selected) ?? null;
}

function renderN12List() {
  const list = $("n12-list");
  list.replaceChildren();
  $("n12-empty").hidden = n12.analyses.length > 0;
  for (const analysis of n12.analyses) {
    const label = `${analysis.condition ?? "?"} · ${analysis.analysis_run_id ? analysis.analysis_run_id.slice(0, 8) : analysis.id}${analysis.repeat ? ` · 회차 ${analysis.repeat}` : ""}${analysis.runnable ? "" : " · 실행 불가"}`;
    const chip = el("button", {
      type: "button", role: "radio", class: `chip${analysis.runnable ? "" : " blocked"}`,
      "aria-checked": String(analysis.id === n12.selected), title: analysis.file, text: label,
    });
    chip.addEventListener("click", () => { n12.selected = analysis.id; renderN12List(); renderN12Detail(); });
    list.append(chip);
  }
}

function renderN12Detail() {
  const analysis = selectedAnalysis();
  $("n12-detail").hidden = !analysis;
  if (!analysis) return;
  $("n12-result").hidden = true;

  const meta = $("n12-meta");
  meta.replaceChildren();
  fact(meta, "조건", analysis.condition === "A" ? "A · 패킷만" : analysis.condition === "B" ? "B · 패킷 + 바이너리(REA)" : "알 수 없음");
  fact(meta, "analysis_run_id", analysis.analysis_run_id ?? "없음");
  fact(meta, "preparation_run_id", analysis.preparation_run_id ?? "없음");
  fact(meta, "회차(repeat)", analysis.repeat ?? "기록 없음");
  fact(meta, "모델", `${analysis.model ?? "알 수 없음"} · backend ${analysis.execution_backend ?? "?"} · model_called ${analysis.model_called}`);
  fact(meta, "experiment_score", String(analysis.experiment_score));
  fact(meta, "명세 sha256", analysis.spec_sha256 ?? "없음");
  fact(meta, "분석 파일", `${analysis.file} · sha256 ${String(analysis.file_sha256).slice(0, 12)}…`);
  if (analysis.fixture) fact(meta, "출처", `${analysis.fixture.source_file} → ${analysis.fixture.json_path} (수정 없이 복사)`);

  const problems = $("n12-problems");
  problems.hidden = analysis.problems.length === 0;
  problems.replaceChildren(...analysis.problems.map((p) => el("li", { text: p })));

  const body = $("n12-fields").querySelector("tbody");
  body.replaceChildren();
  for (const direction of ["request", "response"]) {
    for (const field of analysis.spec?.[direction]?.fields ?? []) {
      body.append(el("tr", {},
        el("td", { text: direction === "request" ? "요청" : "응답" }),
        el("td", { text: field.name }),
        el("td", { text: field.type }),
        el("td", { text: field.bytes ?? (field.hex ? field.hex.length / 2 : "가변") }),
        el("td", { text: field.endian ?? "" }),
        el("td", { class: "hex", text: field.hex ?? (field.of ? `→ ${field.of}` : "") }),
      ));
    }
  }
  $("n12-semantics").textContent = analysis.semantics ?? "(없음)";
  $("n12-unknowns").replaceChildren(...(analysis.unknowns.length ? analysis.unknowns : ["(없음)"]).map((u) => el("li", { text: u })));
  $("n12-observations").replaceChildren(...analysis.observations.map((o) => el("li", {},
    document.createTextNode(`${o.claim} `), el("span", { class: "muted", text: `[${o.evidence_id}] ` }), el("code", { text: o.quote }))));

  const runnable = analysis.runnable;
  $("n12-send").disabled = !runnable;
  $("n12-eval").disabled = !runnable;
  if (analysis.shape) {
    const input = analysis.shape.input;
    $("n12-label").textContent = `입력 필드 "${input.name}" (정수 배열, 각 0~${input.max_value}, ${input.bytes}바이트 ${input.endian})`;
    $("n12-limit").textContent = `복원 명세에는 숫자 개수 상한이 없습니다. 프레임 바이트 한도로 최대 ${input.max_items}개까지 보낼 수 있지만, 서버가 거절할 수 있습니다(그 경우 "복원 명세 밖 응답"으로 표시).`;
  } else {
    $("n12-label").textContent = "입력 숫자";
    $("n12-limit").textContent = "이 분석은 실행할 수 없습니다.";
  }
  const latest = n12.latest[analysis.id];
  if (latest) showN12Evaluation(latest);
  else $("n12-eval-result").hidden = true;
}

function renderTypedBytes(container, fields, rawHex) {
  container.replaceChildren();
  if (fields?.length) {
    for (const field of fields) {
      const value = Array.isArray(field.value) ? `[${field.value.join(", ")}]` : field.value;
      container.append(el("span", { class: `byte t-${field.type}`, title: `${field.name} (${field.type}) = ${value}`, text: field.hex ? field.hex.match(/../g).join(" ") : "(0바이트)" }));
    }
    return;
  }
  container.append(el("span", { class: rawHex ? "byte t-raw" : "muted", text: rawHex ? rawHex.match(/../g).join(" ") : "(받은 바이트 없음)" }));
}

function showN12Result(result) {
  $("n12-result").hidden = false;
  const kind = result.ok ? "ok" : result.outcome === "outside_spec" ? "warn" : "bad";
  $("n12-outcome").replaceChildren(el("span", { class: `pill ${kind}`, text: result.outcome_text }));
  const analysis = selectedAnalysis();
  const output = analysis?.shape?.output?.name;
  let headline = result.error_message ?? result.outcome_text;
  if (result.ok && result.response.values && output in result.response.values) headline = `${output} = ${result.response.values[output]}`;
  else if (result.outcome === "outside_spec") headline = "복원 명세 밖 응답";
  $("n12-headline").textContent = headline;

  const facts = $("n12-facts");
  facts.replaceChildren();
  fact(facts, "분석", `${result.analysis.condition ?? "?"} · ${result.analysis.analysis_run_id ?? result.analysis.id}`);
  fact(facts, "접속 대상", `${result.connection.host}:${result.connection.port} (서버에 고정)`);
  fact(facts, "서버가 연결을 닫음", result.connection.closed_by_server === null ? "해당 없음" : result.connection.closed_by_server ? "예 (EOF 확인)" : "아니오");
  fact(facts, "받은 바이트", result.response.bytes_received);
  fact(facts, "소요 시간", `${result.elapsed_ms} ms`);

  renderTypedBytes($("n12-request-bytes"), result.request.fields, result.request.hex);
  renderTypedBytes($("n12-response-bytes"), result.response.fields, result.response.hex);

  const outside = $("n12-outside");
  outside.hidden = result.outcome !== "outside_spec";
  if (result.outside_spec) {
    $("n12-outside-reason").textContent = `디코더 메시지: ${result.outside_spec.reason}`;
    $("n12-outside-unknowns").replaceChildren(...(result.outside_spec.unknowns.length ? result.outside_spec.unknowns : ["(없음)"]).map((u) => el("li", { text: u })));
  }
  $("n12-notes").replaceChildren(...result.notes.map((note) => el("li", { text: note })));
}

$("n12-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const analysis = selectedAnalysis();
  const hint = $("n12-error");
  const show = (text) => { hint.hidden = false; hint.className = "hint bad"; hint.textContent = text; };
  if (!analysis?.shape) return;
  const parts = $("n12-numbers").value.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) { show("0 이상의 정수를 공백이나 쉼표로 구분해 1개 이상 입력하세요."); return; }
  const numbers = parts.map(Number);
  hint.hidden = true;
  const button = $("n12-send");
  button.disabled = true;
  try {
    const { status, body } = await post("/api/n12/send", { analysis_id: analysis.id, numbers });
    if (status === 200) showN12Result(body.result);
    else { show(`${body.message ?? "요청 실패"} (HTTP ${status})`); $("n12-result").hidden = true; }
  } catch (error) {
    show(`백엔드에 연결하지 못했습니다: ${error.message}`);
  } finally {
    button.disabled = !analysis.runnable;
    refreshStatus();
  }
});

function showN12Evaluation(evaluation) {
  $("n12-eval-result").hidden = false;
  const chips = $("n12-eval-summary");
  chips.replaceChildren();
  const statusKind = evaluation.status === "all_pass" ? "pass" : evaluation.status === "completed_with_mismatch" ? "warn" : "bad";
  chips.append(el("span", { class: `pill ${statusKind}`, text: evaluation.status_text }));
  const result = evaluation.result;
  if (result?.summary) {
    const s = result.summary;
    for (const [label, value] of [["총", s.total], ["통과", s.pass], ["실패", s.fail], ["오류", s.error], ["all_pass", s.all_pass]]) {
      chips.append(el("span", { class: "chip static", text: `${label}: ${value}` }));
    }
  }
  chips.append(el("span", { class: `pill ${evaluation.n12.all_decoded ? "pass" : "warn"}`, text: evaluation.n12.all_decoded ? "실제 응답 전부 복원 명세로 해석됨" : "복원 명세로 해석 안 된 응답 있음" }));

  const facts = $("n12-eval-facts");
  facts.replaceChildren();
  fact(facts, "분석", `${evaluation.n12.condition ?? "?"} · ${evaluation.n12.analysis_run_id ?? evaluation.n12.analysis_id} · 명세 sha256 ${String(evaluation.n12.spec_sha256).slice(0, 12)}…`);
  fact(facts, "오라클", `${evaluation.n12.oracle_file} · sha256 ${String(evaluation.n12.oracle_sha256).slice(0, 12)}…`);
  fact(facts, "케이스 파일", `${evaluation.n12.cases_file} (${evaluation.n12.case_count}개)`);
  fact(facts, "대상 서버", evaluation.target);
  fact(facts, "종료 코드", `${evaluation.exit_code}${evaluation.signal ? ` (signal ${evaluation.signal})` : ""}`);
  fact(facts, "결과 JSON (백엔드 컨테이너 안)", evaluation.out_file ?? "없음");
  if (result) fact(facts, "experiment_score", String(result.experiment_score));
  if (evaluation.error_message) fact(facts, "실패 사유", evaluation.error_message);

  const decodedById = new Map(evaluation.n12.decoded_responses.map((d) => [d.case_id, d]));
  const body = $("n12-eval-table").querySelector("tbody");
  body.replaceChildren();
  for (const row of result?.results ?? []) {
    const decoded = decodedById.get(row.case_id);
    const decodedText = !decoded ? "" : decoded.error ? `해석 실패: ${decoded.error}` : decoded.complete ? Object.entries(decoded.values).map(([k, v]) => `${k}=${v}`).join(", ") : "불완전";
    body.append(el("tr", {},
      el("td", { title: row.description ?? "", text: row.case_id }),
      el("td", {}, pill(row.verdict)),
      el("td", { class: "hex", text: row.expected_hex || "(응답 없음)" }),
      el("td", { class: "hex", text: row.actual_hex || "(응답 없음)" }),
      el("td", { text: decodedText }),
      el("td", { text: row.error ? `${row.error.type}: ${row.error.message}` : "" }),
    ));
  }
}

$("n12-eval").addEventListener("click", async () => {
  const analysis = selectedAnalysis();
  if (!analysis) return;
  const button = $("n12-eval");
  button.disabled = true;
  $("n12-eval-progress").textContent = "평가 중…";
  try {
    const { status, body } = await post("/api/n12/evaluate", { analysis_id: analysis.id });
    if (status === 200) { n12.latest[analysis.id] = body.evaluation; showN12Evaluation(body.evaluation); $("n12-eval-progress").textContent = ""; }
    else $("n12-eval-progress").textContent = `${body.message ?? "평가 요청 실패"} (HTTP ${status})`;
  } catch (error) {
    $("n12-eval-progress").textContent = `백엔드에 연결하지 못했습니다: ${error.message}`;
  } finally {
    button.disabled = !analysis.runnable;
    refreshStatus();
  }
});

async function startN12() {
  const { status, body } = await api("/api/n12");
  if (status !== 200) { $("n12-empty").hidden = false; $("n12-empty").textContent = "N12 목록을 불러오지 못했습니다."; return; }
  if (body.experiment_score !== false) { $("n12-banner").className = "banner alert"; $("n12-banner").textContent = "experiment_score가 false가 아닙니다. 확인 필요."; }
  n12.analyses = body.analyses;
  n12.latest = body.latest_evaluations ?? {};
  n12.selected = (n12.analyses.find((a) => a.runnable) ?? n12.analyses[0])?.id ?? null;
  renderN12List();
  renderN12Detail();
}

// ---------------------------------------------------------------- 시작
async function start() {
  const specResponse = await api("/api/spec");
  spec = specResponse.body;
  const list = $("example-list");
  for (const example of spec.examples) {
    const chip = el("button", { type: "button", class: "chip", title: `${example.note} · 요청 ${example.request_hex} → 응답 ${example.response_hex}`, text: example.input.join(" ") });
    chip.addEventListener("click", () => { $("numbers").value = example.input.join(" "); });
    list.append(chip);
  }
  if (spec.experiment_score !== false) {
    $("practice-banner").className = "banner alert";
    $("practice-banner").textContent = `명세의 experiment_score가 ${spec.experiment_score}입니다. 확인 필요.`;
  }
  await refreshStatus();
  const latest = await api("/api/evaluate/latest");
  if (latest.body.evaluation) { lastRows = latest.body.evaluation.result?.results ?? []; showEvaluation(latest.body.evaluation); }
  await startN12();
}
start().catch((error) => { $("server-status").className = "status bad"; $("server-status").textContent = `화면을 시작하지 못했습니다: ${error.message}`; });
