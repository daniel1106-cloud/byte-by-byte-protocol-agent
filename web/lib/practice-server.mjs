// N08: 연습 서버(runs/n06/practice-server)를 웹 백엔드와 같은 컨테이너에서 자식 프로세스로 실행한다.
// 서버는 127.0.0.1에만 바인드하므로 같은 컨테이너 안의 백엔드만 접속할 수 있다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

const START_TIMEOUT_MS = 5000;

export function createPracticeServer({ binary, port, relativeBinary = "runs/n06/practice-server" }) {
  const info = {
    state: "stopped", // stopped | binary_missing | starting | running | exited | failed_to_start
    message: "",
    binary: relativeBinary,
    port,
    pid: null,
    sha256: null,
    size: null,
    banner: null,
    exit_code: null,
    signal: null,
    started_at: null,
  };
  let child = null;
  let stderrText = "";

  return {
    snapshot: () => ({ ...info }),

    async start() {
      if (!existsSync(binary)) {
        info.state = "binary_missing";
        info.message = `${relativeBinary} 가 없습니다. docs/n08-web-client.md의 '서버 빌드' 명령을 먼저 실행하세요.`;
        return info;
      }
      const bytes = readFileSync(binary);
      info.sha256 = createHash("sha256").update(bytes).digest("hex");
      info.size = statSync(binary).size;
      info.state = "starting";
      await new Promise((resolve) => {
        child = spawn(binary, [String(port)], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
        info.pid = child.pid ?? null;
        const timer = setTimeout(() => {
          info.state = "failed_to_start";
          info.message = `서버가 ${START_TIMEOUT_MS / 1000}초 안에 시작 메시지를 내지 않았습니다.`;
          resolve();
        }, START_TIMEOUT_MS);
        child.stderr.on("data", (chunk) => {
          stderrText = (stderrText + chunk.toString("utf8")).slice(-2000);
          const match = stderrText.match(/listening on (127\.0\.0\.1:\d+)/);
          if (match && info.state === "starting") {
            info.state = "running";
            info.banner = stderrText.trim().split("\n").find((line) => line.includes("listening on")) ?? null;
            info.started_at = new Date().toISOString();
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", (error) => {
          info.state = "failed_to_start";
          info.message = `서버를 실행하지 못했습니다: ${error.message}`;
          clearTimeout(timer);
          resolve();
        });
        child.on("exit", (code, signal) => {
          info.exit_code = code;
          info.signal = signal;
          if (info.state === "running" || info.state === "starting") {
            info.state = "exited";
            info.message = `서버 프로세스가 끝났습니다 (code ${code}, signal ${signal}). ${stderrText.trim().slice(-300)}`;
          }
          clearTimeout(timer);
          resolve();
        });
      });
      return info;
    },

    /** SIGTERM으로 끝내고 2초 안에 안 끝나면 SIGKILL. 끝난 뒤 반환한다. */
    async stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill("SIGTERM");
      });
      info.state = "stopped";
      info.message = "웹 서버 종료와 함께 정리했습니다.";
    },
  };
}
