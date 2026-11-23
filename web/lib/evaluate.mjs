// N08: 웹이 쓰는 그 연습 서버를 N07 평가기(--target 모드)로 평가하고 결과 JSON을 읽는다.
// 명령은 인자 배열로만 실행하고(shell 없음) 사용자가 준 값은 어디에도 들어가지 않는다.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_CAPTURE = 64 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export const DEFAULT_EVALUATOR = ["python3", "scripts/n07-evaluate.py"];
export const DEFAULT_CASES = "practice/n06/cases.json";

export const STATUS_TEXT = {
  all_pass: "평가 완료 · 전부 통과 (summary.all_pass)",
  completed_with_mismatch: "평가 완료 · 불일치(fail/error)가 있음",
  run_failed: "평가 실행 실패 (결과를 얻지 못함)",
  timeout: "평가 시간 초과 (프로세스를 종료함)",
};

/** 실행마다 새 결과 경로가 필요하다(N07은 기존 파일을 덮어쓰지 않고 거부한다). */
export function newRunTag(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function collect(stream, limit) {
  const chunks = [];
  let size = 0;
  stream.on("data", (chunk) => {
    if (size >= limit) return;
    chunks.push(chunk.subarray(0, limit - size));
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

export async function runEvaluation({
  root,
  host,
  port,
  casesFile = DEFAULT_CASES,
  outDir = "runs/n08",
  command = DEFAULT_EVALUATOR,
  timeoutMs = 120_000,
}) {
  const tag = newRunTag();
  const outFile = `${outDir}/eval-web-${tag}.json`;
  const args = [...command.slice(1), "--cases", casesFile, "--target", `${host}:${port}`, "--out", outFile];
  const started = Date.now();

  const base = {
    tag,
    out_file: outFile,
    csv_file: outFile.replace(/\.json$/, ".csv"),
    command: [command[0], ...args],
    target: `${host}:${port}`,
  };
  const failed = (message, extra = {}) => ({
    ...base, status: "run_failed", status_text: STATUS_TEXT.run_failed, error_message: message,
    exit_code: null, signal: null, result: null, stderr_tail: "", duration_ms: Date.now() - started, ...extra,
  });

  try {
    mkdirSync(join(root, outDir), { recursive: true });
  } catch (error) {
    return failed(`결과 폴더 ${outDir}를 만들 수 없습니다: ${error.message}`);
  }

  const outcome = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], args, { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ spawnError: error });
      return;
    }
    const stdout = collect(child.stdout, MAX_CAPTURE);
    const stderr = collect(child.stderr, MAX_CAPTURE);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdout(), stderr: stderr() });
    });
  });

  if (outcome.spawnError) {
    return failed(`평가기를 실행하지 못했습니다: ${outcome.spawnError.message}`);
  }
  const stderrTail = outcome.stderr.slice(-2000);
  const common = { ...base, exit_code: outcome.code, signal: outcome.signal, stderr_tail: stderrTail, duration_ms: Date.now() - started };

  if (outcome.timedOut) {
    return { ...common, status: "timeout", status_text: STATUS_TEXT.timeout, result: null };
  }

  let result = null;
  const resultPath = join(root, outFile);
  if (existsSync(resultPath)) {
    try {
      if (statSync(resultPath).size > MAX_RESULT_BYTES) throw new Error("결과 JSON이 너무 큽니다");
      result = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (error) {
      return { ...common, status: "run_failed", status_text: STATUS_TEXT.run_failed, result: null, error_message: `결과 JSON을 읽지 못했습니다: ${error.message}` };
    }
  }
  if (!result) {
    return { ...common, status: "run_failed", status_text: STATUS_TEXT.run_failed, result: null, error_message: `종료 코드 ${outcome.code}, 결과 JSON이 만들어지지 않았습니다.` };
  }
  // success:true 는 "평가 절차가 끝났다"는 뜻일 뿐이다. 통과 여부는 summary.all_pass와 케이스별 verdict로 본다.
  if (result.success !== true) {
    return { ...common, status: "run_failed", status_text: STATUS_TEXT.run_failed, result, error_message: `평가가 중간에 멈췄습니다 (stage: ${result.stage}).` };
  }
  const allPass = result.summary?.all_pass === true && outcome.code === 0;
  return {
    ...common,
    status: allPass ? "all_pass" : "completed_with_mismatch",
    status_text: allPass ? STATUS_TEXT.all_pass : STATUS_TEXT.completed_with_mismatch,
    result,
  };
}
