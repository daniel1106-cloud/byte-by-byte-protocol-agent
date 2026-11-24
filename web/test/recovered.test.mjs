// N12: 복원 명세(wire-spec-v1)로 통신하는 웹 경로의 테스트.
// 모의 테스트는 어디서나 돈다. 실제 서버 테스트는 Linux + runs/n06/practice-server(+ python3)가 있을 때만 돈다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { createApp } from "../lib/app.mjs";
import { createPracticeServer } from "../lib/practice-server.mjs";
import { DEFAULT_ANALYSES, PRACTICE_ORACLE, executableShape, loadAnalyses, loadAnalysis, sendRecovered, splitFields } from "../lib/recovered.mjs";
import { SUM_6, REQUEST_1_2_3, fakeServer, readExactly, spec, writeOneByOne } from "./helpers.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = resolve(import.meta.dirname, "..");
const FAKE_EVALUATOR = [process.execPath, resolve(import.meta.dirname, "fixtures/fake-evaluator.mjs")];
const ERROR_BAD_LENGTH = Buffer.from("424201ff000104", "hex"); // 연습 서버의 bad length 오류 프레임
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "web/spec/n12", name), "utf8"));

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "n12-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeAnalysis(root, name, value) {
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a", name), typeof value === "string" ? value : JSON.stringify(value));
  return `a/${name}`;
}
const baseAnalysis = () => structuredClone(fixture("practice-gemini-A.json").analysis);
const [entryA, entryB] = loadAnalyses(ROOT, DEFAULT_ANALYSES);

// ------------------------------------------------------------------ 분석 파일 읽기·판정

test("기본 fixture 2개(Gemini pilot A·B)는 실행 가능하고 조건·실행 ID·명세 해시가 기록과 같다", () => {
  for (const [entry, condition, file] of [[entryA, "A", "practice-gemini-A.json"], [entryB, "B", "practice-gemini-B.json"]]) {
    assert.equal(entry.runnable, true, entry.problems.join(" / "));
    assert.equal(entry.condition, condition);
    assert.equal(entry.model, "gemini-3.5-flash-lite");
    assert.equal(entry.experiment_score, false);
    const wrapped = fixture(file);
    assert.equal(entry.analysis_run_id, wrapped.analysis.analysis_run_id);
    assert.equal(entry.spec_sha256, wrapped.n12_fixture.recorded_spec_sha256, "브리지가 기록한 spec_sha256과 같아야 한다");
    assert.equal(entry.shape.input.bytes, 2);
    assert.equal(entry.shape.output.bytes, 4);
  }
  assert.notEqual(entryA.id, entryB.id);
});

test("fixture는 증거 JSON의 분석을 수정 없이 복사한 것이다", () => {
  for (const [file, index] of [["practice-gemini-A.json", 0], ["practice-gemini-B.json", 1]]) {
    const wrapped = fixture(file);
    const evidence = JSON.parse(readFileSync(join(ROOT, wrapped.n12_fixture.source_file), "utf8"));
    assert.deepEqual(wrapped.analysis, evidence.final_pilot.conditions[index].analysis);
  }
});

test("실패·모의·빈 명세·지원 안 되는 모양은 실행하지 않는다", () => {
  const root = tempRoot();
  const failed = { ...baseAnalysis(), success: false, error: { code: "MODEL_TIMEOUT", message: "120 s", stage: "model" }, spec: null };
  const mock = baseAnalysis(); mock.runtime.execution_backend = "injected-test";
  const noModel = { ...baseAnalysis(), model_called: false };
  const empty = { ...baseAnalysis(), spec: {} };
  const wrongShape = baseAnalysis();
  wrongShape.spec.request.fields = [{ name: "magic", type: "const", hex: "4242" }, { name: "x", type: "uint", bytes: 2, endian: "big" }];
  const unknownType = baseAnalysis(); unknownType.spec.response.fields[0].type = "unknown";
  const cases = [
    [writeAnalysis(root, "failed.json", failed), /N09 분석이 실패했습니다: MODEL_TIMEOUT/],
    [writeAnalysis(root, "mock.json", mock), /실제 모델이 낸 성공 결과가 아닙니다/],
    [writeAnalysis(root, "no-model.json", noModel), /실제 모델이 낸 성공 결과가 아닙니다/],
    [writeAnalysis(root, "empty.json", empty), /wire-spec-v1 검증 실패/],
    [writeAnalysis(root, "shape.json", wrongShape), /정수 배열 입력 1개 \+ 정수 출력 1개/],
    [writeAnalysis(root, "unknown.json", unknownType), /wire-spec-v1 검증 실패/],
    [writeAnalysis(root, "broken.json", "{not json"), /분석 파일을 읽지 못했습니다/],
    ["a/missing.json", /분석 파일을 읽지 못했습니다/],
  ];
  for (const [file, pattern] of cases) {
    const entry = loadAnalysis(root, file);
    assert.equal(entry.runnable, false, file);
    assert.match(entry.problems.join(" / "), pattern, file);
  }
});

