# HDR and Dolby Vision integration

Build a separate candidate based on V4. Enable objectively verifiable HDR10 and HDR10-compatible single-layer Dolby Vision base-layer conversion to static HDR10, maintaining the user's requested ICQ floors, strict size reduction, stream choices, Arc encoder, cleanup and original-file guards. Inspect decoded frames for HDR dynamic metadata and scan order; obtain source HDR10 mastering metadata from stream or frame side data. Require accurate HDR10 output color and mastering/light metadata before replacement. Never infer PQ from conflicting source tags. Plain HLG is supported by preserving HLG color signaling. Other Dolby Vision profiles and HDR10+ require separately verified paths and remain fail-closed. V4 completion markers remain recognized to avoid generational re-encoding.

1. Add failing tests for classification of HDR10 and compatible Dolby Vision, dynamic metadata rejection, static metadata comparison, and source frame inspection.
2. Implement the minimum passing profile paths with decoded-frame metadata inspection and explicit loss notification for Dolby Vision HDR10 fallback.
3. Test on disposable Dolby reference samples and the actual Arc; test failure and malformed signals. Keep originals and live flow untouched.
4. Request independent safety review, rerun the full candidate suite and document exact support and remaining limitations.
