// 실제 연습 서버(runs/n06/practice-server, Linux 실행 파일)로 하는 소켓 테스트.
// 바이너리가 없거나 Linux가 아니면 건너뛴다(Windows 호스트에서는 건너뛰고, N05 이미지 안에서 실행한다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { createApp } from "../lib/app.mjs";
import { sendRequest } from "../lib/client.mjs";
import { createPracticeServer } from "../lib/practice-server.mjs";
import { decodeResponse } from "../lib/protocol.mjs";
import { sleep, spec } from "./helpers.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BINARY = join(ROOT, "runs/n06/practice-server");
const skip = process.platform !== "linux" || !existsSync(BINARY)
  ? "Linux + runs/n06/practice-server 가 필요합니다 (N05 이미지 안에서 실행)"
  : false;

async function freePort() {
  const probe = net.createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

let port;
let server;
before(async () => {
  if (skip) return;
  port = await freePort();
  server = createPracticeServer({ binary: BINARY, port });
  await server.start();
  assert.equal(server.snapshot().state, "running", server.snapshot().message);
});
after(async () => {
  if (server) await server.stop();
});

/** 요청 바이트를 chunkSize씩 나눠 보내고 서버가 닫을 때까지 받는다 (평가기 없이 직접). */
function raw(hex, { chunkSize = 1000, delayMs = 0 } = {}) {
  return new Promise((resolveRaw, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolveRaw(Buffer.concat(chunks)));
    socket.on("connect", async () => {
      const bytes = Buffer.from(hex, "hex");
      for (let i = 0; i < bytes.length; i += chunkSize) {
        socket.write(bytes.subarray(i, i + chunkSize));
        if (delayMs) await sleep(delayMs);
      }
    });
  });
}

const SESSIONS = [
  [[1, 2, 3], "42420181000400000006"],
  [[10, 20], "4242018100040000001e"],
  [[65535, 65535], "4242018100040001fffe"],
  [[1000], "424201810004000003e8"],
  [[7, 7, 7, 7, 7], "42420181000400000023"],
];

test("실제 서버: README 정상 5세션이 웹 클라이언트로 같은 응답", { skip }, async () => {
  for (const [numbers, expected] of SESSIONS) {
    const result = await sendRequest({ spec, numbers, host: "127.0.0.1", port, minCount: 1 });
    assert.equal(result.outcome, "ok", numbers.join(" "));
    assert.equal(result.response.frame_hex, expected, numbers.join(" "));
    assert.equal(result.connection.closed_by_server, true);
  }
});

test("실제 서버: 32개(최대)와 최댓값 합", { skip }, async () => {
  const result = await sendRequest({ spec, numbers: Array(32).fill(65535), host: "127.0.0.1", port, minCount: 1 });
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.decoded.values.sum, 2097120);
});

test("실제 서버: 오류 프레임 4종을 해석한다", { skip }, async () => {
  const cases = [
    ["414201010000", 1], ["424202010000", 2], ["424201020000", 3],
    ["424201010003", 4], ["424201010042", 4], ["42420101ffff", 4],
  ];
  for (const [hex, code] of cases) {
    const reply = await raw(hex);
    const decoded = decodeResponse(spec, reply);
    assert.equal(decoded.ok, true, `${hex}: ${toStr(reply)}`);
    assert.equal(decoded.message, "ERROR");
    assert.equal(decoded.values.code, code, hex);
  }
});

test("실제 서버: 요청을 1바이트씩 쪼개 보내도 같은 응답", { skip }, async () => {
  const reply = await raw("424201010006000100020003", { chunkSize: 1, delayMs: 5 });
  assert.equal(reply.toString("hex"), "42420181000400000006");
});

test("실제 서버: 응답 없는 EOF (헤더 도중에 쓰기 종료)", { skip }, async () => {
  const reply = await new Promise((done, fail) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", fail);
    socket.on("close", () => done(Buffer.concat(chunks)));
    socket.on("connect", () => socket.end(Buffer.from("4242", "hex")));
  });
  assert.equal(reply.length, 0);
});

test("실제 서버: 웹 API 경로로 1 2 3 → sum=6", { skip }, async () => {
  const app = createApp({
    root: ROOT, spec, publicDir: join(ROOT, "web/public"),
    target: { host: "127.0.0.1", port }, practiceServer: server,
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  const webPort = app.address().port;
  const response = await fetch(`http://127.0.0.1:${webPort}/api/send`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numbers: [1, 2, 3] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.response.frame_hex, "42420181000400000006");
  assert.equal(body.result.response.decoded.values.sum, 6);
  assert.equal(body.server.sha256, server.snapshot().sha256);
  await new Promise((done) => { app.closeAllConnections(); app.close(done); });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
test("실제 서버: 웹이 쓰는 그 서버를 N07 평가기(--target)로 평가하면 21/21", { skip: skip || (!hasPython && "python3 필요") }, async () => {
  const app = createApp({
    root: ROOT, spec, publicDir: join(ROOT, "web/public"),
    target: { host: "127.0.0.1", port }, practiceServer: server,
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  const webPort = app.address().port;
  const response = await fetch(`http://127.0.0.1:${webPort}/api/evaluate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const { evaluation } = await response.json();
  assert.equal(evaluation.status, "all_pass", evaluation.stderr_tail || evaluation.error_message);
  assert.equal(evaluation.exit_code, 0);
  assert.equal(evaluation.result.summary.total, 21);
  assert.equal(evaluation.result.summary.pass, 21);
  assert.equal(evaluation.result.summary.all_pass, true);
  assert.equal(evaluation.result.experiment_score, false);
  assert.equal(evaluation.target, `127.0.0.1:${port}`);
  await new Promise((done) => { app.closeAllConnections(); app.close(done); });
});

function toStr(buffer) {
  return buffer.length ? buffer.toString("hex") : "(빈 응답)";
}
