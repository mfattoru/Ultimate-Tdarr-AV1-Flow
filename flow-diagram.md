# Tdarr AV1 flow V15

V15 is an isolated candidate built from the saved flow revisions. Import it only into the existing test Tdarr instance for verification; this diagram describes the candidate and does not imply production deployment.

```mermaid
flowchart TD
  A[Load and validate source] --> B[Start workflow timer]
  B --> ISO

  subgraph Engine[Arc AV1 engine]
    direction TD
    ISO{ISO or disc image?}
    ISO -->|Yes| DEL[Delete original ISO]
    DEL -->|Deleted| ISOOUT[Return handled ISO outcome]
    DEL -->|Delete failed or path uncertain| ENGINEFAIL
    ISO -->|No| PROBE[Fresh ffprobe]
    PROBE --> EXTRA{Additional candidate video tracks?}
    EXTRA -->|No| MARKER{Completion marker?}
    EXTRA -->|Yes| EXTRADECODE[Decode each extra through its first frame; require explicit progress]
    EXTRADECODE -->|Clean EOF and zero decoded frames| IGNOREEMPTY[Ignore only proven zero-frame extras]
    IGNOREEMPTY --> MARKER
    EXTRADECODE -->|Frame, diagnostic, failure, or missing result| ENGINEFAIL[Return failure with reason]
    MARKER -->|V15, V14, or supported older marker| DONE[Return already-processed outcome]
    MARKER -->|Needs processing| GUARD[Header/config checks: pixel/depth, aspect ratio, Arc access, ICQ, 12-bit policy, and HDR color mapping]
    GUARD -->|Unsupported, ambiguous, unsafe, or unverified DV Profile 8.4| ENGINEFAIL[Return failure with reason]
    GUARD -->|Eligible| HDRPREFLIGHT[Check DV profile/base-layer flags; resolve required Dolby Level 6 metadata]
    HDRPREFLIGHT -->|Static route rejected or Level 6 conflict| ENGINEFAIL
    HDRPREFLIGHT -->|Static checks pass| FULLSOURCE[Full CPU source frame, color/HDR, and timestamp scan]
    FULLSOURCE -->|First decisive corruption, unsupported frame, or metadata conflict| ENGINEFAIL
    FULLSOURCE -->|Scan passes| AUDIOCHECK[Scan retained audio DTS; full-decode retained source audio]
    AUDIOCHECK -->|Recognized source audio corruption| ENGINEFAIL
    AUDIOCHECK -->|No backward DTS (equal-only ties allowed), or repair plan within 100 ms; source decode passes| CACHE[Reclaim safe stale leases; reserve scratch capacity]
    AUDIOCHECK -->|Backward DTS with missing values, repair exceeds 100 ms, or decode guard fails| ENGINEFAIL
    CACHE --> RAM{RAM capacity and host headroom fit?}
    RAM -->|Yes| SHM[Use bounded /dev/shm]
    RAM -->|No| DISK[Use configured disk cache]
    SHM --> WORKSPACE[Create job scratch; record workspace and heartbeat]
    DISK --> WORKSPACE
    WORKSPACE --> CHAPTERS[Clamp unsafe chapter endpoints]
    CHAPTERS --> QSVPATH{Verified direct QSV decode path?}
    QSVPATH -->|H.264 8-bit 4:2:0; HEVC/AV1 8 or 10-bit 4:2:0 SDR| QSVDEC[QSV decode]
    QSVPATH -->|Other supported codecs/formats; verified HDR routes| CPUDEC[CPU decode and normalize to 10-bit 4:2:0]
    QSVDEC --> ENCODE[One Arc QSV AV1 encode at ICQ 22; apply timestamp-only audio DTS repair only to planned tracks; preserve Matroska ASS/SSA]
    CPUDEC --> ENCODE
    ENCODE -->|Hard encoder error| ENGINEFAIL
    ENCODE --> SIZE{AV1 output is valid and smaller than source?}
    SIZE -->|Yes| AV1VALID[Validate AV1 output]
    SIZE -->|No or encoder reached source-size limit| DISCARD[Delete AV1 attempt]
    DISCARD --> REMUX[Stream-copy original video; process retained audio, subtitles, chapters, and seek-healing mux flags]
    REMUX --> CAP{Within currently reserved scratch capacity?}
    CAP -->|Yes| REMUXVALID[Validate remux; it may exceed source size]
    CAP -->|No| GROW[Ask shared cache ledger for more capacity]
    GROW -->|Granted; raise process file limit| REMUX
    GROW -->|Denied; stop and delete partial| ENGINEFAIL
    AV1VALID --> OUTPROBE[Re-probe candidate streams, codec, color/HDR, and marker]
    REMUXVALID --> OUTPROBE
    OUTPROBE -->|Probe, stream, or metadata check failed| VALIDFAIL[Reject candidate; keep original]
    OUTPROBE -->|Passed| FRAMESCAN[Candidate frame scan; stop at first decisive mismatch, then compare full timestamps if clean]
    FRAMESCAN -->|First frame mismatch or timestamp check failed| VALIDFAIL
    FRAMESCAN -->|Passed| TIMELINE[Compare stream timelines; repaired audio must keep packet count and have strictly increasing DTS; verify ASS/SSA hashes and ≤0.5 s repair; verify PGS segments]
    TIMELINE -->|Failed| VALIDFAIL
    TIMELINE -->|Passed| FULLDECODE[Strict candidate video decode on configurable Arc QSV; audio decode on CPU]
    FULLDECODE -->|Clean| ENGINEOK[Return validated output]
    FULLDECODE -->|Video/audio decode failure| SOURCEVERIFY[Strictly decode original video and retained audio on CPU]
    SOURCEVERIFY -->|Known corruption reproduced| ENGINEFAIL
    SOURCEVERIFY -->|No known source corruption found| VALIDFAIL
    ENCODE -. User cancels worker .-> CANCEL[Worker stops; current candidate is not approved]
    REMUX -. User cancels worker .-> CANCEL
    FULLDECODE -. User cancels worker .-> CANCEL
    VALIDFAIL --> ENGINEFAIL
    CANCEL --> REAP[Kill child process groups and remove this scratch on SIGTERM; next admission reclaims lease]
  end

  ENGINEOK --> RECHECK[Recheck original identity and metadata]
  RECHECK -->|Changed or byte comparison fails| CLEANFAIL[Remove temp output and release reservation]
  RECHECK -->|Unchanged or exact byte-identical Mover relocation| REPLACE[Replace source and sync Tdarr database]
  REPLACE --> CLEANSUCCESS[Clean scratch and release reservation]
  CLEANSUCCESS --> ARR[Request Radarr/Sonarr rescan]
  ARR --> SUCCESS[Send Discord success embed]

  ENGINEFAIL --> CLEANFAIL
  CLEANFAIL --> SRCARR{Known source video/audio corruption, or strict decode confirms it in the original?}
  SRCARR -->|Yes| ARRROUTE[Select Arr from the first recognized library-root path segment]
  ARRROUTE -->|anime root; matched Sonarr series and episode IDs| EPSEARCH[Queue Anime or TV Sonarr EpisodeSearch; keep source]
  ARRROUTE -->|movie root; matched Radarr movie and exact movie file| MOVIESEARCH[Queue Radarr MoviesSearch; keep source]
  ARRROUTE -->|Unsupported path or item/file unresolved| NOSEARCH[No Arr search; keep source]
  SRCARR -->|No| NOSEARCH
  EPSEARCH --> FAILNOTICE[Send Discord failure embed with Arr search status]
  MOVIESEARCH --> FAILNOTICE
  NOSEARCH --> FAILNOTICE
  FAILNOTICE --> FAIL[Mark flow failed; keep original]

  ISOOUT --> ARRISO[Request Arr rescan after ISO deletion]
  ARRISO --> ISONOTICE[Send warning: ISO deleted; refetch requested/status]
  ISONOTICE --> HANDLED[End handled outcome]

  DONE --> DONEINFO[Send info: already processed; no encode ran]
  DONEINFO --> HANDLED

  HOOK[Unexpected Tdarr node error] --> ERRORCLEAN[Clean temp files and release reservation when available]
  ERRORCLEAN --> ERRORNOTICE[Send unexpected-error Discord embed]

  classDef failure fill:#3a2020,stroke:#ba5555,color:#f7eeee
  classDef success fill:#1f3528,stroke:#57956c,color:#eff8f1
  classDef cache fill:#203044,stroke:#5c85ad,color:#eff6fc
  class CLEANFAIL,FAILNOTICE,FAIL,ENGINEFAIL,VALIDFAIL failure
  class REPLACE,CLEANSUCCESS,ARR,SUCCESS,HANDLED,DONEINFO,ISONOTICE,ISOOUT success
  class CACHE,RAM,SHM,DISK cache
```

