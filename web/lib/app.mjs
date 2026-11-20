// N08: 웹 화면과 API. Node 내장 모듈만 쓴다.
// 접속 대상(host:port)은 서버 시작 때 정해진 값이고 요청으로 바꿀 수 없다.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sendRequest } from "./client.mjs";
import { DEFAULT_CASES, DEFAULT_EVALUATOR, runEvaluation } from "./evaluate.mjs";
import { InputError } from "./protocol.mjs";
import { BusyError, createSerialQueue } from "./queue.mjs";

const MAX_BODY_BYTES = 4096;
const WEB_MIN_COUNT = 1; // 웹 입력은 숫자 1~32개 (명세는 0개도 허용하지만 참고 클라이언트처럼 1개 이상)

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "body_too_large", `요청 본문은 ${MAX_BODY_BYTES}바이트 이하여야 합니다.`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "요청 본문이 JSON 객체가 아닙니다.");
  }
}

function rejectUnknownKeys(body, allowed) {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw new HttpError(400, "unknown_field", `허용되지 않은 필드: ${extra.join(", ")}. 접속 대상은 서버에 고정돼 있어 요청으로 바꿀 수 없습니다.`);
  }
}

/**
 * options.root          저장소 루트 (평가기 스크립트와 결과 폴더의 기준)
 * options.spec          읽어 둔 명세 객체
 * options.target        { host, port } 고정 접속 대상
 * options.practiceServer snapshot()을 가진 객체 (실행 상태)
 * options.publicDir     정적 파일 폴더
 * options.evaluator     테스트에서만 바꾸는 평가기 명령 배열 (요청으로는 바뀌지 않음)
 */
export function createApp({ root, spec, target, practiceServer, publicDir, evaluator = DEFAULT_EVALUATOR, evaluationTimeoutMs, sendTimeoutMs = 3000, log = () => {} }) {
  const queue = createSerialQueue({ maxPending: 8 });
  const state = { latestEvaluation: null };

  const specSummary = {
    name: spec.name, format: spec.format, classification: spec.classification,
    experiment_score: spec.experiment_score, source: spec.source,
  };

  function checkHost(req) {
    const hostname = hostnameOf(req.headers.host);
    if (!hostname || !LOOPBACK_NAMES.has(hostname)) {
      throw new HttpError(403, "forbidden_host", "이 화면은 localhost / 127.0.0.1로만 열 수 있습니다.");
    }
  }

  function checkPost(req) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, "forbidden_origin", "같은 출처의 요청만 받습니다.");
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      throw new HttpError(415, "unsupported_media_type", "Content-Type은 application/json이어야 합니다.");
    }
  }

  function requireServer() {
    const snap = practiceServer.snapshot();
    if (snap.state !== "running") {
      throw new HttpError(503, "server_unavailable", snap.message || `연습 서버가 실행 중이 아닙니다 (state: ${snap.state}).`);
    }
    return snap;
  }

  const serverInfo = (snap) => ({ host: target.host, port: target.port, pid: snap.pid, sha256: snap.sha256, binary: snap.binary });

  async function route(req, res) {
    checkHost(req);
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" || req.method === "HEAD") {
      if (STATIC_FILES[path]) {
        const [file, type] = STATIC_FILES[path];
        const body = readFileSync(join(publicDir, file));
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (path === "/api/spec") return sendJson(res, 200, spec);
      if (path === "/api/health") {
        const snap = practiceServer.snapshot();
        return sendJson(res, 200, {
          ok: snap.state === "running",
          now: new Date().toISOString(),
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          spec: specSummary,
          server: { ...snap, host: target.host, port: target.port },
          queue: { pending: queue.pending },
          evaluator: {
            script_present: existsSync(join(root, evaluator[evaluator.length - 1])),
            cases_present: existsSync(join(root, DEFAULT_CASES)),
            cases_file: DEFAULT_CASES,
          },
        });
      }
      if (path === "/api/evaluate/latest") return sendJson(res, 200, { evaluation: state.latestEvaluation });
      throw new HttpError(404, "not_found", "없는 경로입니다.");
    }

    if (req.method === "POST") {
      checkPost(req);
      const body = await readJsonBody(req);

      if (path === "/api/send") {
        rejectUnknownKeys(body, ["numbers"]);
        const snap = requireServer();
        let result;
        try {
          result = await queue.run(() => sendRequest({
            spec, numbers: body.numbers, host: target.host, port: target.port, timeoutMs: sendTimeoutMs, minCount: WEB_MIN_COUNT,
          }));
        } catch (error) {
          if (error instanceof InputError) throw new HttpError(400, "invalid_input", error.message);
          if (error instanceof BusyError) throw new HttpError(429, "busy", error.message);
          throw error;
        }
        return sendJson(res, 200, { result, server: serverInfo(snap) });
      }

      if (path === "/api/evaluate") {
        rejectUnknownKeys(body, []);
        const snap = requireServer();
        let evaluation;
        try {
          evaluation = await queue.run(() => runEvaluation({
            root, host: target.host, port: target.port, command: evaluator, timeoutMs: evaluationTimeoutMs,
          }));
        } catch (error) {
          if (error instanceof BusyError) throw new HttpError(429, "busy", error.message);
          throw error;
        }
        evaluation = { ...evaluation, server: serverInfo(snap), finished_at: new Date().toISOString() };
        state.latestEvaluation = evaluation;
        return sendJson(res, 200, { evaluation });
      }
      throw new HttpError(404, "not_found", "없는 경로입니다.");
    }

    throw new HttpError(405, "method_not_allowed", "GET, HEAD, POST만 지원합니다.");
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.code, message: error.message });
        else res.end();
      } else {
        log({ level: "error", message: error.stack ?? String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: "서버 내부 오류입니다." });
        else res.end();
      }
    } finally {
      log({ level: "info", method: req.method, path: req.url?.split("?")[0], status: res.statusCode, ms: Date.now() - started });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
