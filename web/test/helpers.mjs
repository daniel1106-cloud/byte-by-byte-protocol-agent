import net from "node:net";
import { resolve } from "node:path";
import { loadSpec } from "../lib/protocol.mjs";

export const spec = loadSpec(resolve(import.meta.dirname, "../spec/n06-practice.json"));
export const SUM_6 = Buffer.from("42420181000400000006", "hex"); // 1+2+3
export const REQUEST_1_2_3 = Buffer.from("424201010006000100020003", "hex");
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 진짜 TCP 가짜 서버. handler(socket)가 연결마다 불린다. */
export async function fakeServer(handler) {
  const sockets = new Set();
  const stats = { connections: 0, concurrent: 0, maxConcurrent: 0 };
  const server = net.createServer((socket) => {
    stats.connections += 1;
    stats.concurrent += 1;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      stats.concurrent -= 1;
      sockets.delete(socket);
    });
    handler(socket);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: server.address().port,
    stats,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

/** 정확히 length 바이트가 올 때까지 모은다. */
export function readExactly(socket, length) {
  return new Promise((done) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        socket.off("data", onData);
        done(buffer);
      }
    };
    socket.on("data", onData);
  });
}

/** 바이트를 1개씩 delayMs 간격으로 쓴다. */
export async function writeOneByOne(socket, buffer, delayMs = 3) {
  for (const byte of buffer) {
    socket.write(Buffer.from([byte]));
    await sleep(delayMs);
  }
}
