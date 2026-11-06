# Arc AV1 HDR flow V5 — review draft

`flow.json` is a separate export. It has **not** been imported, assigned to a library, or exercised through the live Tdarr replacement lifecycle. The export contains credentials from the supplied flow. Keep it private, rotate the Discord webhook previously exposed in tool output, and update the export before use.

## Supported paths

- SDR uses the Arc AV1 encoder and the existing audio and subtitle policies.
- Plain HDR10 retains PQ/BT.2020 and matching, constant mastering and content-light metadata.
- Plain HLG retains HLG/BT.2020 signaling.
- A single-layer HEVC Dolby Vision Profile 8.1 with an explicitly HDR10-compatible base layer is re-encoded to static HDR10. The Dolby Vision RPU/dynamic rendering is **removed**; the downgrade is included in the job log and success notification. This path requires consistent HDR10 color signals, complete mastering information and valid content light levels. When the base layer omits light levels, the flow can use Dolby Level 6 values only after extracting and checking them across the complete source and confirming consistency with the HDR10 mastering luminance.

Dolby Vision Profile 5, Profile 7, Profile 8.4, AV1 Dolby Vision, HDR10+, HDR Vivid and other unverified/ambiguous signaling currently fail the job and keep the original. The installed FFmpeg/libplacebo path can render Dolby Vision Profile 5, but it has not been validated end to end as a metadata-correct HDR10 file; QSVEncC is not installed. The tested Profile 8.1 file in the library with conflicting BT.709 tags is held rather than relabeled. This draft therefore **does not yet encode every HDR or Dolby Vision file**.

## Quality and size

Intel QSV ICQ values use larger numbers for lower quality. For SDR the whole-file attempts are 1080p 19 → 23 and above 1080p 19 → 23 → 26. For HDR the user-approved provisional 4K attempts are 18 → 22; 1080p and 720p HDR use 19 only, and SD HDR uses 18 only. The HDR ICQ 22 setting was tested for size, not HDR perceptual quality. Values were informed by short test clips, not a guarantee for an entire library.

The result must be smaller than the complete original and pass validation, otherwise the original remains. No larger stream-copy fallback or permanent original recovery copy is made. Existing V4 and V5 completed AV1 markers prevent repeated encodes unless another tool removes the marker.

## Validation and limits

The source and output are decoded and scanned for HDR/Dolby side data, interlacing, color conflicts and per-frame video timestamps. HDR10 mastering and light metadata must be present, match stream and frame data, remain constant through the file, and match the output; known dynamic HDR on the output is rejected. Selected audio and subtitle track endpoints must remain within 100 ms of the source relative to video. Codecs, selected tracks, dimensions, aspect ratio, frame counts, video timelines, complete output decode, completion marker, input identity and output size are checked. The checks cannot guarantee perceptual quality, catch every metadata or subtitle defect, or prove every interior audio/subtitle event remains synchronized.

Full decode scans, frame counting and output decode add significant CPU, I/O, time and memory. Some valid files with missing/conflicting metadata, unusual timings, multiple video streams, interlaced frames, more than 10-bit precision or greater-than-4:2:0 chroma are held instead of being replaced. The V3 identity/destination guard and Tdarr's later replacement are separate operations; a simultaneous external writer can race them. Do not allow other applications to modify library files being processed. No permanent backup exists.

The node needs `mediainfo`, `ffprobe`, `ffmpeg`, `dovi_tool`, and an accessible Intel Arc render device (default `/dev/dri/renderD129`, configurable as in the previous flow). Dolby Level 6 verification temporarily stores only extracted RPU/CSV metadata under the node's temporary directory and removes it on normal completion; a hard crash can leave temporary files. Existing shared cache lock and free-space limitations are documented in `../tdarr-flow-v3/README.md`.

ISO deletion and the Arr rescan branch are inherited as requested. A rescan is not an Arr search and does not guarantee a replacement download.

## Verification

Build with `python3 work/tdarr-flow-v5/build.py`; run `node --test work/tdarr-flow-v5/policy.test.js work/tdarr-flow-v5/integration.test.js`. Tests use disposable files and simulated Arc calls. Real Arc tests used a disposable 4K HDR10 library excerpt, Dolby's public Profile 8.1 clip, and a plain HLG base-layer clip derived from Dolby's public Profile 8.4 test. Profile 5 and 8.4 test inputs were held. Test clips were temporary and the media library was not changed.

Dolby reference clips: https://github.com/DolbyLaboratories/dolby-vision-contents. Further testing on disposable full-length media and the actual Tdarr flow is required before production use.
