# Full frame scan thread benchmark — 2026-11-05

## Change

The production precheck was invoking FFprobe's full `-show_frames` scan without a decoder thread option. The production FFprobe build reported a default of one thread, and the two active prechecks each showed one process thread. The Tdarr container had no Docker CPU quota or CPU-set restriction; Unraid reported 16 logical CPUs.

The initial V15 change set `-threads` for the **pre-encode source frame scan** using `TDARR_PRECHECK_THREADS`. The current local flow uses the shared `TDARR_DECODE_THREADS` setting (default 4, valid values 1–16) for CPU decode work across the flow. `TDARR_PRECHECK_THREADS` remains a fallback alias. No production job, container configuration, or media was changed.

## Method

Ran direct FFprobe scans in the already-running `tdarr-flow-live-test-20261102` container. The argument list used the same selected-stream, frame fields, and compact output format as V15. Each file was scanned at 1, 2, and 4 threads. The complete FFprobe stdout was captured and SHA-256 hashed, so the comparison covers frame timestamps, interlace flags, color fields, and frame side-data fields requested by V15.

The AV1 row uses an existing encoded output and mirrors the full candidate frame scan. The tested 1/2/4-thread scan command is also the command pattern used for candidate frame validation; the current local flow applies `TDARR_DECODE_THREADS` to both source and candidate scans.

The test node used FFprobe `N-128195-g914e454559`, whose help reports a one-thread default. An unrelated full 4K FFprobe job was also active in the test container during these short runs, and production Tdarr had two jobs active. The host has 16 logical CPUs. Wall-clock results therefore include concurrent workload and are indicative rather than an idle-host benchmark. These were direct scan benchmarks, not full Tdarr jobs; the stale test-flow import was not run.

## Results

| Test input | Duration / frames | 1 thread | 2 threads | 4 threads | 4-thread speedup | FFprobe stdout SHA-256 |
|---|---:|---:|---:|---:|---:|---|
| 1080p H.264 SDR excerpt, first 120 s | 120.037 s / 2,878 | 18.181 s | 9.442 s | 6.352 s | 2.86× | `fd300739e341aa975bc8e526289704e5edb2d4d9a245f3ba30d74ca2345a0699` |
| 4K HEVC Main 10 HDR10+ sample | 21.355 s / 508 | 35.033 s | 19.465 s | 11.528 s | 3.04× | `cb449f374d2d2e74a7231913bbece17dee391cd64708c8b1df4cd50e676702e7` |
| 1080p AV1 output, same 120 s excerpt | 120.037 s / 2,878 | 16.168 s | 9.923 s | 7.328 s | 2.21× | `f58e6ace150899b5782f3cca330876a64fd06d4cf7319822c5f1644f0a274932` |

For each input, the frame count and complete stdout hash matched exactly at 1, 2, and 4 threads. This shows that increasing decoder threads did not change the metadata report on these three samples. It does not prove identical behavior for every codec, damaged stream, or unusual HDR layout.

An initial 120-second H.264 excerpt taken around source time 300 seconds produced only 44 frame records and emitted malformed NAL-unit diagnostics. It was excluded from performance results. The first 120 seconds of the same test copy decoded cleanly and were used for the H.264 comparison.

## Decision and limits

Use 4 decoder threads per job as the default: the two source samples showed close to 3× speedup over one thread, with exact scan-output equality. The output AV1 sample also scaled to 2.21× at four threads. The shared setting now covers both source and candidate frame scans plus other CPU decode checks. Four concurrent jobs at the default can request up to 16 decoder threads; lower the setting if Tdarr concurrency increases or other Unraid services need the CPU.

This benchmark measures FFprobe frame scanning on short samples. Actual whole-file savings depend on codec threading support, resolution, storage speed, FFprobe output parsing, and concurrent work. It does not quantify savings for audio decode, hybrid encode, or end-to-end job time, and it does not alter the full-file validation policy. The thread setting applies only to decode work; packet-only demux scans and stream-copy operations remain unchanged.

The benchmark artifacts remain in the test container under `/test/precheck-thread-benchmark-20261105/`. The summarized per-run timings, frame counts, and stdout hashes are copied to [`evidence/precheck-threads/results.json`](evidence/precheck-threads/results.json).
