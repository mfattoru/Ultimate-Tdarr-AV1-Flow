# V6: concurrent jobs, PGS validation and failure notifications

Work in a separate export; never change the live Tdarr workflow or library. Preserve original input and accepted audio/subtitle behavior, use the Arc and bounded quality values, require smaller output, and do not keep permanent recovery copies.

1. Reproduce the reported V3 failure: compare remuxed PGS segment payloads and timestamps with the source. Implement a packetization-independent PGS content and timeline validator; add regression tests for same-content regrouping and missing/retimed segments.
2. Route both controlled failures and unexpected flow errors through a deduplicating Discord failure notification; retain the actual reason in flow variables and keep failure status if notification fails. Test with mock HTTPS only.
3. Replace the whole-job capacity lock with per-filesystem reservations guarded by a short mutex. Preserve cleanup ownership and recoverability; handle /dev/shm and disk independently, concurrency, low space and crashes conservatively.
4. Investigate supported HDR/Dolby paths; enable only conversions whose pixel transform and output metadata can be validated. Preserve user-approved HDR10 fallback and report unsupported or unverified variants rather than destroying originals.
5. Run unit and integration regressions, disposable node tests for PGS and Arc, independent review, and document live-deployment limits.
6. Preserve styled ASS/SSA subtitle tracks in Matroska: stream-copy them without SRT conversion, validate their output codec/packet count/timeline, and separately confirm Jellyfin playback on the TV and phone.

---

# V15 Resilience & Compatibility Plan (Out-of-Order ASS, Video Timestamp Quantization, Dynamic-HDR Seek-Heal Stream-Copy Preservation)

## Change Categorization
- **In-Place Behavioral & Feature Enhancements**:
  1. **Chronological ASS/SSA Subtitle Normalization & Multiset Validation** (`Overlord - S01E08` and general Matroska anime/remuxes).
  2. **Video Timestamp Quantization Tolerance & Input DTS Preservation** (`Street Fighter (2026)` and general B-frame / VFR-origin WebRips).
  3. **Dynamic-HDR Seek-Heal Stream-Copy Preservation** (`Challengers (2024)` and compact 4K WEB-DLs): Allow dynamic HDR routes (`dovi81_hdr10`, `dovi7_hdr10`, `hdr10plus_hdr10`, `dovi81_hdr10plus_hdr10`, `dovi7_hdr10plus_hdr10`) to use the `seek-heal` source-video stream-copy remux (`ArcAV1_SeekHeal_V15`) when `ICQ 22` reaches the quality floor, and validate that stream-copied candidates preserve their exact source Dolby Vision RPU and HDR10+ dynamic metadata frame counts alongside static HDR metadata.

