# Resilient candidate validation

**Goal:** Implement the approved validation outcomes: confirmed mismatches reject a candidate, verified fallbacks can recover a tool failure, and incomplete checks retain the original with an inconclusive result.

**Architecture:** Keep the existing stream, HDR, frame, subtitle, and timing contracts. Add a focused validation module with structured reports and one CPU retry for failed QSV verification. Carry the report through the generated Tdarr engine and notifications.

**Constraints:** No relaxed HDR or timestamp tolerances, no automatic metadata rewriting, no extra encode attempt, no automatic source search for an inconclusive check, and no production deployment in this change. Failed candidates use existing cache cleanup; bounded diagnostics survive in job variables/logs.

## Task 1: Decoder recovery and structured results

- [x] Write behavioral tests in `validation.test.js` for QSV failure followed by clean CPU decode, failed CPU decode with and without recognized corruption, error diagnostics with exit zero, unsupported QSV codecs, timeout precedence, and checking only the affected source track.
- [x] Run `node --test validation.test.js`; expect failures for missing behavior.
- [x] Implement `validation.js`: report creation, explicit validation failures, stage execution, and strict candidate decode orchestration. Preserve the batched successful audio decode.
- [x] Run the focused tests; expect all to pass.

## Task 2: Integrate final checks and notices

- [x] Extend the generated-engine integration tests to exercise real software decoding after a simulated unavailable QSV device, a failed verification process, and a rejected candidate with missing retained content.
- [x] Run those new tests; expect current engine behavior to fail the assertions.
- [x] Update `build.py` to use the decoder orchestrator, report validation stages, and preserve structured process failure details. Mark unmeasurable timelines/frame scans inconclusive. Keep confirmed stream/HDR/timing mismatches rejected.
- [x] Update `failure_notify.js` and success notification generation so inconclusive/rejected/recovered results have accurate explanations. Keep source corruption search gated by an independently failed source decode.
- [x] Regenerate `flow.json` and run `node --test validation.test.js integration.test.js failure_notify.test.js success_notify.test.js`; expect all to pass.

## Task 3: Document and review

- [x] Document outcomes, the single CPU verification retry, retained diagnostics, and limits in `README.md` and `FAILURE_DIAGNOSTICS.md`.
- [x] Run `python3 build.py`, `node --test *.test.js`, and `git diff --check`; expect a reproducible artifact and all checks passing.
- [x] Review the full change for any path that permits replacement after an incomplete check, falsely labels source corruption, or retries encoding instead of verification.
- [x] Leave the updated flow and code on `codex/validation-resilience` for review.

Baseline: 212 tests passed before changes. Local FFmpeg can exercise CPU validation with synthetic media; the local host has no Intel Arc device. A production full-length run remains a separate validation step.

Completion evidence: 240/240 local tests passed; repeat builds produced identical `flow.json` bytes; `git diff --check` passed. Independent review findings about resource diagnostics, partial stderr lines, PGS process metadata, and missing source subtitle measurements were reproduced with failing tests and corrected. Final review found no material issues. No production media was replaced or Tdarr flow imported.
