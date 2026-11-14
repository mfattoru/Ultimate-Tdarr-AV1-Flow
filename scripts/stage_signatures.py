"""Stage-scoped code signature partitioning and completeness verification."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

STAGES = ("precheck_video", "precheck_audio", "encode", "candidate_frames", "decode")
ALLOWED_TARGETS = set(STAGES) | {"ui_only"}
DECL_RE = re.compile(r"(?m)^(?:const|let|var|async\s+function|function)\s+([A-Za-z0-9_]+)\b")

# Maps each src/<file> top-level declaration to the stage hash(es) affected by edits to it.
# Completeness is enforced at build time so no declaration can silently escape hashing.
SYMBOL_STAGE_MAP: dict[str, dict[str, tuple[str, ...]]] = {
    "policy.js": {
        "DEFAULT_ICQ": ("encode",),
        "VIDEO_BITSTREAM_CORRUPTION_RE": ("precheck_video", "candidate_frames", "decode"),
        "AUDIO_BITSTREAM_CORRUPTION_RE": ("precheck_audio", "decode"),
        "isKnownVideoCorruptionDiagnostic": ("precheck_video", "candidate_frames", "decode"),
        "isKnownAudioCorruptionDiagnostic": ("precheck_audio", "decode"),
        "selectQualityValue": ("encode",),
        "isCompletedEncode": ("encode",),
        "isNonDolbyDynamic": ("precheck_video", "encode"),
        "isDynamicHdrSignal": ("precheck_video", "encode"),
        "mustRetainOriginalAtQualityFloor": ("encode",),
        "SDR_TRANSFER_MAP": ("precheck_video", "encode", "candidate_frames", "decode"),
        "normalizeColorToken": ("precheck_video", "encode", "candidate_frames", "decode"),
        "normalizeSdrTransfer": ("precheck_video", "encode", "candidate_frames", "decode"),
        "isBt2020Color": ("precheck_video", "encode", "candidate_frames", "decode"),
        "isVerifiedHdr10CompatibleDv8": ("precheck_video", "encode", "candidate_frames", "decode"),
        "normalizeSdrMatrix": ("precheck_video", "encode", "candidate_frames", "decode"),
        "classifyVideo": ("precheck_video", "encode", "decode"),
        "validateHdr10": ("decode",),
        "validateSdrColor": ("decode",),
        "guardSourceVideo": ("precheck_video",),
        "useQsvDecode": ("precheck_video", "encode"),
        "isMissingSampleAspectRatio": ("precheck_video", "decode"),
        "isSquareMediaInfoPixelAspectRatio": ("precheck_video", "decode"),
        "isInterlacedFieldOrderTag": ("precheck_video", "encode", "decode"),
        "validateAspect": ("decode",),
        "isHdr10PlusSignal": ("precheck_video", "encode", "candidate_frames", "decode"),
        "mediaInfoHdrText": ("precheck_video", "decode"),
        "validateMediaInfoHdrColors": ("precheck_video", "decode"),
        "preflightHybridHdr": ("precheck_video",),
        "isVerifiedDolbyProfile5Config": ("precheck_video",),
        "preflightDolbyHdrRoute": ("precheck_video",),
        "determineHdrRoute": ("precheck_video", "encode"),
        "mergeHdrMetadata": ("precheck_video", "encode", "candidate_frames"),
        "recordHdrFrame": ("precheck_video", "candidate_frames"),
        "estimateVideoFrames": ("precheck_video", "candidate_frames"),
        "getDecodeThreadCount": ("precheck_video", "encode", "candidate_frames"),
        "withDecoderThreads": ("precheck_video", "encode", "candidate_frames"),
        "buildFrameScanArguments": ("precheck_video", "candidate_frames"),
        "inspectVideoFrames": ("precheck_video", "candidate_frames"),
        "parseDolbyLevel6": ("precheck_video",),
        "readHdrFrames": ("precheck_video", "encode"),
        "summarizeLevel6Rows": ("precheck_video",),
        "DOLBY_LEVEL9_PRIMARIES": ("precheck_video", "encode"),
        "parseDolbyLevel9": ("precheck_video",),
        "summarizeLevel9Rows": ("precheck_video",),
        "formatMasteringDisplayArg": ("precheck_video", "encode"),
        "buildDovi5HdrTarget": ("precheck_video", "encode"),
        "extractDolbyLevel6": ("precheck_video", "encode"),
        "extractDolbyProfile5HdrMetadata": ("precheck_video", "encode"),
        "rationalValue": ("precheck_video", "encode", "candidate_frames", "decode"),
        "resolveHdrLight": ("precheck_video", "encode"),
        "hdrMasterFields": ("precheck_video", "encode", "candidate_frames", "decode"),
        "sameHdrSideData": ("precheck_video", "candidate_frames", "decode"),
        "mediaInfoHdrNumber": ("precheck_video", "encode"),
        "mediaInfoMasteringMetadata": ("precheck_video", "encode"),
        "mediaInfoContentLightMetadata": ("precheck_video", "encode"),
        "seedHdrMetadataFromMediaInfo": ("precheck_video", "encode"),
        "isQsvHdrMasteringClampRisk": ("precheck_video", "encode", "decode"),
        "shouldRetrySvtForQsvHdrClamp": ("decode",),
        "validateQsvWithSvtHdrClampFallback": ("decode",),
        "isKnownQsvHdrMasteringClamp": ("precheck_video", "decode"),
        "collectHdrFrameStatic": ("precheck_video", "candidate_frames"),
        "checkHdrFrameStatic": ("precheck_video", "encode", "decode"),
        "hdrFrameMetadataRequirements": ("precheck_video", "decode"),
        "composeVideoFilterChain": ("encode",),
        "compareVideoTimestamps": ("decode",),
        "hasVerifiedCandidateFrameTimestamps": ("decode",),
        "validateHlg": ("decode",),
        "isVerifiedSdr": ("precheck_video", "encode", "decode"),
        "validateEffectiveSdrTransfer": ("precheck_video", "decode"),
        "validateSdrFrameSignaling": ("precheck_video", "decode"),
        "effectiveSdrSource": ("precheck_video", "encode", "decode"),
        "isUnknownColorValue": ("precheck_video", "encode", "candidate_frames", "decode"),
        "normalizeColorRange": ("precheck_video", "encode", "candidate_frames", "decode"),
        "inferUntaggedColorRange": ("precheck_video", "encode"),
        "untaggedColorRangeArgs": ("encode",),
        "isUntaggedVideo": ("precheck_video", "encode", "decode"),
        "validateUntaggedOutput": ("decode",),
    },
    "subtitle_timing.js": {
        "subtitleMeasurementUnavailable": ("encode", "decode"),
        "createSubtitleTimingPrecheck": ("encode",),
        "decodeFfprobeDataHex": ("encode",),
        "parseSubtitlePacketLine": ("encode", "decode"),
        "readSubtitlePackets": ("encode", "decode"),
        "formatAssTimestamp": ("encode",),
        "reconstructAssSubtitleFile": ("encode",),
        "validateCopiedSubtitlePackets": ("decode",),
    },
    "audio_timing.js": {
        "MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS": ("precheck_audio", "encode"),
        "timeBaseToSeconds": ("precheck_audio",),
        "createAudioDtsAnalyzer": ("precheck_audio",),
        "analyzeAudioDtsTimeline": ("precheck_audio",),
        "parseAudioDtsLine": ("precheck_audio",),
        "audioTimestampRepairBsf": ("encode",),
        "scanAudioDtsPackets": ("precheck_audio",),
    },
    "progress.js": {
        "progressFs": ("ui_only",),
        "progressWorkerContext": ("ui_only",),
        "createFpsSampler": ("ui_only",),
        "progressFileSize": ("ui_only",),
        "reportWorkerProgress": ("ui_only",),
        "runLimitedFfmpeg": ("encode",),
        "runSingleQuality": ("encode",),
    },
    "validation.js": {"*": ("decode",)},
    "pgs.js": {"*": ("decode",)},
    "precheck_cache.js": {
        "precheckFs": ("precheck_video", "precheck_audio", "candidate_frames"),
        "precheckPath": ("precheck_video", "precheck_audio", "candidate_frames"),
        "precheckCrypto": ("precheck_video", "precheck_audio", "candidate_frames"),
        "precheckZlib": ("precheck_video", "precheck_audio", "candidate_frames"),
        "PRECHECK_HASH_RE": ("precheck_video", "precheck_audio", "candidate_frames"),
        "PRECHECK_ID_RE": ("precheck_video", "precheck_audio", "candidate_frames"),
        "PRECHECK_SOURCE_FILE_RE": ("precheck_video", "precheck_audio"),
        "PRECHECK_MAX_RAW": ("precheck_video", "precheck_audio", "candidate_frames"),
        "PRECHECK_MAX_COMPRESSED": ("precheck_video", "precheck_audio", "candidate_frames"),
        "precheckAssertDirectory": ("precheck_video", "precheck_audio", "candidate_frames"),
        "precheckPathFor": ("precheck_video", "precheck_audio"),
        "sourcePrecheckPathFor": ("precheck_video", "precheck_audio"),
        "candidateFramesPathFor": ("candidate_frames",),
        "validFrameScanEvidence": ("precheck_video", "candidate_frames"),
        "validAudioPrecheckEvidence": ("precheck_audio",),
        "validPrecheckEvidence": ("precheck_video", "precheck_audio"),
        "safeUnlink": ("precheck_video", "precheck_audio", "candidate_frames"),
        "writeSignedEnvelope": ("precheck_video", "precheck_audio", "candidate_frames"),
        "readSignedEnvelope": ("precheck_video", "precheck_audio", "candidate_frames"),
        "savePrecheckCache": ("precheck_video", "precheck_audio"),
        "loadPrecheckCache": ("precheck_video", "precheck_audio"),
        "removePrecheckCache": ("precheck_video", "precheck_audio"),
        "saveSourcePrecheck": ("precheck_video", "precheck_audio"),
        "loadSourcePrecheck": ("precheck_video", "precheck_audio"),
        "removeSourcePrecheck": ("precheck_video", "precheck_audio"),
        "saveCandidateFramesCache": ("candidate_frames",),
        "loadCandidateFramesCache": ("candidate_frames",),
        "removeCandidateFramesCache": ("candidate_frames",),
    },
}


def split_top_level_declarations(source_text: str) -> list[tuple[str, str]]:
    """Split a src/*.js file into (symbol_name, declaration_source) slices."""
    matches = list(DECL_RE.finditer(source_text))
    if not matches:
        return []
    export_match = re.search(r"(?m)^if\s*\(\s*typeof\s+module\b", source_text)
    end_limit = export_match.start() if export_match else len(source_text)
    items: list[tuple[str, str]] = []
    for idx, match in enumerate(matches):
        name = match.group(1)
        start = match.start()
        if start >= end_limit:
            continue
        stop = matches[idx + 1].start() if idx + 1 < len(matches) else end_limit
        stop = min(stop, end_limit)
        items.append((name, source_text[start:stop].strip()))
    return items


def compute_stage_hashes(
    src_dir: pathlib.Path,
    *,
    overrides: dict[str, str] | None = None,
    inline_sections: dict[str, list[str] | tuple[str, ...]] | None = None,
) -> dict[str, str]:
    """Compute SHA-256 stage hashes over mapped src declarations and optional inline sections."""
    overrides = overrides or {}
    inline_sections = inline_sections or {}
    buckets: dict[str, list[str]] = {stage: [] for stage in STAGES}

    for filename in sorted(SYMBOL_STAGE_MAP):
        text = overrides.get(filename)
        if text is None:
            text = (src_dir / filename).read_text()
        mapping = SYMBOL_STAGE_MAP[filename]
        if "*" in mapping:
            for stage in mapping["*"]:
                if stage not in ALLOWED_TARGETS:
                    raise RuntimeError(f"Unknown stage target {stage!r} in {filename}")
                if stage in buckets:
                    buckets[stage].append(f"// {filename}\n{text}")
            continue

        decls = split_top_level_declarations(text)
        seen: set[str] = set()
        for name, body in decls:
            if name in seen:
                raise RuntimeError(f"Duplicate top-level declaration {name!r} in {filename}")
            seen.add(name)
            if name not in mapping:
                raise RuntimeError(
                    f"Unmapped top-level declaration {name!r} in {filename}; assign it in SYMBOL_STAGE_MAP"
                )
            for target in mapping[name]:
                if target not in ALLOWED_TARGETS:
                    raise RuntimeError(f"Unknown stage target {target!r} for {filename}:{name}")
                if target in buckets:
                    buckets[target].append(f"// {filename}:{name}\n{body}")

    for stage in STAGES:
        for idx, snippet in enumerate(inline_sections.get(stage, ())):
            buckets[stage].append(f"// inline:{stage}:{idx}\n{snippet}")

    return {
        stage: hashlib.sha256("\n".join(buckets[stage]).encode("utf-8")).hexdigest()
        for stage in STAGES
    }


def _mutate_declaration(source_text: str, symbol: str, marker: str) -> str:
    pattern = re.compile(rf"(?m)^((?:const|let|var|async\s+function|function)\s+{re.escape(symbol)}\b[^\n]*)")
    updated, count = pattern.subn(rf"\1 /* {marker} */", source_text, count=1)
    if count != 1:
        raise RuntimeError(f"Unable to locate declaration {symbol!r} for isolation check")
    return updated