## Seek-heal remux rule

V15 runs one Arc AV1 encode at global ICQ 22. If its output is equal to or larger than the source, it deletes that encode attempt and remuxes the original video stream with seek-healing flags. It applies the same audio, subtitle, chapter, and metadata handling to the remux. The remux is not capped against the input size: it can replace the original even if mux overhead makes it larger, provided it passes full validation. Its scratch growth is bounded by available cache capacity, using the shared reservation ledger and retaining configured filesystem and host-RAM floors. If capacity growth is denied, Tdarr stops and removes the partial output, keeping the original.

A remux can repair container indexes and packet timestamps. It cannot reconstruct damaged compressed video or audio packets; decode and validation failures keep the original and trigger a search only when known source corruption is independently confirmed.

## Full validation and process diagnostics

Before the full source scan, V15 checks probed pixel format/depth, sample aspect ratio, Arc render-device access, ICQ configuration, the 12-bit policy, and applicable MediaInfo color mappings. Dolby Vision profile/base-layer eligibility and any required Dolby Level 6 extraction are also checked before the scan; the extracted Level 6 row count is then matched to the full decoded-frame count. Unsupported inputs and metadata conflicts can therefore stop before the expensive decode pass.

Every eligible source that passes preflight still gets a complete CPU frame, color/HDR, and timestamp scan before encoding. The scanner exits as soon as it finds known bitstream corruption, interlaced frames, conflicting color or static HDR metadata, or unsupported dynamic HDR; otherwise it reaches the end of the source. FFprobe in the test node cannot use the Arc device for the metadata scan. After encoding or remux, V15 scans the candidate and exits at the first decisive frame/metadata mismatch; a clean candidate still gets a complete scan and full source/output timestamp comparison. Checked timestamps must be present and differ by no more than 50 ms. It then checks stream counts/codecs, color/HDR metadata, audio/subtitle packet timelines, subtitle counts, and PGS payloads. Equal audio DTS values without any backward transitions are preserved, including time-base quantization ties. A bounded source DTS regression may be repaired by a timestamp-only bitstream filter by at most 100 ms; when repair runs, the candidate must retain packet count and have strictly increasing DTS. Larger or unprovable audio repair keeps the original and does not request an Arr search. Copied ASS/SSA packet payloads and counts must match exactly; subtitle timestamp repair remains limited to 0.5 seconds per packet.

