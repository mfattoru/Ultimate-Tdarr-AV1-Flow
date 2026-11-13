# Quality decision record — updated 2026-11-04

## Decision

Keep one global Arc QSV value, ICQ 22, as the **provisional** choice. It gives strong VMAF results on the SDR examples below and a fresh matched HDR10 excerpt scored close to the HDR model's self-comparison. This supports the tested SDR and HDR10 picture-quality samples only. HLG, HDR10+ conversion, and Dolby Vision profile conversions have route/metadata smoke tests but no matched quality measurements; see [HDR_LIVE_VALIDATION.md](../reports/HDR_LIVE_VALIDATION.md).

The flow still attempts an encode for every eligible video. If an encode is not smaller, the flow discards it and uses the original-video remux path. The Sample 4K Film excerpt below confirms that this guard is useful: its ICQ 22 encode scored well but was about 4% larger than a remux of the source excerpt.

## Earlier ICQ comparison

| Sample | ICQ 20 size / SSIM | ICQ 22 size / SSIM | ICQ 22 change |
| --- | ---: | ---: | ---: |
| 1080p SDR, 60 s | 15.61 MB / 0.90665 | 11.23 MB / 0.90611 | 28% smaller; SSIM −0.00055 |
| 1056×800 SDR, 60 s | 8.76 MB / 0.86150 | 6.43 MB / 0.86127 | 27% smaller; SSIM −0.00023 |
| 4K HDR10, 30 s | 31.02 MB / 0.99520 | 20.49 MB / 0.99477 | 34% smaller; SSIM −0.00043 |

The 720p-named source in that comparison was actually 1056×800. These SSIM results show relative changes in those excerpts; they are not a stand-alone perceptual quality guarantee.

## Live SDR VMAF samples

Netflix VMAF v1.0.16 was run at 10-bit 4:2:0 with full-rate frames. TV results use the 1080p 3H model; phone results use the 1080p 5H model. Both inputs were brought to the same 1920×1080 display canvas. The 75-inch 4K TV at 2–3 m is roughly 2.1–3.2 screen-heights away, so the TV model is a useful 3H approximation; the 5H model is the phone-oriented comparison. Model selection details are in [Netflix’s VMAF v1 guide](https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v1.md).

| Source and flow/test output | VMAF sample | TV 3H mean | Phone 5H mean | Size outcome |
| --- | --- | ---: | ---: | --- |
| Sample Anime Series S09E18, 1920×1078 10-bit HEVC; full 24.5 min, 266,987,652-byte source and 208,986,458-byte V13 output | First 60 s of the actual V13 output | 96.621491 | 97.660245 | Full file −21.7% |
| Sample 4K Film (2021), 1920×804 8-bit AV1, untagged; 9,326.656 s / 1,509,761,419-byte source | 30 s at source time 3,600 s, from a 60 s Arc QSV ICQ 22 test encode | 96.612111 | 98.020241 | 60 s encode 10,319,239 bytes; source-video remux 9,922,500 bytes (+4.0%), so the flow would take the original-video fallback |

The first row is an actual V13 output. The Sample 4K Film row is a controlled Arc encode using the flow’s QSV settings, not an end-to-end Tdarr replacement. It tests a much longer live-action source and an already-AV1 input; the size guard prevents its slightly larger encode from replacing the source.

These two examples support ICQ 22 for the tested SDR material. They do not establish that every film, source codec, resolution, or scene will look the same, and VMAF should be paired with a viewing check for a final subjective decision.

## HDR and Dolby Vision checks

The test container has Netflix’s HDR VMAF v1.1.8 4K 3H model. Its 2-second self-comparison scored 106.088, which confirms the model and HDR color-conversion path can produce a valid nonzero result. Netflix documents that HDR inputs must be described as PQ, BT.2020 with their matrix and range; VMAF converts them to its common HDR target before scoring. The original reports are in `/test/reports/vmaf/` in the isolated test container. A copy of the JSON results, captured encode/extraction/scoring logs, and the model SHA-256 list is now included in [`evidence/vmaf/`](../../evidence/vmaf/README.md); its `SHA256SUMS` file lets the copied artifacts be checked locally.

| Sample pair | Check | Result | Interpretation |
| --- | --- | ---: | --- |
| Fresh Sample HDR Film HDR10 source, 80,024,676,767 bytes, 3840×1608 10-bit AV1; 45 s Arc QSV ICQ 22 output | HDR VMAF v1.1.8, 2160p 3H, 20 s at source time 1,800 s; 478 common frames | Mean 106.181; harmonic 106.181; min 105.478, max 106.593 | Supports this matched HDR10 excerpt. The test output retained mastering-display and content-light metadata. This was a controlled QSV encode, not an end-to-end Tdarr replacement. |
| Sample HDR Film source, 102,682,361,361 bytes, 3840×2160 10-bit HEVC with Dolby Vision Profile 8 and HDR10+ signaling; 45 s Arc QSV ICQ 22 output | HDR VMAF v1.1.8, 2160p 3H, 20 s at source time 3,600 s; 480 frames | Mean 100.195; harmonic 100.142; min 85.145, max 110.000 | Exploratory only. The flow holds this hybrid Dolby Vision/HDR10+ combination, so this does not validate an eligible flow route. |
| Earlier Sample HDR Film HDR10 source and 19.85 s AV1 test output, 3840×1608 | HDR VMAF v1.1.8, 2160p 3H, first 8 s | Mean 0.000 | Unresolved old pair. Direct SSIM was 0.846 overall / 0.770 luma at zero offset; tested 1–4 s source offsets stayed around 0.844–0.858 overall. First-frame luma averages were 64 and 192.3. The source/output frame provenance was not re-established, so this is not a valid quality conclusion about the fresh encode above. |
| Sample HDR Film Profile 7 source and 15.64 s AV1 test output, 3840×2160 | HDR VMAF v1.1.8, 2160p 3H, first 8 s | Mean 0.266; max 14.710 | Not cleared. This older pair is far below the self-check; Profile 7 output quality remains unverified. |

The HDR model self-comparison scored 106.088. The fresh Sample HDR Film pair has matching start time and common frame count, and its score is close to that self-check. The earlier low-score pairs remain inconclusive because their frame provenance is unknown. The new result does not establish quality across all HDR sources or Dolby Vision conversions; keep those routes under review until matched samples cover them.

## Test-container files and reproducibility

- Model files used in the test container: `/test/models/netflix-vmaf-v1/`; their original model SHA-256 values are preserved in [`evidence/vmaf/model-sha256.txt`](../../evidence/vmaf/model-sha256.txt).
- Standalone scorer: `/test/tools/netflix-vmaf-source/libvmaf/build/tools/vmaf`.
- Original JSON measurements and logs: `/test/reports/vmaf/`; local copies are under [`evidence/vmaf/`](../../evidence/vmaf/README.md). The local `SHA256SUMS` file covers every copied result and log.
- Large-source additions include `Sample HDR Film_hdr_large_icq22.json` and `Sample HDR Film_hdr.json`, alongside their captured encode, extraction, and scoring logs.
- Scratch raw YUV files were removed after scoring. No source media or model binaries are included in the local evidence copy; the JSON, logs, and model hash manifest are.

This used an isolated test container and read-only source media. Production Tdarr and production files were not changed.