test("N09-live 결과 형식(task·run_id·condition·repeat)을 그대로 읽는다", () => {
  const root = tempRoot();
  const live = { ...baseAnalysis(), task: "N09-live", run_id: "live-run-1", analysis_run_id: undefined, condition: "B", repeat: 3 };
  delete live.analysis_run_id;
  const entry = loadAnalysis(root, writeAnalysis(root, "live.json", live));
  assert.equal(entry.runnable, true, entry.problems.join(" / "));
  assert.equal(entry.analysis_run_id, "live-run-1");
  assert.equal(entry.condition, "B");
  assert.equal(entry.repeat, 3);
});

test("같은 분석을 두 번 넣어도 id가 겹치지 않는다", () => {
  const entries = loadAnalyses(ROOT, [DEFAULT_ANALYSES[0], DEFAULT_ANALYSES[0]]);
  assert.notEqual(entries[0].id, entries[1].id);
});

test("executableShape와 splitFields는 복원 명세 필드 순서대로 바이트를 나눈다", () => {
  const shape = executableShape(entryA.spec);
  assert.equal(shape.ok, true);
  assert.equal(shape.input.name, "arguments");
  const fields = splitFields(entryA.spec, "request", REQUEST_1_2_3);
  assert.deepEqual(fields.map((f) => [f.name, f.hex]), [["magic", "4242"], ["version_or_type", "0101"], ["arg_length", "0006"], ["arguments", "000100020003"]]);
  assert.deepEqual(fields[3].value, [1, 2, 3]);
  // B는 같은 바이트를 다르게 나눴다(매직을 1바이트 상수 두 개로). 모델마다 필드 경계가 다를 수 있다.
  assert.deepEqual(splitFields(entryB.spec, "response", SUM_6).map((f) => [f.name, f.value]),
    [["magic1", "42"], ["magic2", "42"], ["version", "01"], ["status", "81"], ["resp_len", 4], ["result", 6]]);
});

// ------------------------------------------------------------------ 가짜 TCP 서버로 통신

async function withServer(handler) {
  const server = await fakeServer(handler);
  cleanups.push(() => server.close());
  return server;
}

test("정상 응답: 요청 바이트가 README와 같고 출력 필드로 해석한다", async () => {
  const server = await withServer(async (socket) => { await readExactly(socket, 12); socket.end(SUM_6); });
  const result = await sendRecovered({ entry: entryA, numbers: [1, 2, 3], host: "127.0.0.1", port: server.port });
  assert.equal(result.outcome, "ok");
  assert.equal(result.request.hex, REQUEST_1_2_3.toString("hex"));
  assert.equal(result.response.values.result_value, 6);
  assert.equal(result.connection.closed_by_server, true);
  assert.equal(result.analysis.analysis_run_id, entryA.analysis_run_id);
});

test("응답이 1바이트씩 와도 프레임 하나로 모은다 (TCP 경계 없음)", async () => {
  const server = await withServer(async (socket) => { await readExactly(socket, 12); await writeOneByOne(socket, SUM_6); socket.end(); });
  const result = await sendRecovered({ entry: entryB, numbers: [1, 2, 3], host: "127.0.0.1", port: server.port });
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.values.result, 6);
});

test("서버 오류 프레임은 네트워크 실패가 아니라 '복원 명세 밖 응답'으로 원본 hex와 함께 돌려준다", async () => {
  const server = await withServer(async (socket) => { await readExactly(socket, 6); socket.end(ERROR_BAD_LENGTH); });
  const result = await sendRecovered({ entry: entryA, numbers: [1], host: "127.0.0.1", port: server.port });
  assert.equal(result.outcome, "outside_spec");
  assert.equal(result.ok, false);
  assert.equal(result.response.hex, ERROR_BAD_LENGTH.toString("hex"), "서버가 닫을 때까지 전부 모은다");
  assert.match(result.outside_spec.reason, /Constant mismatch at version_or_type/);
  assert.deepEqual(result.outside_spec.unknowns, entryA.unknowns);
});