Strict candidate video decode uses Arc QSV with `TDARR_ARC_DEVICE` (default `/dev/dri/renderD129`). Retained audio is decoded separately on the CPU. For the strict video decode, FFmpeg progress advances the Tdarr percentage and reports FPS; stream-copy remux and full frame scans also report progress/FPS. Metadata-only phases do not have a meaningful frame rate. Process stderr is preserved as diagnostic detail, but a clean exit status succeeds; recognized `-v error` source-corruption signatures are classified separately.

## Concurrency and scratch

V15 uses capacity reservations rather than a single job-at-a-time lock. Concurrent jobs may proceed when the shared cache ledger confirms that each has sufficient scratch and host-RAM headroom. The ledger coordinates jobs using it; unrelated writers and filesystem quotas remain outside its control. Each reservation heartbeats and records the exact worker scratch path. Cleanup removes only that job's scratch, and abandoned leases are reclaimed on a later admission.

The Discord webhook is injected through `TDARR_DISCORD_WEBHOOK`; it is not stored in the flow export. V15 sends success/failure embeds, an information notice when a file already has a completion marker, and a warning after deleting an ISO and requesting an Arr rescan. Success notices retain the `✅ filename` title and summarize the outcome, exact size delta, estimated video bitrate/ICQ, output track languages, validation, and processing time. A queued Arr search is not a guarantee that a replacement download is accepted.

The worker UI is seeded before media preflight with source size as both current and estimated output, so C and T begin at 100%. That is a neutral no-encode-yet baseline; live output size replaces it when encoding starts. Progress updates set phase status labels for source scan, retained-audio decode, Arc encode, seek-heal remux, frame/HDR scan, packet timeline comparison, and strict output decode. Tdarr's `updateWorker` interface accepts a free-form object, and the flow sends the worker `status` field alongside its existing percentage and worker details. The user confirmed on 2026-11-04 that the test UI's Status column displays the changing phase labels.
