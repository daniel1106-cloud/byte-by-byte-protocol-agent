// N04·N08 웹 백엔드 진입점.
//   연습 서버(runs/n06/practice-server)를 이 컨테이너 안에서 127.0.0.1:19006으로 실행하고,
//   웹 화면과 API를 N08_HOST:N08_PORT(기본 127.0.0.1:8080)로 연다.
// 실행법은 docs/n08-web-client.md.
import { resolve } from "node:path";
import { createApp } from "./lib/app.mjs";
import { createPracticeServer } from "./lib/practice-server.mjs";
import { loadSpec } from "./lib/protocol.mjs";

const root = resolve(import.meta.dirname, "..");
const spec = loadSpec(resolve(root, "web/spec/n06-practice.json"));

const webHost = process.env.N08_HOST ?? "127.0.0.1";
const webPort = Number(process.env.N08_PORT ?? 8080);
const serverPort = Number(process.env.N08_SERVER_PORT ?? spec.transport.default_port);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535 || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
  console.error("N08_PORT와 N08_SERVER_PORT는 1~65535의 정수여야 합니다.");
  process.exit(2);
}

const log = (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));

const practiceServer = createPracticeServer({
  binary: resolve(root, process.env.N08_SERVER_BINARY ?? "runs/n06/practice-server"),
  relativeBinary: process.env.N08_SERVER_BINARY ?? "runs/n06/practice-server",
  port: serverPort,
});
const started = await practiceServer.start();
log({ level: started.state === "running" ? "info" : "error", message: "practice server", server: practiceServer.snapshot() });

const app = createApp({
  root, spec, practiceServer, log,
  target: { host: "127.0.0.1", port: serverPort }, // 요청으로 바꿀 수 없다
  publicDir: resolve(root, "web/public"),
});
app.listen(webPort, webHost, () => {
  log({ level: "info", message: `web listening on http://${webHost}:${webPort}`, practice_server_state: practiceServer.snapshot().state });
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log({ level: "info", message: `${signal}: shutting down` });
  app.close();
  app.closeAllConnections?.();
  await practiceServer.stop();
  log({ level: "info", message: "practice server stopped", server: practiceServer.snapshot() });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