test("응답이 도중에 끊기면 truncated, 아무것도 없으면 eof_no_response, 닫지 않으면 timeout", async () => {
  const cut = await withServer(async (socket) => { await readExactly(socket, 12); socket.end(SUM_6.subarray(0, 7)); });
  assert.equal((await sendRecovered({ entry: entryA, numbers: [1, 2, 3], host: "127.0.0.1", port: cut.port })).outcome, "truncated");
  const empty = await withServer(async (socket) => { await readExactly(socket, 12); socket.end(); });
  assert.equal((await sendRecovered({ entry: entryA, numbers: [1, 2, 3], host: "127.0.0.1", port: empty.port })).outcome, "eof_no_response");
  const silent = await withServer(async () => {});
  assert.equal((await sendRecovered({ entry: entryA, numbers: [1, 2, 3], host: "127.0.0.1", port: silent.port, timeoutMs: 200 })).outcome, "timeout");
});

test("프레임 뒤에 남는 바이트는 기록하고, 결과는 정상으로 둔다", async () => {
  const server = await withServer(async (socket) => { await readExactly(socket, 12); socket.end(Buffer.concat([SUM_6, Buffer.from("ff", "hex")])); });
  const result = await sendRecovered({ entry: entryA, numbers: [1, 2, 3], host: "127.0.0.1", port: server.port });
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.trailing_hex, "ff");
  assert.equal(result.notes.length, 1);
});

test("잘못된 입력은 연결하기 전에 InputError로 거절한다", async () => {
  for (const numbers of [[], [65536], [-1], [1.5], "1 2", new Array(entryA.shape.input.max_items + 1).fill(1)]) {
    await assert.rejects(sendRecovered({ entry: entryA, numbers, host: "127.0.0.1", port: 1 }), { name: "InputError" }, JSON.stringify(numbers).slice(0, 30));
  }
  const root = tempRoot();
  const blocked = loadAnalysis(root, writeAnalysis(root, "mock.json", { ...baseAnalysis(), model_called: false }));
  await assert.rejects(sendRecovered({ entry: blocked, numbers: [1], host: "127.0.0.1", port: 1 }), { name: "InputError" });
});

// ------------------------------------------------------------------ 웹 API

