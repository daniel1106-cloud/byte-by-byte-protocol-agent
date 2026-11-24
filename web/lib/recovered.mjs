// N12: LLM이 복원한 명세(wire-spec-v1)로 실제 서버와 통신하고, 공개 연습 오라클로 N07 평가를 돌린다.
// - 분석 파일 목록은 서버 시작 때 정해진다(요청으로 경로를 바꿀 수 없다). 요청은 목록의 id만 고른다.
// - 모델이 만든 코드는 실행하지 않는다. scripts/wire-spec.mjs의 선언형 인코더·디코더만 쓴다.
// - 실행 조건은 scripts/n12-practice-bridge.mjs와 같다: 실패·모의·빈 명세는 실행하지 않고,
//   정수 배열 입력 1개 + 정수 출력 1개 모양만 실행한다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, join } from "node:path";
import { decodeMessage, encodeMessage, validateWireSpec } from "../../scripts/wire-spec.mjs";
import { buildPracticeCases } from "../../scripts/n12-practice-bridge.mjs";
import { newRunTag, runEvaluation } from "./evaluate.mjs";
import { InputError } from "./protocol.mjs";

export const DEFAULT_ANALYSES = ["web/spec/n12/practice-gemini-A.json", "web/spec/n12/practice-gemini-B.json"];
export const PRACTICE_ORACLE = "practice/n06/client-vectors.json";
export const N12_OUT_DIR = "runs/n12";

const MAX_ANALYSIS_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 4096; // wire-spec.mjs의 프레임 한도와 같다
const MAX_RECEIVED_BYTES = 4096;

