# VMAF and encode evidence

This folder keeps the result JSON, captured command logs, model checksums, and file checksums for representative V15 quality checks. Media files and source library paths are not included; sample titles and paths have been anonymized.

## Evidence index

| Sample class | Results and logs |
| --- | --- |
| 1080p SDR | [Phone model result](sdr_1080p_phone.json) · [TV model result](sdr_1080p_tv.json) |
| 4K SDR | [VMAF result](sdr_4k_vmaf.json) · [Encode log](sdr_4k_encode.log) · [VMAF log](sdr_4k_vmaf.log) |
| HDR10 | [Main result](hdr10_4k_metrics.json) · [Large-source ICQ 22 result](hdr10_4k_hdr_large_icq22.json) · [Encode log](hdr10_4k_large_encode.log) |
| HDR and Dolby Vision hybrid | [VMAF result](hdr_hybrid_4k_metrics.json) · [Encode log](hdr_hybrid_4k_encode.log) · [Reference extraction log](hdr_hybrid_4k_ref_extract.log) |
| Dolby Vision Profile 7 route | [Metadata result](dv_p7_metrics.json) · [Run log](dv_p7_run.log) |
| Model check | [HDR self-check result](hdr_selfcheck.json) · [Model SHA-256 values](model-sha256.txt) |

Other extraction, offset, and SSIM logs are included for the same anonymized sample classes. `SHA256SUMS` contains checksums for the result and log files in this folder; verify them from this directory with:

```sh
shasum -c SHA256SUMS
```

These are controlled sample and excerpt measurements. They do not establish quality for every source or replace playback checks on target devices. See the repository's [quality decision](../../docs/architecture/QUALITY_DECISION.md) for interpretation and limits.
