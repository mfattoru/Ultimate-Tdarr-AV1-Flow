# Arc AV1 safety V3

`flow.json` is an importable copy of the user's latest supplied export with a new ID. It has not been installed or assigned to a live Tdarr library. It retains the credentials embedded in the supplied export; keep it private and rotate them when ready.

The flow retains the original ISO deletion and subsequent content-aware Arr rescan, existing audio-language and conversion preferences, subtitle rules, HDR/Dolby Vision handling, and oversized-AV1 re-encoding decisions. It creates no permanent original recovery copy. The metadata-only duplicate and zero-duration ghost pruner was removed because it could discard different valid tracks.

Before replacement, ffprobe checks output stream counts/codecs and reads selected video, audio, and subtitle packet timelines for input and output. Video duration is compared within 0.5% or 0.5 seconds, whichever is greater. Audio/subtitle start and end times are compared relative to video; subtitle output must not have fewer packets. Output video and audio are fully decoded with FFmpeg `-xerror`. These checks take additional disk I/O and CPU time, can reject unusual valid sources, and do not guarantee detection of every missing frame, altered subtitle, or playback defect. Missing required timestamps or decoders fail closed.

The flow checks source identity/size/timestamps at job start and before replacement, plus a destination collision check. Tdarr's existing replacement plugin is still used; its later move is not an atomic no-clobber transaction with these checks, so another writer could race the final check. Avoid simultaneous external changes to files being processed. No persistent recovery copy is kept.

Cache space reads use bigint `statfs`, with a `df` fallback; unknown free space fails closed. Disk admission requires the configured free-space floor plus an estimate of 1.25 times source size. The floor is an admission estimate rather than a guaranteed reservation against output exceeding the estimate or unrelated applications writing to the same disk.

Jobs using this flow serialize through `/transcode_cache/.tdarr-av1-capacity.lock` until replacement or failure cleanup. This protects against overlapping checks only for jobs using the same shared lock directory and this flow's lock protocol. It does not coordinate with downloaders or unrelated flows. Set the node environment variable `TDARR_CAPACITY_LOCK_DIR` to an existing shared writable directory if `/transcode_cache` is unavailable or not shared. A hard crash or interruption can leave a stale lock, which blocks new jobs (wait timeout: 12 hours). Do not remove it until you have verified no corresponding job is active. Then inspect and remove the lock directory manually.

`On Flow Error` routes plugin exceptions to failure cleanup without resetting the error status. If the original is missing, failure cleanup keeps any temporary output for inspection; a hard crash can leave other temporary files behind.

The Arc device defaults to `/dev/dri/renderD129` and can be configured as in the supplied export. The full output validation decode runs separately on the CPU. A scan request is not an Arr search and does not itself guarantee a replacement download.

## Verification

From the workspace root, run `python3 work/tdarr-flow-v3/build.py` and `node --test work/tdarr-flow-v3/regression.test.js`. Tests use disposable local files and simulated Arr responses. They do not exercise the Arc QSV encoder, the installed Tdarr error lifecycle/replacement implementation, or a live Arr server. Validate against disposable media on the actual node before assigning this flow to a production library.