export const N12_OUTCOME_TEXT = {
  ok: "복원 명세대로 해석된 응답",
  outside_spec: "복원 명세 밖 응답 (명세로 해석할 수 없음)",
  timeout: "시간 초과 (응답이 끝까지 오지 않음)",
  eof_no_response: "응답 없이 서버가 연결을 닫음 (EOF)",
  truncated: "응답이 도중에 끊김 (EOF)",
  connection_error: "연결 오류 (연결 뒤 끊김)",
  connect_failed: "연결 실패",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toHex = (bytes) => Buffer.from(bytes).toString("hex");

/** 브리지와 같은 실행 가능 모양 판정. 맞으면 입력·출력 필드를 돌려준다. */
export function executableShape(spec) {
  const inputs = spec.request.fields.filter((f) => !["const", "length"].includes(f.type));
  const outputs = spec.response.fields.filter((f) => !["const", "length"].includes(f.type));
  if (inputs.length !== 1 || inputs[0].type !== "uint_array" || outputs.length !== 1 || outputs[0].type !== "uint") {
    return {
      ok: false,
      reason: `실행 가능한 모양은 정수 배열 입력 1개 + 정수 출력 1개입니다 (입력: ${inputs.map((f) => `${f.name}:${f.type}`).join(", ") || "없음"}, 출력: ${outputs.map((f) => `${f.name}:${f.type}`).join(", ") || "없음"}).`,
    };
  }
  const input = inputs[0];
  const fixed = spec.request.fields.reduce((sum, f) => sum + (f.type === "const" ? f.hex.length / 2 : ["uint", "length"].includes(f.type) ? f.bytes : 0), 0);
  return {
    ok: true,
    input: { name: input.name, bytes: input.bytes, endian: input.endian, max_value: 2 ** (8 * input.bytes) - 1, max_items: Math.floor((MAX_FRAME_BYTES - fixed) / input.bytes) },
    output: { name: outputs[0].name, bytes: outputs[0].bytes, endian: outputs[0].endian },
  };
}

/** 분석 JSON(N09 결과) 하나를 읽고 실행 가능 여부를 판정한다. 던지지 않는다. */
export function loadAnalysis(root, file) {
  const entry = {
    id: null, file, file_sha256: null, fixture: null, runnable: false, problems: [],
    analysis_run_id: null, preparation_run_id: null, condition: null, repeat: null,
    model: null, execution_backend: null, success: null, model_called: null, experiment_score: null,
    started_at: null, finished_at: null, spec: null, spec_sha256: null, semantics: null,
    observations: [], unknowns: [], shape: null,
  };
  let analysis;
  try {
    const path = join(root, file);
    if (statSync(path).size > MAX_ANALYSIS_BYTES) throw new Error(`${MAX_ANALYSIS_BYTES}바이트보다 큽니다`);
    const raw = readFileSync(path);
    entry.file_sha256 = sha256(raw);
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed && typeof parsed === "object" && parsed.n12_fixture && parsed.analysis) {
      entry.fixture = parsed.n12_fixture;
      analysis = parsed.analysis;
    } else {
      analysis = parsed;
    }
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("JSON 객체가 아닙니다");
  } catch (error) {
    entry.id = `file-${basename(file).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    entry.problems.push(`분석 파일을 읽지 못했습니다: ${error.message}`);
    return entry;
  }

  entry.analysis_run_id = analysis.analysis_run_id ?? (analysis.task === "N09-live" ? analysis.run_id : null) ?? null;
  entry.preparation_run_id = analysis.preparation_run_id ?? null;
  entry.condition = analysis.condition ?? entry.fixture?.condition ?? null;
  entry.repeat = analysis.repeat ?? null;
  entry.model = analysis.model?.returned ?? analysis.model?.requested ?? null;
  entry.execution_backend = analysis.runtime?.execution_backend ?? null;
  entry.success = analysis.success ?? null;
  entry.model_called = analysis.model_called ?? null;
  entry.experiment_score = analysis.experiment_score ?? null;
  entry.started_at = analysis.started_at ?? null;
  entry.finished_at = analysis.finished_at ?? null;
  entry.observations = Array.isArray(analysis.observations) ? analysis.observations.slice(0, 50) : [];
  entry.unknowns = Array.isArray(analysis.unknowns) ? analysis.unknowns.slice(0, 50) : [];
  entry.spec = analysis.spec ?? null;
  entry.spec_sha256 = analysis.spec === undefined ? null : sha256(JSON.stringify(analysis.spec));
  entry.semantics = typeof analysis.spec?.semantics === "string" ? analysis.spec.semantics : null;
  entry.id = `${entry.condition ?? "X"}-${(entry.analysis_run_id ?? entry.file_sha256).slice(0, 8)}`;

  if (analysis.success === false) {
    const e = analysis.error ?? {};
    entry.problems.push(`N09 분석이 실패했습니다: ${e.code ?? "ANALYSIS_FAILED"} ${e.message ?? ""}${e.stage ? ` (stage: ${e.stage})` : ""}`.trim());
  } else if (analysis.success !== true || analysis.model_called !== true || entry.execution_backend !== "real") {
    entry.problems.push("실제 모델이 낸 성공 결과가 아닙니다. 모의·빈·실패 분석은 실행하지 않습니다.");
  }
  try {
    validateWireSpec(analysis.spec);
    const shape = executableShape(analysis.spec);
    if (shape.ok) entry.shape = { input: shape.input, output: shape.output };
    else entry.problems.push(shape.reason);
  } catch (error) {
    entry.problems.push(`wire-spec-v1 검증 실패: ${error.message}`);
  }
  entry.runnable = entry.problems.length === 0;
  return entry;
}

export function loadAnalyses(root, files = DEFAULT_ANALYSES) {
  const entries = [];
  for (const file of files) {
    const entry = loadAnalysis(root, file);
    let id = entry.id;
    for (let n = 2; entries.some((other) => other.id === id); n += 1) id = `${entry.id}-${n}`;
    entries.push({ ...entry, id });
  }
  return entries;
}

/** 명세 필드 순서대로 바이트를 나눠 보여주기 위한 표. 디코드에 성공한 프레임에만 쓴다. */
export function splitFields(spec, direction, frame) {
  const fields = spec[direction].fields;
  const lengths = new Map();
  const out = [];
  let offset = 0;
  for (const field of fields) {
    let size;
    if (field.type === "const") size = field.hex.length / 2;
    else if (field.type === "uint" || field.type === "length") size = field.bytes;
    else size = lengths.get(field.name) ?? frame.length - offset;
    const piece = frame.subarray(offset, offset + size);
    offset += size;
    let value = toHex(piece);
    if (field.type === "uint" || field.type === "length") {
      value = piece[field.endian === "big" ? "readUIntBE" : "readUIntLE"](0, field.bytes);
      if (field.type === "length") lengths.set(field.of, value);
    } else if (field.type === "uint_array") {
      value = [];
      for (let i = 0; i + field.bytes <= piece.length; i += field.bytes) value.push(piece[field.endian === "big" ? "readUIntBE" : "readUIntLE"](i, field.bytes));
    }
    out.push({ name: field.name, type: field.type, hex: toHex(piece), value });
  }
  return out;
}

function checkNumbers(entry, numbers) {
  const { input } = entry.shape;
  if (!Array.isArray(numbers)) throw new InputError("numbers는 숫자 배열이어야 합니다.");
  if (numbers.length < 1 || numbers.length > input.max_items) {
    throw new InputError(`숫자는 1~${input.max_items}개여야 합니다 (입력: ${numbers.length}개). 이 상한은 프레임 바이트 한도에서 나온 값이고, 복원 명세에는 개수 상한이 없습니다.`);
  }
  numbers.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > input.max_value) {
      throw new InputError(`${index + 1}번째 값 ${JSON.stringify(value)}은(는) 0~${input.max_value} 정수가 아닙니다 (${input.bytes}바이트 ${input.endian}).`);
    }
  });
}

/**
 * 복원 명세로 요청 하나를 보내고 응답 하나를 읽는다. 네트워크 문제로 reject하지 않는다.
 * 명세로 해석되지 않는 응답은 outside_spec으로 원본 hex와 함께 돌려준다(서버 오류 프레임 등).
 */
export async function sendRecovered({ entry, numbers, host, port, timeoutMs = 3000, settleMs = 500 }) {
  if (!entry.runnable) throw new InputError(`이 분석은 실행할 수 없습니다: ${entry.problems.join(" / ")}`);
  checkNumbers(entry, numbers);
  const { spec, shape } = entry;
  let request;
  try {
    request = encodeMessage(spec, "request", { [shape.input.name]: numbers });
  } catch (error) {
    throw new InputError(`복원 명세로 요청을 만들 수 없습니다: ${error.message}`);
  }

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    let received = Buffer.alloc(0);
    let connected = false;
    let serverClosed = false;
    let decoded = null;
    let outsideReason = null;
    let finished = false;
    let settleTimer = null;
    const notes = [];
    const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;

    const finish = (outcome, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(settleTimer);
      socket.destroy();
      const response = { bytes_received: received.length, hex: toHex(received) };
      if (decoded) {
        const frame = received.subarray(0, decoded.bytes_consumed);
        response.frame_hex = toHex(frame);
        response.values = decoded.values;
        response.fields = splitFields(spec, "response", frame);
        if (received.length > decoded.bytes_consumed) {
          response.trailing_hex = toHex(received.subarray(decoded.bytes_consumed));
          notes.push(`응답 프레임 뒤에 ${received.length - decoded.bytes_consumed}바이트가 더 왔습니다.`);
        }
      }
      resolve({
        outcome,
        outcome_text: N12_OUTCOME_TEXT[outcome],
        ok: outcome === "ok",
        analysis: { id: entry.id, analysis_run_id: entry.analysis_run_id, condition: entry.condition, repeat: entry.repeat, spec_sha256: entry.spec_sha256 },
        request: { hex: toHex(request), fields: splitFields(spec, "request", request), input: { [shape.input.name]: numbers } },
        response,
        ...(outcome === "outside_spec" ? { outside_spec: { reason: outsideReason, unknowns: entry.unknowns, semantics: entry.semantics } } : {}),
        connection: {
          host, port, connected,
          closed_by_server: connected ? serverClosed : null,
          ...(extra.error_code ? { error_code: extra.error_code } : {}),
        },
        ...(extra.error_message ? { error_message: extra.error_message } : {}),
        elapsed_ms: elapsedMs(),
        notes,
      });
    };

    // 프레임이 끝났거나(정상) 명세로 해석이 안 되는 걸 안 뒤에는(명세 밖) 서버가 닫을 때까지 잠깐 더 모은다.
    const settle = () => {
      if (serverClosed) finish(decoded ? "ok" : "outside_spec");
      else if (!settleTimer) settleTimer = setTimeout(() => finish(decoded ? "ok" : "outside_spec"), settleMs);
    };

    const consume = () => {
      if (received.length > MAX_RECEIVED_BYTES) {
        if (!decoded && !outsideReason) outsideReason = `서버가 ${MAX_RECEIVED_BYTES}바이트가 넘게 보냈습니다.`;
        finish(decoded ? "ok" : "outside_spec");
        return;
      }
      if (decoded || outsideReason) return;
      try {
        const result = decodeMessage(spec, "response", received);
        if (result.complete) { decoded = result; settle(); }
      } catch (error) {
        outsideReason = error.message;
        settle();
      }
    };

    const deadline = setTimeout(() => {
      if (decoded) finish("ok");
      else if (outsideReason) finish("outside_spec");
      else finish("timeout");
    }, timeoutMs);

    const onClosed = () => {
      if (finished) return;
      serverClosed = true;
      if (decoded) finish("ok");
      else if (outsideReason) finish("outside_spec");
      else if (received.length === 0) finish("eof_no_response");
      else {
        // 명세상 아직 덜 왔는데 끊겼다.
        finish("truncated");
      }
    };

    socket.on("connect", () => { connected = true; socket.write(request); });
    socket.on("data", (chunk) => {
      if (finished) return;
      received = Buffer.concat([received, chunk]);
      consume();
    });
    socket.on("end", onClosed);
    socket.on("close", onClosed);
    socket.on("error", (error) => {
      if (finished) return;
      if (decoded || outsideReason) {
        notes.push(`응답을 받은 뒤 연결 오류가 있었습니다 (${error.code ?? error.message}).`);
        finish(decoded ? "ok" : "outside_spec");
        return;
      }
      finish(connected ? "connection_error" : "connect_failed", { error_code: error.code, error_message: error.message });
    });
  });
}

/**
 * 공개 연습 오라클(practice/n06/client-vectors.json)로 브리지와 같은 15개 케이스를 만들고,
 * 웹이 쓰는 같은 서버를 N07 평가기 --target으로 평가한다. 실제 응답은 복원 명세로도 다시 해석한다.
 */
export async function evaluateRecovered({ root, entry, host, port, command, timeoutMs }) {
  if (!entry.runnable) throw new InputError(`이 분석은 실행할 수 없습니다: ${entry.problems.join(" / ")}`);
  const oraclePath = join(root, PRACTICE_ORACLE);
  const n12 = {
    analysis_id: entry.id, analysis_run_id: entry.analysis_run_id, condition: entry.condition, repeat: entry.repeat,
    spec_sha256: entry.spec_sha256, oracle_file: PRACTICE_ORACLE, oracle_sha256: null, cases_file: null, case_count: 0,
    classification: "public-practice-recovered-wire-client", decoded_responses: [], all_decoded: false,
  };
  let cases;
  try {
    const oracleRaw = readFileSync(oraclePath);
    n12.oracle_sha256 = sha256(oracleRaw);
    cases = buildPracticeCases(entry.spec, JSON.parse(oracleRaw.toString("utf8")));
    mkdirSync(join(root, N12_OUT_DIR), { recursive: true });
    n12.cases_file = `${N12_OUT_DIR}/cases-${newRunTag()}.json`;
    writeFileSync(join(root, n12.cases_file), JSON.stringify(cases, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    n12.case_count = cases.cases.length;
  } catch (error) {
    return {
      status: "run_failed", status_text: "평가 실행 실패 (케이스를 만들지 못함)", error_message: error.message,
      result: null, exit_code: null, signal: null, stderr_tail: "", duration_ms: 0, target: `${host}:${port}`, n12,
    };
  }
  const evaluation = await runEvaluation({ root, host, port, casesFile: n12.cases_file, outDir: N12_OUT_DIR, command, timeoutMs });
  const rows = evaluation.result?.results ?? [];
  n12.decoded_responses = rows.map((row) => {
    try {
      const value = decodeMessage(entry.spec, "response", Buffer.from(row.actual_hex ?? "", "hex"));
      return { case_id: row.case_id, ...value };
    } catch (error) {
      return { case_id: row.case_id, error: error.message };
    }
  });
  n12.all_decoded = rows.length > 0 && n12.decoded_responses.every((r) => r.complete === true && r.remaining_hex === "");
  return { ...evaluation, n12 };
}

export function oracleInfo(root) {
  const path = join(root, PRACTICE_ORACLE);
  return { file: PRACTICE_ORACLE, present: existsSync(path) };
}
