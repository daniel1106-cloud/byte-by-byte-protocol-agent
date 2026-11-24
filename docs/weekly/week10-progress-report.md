# Week 10 Project Progress Report — draft

Team: Byte by Byte  
Project: REA-Assisted Reconstruction and Validation of a Custom TCP Application Protocol  
Progress snapshot: 4–18 November 2026 (KST)  
Status: Team review draft. Confirm the reporting period in LMS before submission.

## 1. Goal for This Week

Connect an LLM's protocol specification to a working TCP client on the public practice server. Prepare a fair comparison between packet-only analysis (A) and analysis of the same packet capture plus evidence from the selected server binary (B). Set up the inputs and grading for the blind experiment.

## 2. Working Result and Evidence

- **Model and tool integration (N05).** Gemini (`gemini-3.5-flash-lite`) called REA on the public practice binary and summarized the returned evidence. The execution log preserves the tool-call ID, the model output, and the supporting quotations. This live run was automated. [Live execution evidence](../evidence/N05-N09-Gemini-integration-2026-11-17.md)
- **Recovered client (N09/N12 practice).** The same model produced a `wire-spec-v1` specification for each condition. The TCP client used those specifications as returned. A and B each passed **15/15** public practice checks, covering five input cases across three write patterns. Both runs used the same TCP stream reconstruction and prompt. B additionally received REA evidence. The two final requests used **13,444 tokens** in total. These runs validate the tested normal-message framing. The public expected values came from the evaluator, and some operation and error semantics still need verification. [PR #11](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/11)
- **Reproduction.** The CI record contains **97/97 Node** and **25/25 Python** regression passes, plus **21/21** public-server baseline TCP checks. Jeong Ui-jong directly reran the 97 Node and 25 Python tests and the two recovered-client evaluations, using the saved model outputs. The direct rerun made zero new model requests and returned 15/15 per condition. [CI](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/actions/runs/44034971195) · [Direct rerun](../evidence/N09-manual-2026-11-17.md)
- **Experiment package and grading.** PR #7 was merged after the committed public inputs' hashes, server startup, loopback connection and shutdown were verified. PR #8 merged the evaluation format and CSV templates. On 18 November, PR #12 proposed clearer error, text and ID rules, and PR #13 proposed writing all 23 result CSV columns directly from N07. In a separate review of the draft, the 26 evaluator tests passed with public fixtures. The evaluation procedure for recovered specifications still needs to be connected to the private test inputs. [PR #7](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/7) · [PR #8](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/8) · [PR #12](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/12) · [PR #13](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/13)

## 3. Blockers

- PRs #10 and #11 are awaiting team review. PRs #12 and #13 are drafts. For the final comparison, we still need to confirm the course model requirement and record the selected model, prompt, input hashes and budget.
- The team still needs to confirm the frozen version of the N11 private rubric and unseen-input set. We also need one end-to-end grading check that carries the analysis ID from the generated client into the evaluation CSV.
- The committed PR #9 cannot start from a fresh checkout because web modules are missing, and the branch conflicts with `main`. Repairing that checkout is needed for the N12 web integration. [PR #9 review](https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent/pull/9#pullrequestreview-5934021944)

## 4. Plan for Next Week

- By 22 November, finish the remaining reviews, freeze the private grading criteria and confirm the specification-to-evaluation connection. Keep the private answers and unseen inputs in the grading environment.
- On 23–29 November, aim to run **five independent blind trials per condition** with the same model and fixed settings. Record every result, including failures, and compare checklist results and client communication using the same grading rules.
- Verify the web flow after PR #9 is repaired. Use the blind-run outputs for client communication checks, then perform the robustness and load measurements in the following stage.

## 5. GitHub Repository

https://github.com/jeonguijong67-hub/byte-by-byte-protocol-agent

## 6. Individual Contributions

- **Jeong Ui-jong (정의종)** integrated Gemini with REA, prepared the A/B analysis and logging, connected the generated specifications to a practice TCP client, and directly reproduced the practice results.
- **Kim Tae-hyung (김태형)** prepared the practice server, the experiment server binary, packet capture and run instructions. He maintains the original implementation and reference material for the private handoff to the evaluator.
- **Kwon Se-hyeon (권세현)** built the evaluator and CSV templates. He submitted follow-up drafts for the grading rules and 23-column evaluator output and reported checking the draft evaluator with private reference cases.
- **Yoo Hyeon-seok (유현석)** prepared the practice web client and result display. His PR is the starting point for fixing fresh-checkout execution and connecting the recovered specification to the web interface.
