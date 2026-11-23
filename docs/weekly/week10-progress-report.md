# Week 10 Project Progress Report — draft

Team: Byte by Byte  
Project: REA-Assisted Reconstruction and Validation of a Custom TCP Application Protocol  
Reporting period: 2026-11-04 to 2026-11-13 (cumulative snapshot; update the period and results before LMS submission)  
Status: Prepared for review; not submitted to LMS.

## 1. Goal for This Week

Build and validate the shared practice pipeline, prepare fair packet-only (A) and packet-plus-binary/REA (B) analysis inputs, and prepare the experiment package and evaluation format while access to the course GLM API is delayed.

## 2. Working Result and Evidence

- The N05–N07 practice components were integrated in main through PRs #1–#6. The team recorded 25/25 N05 mock tests and 21/21 actual N06 TCP evaluation cases. Jeong Ui-jong directly reproduced the key-free integration on 2026-11-09; the actual course-model loop remains unverified.
- PR #10 implements offline A/B preparation, a shared prompt and declared model budget, a common result envelope, input hashes, and stage-specific success/failure records. Condition A rejects a binary selection before input/output access; B reuses N05 REA-only validation for the selected binary. The current CI records 55/55 Node mock tests, 21/21 Python evaluator regression tests, actual public-PCAP preparation, and 21/21 practice TCP cases. Real A/B preparation and retained REA evidence are documented separately in the linked N09 evidence.
- PR #7 provides the versioned experiment binary, capture, execution instructions, and input hashes. Its author reports successful REA-only analysis and private self-checks. We did not inspect or rerun private answer material in this review. The author's manual check covers one original-client session.
- PR #8 supplies the evaluation-format draft and blank CSV templates. Its author records 21/21 evaluator tests and CSV-column checks. The example CSV values are illustrative, not experimental measurements. The actual N11 checklist and unseen-input tests are not yet confirmed as frozen.
- PR #9 supplies the practice web-to-server path and N07 result display. Its evidence JSON records 51/51 container tests (44 mock and 7 actual-server tests), five matching practice API sessions, and 21/21 web/CLI evaluation cases. These are the author's AI-run records; the owner's direct execution check is pending.

All results above use public practice inputs or implementation checks. No course-model A/B reconstruction scores, automatically recovered clients, or E2/E3 load-performance measurements are claimed. PRs #7–#10 remain open at this snapshot; #7 has a merge conflict.

Evidence:
- N09 implementation: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/10
- N09 execution evidence: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/blob/n09-ab-keyless-preparation/docs/evidence/N09-2026-11-13.md
- Prior owner reproduction: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/blob/main/docs/evidence/N05-manual-2026-11-09.md
- N10 package: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/7
- Evaluation format: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/8
- Practice web integration: https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/9

## 3. Blockers

The course GLM API is expected next week according to the latest team update, but its exact delivery date, model ID, and endpoint are unconfirmed. Actual model tool calls, summaries, and protocol reconstruction cannot yet be validated. Work on inputs, evaluation, logging, and practice integration continues.

N10 requires merge-conflict resolution and confirmation that private reference material has been transferred to the evaluator. N11 must freeze the private checklist and unseen inputs before the blind comparison. N12 still needs an agreed executable-spec format and an adapter from the N09 output envelope. Team-owner checks are pending for the newly submitted N03/N08/N09 work.

## 4. Plan for Next Week

- Resolve/review the open PRs and retain reproducible evidence with each contribution.
- Freeze the N10 input hashes and N11 private grading version; keep answers outside the analysis environment.
- Complete the practice N12 specification-to-client integration. Reject missing or empty specifications instead of treating them as reconstructed clients.
- When API access becomes available, verify the actual model ID and tool-call behavior, complete the N05 real loop, and validate N09 output and evidence meaning.
- After freezing the model, prompts, budgets, and evaluator, perform five independent runs per condition and retain every success and failure. If API delivery slips again, report the dependency and adjust the experimental schedule.

## 5. GitHub Repository

https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent

## 6. Individual Contributions

- **Jeong Ui-jong (정의종):** Integrated N05–N07 and personally reproduced the practice evaluation/REA input-hash checks on 11/09. Implemented key-free N09 A/B preparation, output/evidence contracts, regression tests, CI, and the report/handoff records. New N09 validation is CI/AI execution; the owner's new manual check is pending.
- **Kim Tae-hyung (김태형):** Produced the N02/N06 practice server, original client, capture, and cases; provided the N10 experiment binary/capture/instructions and maintained private reference material. His recorded manual N10 check covers one original-client session.
- **Kwon Se-hyeon (권세현):** Built and personally checked the initial N07 practice evaluator; supplied the N03 evaluation-format draft and CSV templates. The new format owner's check and N11 private grading integration remain pending.
- **Yoo Hyeon-seok (유현석):** Implemented the N04/N08 web client, local backend, actual practice-server communication, and N07 result display. Submitted AI-run evidence; the owner's manual check and N12 automatic client generation remain pending.