function request(port, { method = "GET", path = "/", body } = {}) {
  return new Promise((done, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false,
      headers: payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startApp({ handler, analyses = [entryA, entryB], serverState = "running" } = {}) {
  const target = await withServer(handler ?? (async (socket) => { await readExactly(socket, 12); socket.end(SUM_6); }));
  const root = tempRoot();
  mkdirSync(join(root, "practice/n06"), { recursive: true });
  copyFileSync(join(ROOT, PRACTICE_ORACLE), join(root, PRACTICE_ORACLE));
  const app = createApp({
    root, spec, analyses, publicDir: join(WEB, "public"), evaluator: FAKE_EVALUATOR, evaluationTimeoutMs: 5000,
    target: { host: "127.0.0.1", port: target.port },
    practiceServer: { snapshot: () => ({ state: serverState, pid: 1, sha256: "ab".repeat(32), binary: "runs/n06/practice-server" }) },
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise((done) => { app.closeAllConnections(); app.close(done); }));
  return { port: app.address().port, root };
}

test("GET /api/n12: 분석 목록·실행 가능 여부·근거를 준다", async () => {
  const { port } = await startApp();
  const { status, json } = await request(port, { path: "/api/n12" });
  assert.equal(status, 200);
  assert.equal(json.experiment_score, false);
  assert.deepEqual(json.analyses.map((a) => [a.condition, a.runnable]), [["A", true], ["B", true]]);
  assert.ok(json.analyses[1].observations.length > 0);
  assert.equal(json.oracle.present, true);
});

test("POST /api/n12/send: id로만 고르고, 모르는 id·추가 필드·잘못된 숫자는 거절한다", async () => {
  const { port } = await startApp();
  const ok = await request(port, { method: "POST", path: "/api/n12/send", body: { analysis_id: entryA.id, numbers: [1, 2, 3] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.response.values.result_value, 6);
  assert.equal((await request(port, { method: "POST", path: "/api/n12/send", body: { analysis_id: "../../etc/passwd", numbers: [1] } })).status, 404);
  assert.equal((await request(port, { method: "POST", path: "/api/n12/send", body: { analysis_id: entryA.id, numbers: [1], file: "x.json" } })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/n12/send", body: { analysis_id: entryA.id, numbers: [70000] } })).status, 400);
});

test("POST /api/n12/send: 실행 불가 분석은 400, 서버가 없으면 503", async () => {
  const root = tempRoot();
  const blocked = loadAnalysis(root, writeAnalysis(root, "mock.json", { ...baseAnalysis(), model_called: false }));
  const app = await startApp({ analyses: [blocked] });
  assert.equal((await request(app.port, { method: "POST", path: "/api/n12/send", body: { analysis_id: blocked.id, numbers: [1] } })).status, 400);
  const down = await startApp({ serverState: "binary_missing" });
  assert.equal((await request(down.port, { method: "POST", path: "/api/n12/send", body: { analysis_id: entryA.id, numbers: [1] } })).status, 503);
});

test("POST /api/n12/evaluate: 브리지와 같은 15개 케이스 파일을 만들어 평가기에 --target으로 넘긴다", async () => {
  const { port, root } = await startApp();
  const { status, json } = await request(port, { method: "POST", path: "/api/n12/evaluate", body: { analysis_id: entryB.id } });
  assert.equal(status, 200);
  const evaluation = json.evaluation;
  assert.equal(evaluation.n12.case_count, 15);
  assert.equal(evaluation.n12.condition, "B");
  assert.equal(evaluation.n12.analysis_run_id, entryB.analysis_run_id);
  assert.match(evaluation.n12.cases_file, /^runs\/n12\/cases-.*\.json$/);
  const args = evaluation.result.received_args;
  assert.equal(args[args.indexOf("--cases") + 1], evaluation.n12.cases_file);
  assert.match(args[args.indexOf("--target") + 1], /^127\.0\.0\.1:\d+$/);
  const cases = JSON.parse(readFileSync(join(root, evaluation.n12.cases_file), "utf8"));
  assert.equal(cases.name, "n12-public-recovered-client");
  // 가짜 평가기의 응답("00","01")은 복원 명세로 해석되지 않는다.
  assert.equal(evaluation.n12.all_decoded, false);
  const latest = await request(port, { path: "/api/n12" });
  assert.ok(latest.json.latest_evaluations[entryB.id]);
});

// ------------------------------------------------------------------ 실제 연습 서버

const BINARY = join(ROOT, "runs/n06/practice-server");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const skipReal = process.platform !== "linux" || !existsSync(BINARY) ? "Linux + runs/n06/practice-server 가 필요합니다 (N05 이미지 안에서 실행)" : false;

async function freePort() {
  const probe = net.createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

async function realServer() {
  const port = await freePort();
  const server = createPracticeServer({ binary: BINARY, port });
  await server.start();
  cleanups.push(() => server.stop());
  assert.equal(server.snapshot().state, "running", server.snapshot().message);
  return port;
}

test("실제 서버: A·B 복원 명세로 1 2 3 → 6, 개수 초과는 명세 밖 응답(bad length 오류 프레임)", { skip: skipReal }, async () => {
  const port = await realServer();
  for (const entry of [entryA, entryB]) {
    const ok = await sendRecovered({ entry, numbers: [1, 2, 3], host: "127.0.0.1", port });
    assert.equal(ok.outcome, "ok", entry.id);
    assert.equal(ok.response.frame_hex, SUM_6.toString("hex"));
    const tooMany = await sendRecovered({ entry, numbers: new Array(40).fill(1), host: "127.0.0.1", port });
    assert.equal(tooMany.outcome, "outside_spec", entry.id);
    assert.equal(tooMany.response.hex, ERROR_BAD_LENGTH.toString("hex"));
  }
});

test("실제 서버: A·B 복원 명세를 공개 오라클 15케이스로 N07 평가하면 15/15, 응답 전부 복원 명세로 해석", { skip: skipReal || (!hasPython && "python3 필요") }, async () => {
  const port = await realServer();
  const root = tempRoot();
  for (const dir of ["scripts", "practice/n06"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(ROOT, "scripts/n07-evaluate.py"), join(root, "scripts/n07-evaluate.py"));
  copyFileSync(join(ROOT, PRACTICE_ORACLE), join(root, PRACTICE_ORACLE));
  const app = createApp({
    root, spec, analyses: [entryA, entryB], publicDir: join(WEB, "public"), evaluationTimeoutMs: 60_000,
    target: { host: "127.0.0.1", port },
    practiceServer: { snapshot: () => ({ state: "running", pid: 1, sha256: "x", binary: "runs/n06/practice-server" }) },
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise((done) => { app.closeAllConnections(); app.close(done); }));
  for (const entry of [entryA, entryB]) {
    const { status, json } = await request(app.address().port, { method: "POST", path: "/api/n12/evaluate", body: { analysis_id: entry.id } });
    assert.equal(status, 200);
    const evaluation = json.evaluation;
    assert.equal(evaluation.status, "all_pass", evaluation.error_message ?? evaluation.stderr_tail);
    assert.deepEqual([evaluation.result.summary.total, evaluation.result.summary.pass], [15, 15]);
    assert.equal(evaluation.result.experiment_score, false);
    assert.equal(evaluation.n12.all_decoded, true);
  }
});
