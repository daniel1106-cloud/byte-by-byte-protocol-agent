import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { createApp } from "../lib/app.mjs";
import { SUM_6, fakeServer, readExactly, sleep, spec } from "./helpers.mjs";

const WEB = resolve(import.meta.dirname, "..");
const FAKE_EVALUATOR = [process.execPath, resolve(import.meta.dirname, "fixtures/fake-evaluator.mjs")];
const running = { state: "running", pid: 4242, sha256: "ab".repeat(32), binary: "runs/n06/practice-server" };

const openApps = [];
after(async () => { for (const app of openApps) await app.close(); });

async function startApp({ serverState = running, evaluator = FAKE_EVALUATOR, handler, evaluationTimeoutMs = 5000 } = {}) {
  const target = await fakeServer(handler ?? (async (socket) => {
    await readExactly(socket, 12);
    socket.end(SUM_6);
  }));
  const root = mkdtempSync(join(tmpdir(), "n08-test-"));
  const app = createApp({
    root, spec, publicDir: join(WEB, "public"), evaluator, evaluationTimeoutMs,
    target: { host: "127.0.0.1", port: target.port },
    practiceServer: { snapshot: () => serverState },
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  const port = app.address().port;
  let closed = false;
  const handle = {
    port, target, root,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((done) => { app.closeAllConnections(); app.close(done); });
      await target.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  openApps.push(handle);
  return handle;
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML 등 */ }
        resolveRequest({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const postJson = (port, path, body, headers = {}) =>
  request(port, { method: "POST", path, body, headers: { "Content-Type": "application/json", ...headers } });

test("정적 파일: 화면과 보안 헤더", async () => {
  const app = await startApp();
  const page = await request(app.port, { path: "/" });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.text, /연습 결과/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal((await request(app.port, { path: "/app.js" })).status, 200);
  assert.equal((await request(app.port, { path: "/style.css" })).status, 200);
  await app.close();
});

test("정적 파일: 경로 이동·없는 경로는 404", async () => {
  const app = await startApp();
  for (const path of ["/../server.mjs", "/%2e%2e/server.mjs", "/lib/app.mjs", "/spec/n06-practice.json", "/nope"]) {
    assert.equal((await request(app.port, { path })).status, 404, path);
  }
  await app.close();
});

test("GET /api/health, /api/spec", async () => {
  const app = await startApp();
  const health = await request(app.port, { path: "/api/health" });
  assert.equal(health.json.ok, true);
  assert.equal(health.json.server.state, "running");
  assert.equal(health.json.spec.experiment_score, false);
  const got = await request(app.port, { path: "/api/spec" });
  assert.equal(got.json.name, "n06-practice-sum");
  await app.close();
});

test("POST /api/send: 서버 응답을 그대로 해석해 돌려준다", async () => {
  const app = await startApp();
  const reply = await postJson(app.port, "/api/send", { numbers: [1, 2, 3] });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.result.outcome, "ok");
  assert.equal(reply.json.result.request.hex, "424201010006000100020003");
  assert.equal(reply.json.result.response.frame_hex, "42420181000400000006");
  assert.equal(reply.json.result.response.decoded.values.sum, 6);
  assert.equal(reply.json.server.port, app.target.port);
  await app.close();
});

test("POST /api/send: 서버에서 입력을 다시 검증한다", async () => {
  const app = await startApp();
  const bad = [
    {}, { numbers: [] }, { numbers: Array(33).fill(1) }, { numbers: [65536] }, { numbers: [-1] },
    { numbers: [1.5] }, { numbers: ["1"] }, { numbers: "1 2 3" }, { numbers: null }, { numbers: [null] },
  ];
  for (const body of bad) {
    const reply = await postJson(app.port, "/api/send", body);
    assert.equal(reply.status, 400, JSON.stringify(body));
  }
  assert.equal(app.target.stats.connections, 0, "잘못된 입력은 서버에 닿지 않는다");
  await app.close();
});

test("접속 대상은 요청으로 바꿀 수 없다 (host/port/path 필드 거절)", async () => {
  const app = await startApp();
  for (const extra of [{ host: "8.8.8.8" }, { port: 22 }, { target: "evil:1" }, { path: "/etc/passwd" }, { file: "x" }]) {
    const reply = await postJson(app.port, "/api/send", { numbers: [1], ...extra });
    assert.equal(reply.status, 400);
    assert.equal(reply.json.error, "unknown_field");
  }
  const evaluate = await postJson(app.port, "/api/evaluate", { target: "evil:1" });
  assert.equal(evaluate.status, 400);
  assert.equal(app.target.stats.connections, 0);
  await app.close();
});

test("요청 형식: JSON 아님·잘못된 Content-Type·너무 큰 본문·허용 안 하는 메서드", async () => {
  const app = await startApp();
  assert.equal((await postJson(app.port, "/api/send", "{not json")).status, 400);
  assert.equal((await postJson(app.port, "/api/send", "[1,2,3]")).status, 400);
  const wrongType = await request(app.port, { method: "POST", path: "/api/send", body: JSON.stringify({ numbers: [1] }), headers: { "Content-Type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  const huge = await postJson(app.port, "/api/send", JSON.stringify({ numbers: [1], pad: "x".repeat(5000) }));
  assert.equal(huge.status, 413);
  assert.equal((await request(app.port, { method: "PUT", path: "/api/send" })).status, 405);
  assert.equal((await request(app.port, { method: "DELETE", path: "/" })).status, 405);
  await app.close();
});

test("Host/Origin 검사: 다른 호스트 이름(DNS 재바인딩)과 다른 출처는 거절", async () => {
  const app = await startApp();
  const rebinding = await request(app.port, { path: "/api/health", headers: { Host: "evil.example" } });
  assert.equal(rebinding.status, 403);
  const lan = await request(app.port, { path: "/", headers: { Host: "192.168.0.5:8080" } });
  assert.equal(lan.status, 403);
  const crossOrigin = await postJson(app.port, "/api/send", { numbers: [1] }, { Origin: "http://evil.example" });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await postJson(app.port, "/api/send", { numbers: [1, 2, 3] }, { Origin: `http://127.0.0.1:${app.port}`, Host: `127.0.0.1:${app.port}` });
  assert.equal(sameOrigin.status, 200);
  const localhost = await request(app.port, { path: "/api/health", headers: { Host: `localhost:${app.port}` } });
  assert.equal(localhost.status, 200);
  await app.close();
});

test("연습 서버가 없으면 503과 분명한 사유", async () => {
  const app = await startApp({ serverState: { state: "binary_missing", message: "runs/n06/practice-server 가 없습니다." } });
  const reply = await postJson(app.port, "/api/send", { numbers: [1] });
  assert.equal(reply.status, 503);
  assert.match(reply.json.message, /practice-server/);
  assert.equal((await postJson(app.port, "/api/evaluate", {})).status, 503);
  await app.close();
});

// 요청을 읽기 시작해서 응답을 다 쓸 때까지를 "처리 중"으로 센다.
function busyHandler(delayMs) {
  const counts = { inFlight: 0, maxInFlight: 0, handled: 0 };
  const handler = async (socket) => {
    counts.inFlight += 1;
    counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
    await readExactly(socket, 12);
    await sleep(delayMs);
    await new Promise((done) => socket.end(SUM_6, done));
    counts.inFlight -= 1;
    counts.handled += 1;
  };
  return { counts, handler };
}

test("요청은 한 번에 하나씩 서버로 간다 (직렬화)", async () => {
  const { counts, handler } = busyHandler(60);
  const app = await startApp({ handler });
  const replies = await Promise.all(Array.from({ length: 5 }, () => postJson(app.port, "/api/send", { numbers: [1, 2, 3] })));
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(counts.handled, 5);
  assert.equal(counts.maxInFlight, 1, "서버가 동시에 처리한 요청은 1개를 넘지 않는다");
  await app.close();
});

test("대기가 너무 많으면 429", async () => {
  const { counts, handler } = busyHandler(80);
  const app = await startApp({ handler });
  const replies = await Promise.all(Array.from({ length: 14 }, () => postJson(app.port, "/api/send", { numbers: [1, 2, 3] })));
  const statuses = replies.map((r) => r.status);
  assert.ok(statuses.includes(200));
  assert.ok(statuses.includes(429), `statuses: ${statuses}`);
  assert.equal(statuses.filter((code) => code === 200).length, counts.handled);
  assert.equal(counts.maxInFlight, 1);
  await app.close();
});

test("응답 없는 서버는 시간 제한 뒤 timeout으로 돌려준다 (HTTP 200)", async () => {
  const target = await fakeServer(async (socket) => { await readExactly(socket, 12); });
  const root = mkdtempSync(join(tmpdir(), "n08-test-"));
  const app = createApp({ root, spec, publicDir: join(WEB, "public"), target: { host: "127.0.0.1", port: target.port }, practiceServer: { snapshot: () => running }, sendTimeoutMs: 250 });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  const reply = await postJson(app.address().port, "/api/send", { numbers: [1] });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.result.outcome, "timeout");
  await new Promise((done) => { app.closeAllConnections(); app.close(done); });
  await target.close();
  rmSync(root, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------- 평가
async function evaluate(mode, options = {}) {
  process.env.FAKE_EVAL_MODE = mode;
  const app = await startApp(options);
  const reply = await postJson(app.port, "/api/evaluate", {});
  return { app, reply };
}

test("평가 전부 통과: all_pass, 대상은 웹이 쓰는 서버, 결과 파일은 새 경로", async () => {
  const { app, reply } = await evaluate("pass");
  assert.equal(reply.status, 200);
  const evaluation = reply.json.evaluation;
  assert.equal(evaluation.status, "all_pass");
  assert.equal(evaluation.exit_code, 0);
  assert.equal(evaluation.result.summary.all_pass, true);
  assert.equal(evaluation.target, `127.0.0.1:${app.target.port}`);
  assert.deepEqual(evaluation.result.received_args.slice(0, 4), ["--cases", "practice/n06/cases.json", "--target", `127.0.0.1:${app.target.port}`]);
  assert.match(evaluation.out_file, /^runs\/n08\/eval-web-\d{8}-\d{6}Z-[0-9a-f]{6}\.json$/);
  assert.equal(JSON.parse(readFileSync(join(app.root, evaluation.out_file), "utf8")).task, "N07");
  // 같은 요청을 다시 해도 새 경로가 쓰여 거절되지 않는다
  const second = await postJson(app.port, "/api/evaluate", {});
  assert.equal(second.json.evaluation.status, "all_pass");
  assert.notEqual(second.json.evaluation.out_file, evaluation.out_file);
  const latest = await request(app.port, { path: "/api/evaluate/latest" });
  assert.equal(latest.json.evaluation.out_file, second.json.evaluation.out_file);
  await app.close();
});

test("평가 불일치(종료 코드 1, success:true): completed_with_mismatch — 실행 실패와 구분", async () => {
  const { app, reply } = await evaluate("mismatch");
  const evaluation = reply.json.evaluation;
  assert.equal(evaluation.status, "completed_with_mismatch");
  assert.equal(evaluation.exit_code, 1);
  assert.equal(evaluation.result.success, true);
  assert.equal(evaluation.result.summary.all_pass, false);
  assert.equal(evaluation.result.results[1].verdict, "fail");
  await app.close();
});

test("평가가 중간에 멈춤(success:false)과 평가기 비정상 종료는 run_failed", async () => {
  const aborted = await evaluate("abort");
  assert.equal(aborted.reply.json.evaluation.status, "run_failed");
  assert.match(aborted.reply.json.evaluation.error_message, /stage: cases/);
  await aborted.app.close();

  const crashed = await evaluate("crash");
  assert.equal(crashed.reply.json.evaluation.status, "run_failed");
  assert.equal(crashed.reply.json.evaluation.exit_code, 3);
  assert.match(crashed.reply.json.evaluation.stderr_tail, /boom/);
  await crashed.app.close();
});

test("평가기가 끝나지 않으면 timeout으로 끝내고 프로세스를 종료한다", async () => {
  const { app, reply } = await evaluate("hang", { evaluationTimeoutMs: 400 });
  assert.equal(reply.json.evaluation.status, "timeout");
  assert.equal(reply.json.evaluation.signal, "SIGKILL");
  await app.close();
});

test("평가기 실행 파일이 없으면 run_failed (서버가 죽지 않는다)", async () => {
  const app = await startApp({ evaluator: ["/nonexistent/python-does-not-exist", "scripts/n07-evaluate.py"] });
  const reply = await postJson(app.port, "/api/evaluate", {});
  assert.equal(reply.status, 200);
  assert.equal(reply.json.evaluation.status, "run_failed");
  assert.match(reply.json.evaluation.error_message, /실행하지 못했습니다/);
  assert.equal((await request(app.port, { path: "/api/health" })).status, 200);
  await app.close();
});
