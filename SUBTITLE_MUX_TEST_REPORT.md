# Copied ASS timestamp mux test — 2026-11-03

## Test boundary

- Used the already-running `tdarr-flow-live-test-20261102` container. It was not recreated.
- The test container's imported V15 flow is stale and still contains legacy static Arr settings. I did not submit a Tdarr job. I ran direct FFmpeg commands against a copy in `/test/logfix`; the production `/mnt/media` mount stayed read-only.
- The read-only source path was `/path/to/source-video.mkv`.
- No production flow, production media, Arr service, or Discord webhook was changed or contacted.

## Root cause

The copied Sample Anime Series S14E27 source is 356,338,031 bytes and 1,468.34 seconds. Its selected first ASS track is source stream 3. In packet order, one subtitle timestamp goes backward from 2.450 seconds to 2.140 seconds. V15 stream-copies that ASS track but currently applies `setts` only to copied PGS tracks.

A copy-only remux with the current subtitle mapping reproduced the reported Matroska failure, exit 234:

```text
[sost#0:3/copy] Non-monotonic DTS; previous: 2450, current: 2140; Error submitting a packet to the muxer
```

Adding `-fflags +sortdts` did not change the failure. A DTS-only clamp also produced a muxer warning because DTS then exceeded PTS; it was not a better fix.

## Repair tested

Applied the existing PTS/DTS monotonic clamp to only the failing copied ASS output stream, leaving its codec and payload unchanged:

```text
setts=pts=if(eq(PTS\,NOPTS)\,NOPTS\,max(PTS\,PREV_OUTPTS+1)):dts=if(eq(DTS\,NOPTS)\,NOPTS\,max(DTS\,PREV_OUTDTS+1))
```

The copy-only remux exited 0. I then ran a direct Arc QSV AV1 encode of the same source at ICQ 22 with the filter on that ASS stream. It also exited 0, completed at about 17× real time, and wrote `/test/logfix/arc-av1-fixed.mkv`.

## Validation results

- Source decoded-frame count and candidate decoded-frame count: **43,959 each**.
- Candidate stream layout: AV1 10-bit 4:2:0 at 1908×1080; two Opus audio tracks; two ASS tracks; one PGS track. Source and output both report TV range; the source's other color fields remain unspecified.
- Full QSV decode of candidate video: **passed**.
- Full CPU decode of copied audio streams: **passed**.
- ASS stream 3: 273 source/output packets; all payload hashes identical. Exactly one packet's PTS changed, by 0.311 seconds after the global video shift.
- ASS stream 4: 269 source/output packets; all payload hashes and timestamps identical.
- PGS: 2,373 source/output SUP segments; segment types and payload hashes identical. PTS and DTS match the source-to-output timeline shift exactly in this encode, so the existing 0.1-second PGS validator passes.
- Candidate size: 339,362,128 bytes, **4.76% smaller** than the copied source.

The 0.311-second packet adjustment was measured with the original strict `+1` clamp. The follow-up below shows that it included an artificial 1 ms increase; the minimal correction for this fixture is 0.310 seconds. These values measure packet timestamp movement, not the subtitle's offset from speech.

## V15 engine-command rerun — 2026-11-03

After implementing the V15 builder and output validator, I reran a direct Arc QSV encode of the same read-only source using the V15-generated arguments. This remains a direct FFmpeg test, not a Tdarr job.

- Arc device: `/dev/dri/renderD129`; encoder: `av1_qsv`, ICQ 22; output used the V15 frame-passthrough setting.
- FFmpeg exited 0 and completed at approximately 15× real time. The candidate was 339,362,128 bytes versus 356,338,031 bytes for the source (4.76% smaller).
- Full QSV decode of candidate video and full CPU decode of copied audio passed. The candidate yielded 43,959 decoded video frames, matching the source count measured in the prior source scan.
- ASS track 0: 273 packets on both sides, identical payload hashes, monotonic output timestamps; one timestamp needed correction, with a maximum 0.311-second adjustment.
- ASS track 1: 269 packets on both sides, identical payload hashes, monotonic timestamps, and no adjustment.
- PGS: 2,373 segments on both sides; segment types and payload hashes matched, and timestamps stayed within the existing 0.1-second tolerance.
- Output was AV1, 10-bit 4:2:0, 1908×1080, TV range. The source and output retained the same unspecified color fields.

The direct checks cover the specific mux failure and the implemented packet-level safeguards. The V15 engine's full timeline validator and Tdarr node/replacement/notification wiring have not run end to end. The existing test instance still has a stale flow import with legacy Arr settings, so no Tdarr job was submitted. Import the sanitized export and disable or mock Arr actions before that release-gate test. Production remains untouched.

## Scope limit

This verifies the FFmpeg command and the listed subtitle/video/audio checks; it is **not** an end-to-end Tdarr flow verification. The engine's full output frame-by-frame timestamp validator was not run on this direct encode. The next V15 execution must import the sanitized export into the existing test instance first, then run the source as a test-library job with Arr actions disabled. The V15 implementation plan is in [V15_PLAN.md](V15_PLAN.md), Task 8.

## Sample Superhero Series S02E16 duplicate-timestamp diagnosis — 2026-11-04

The read-only original was found in the main media mount and inspected in the isolated test container. It is 362,571,428 bytes. Its English ASS track is global stream 5 with 84,323 packets. Source PTS and DTS are nondecreasing, but many packets legitimately share timestamps: PTS/DTS 24.920 seconds repeats 900 times. Equal packet timestamps are not a backward timestamp error.

I reproduced the logged seek-heal remux with V15's old `PREV_OUTPTS+1` / `PREV_OUTDTS+1` filter. It exited successfully and produced 363,130,777 bytes, within 32 bytes of the notification's 363,130,809-byte output. All 84,323 subtitle packet payload hashes matched the source. However, the filter advanced packets sharing a timestamp by one millisecond each: packet 506 moved from PTS/DTS 24.920 to 25.421 seconds, exactly +0.501 seconds; the maximum accumulated shift later reached 3.041 seconds at packet 74,072. This reproduces the notification precisely. The validator's arithmetic was right about the candidate's timestamp movement, but that movement was introduced by the strict `+1` clamp; it did not show that the original subtitles were 0.501 seconds out of sync with speech.

V15 now uses `max(PTS,PREV_OUTPTS)` and the equivalent DTS expression. This raises a timestamp only when it moves backward and leaves equal timestamps unchanged. A new remux of this same source exited 0, produced 362,572,158 bytes, kept all 84,323 packet payload hashes, preserved packet 506 at 24.920 seconds, and had zero timestamp movement or output PTS decreases. This verifies the ASS packet behavior on the real file; it is not a full Tdarr encode or validation of every other stream type.