## Files Affected
- [`subtitle_timing.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/subtitle_timing.js):
  - Extend `createSubtitleTimingPrecheck` / packet analysis to identify which retained ASS/SSA streams contain out-of-order packets (`backwardPackets > 0` or `maxAdjustmentSeconds > 0`).
  - Add helper to reconstruct/normalize an out-of-order Matroska ASS/SSA stream into a temporary `.ass` subtitle input (ordered by `ReadOrder` so FFmpeg's `assdec` emits packets in chronological `pts` order while preserving `[Script Info]`, `[V4+ Styles]`, event payloads, `pts`, and `duration`).
  - Update `validateCopiedSubtitlePackets` so out-of-order source ASS/SSA streams are validated against the chronologically sorted output packets (verifying exact packet count, monotonic output PTS/DTS, payload integrity, and per-event timestamp/duration fidelity within `maxRepairSeconds`), while monotonic source tracks retain strict index-by-index validation.
- [`policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - Update `compareVideoTimestamps` to:
    1. Tolerate Matroska timebase quantization ties / sub-frame jitter (`<= 0.002s` / 2 ms step between adjacent frames) when the source advances, while still enforcing the strict `0.050s` (50 ms) cumulative presentation drift bound (`|(a[i]-a[0]) - (b[i]-b[0])| <= 0.050`).
    2. Include exact `source[i-1] -> source[i]` and `output[i-1] -> output[i]` timestamps in `video_timestamp_order_changed` when a genuine backward jump (`> 0.002s`) occurs.
- [`progress.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/progress.js):
  - Update `runSingleQuality` (or add bounded quality step-up `qualitySteps`, e.g. `[quality, quality + 2, quality + 4]` capped at `51`) when an AV1 encode hits `quality_floor` (`size >= sourceSize`) so compact sources (especially dynamic HDR routes that cannot fall back to stream-copy `seek_heal_remux`) can step up ICQ to produce a smaller valid AV1 output.
- [`build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) & [`build_additions.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_additions.py):
  - **Stale Quarantine Self-Healing (Preflight)**:
    - Before running the full CPU source frame scan, if `quarantinedCandidate` is loaded:
      - Retire/remove the quarantined candidate and proceed with a fresh encode if `quarantinedCandidate.kind === 'seek_heal_remux'` and preflight detects a dynamic HDR route (`preflightDoviRoute` or HDR10+ signaling where `mustRetainOriginalAtQualityFloor` applies).
      - Retire/remove the quarantined candidate and proceed with a fresh encode if the source requires retained attachments (`retainedAttachmentStreams.length > 0`) that are missing from the quarantined candidate, or if the source has out-of-order ASS/SSA packets that the quarantined candidate corrupted via `setts`.
  - **Out-of-Order ASS Normalization in FFmpeg Pipeline**:
    - When `createSubtitleTimingPrecheck` detects an ASS/SSA stream whose packets are out of chronological order, extract/normalize that stream into a job-scoped temporary `.ass` file in the scratch directory and map it into FFmpeg (`-i normalized.ass -c:s:<idx> copy`) without applying the destructive `setts=max(PTS,PREV_OUTPTS)` clamp.
  - **FFmpeg Input Timestamp Flags**:
    - Use `-fflags +genpts` on normal video encodes (preserving valid input container DTS for B-frame streams) and reserve `+igndts` only for `forceStreamCopy` (`seek_heal_remux`) and Dolby RPU annex-B extraction.
- **Test Files (`*.test.js`)**:
  - [`subtitle_timing.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/subtitle_timing.test.js): Add unit & FFmpeg integration tests for out-of-order ASS subtitle normalization and chronological multiset validation (including the exact `5.000s` -> `1.860s` pattern from `Overlord - S01E08`).
  - [`hdr_route.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/hdr_route.test.js) / [`validation_resilience.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/validation_resilience.test.js): Add tests for `compareVideoTimestamps` 1–2 ms quantization ties vs. true backward jumps, ICQ step-up on `quality_floor`, and preflight retirement of incompatible quarantined candidates.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json) & [`FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md):
  - Rebuild `flow.json` via `python3 build.py` and document the updated behavior.

## Step-by-Step Execution Path (TDD)
1. **Red Phase (Write Failing Tests)**:
   - Add failing tests in `subtitle_timing.test.js` for out-of-order ASS packet normalization and chronological validation.
   - Add failing tests in `validation_resilience.test.js` / `hdr_route.test.js` for:
     - `compareVideoTimestamps` allowing 1 ms Matroska quantization ties while rejecting true backward jumps with full timestamp details in the error message.
     - `runSingleQuality` stepping up ICQ (`+2`, `+4`) when the base ICQ hits the source-size cap (`quality_floor`).
     - Preflight quarantine self-healing (retiring `seek_heal_remux` on dynamic HDR routes and retiring candidates missing attachments / having `setts`-clamped ASS tracks).
2. **Green Phase (Implement Production Logic)**:
   - Implement the changes in `subtitle_timing.js`, `policy.js`, `progress.js`, `build.py`, and `build_additions.py`.
3. **Refactor & Verify**:
   - Rebuild `flow.json` via `python3 build.py`.
   - Run the complete test suite to verify 100% pass rate and zero regressions.
   - Update `FAILURE_DIAGNOSTICS.md`.

---

# V15 HDR Fixes: Dolby Level 6 Conflict Fallback & Dolby Vision Profile 5 -> HDR10 Path

## Change Categorization
- **In-Place Behavioral Change (`Pirates` Option 1A)**: Update `resolveHdrLight` in `policy.js` so Dolby Vision HDR10-compatible fallback routes (`dovi81_hdr10`, `dovi7_hdr10`, `dovi81_hdr10plus_hdr10`, `dovi7_hdr10plus_hdr10`) do not borrow conflicting Level 6 `MaxCLL`/`MaxFALL` when the verified HDR10 base layer omits CLL (or sets `0,0`) and Level 6 mastering luminance differs from the HDR10 base. Instead, omit CLL (`override: null`), emit a structured warning, and proceed with encoding the verified HDR10 base layer without CLL.
- **New Feature Addition (`Dune` `dovi5_hdr10` Route)**: Add a dedicated `dovi5_hdr10` route converting verified Dolby Vision Profile 5 (`dvhe.05`, full-range IPT-PQ-c2 with no HDR10 base layer) to limited-range BT.2020 PQ HDR10 AV1 via Vulkan `libplacebo` (`apply_dolbyvision=true`) + `dovi_tool` Level 6 / Level 9 static HDR10 metadata synthesis.

## Files Affected
- [`policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - Update `resolveHdrLight` for Option 1A Level 6 luminance conflict handling + `warning` field.
  - Add `isVerifiedDolbyProfile5Config`, `parseDolbyLevel9`, `summarizeLevel9Rows`, `extractDolbyProfile5HdrMetadata`, `formatMasteringDisplayArg`, and `buildDovi5HdrTarget`.
  - Update `preflightDolbyHdrRoute` and `determineHdrRoute` to admit and verify `dovi5_hdr10`.
- [`progress.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/progress.js):
  - Allow optional `env` override in `runLimitedFfmpeg` so FFmpeg inherits Intel Vulkan ICD variables without mutating global container environment.
- [`build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py):
  - Log `resolveHdrLight` warnings on Option 1A fallback.
  - Enforce `dovi5_hdr10` preflight capability gate (`libplacebo` filter + `/usr/share/vulkan/icd.d/intel_icd.json`) and extract RPU Level 6 + Level 9 metadata before the full source scan.
  - Configure CPU decode + Vulkan `libplacebo` filter (`apply_dolbyvision=true:colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv:tonemapping=clip:peak_detect=false:format=p010le` / `yuv420p10le` for SVT-AV1 fallback) + `sidedata=mode=delete:type=DOVI_METADATA` (+ `CONTENT_LIGHT_LEVEL` strip when CLL is absent/0,0), `-mastering_display` / `-content_light` before `-i`, `VK_ICD_FILENAMES` / `VK_DRIVER_FILES` override, and strict HDR10 + `dovi5_hdr10` stream-copy fallback validation.
- [`flow_test_runtime.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow_test_runtime.js), [`policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js), [`progress.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/progress.test.js), [`flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js): TDD unit and flow-wiring tests.
- [`README.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/README.md), [`V15_DESIGN.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/V15_DESIGN.md), [`HDR_LIVE_VALIDATION.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/reports/HDR_LIVE_VALIDATION.md), [`FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md), and regenerated [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json).

## Step-by-Step Execution Path (TDD)
1. **Red Phase**: Update conflicting Level 6 tests in `policy.test.js` and add failing unit/wiring tests for Option 1A warnings, `dovi5_hdr10` classification/Level 9 synthesis, `runLimitedFfmpeg` `env` propagation, and flow wiring; run `node --test *.test.js`.
2. **Green Phase**: Implement logic in `policy.js`, `progress.js`, `build.py`, and `flow_test_runtime.js`, update docs, and run `python3 build.py`.
3. **Verify**: Run `node --test *.test.js` to confirm all tests pass, smoke-verify `dovi5_hdr10` in the Unraid test container if appropriate, and author `walkthrough.md`.

---

# V15 Notification & Arr Offline Resilience Hardening Plan

## Change Categorization
- **Feature Addition / Non-Breaking Resilience Hardening** (with minor in-place behavioral refinements to `discord_success` and Arr HTTP stream handling):
  - No changes to flow topology, edge handles, output numbers (`outputNumber`), embed payloads, or environment variable names (`TDARR_DISCORD_WEBHOOK`, `TDARR_ARR_*`).
  - Refines `discord_success` delivery to match the defensive transport guarantees already enforced in `already_notify.js` and `failure_notify.js` (response stream error handling, wall-clock timeout, explicit webhook URL/protocol checks, and `args.jobLog` reporting), and closes the same response-stream error gap in `notify_arr` / `arr_action.js`.

## Files Affected
- [`src/discord_webhook.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/discord_webhook.js) *(new shared helper)*:
  - Provide a single hardened `sendDiscordWebhook(webhookUrl, payload, options)` helper used across all Discord notification nodes:
    - Validate `TDARR_DISCORD_WEBHOOK` presence and `https:` protocol before opening sockets, returning structured non-throwing failure status without logging webhook credentials/tokens.
    - Pass full `URL` (`protocol`, `hostname`, `port`, `pathname`, `search`) to `https.request`.
    - Attach both `request.on('error')` and `response.on('error')` so mid-stream socket resets when Unraid/internet drops cannot raise an unhandled `EventEmitter` `'error'`.
    - Enforce both an explicit wall-clock `setTimeout` (guarded with `typeof clearTimeout === 'function'` fallback safety) and `request.setTimeout` so stalled DNS lookups or sockets always settle within the configured budget.
    - Support bounded retries (`maxRetries`, `429` `retry_after` capped to a safe ceiling, `5xx`/network/timeout backoff) with an optional `maxTotalWaitMs` cap so offline retries never stall a Tdarr worker indefinitely.
    - Log sanitized diagnostics via `args.jobLog` (with `console` fallback).
- [`src/already_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/already_notify.js) & [`src/failure_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/failure_notify.js):
  - Delegate HTTPS POST delivery to `sendDiscordWebhook` (`retries: 1`, `timeoutMs: 10000`), removing duplicated `https.request` boilerplate while preserving existing log messages, `user.failure_notified` retry semantics, and `outputNumber` (`1` / `2`) contracts.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) & [`scripts/build_additions.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_additions.py):
  - Bundle `src/discord_webhook.js` into `discord_success`, `already_completed`, `notify_failure`, and `notify_failure_on_error`.
  - Update `discord_success` to call `sendDiscordWebhook` (3 bounded attempts, `15000` ms per-attempt timeout, `args.jobLog` + `console` logging, never throwing or failing the flow).
  - Harden `notify_arr` (in `build.py`) with `res.on("error", ...)` and a wall-clock `setTimeout` guard alongside `req.setTimeout(10000)`.
- [`src/arr_action.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/arr_action.js):
  - Add `res.on('error', ...)` and a wall-clock `setTimeout` guard to `request(...)` so mid-response Arr/Unraid disconnects settle cleanly as non-fatal failures.
- [`scripts/run-coverage.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/run-coverage.js):
  - Add `src/discord_webhook.js` to `--test-coverage-include` so the shared transport helper meets the >=90% line/function coverage gate.
- **Test Files**:
  - [`tests/discord_webhook.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/discord_webhook.test.js) *(new)*: Unit tests covering missing/non-HTTPS webhook, DNS/network errors (`ENOTFOUND`, `EHOSTUNREACH`, `ECONNREFUSED`), pre-connect wall-clock timeout, mid-response `res` `'error'` event, HTTP `429` retry + cap, `5xx` retry exhaustion, and secret redaction in logs.
  - [`tests/success_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/success_notify.test.js): Add offline tests on the built `discord_success` plugin verifying network errors, response-stream `error`, timeouts, missing/invalid `TDARR_DISCORD_WEBHOOK`, and HTTP 5xx never throw and always return `outputNumber: 1`.
  - [`tests/already_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/already_notify.test.js), [`tests/failure_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/failure_notify.test.js), [`tests/arr_action.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/arr_action.test.js): Update VM test harnesses if needed for the shared helper and add mid-response `res` `'error'` regression tests.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json):
  - Regenerate via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red Phase**:
   - Add failing unit tests in `tests/discord_webhook.test.js` for `sendDiscordWebhook` error/timeout/retry/stream-reset/redaction cases.
   - Add failing offline/error-stream tests in `tests/success_notify.test.js` (missing webhook, `http://` webhook, network failure, response stream `'error'`, timeout) and mid-response `'error'` test in `tests/arr_action.test.js`.
   - Run `npm test` to confirm the new tests fail as expected.
2. **Green Phase**:
   - Implement `src/discord_webhook.js`.
   - Refactor `src/already_notify.js` and `src/failure_notify.js` to use `sendDiscordWebhook`.
   - Update `src/arr_action.js`, `scripts/build.py`, `scripts/build_additions.py`, and `scripts/run-coverage.js`.
   - Rebuild `flow.json` with `python3 scripts/build.py`.
3. **Refactor & Verify**:
   - Run `make check` (`python3 scripts/build.py`, `npm run test:coverage`, and `git diff --check`) and confirm all tests and >=90% coverage thresholds pass.

---

# V15 WCG-SDR, Dolby Vision 8.6, Proactive SVT-AV1 & Failure Alert Polish Plan

## Change Categorization
All four changes are approved in-place enhancements/bug fixes triggered from the production log diagnosis of [`GU38OXc-log.txt`](file:///Users/mfattoru/Downloads/GU38OXc-log.txt) and [`w2H4THa-log.txt`](file:///Users/mfattoru/Downloads/w2H4THa-log.txt):
1. **WCG-SDR (`BT.2020` + `bt2020-10` / `bt2020-12` / `bt709` SDR) Support — Feature Addition:**
   - Admits genuine wide-color-gamut SDR sources (such as BT.2020 10-bit anime/mastered SDR without PQ/HLG/dynamic-HDR/mastering/CLL signals) instead of misclassifying/holding them as unrecognized HDR or failing MediaInfo `"BT.2020 (10-bit)"` normalization.
2. **Dolby Vision Profile 8 `dv_bl_signal_compatibility_id === 6` ("Blu-ray / HDR10") Support — Feature Addition:**
   - Admits Dolby Vision Profile 8 (`BL+RPU`, `el_present_flag=0`) with `dv_bl_signal_compatibility_id === 6` alongside `1` only when base-layer HEVC PQ/BT.2020/`tv` metadata and MediaInfo `HDR_Format_Compatibility` containing `HDR10` are independently verified; all unverified `id` values (`0`, `2`, `3`, `4`) and non-HDR10 `id=6` streams remain rejected.
3. **Proactive `libsvtav1` Routing on QSV Green-y Clamp Risk — In-Place Behavioral Change:**
   - Replaces the reactive-only workflow (full `av1_qsv` encode -> strict rejection -> `libsvtav1` retry) with proactive direct routing to `libsvtav1` (`CRF 28`) when `isQsvHdrMasteringClampRisk(hdrSource)` is already known true in preflight, while retaining `validateQsvWithSvtHdrClampFallback` as defense-in-depth (and for any quarantined QSV candidate). Requires updating existing reactive-only assertions in `tests/flow.test.js` and `tests/policy.test.js`.
4. **Failure Notifier & Controlled-Failure Error-Hook Polish — In-Place Hardening:**
   - Adds a dedicated `video_color_signaling` (`[Video guard]`) warning classification in `src/failure_notify.js` so color/transfer/guard holds do not fall through to generic `processing_failure` (`❌ error`).
   - Marks `args.variables.flowFailed = true` in `src/failure_notify.js` once notification delivery has succeeded (or was already recorded), preventing Tdarr's `fail_flow` (`DeNiX Enhanced Fail Flow`) from needlessly invoking `on_flow_error` -> `cleanup_on_error` -> `notify_failure_on_error` after controlled failure cleanup and alerting have already succeeded.

## Files Affected
- [`src/policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - **WCG-SDR:**
    - Extract/share a canonical SDR transfer normalizer covering `'bt709'`, `'smpte170m'`, `'bt470bg'`, `'bt470m'`, `'gamma22'`, `'gamma28'`, `'smpte240m'`, `'iec6196621'`, plus **`bt2020-10`** (`'bt202010'`, `'bt202010bit'`) and **`bt2020-12`** (`'bt202012'`, `'bt202012bit'`).
    - Update `classifyVideo(video, info)` so `bt2020` primaries/color space alone does NOT set the HDR hint when transfer is an explicit SDR transfer (including `bt2020-10` / `bt2020-12`) and there are no PQ (`smpte2084`), HLG (`arib-std-b67`), ST 2086/2094/2100, `HDR_Format`, mastering display, content light, or dynamic HDR signals. Keep `bt2020` with unknown/missing transfer or any HDR signal as `'unsupported'`.
    - Update `validateMediaInfoHdrColors(video, info)` transfer/matrix/primaries mappings to include `bt202010` / `bt202010bit` -> `'bt2020-10'`, `bt202012` / `bt202012bit` -> `'bt2020-12'`, and standard SDR aliases (`smpte170m`, `bt601`, `bt470bg`, `bt470m`, `gamma22`, `gamma28`, `iec6196621`, `srgb`, `smpte240m`).
    - Update `validateSdrFrameSignaling(basic, scan, sourceVideo)` to continue rejecting frame-level HDR transfers (`smpte2084`, `arib-std-b67`), and allow observed `bt2020` primaries/matrix for verified SDR only when the stream is not a `bt709`/narrow-gamut stream unexpectedly reporting `bt2020` (i.e. when source metadata itself carries `bt2020` or WCG-SDR transfer).
    - Update `effectiveSdrSource(video, info, scan)` fallback map to recognize `bt202010` / `bt202010bit` (`'bt2020-10'`) and `bt202012` / `bt202012bit` (`'bt2020-12'`).
  - **DV8 `id=6`:**
    - Add a single shared helper `isVerifiedHdr10CompatibleDv8(dovi, info)` requiring `dv_profile === 8`, `bl_present_flag === 1`, `el_present_flag === 0`, `rpu_present_flag === 1`, and either `dv_bl_signal_compatibility_id === 1` OR (`dv_bl_signal_compatibility_id === 6` AND `/\bhdr10\b/i.test(String(info?.HDR_Format_Compatibility || ''))`).
    - Use `isVerifiedHdr10CompatibleDv8` uniformly across `preflightHybridHdr`, `preflightDolbyHdrRoute`, and `determineHdrRoute`.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) (patches over [`src/base/flow-template-v3.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/base/flow-template-v3.json)):
  - **WCG-SDR:**
    - Patch `const isHdr = isHlg || isPq || isBt2020 || isDovi;` to `const isHdr = isHlg || isPq || isDovi;` so WCG-SDR (`bt2020` without PQ/HLG/DoVi) is not classified as HDR in template tier sizing or `-color_trc smpte2084` injection.
    - Gate `validateMediaInfoHdrColors(mainVideo, preflightInfoVideo)` so WCG-SDR (`bt2020` color space/primaries/transfer) is also validated against MediaInfo alongside HDR streams.
    - When `!isHdr && hdrClass === "sdr"`, emit explicit `-color_primaries`, `-color_trc`, `-colorspace`, and `-color_range` flags from `sdrSource` whenever those values are explicitly known (non-unknown/unspecified), preserving `bt2020` / `bt2020-10` / `bt2020nc` / `tv` across QSV/FFmpeg encoding and `validateSdrColor`.
    - Pass `mainVideo` as 3rd arg to `validateSdrFrameSignaling(preflightBasic, frameScan, mainVideo)` (and similarly in `src/policy.js` inside `validateOutput`).
  - **Proactive SVT-AV1:**
    - Update `softwareHdrFallback` initialization to `quarantinedCandidate?.kind === "svt_av1_encode" || (!quarantinedCandidate && qsvHdrClampRetryEligible)`.
    - Differentiate logging/mode when `softwareHdrFallback` comes from quarantine revalidation (`"Software SVT-AV1 HDR candidate revalidation"`) vs proactive routing (`"Software SVT-AV1 HDR encode (proactive QSV green-y clamp avoidance)"`).
- [`src/failure_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/failure_notify.js):
  - Add a dedicated `video_color_signaling` (`severity: 'warning'`) branch in `humanizeFailure` for `[Video guard]` color, transfer, aspect ratio, pixel format, and interlaced hold messages so they produce accurate warning embeds without suggesting source corruption or generic error status.
  - Set `args.variables.flowFailed = true` when `user.failure_notified === true` (both after successful webhook delivery and on the already-notified early return), suppressing redundant `on_flow_error` execution after controlled failures while keeping `on_flow_error` retries active if delivery failed.
- **Test Files:**
  - [`tests/policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js):
    - Add unit tests for WCG-SDR (`BT.2020` + `bt2020-10`/`bt2020-12` + `BT.2020 (10-bit)` MediaInfo) acceptance and preservation via `validateSdrColor`, plus rejection of `BT.2020` with unknown transfer, contradicting MediaInfo PQ/BT.709, or PQ/HLG/HDR10+ signals.
    - Add unit tests for DV8 `dv_bl_signal_compatibility_id === 6` acceptance with `HDR10` compatibility (and DV8.6 + HDR10+ hybrid) and rejection when `HDR10` compatibility is absent.
    - Update clamp-routing unit coverage if needed while preserving reactive `validateQsvWithSvtHdrClampFallback` tests.
  - [`tests/flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js):
    - Update `known Intel QSV HDR mastering clamp...` test to verify proactive SVT-AV1 routing on `qsvHdrClampRetryEligible`, WCG-SDR non-HDR `-color_trc` emission (never `smpte2084`), and reactive fallback retention.
  - [`tests/failure_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/failure_notify.test.js):
    - Add tests for `[Video guard]` color/MediaInfo hold categorization (`warning` embed, accurate file state/action) and `args.variables.flowFailed === true` on successful delivery vs unset on failed/missing delivery.
  - [`tests/integration.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/integration.test.js):
    - Add an end-to-end integration test with a real synthetic `bt2020` + `bt2020-10` WCG-SDR fixture and verify full pass-through encoding, validation, and output color tags (`libsvtav1` mock/transcode path), plus verify controlled failure sets `variables.flowFailed === true` after `notify_failure`.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json):
  - Rebuild deterministically via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red Phase:**
   - Add failing tests across `tests/policy.test.js`, `tests/failure_notify.test.js`, `tests/flow.test.js`, and `tests/integration.test.js` covering WCG-SDR (`bt2020-10`, MediaInfo `"BT.2020 (10-bit)"`, negative guards), DV8 `id=6` (with and without `HDR10` compatibility), proactive SVT-AV1 green-y routing, `[Video guard]` color humanization, and `flowFailed = true` propagation.
   - Run `npm test` and verify the new assertions fail as expected.
2. **Green Phase:**
   - Implement WCG-SDR and DV8 `id=6` updates in `src/policy.js`.
   - Implement `humanizeFailure` video color/guard classification and `flowFailed = true` propagation in `src/failure_notify.js`.
   - Update `scripts/build.py` for WCG-SDR `isHdr`/color flags/MediaInfo validation and proactive `libsvtav1` routing on `qsvHdrClampRetryEligible`.
   - Regenerate `flow.json` via `python3 scripts/build.py`.
   - Run `npm test` to confirm all tests turn green.
3. **Refactor & Verify:**
   - Review shared helpers (SDR transfer maps, `isVerifiedHdr10CompatibleDv8`) to ensure zero duplication and clean readability.
   - Run `python3 scripts/build.py`, full `npm test` (and check `package.json` for coverage script if present), and `git diff --check`.
