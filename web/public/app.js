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
}
start().catch((error) => { $("server-status").className = "status bad"; $("server-status").textContent = `화면을 시작하지 못했습니다: ${error.message}`; });
