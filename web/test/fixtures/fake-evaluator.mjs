// 테스트용 가짜 평가기. scripts/n07-evaluate.py와 같은 인자(--cases --target --out)를 받는다.
// FAKE_EVAL_MODE: pass | mismatch | abort | crash | hang
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const out = get("--out");
const mode = process.env.FAKE_EVAL_MODE ?? "pass";

if (existsSync(out)) {
  console.error("refusing to overwrite");
  process.exit(2);
}
if (mode === "crash") {
  console.error("boom");
  process.exit(3);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const bad = mode === "mismatch";
  const result = {
    task: "N07", classification: "practice", experiment_score: false,
    stage: mode === "abort" ? "cases" : "complete", success: mode !== "abort",
    started_at: "2026-01-01T00:00:00+09:00", finished_at: "2026-01-01T00:00:01+09:00",
    received_args: args,
    summary: { total: 2, pass: bad ? 1 : 2, fail: bad ? 1 : 0, error: 0, pass_rate: bad ? 0.5 : 1, all_pass: !bad },
    results: [
      { case_id: "a", description: "d", verdict: "pass", request_chunks_hex: ["00"], half_close: false, expected_hex: "00", actual_hex: "00", expected_text: "", actual_text: "", first_diff_offset: null, server_closed: true, elapsed_ms: 1, error: null },
      { case_id: "b", description: "d", verdict: bad ? "fail" : "pass", request_chunks_hex: ["00"], half_close: false, expected_hex: "01", actual_hex: bad ? "02" : "01", expected_text: "", actual_text: "", first_diff_offset: bad ? 0 : null, server_closed: true, elapsed_ms: 1, error: null },
    ],
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result));
  process.exit(mode === "pass" ? 0 : 1);
}
