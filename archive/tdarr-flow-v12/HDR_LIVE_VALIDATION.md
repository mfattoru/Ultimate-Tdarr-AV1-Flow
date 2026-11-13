# HDR and Dolby Vision live Arc validation — 2026-11-02

## Scope

These are controlled FFmpeg runs inside the existing `tdarr-flow-live-test-20261102` Unraid container, using Arc QSV on `/dev/dri/renderD129`. The test container's imported flow is still V12, so the V13 candidate was **not** imported or executed as a full Tdarr job. The commands reproduced the V13 HDR decode/filter/AV1 encode branches. The source library mount at `/mnt/media` is read-only; excerpts and reports are under `/test`, with working output in `/dev/shm`.

These checks establish that the tested routes ran, kept expected static color/HDR signaling, removed dynamic metadata where the route converts to static HDR10, and produced output that decodes cleanly. They do not establish picture quality, test complete titles, or verify every stream-layout combination.

## Results

| Input | Arc output | Checks |
| --- | --- | --- |
| Sample HDR Film, Dolby Vision Profile 7, HDR10-compatible base | AV1 Main 10, BT.2020/PQ; about 21 MB | Mastering metadata (4000 nits) and content light (992/120) preserved; Dolby Vision frame metadata absent; 492 frames; full output decode passed. |
| Soul, Dolby Vision Profile 8.1 | AV1 Main 10, BT.2020/PQ; about 6.1 MB | Dolby Level 6 fallback supplied content light 189/89; output mastering/content-light metadata matched the selected fallback; Dolby Vision frame metadata absent; 480 frames; full output decode passed. |
| Birds of Prey, HDR10+ | AV1 Main 10, BT.2020/PQ; about 12 MB | Static mastering/content-light metadata preserved; HDR10+ dynamic metadata absent; 508 frames; full output decode passed. FFmpeg logged repeated `incompatible video parameters (5)` warnings, but the command completed and output validation passed. |
| Synthetic 4K HLG pattern, 4 seconds | AV1 Main 10, BT.2020/HLG; about 10 MB | HLG transfer and BT.2020 primaries/matrix remained signaled; full output decode passed. This is a metadata-path smoke test, not representative HLG content. |

Persistent excerpts, outputs, and logs are in the test container at `/test/source/hdr-next` and `/test/reports/hdr-live`. The Dolby Vision conversions intentionally discard Dolby dynamic metadata and retain the compatible HDR10 or HLG base-layer presentation.

## Source availability and limits

A read-only scan covered 212 filename-tagged 2160p videos in the test library (209 MKV and 3 MP4). It found no genuine HLG source and no Dolby Vision Profile 8.4 source. Thus the Profile 8.4 HLG-base route has only been checked with the synthetic HLG metadata pattern, not with genuine Dolby Vision 8.4 input.

No VMAF comparison was run for these HDR/Dolby Vision outputs. The direct tests also did not exercise V13's complete source guards, audio/subtitle policy, validators, fallback remux, notifications, or file replacement. The isolated container remains on V12, and production Tdarr and media were not changed. Before claiming full V13 HDR production verification, import the candidate into the isolated instance and run complete jobs from test-only copies, including a genuine Profile 8.4 or HLG sample if one becomes available.
