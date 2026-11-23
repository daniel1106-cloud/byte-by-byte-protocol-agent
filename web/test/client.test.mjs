import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { sendRequest } from "../lib/client.mjs";
import { REQUEST_1_2_3, SUM_6, fakeServer, readExactly, sleep, spec, writeOneByOne } from "./helpers.mjs";

const call = (server, options = {}) =>
  sendRequest({ spec, numbers: [1, 2, 3], host: "127.0.0.1", port: server.port, timeoutMs: 1500, settleMs: 150, minCount: 1, ...options });

test("정상 응답 한 번에 도착", async () => {
  const received = [];
  const server = await fakeServer(async (socket) => {
    received.push(await readExactly(socket, 12));
    socket.end(SUM_6);
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.response.decoded.values.sum, 6);
  assert.equal(result.response.frame_hex, "42420181000400000006");
  assert.equal(result.connection.connected, true);
  assert.equal(result.connection.closed_by_server, true);
  assert.deepEqual(received[0], REQUEST_1_2_3); // 서버가 받은 요청 바이트도 맞다
  assert.ok(result.elapsed_ms >= 0);
});

test("응답을 1바이트씩 쪼개서 보내도 하나의 프레임으로 모은다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    await writeOneByOne(socket, SUM_6, 4);
    socket.end();
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.decoded.values.sum, 6);
  assert.equal(result.response.bytes_received, 10);
});

test("헤더 한가운데(3바이트)에서 나뉘어도 된다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.write(SUM_6.subarray(0, 3));
    await sleep(40);
    socket.write(SUM_6.subarray(3, 7));
    await sleep(40);
    socket.end(SUM_6.subarray(7));
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.decoded.values.sum, 6);
});

test("오류 프레임(code 04)은 error_frame으로 구분한다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end(Buffer.from("424201ff000104", "hex"));
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "error_frame");
  assert.equal(result.ok, false);
  assert.equal(result.response.decoded.values.code, 4);
  assert.match(result.response.decoded.meanings.code, /bad length/);
});

test("응답 없이 서버가 연결을 닫으면 eof_no_response", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end();
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "eof_no_response");
  assert.equal(result.connection.connected, true);
  assert.equal(result.connection.closed_by_server, true);
  assert.equal(result.response.bytes_received, 0);
});

test("응답이 도중에 끊기면 truncated (받은 바이트 보존)", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end(SUM_6.subarray(0, 4));
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "truncated");
  assert.equal(result.response.hex, "42420181");
});

test("서버가 연결만 받고 아무 말이 없으면 timeout (EOF와 구분)", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
  });
  const started = Date.now();
  const result = await call(server, { timeoutMs: 250 });
  await server.close();
  assert.equal(result.outcome, "timeout");
  assert.equal(result.connection.connected, true);
  assert.equal(result.connection.closed_by_server, false);
  assert.ok(Date.now() - started < 1500);
});

test("응답이 절반만 오고 멈추면 timeout, 받은 부분은 남는다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.write(SUM_6.subarray(0, 8));
  });
  const result = await call(server, { timeoutMs: 250 });
  await server.close();
  assert.equal(result.outcome, "timeout");
  assert.equal(result.response.hex, "4242018100040000");
});

test("닫힌 포트는 connect_failed", async () => {
  const probe = net.createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  const result = await sendRequest({ spec, numbers: [1], host: "127.0.0.1", port, timeoutMs: 1000, minCount: 1 });
  assert.equal(result.outcome, "connect_failed");
  assert.equal(result.connection.connected, false);
  assert.equal(result.connection.error_code, "ECONNREFUSED");
});

test("magic이 틀린 응답은 protocol_violation", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end(Buffer.from("41420181000400000006", "hex"));
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "protocol_violation");
  assert.match(result.violation, /magic/);
});

test("명세에 없는 length(한 프레임이 너무 긴 응답)도 protocol_violation", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end(Buffer.from("42420181004000000000", "hex")); // length 0x40인데 SUM_RESPONSE는 4여야 한다
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "protocol_violation");
  assert.match(result.violation, /length/);
});

test("프레임 뒤에 바이트가 더 오면 ok이지만 기록한다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.end(Buffer.concat([SUM_6, Buffer.from("ff", "hex")]));
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.trailing_hex, "ff");
  assert.equal(result.notes.length, 1);
});

test("프레임을 보낸 뒤 연결을 닫지 않으면 closed_by_server:false로 기록한다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.write(SUM_6); // 연결은 열어 둔다
  });
  const result = await call(server, { settleMs: 120 });
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.connection.closed_by_server, false);
});

test("응답을 다 받은 뒤의 연결 리셋은 ok에 영향을 주지 않고 기록만 한다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.write(SUM_6);
    await sleep(20);
    socket.resetAndDestroy();
  });
  const result = await call(server);
  await server.close();
  assert.equal(result.outcome, "ok");
  assert.equal(result.response.decoded.values.sum, 6);
});

test("응답 전에 리셋되면 connection_error", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.resetAndDestroy();
  });
  const result = await call(server);
  await server.close();
  assert.ok(["connection_error", "eof_no_response"].includes(result.outcome), result.outcome);
  assert.equal(result.ok, false);
});

test("서버가 끝없이 보내면 한도에서 끊는다", async () => {
  const server = await fakeServer(async (socket) => {
    await readExactly(socket, 12);
    socket.write(Buffer.from("42420181000400000006", "hex")); // 정상 프레임 하나
    socket.write(Buffer.alloc(8192, 0x61)); // 그 뒤로 쓰레기
  });
  const result = await call(server, { settleMs: 800 });
  await server.close();
  assert.ok(["ok", "protocol_violation"].includes(result.outcome), result.outcome);
  assert.ok(result.response.bytes_received <= 4096 + 8192);
});

test("잘못된 입력은 연결하기 전에 InputError", async () => {
  await assert.rejects(() => sendRequest({ spec, numbers: [70000], host: "127.0.0.1", port: 1, minCount: 1 }), { name: "InputError" });
});