def _run_isolation_check(src_dir: pathlib.Path) -> dict[str, object]:
    baseline = compute_stage_hashes(src_dir)
    diff_keys = lambda candidate: sorted(k for k in STAGES if candidate[k] != baseline[k])

    val_edited = compute_stage_hashes(
        src_dir,
        overrides={"validation.js": (src_dir / "validation.js").read_text() + "\n// post-check tweak\n"},
    )
    audio_edited = compute_stage_hashes(
        src_dir,
        overrides={
            "audio_timing.js": _mutate_declaration(
                (src_dir / "audio_timing.js").read_text(), "analyzeAudioDtsTimeline", "audio-tweak"
            )
        },
    )
    encode_edited = compute_stage_hashes(
        src_dir,
        overrides={
            "policy.js": _mutate_declaration(
                (src_dir / "policy.js").read_text(), "composeVideoFilterChain", "encode-tweak"
            )
        },
    )
    frame_scan_edited = compute_stage_hashes(
        src_dir,
        overrides={
            "policy.js": _mutate_declaration(
                (src_dir / "policy.js").read_text(), "inspectVideoFrames", "scan-tweak"
            )
        },
    )

    return {
        "hashes": baseline,
        "isolation": {
            "decodeEditChangedOnlyDecode": diff_keys(val_edited) == ["decode"],
            "audioTimingEditChangedOnlyPrecheckAudio": diff_keys(audio_edited) == ["precheck_audio"],
            "encodeEditChangedOnlyEncode": diff_keys(encode_edited) == ["encode"],
            "frameScanEditLeftEncodeAndAudioUntouched": (
                set(diff_keys(frame_scan_edited)) == {"candidate_frames", "precheck_video"}
            ),
        },
    }


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    src = root / "src"
    if "--check-isolation" in sys.argv[1:]:
        print(json.dumps(_run_isolation_check(src)))
    else:
        print(json.dumps(compute_stage_hashes(src), indent=2))
