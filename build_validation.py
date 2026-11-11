# Structured boundaries around the existing candidate contracts. The contracts
# retain their numeric tolerances; process failures cannot masquerade as damage.
one('const validateOutput = async (ffprobeBin, sourcePath, outputPath, expected) => {', '''const validateOutput = async (ffprobeBin, sourcePath, outputPath, expected) => {
  const validationReport=expected.validationReport || newValidationReport();''')
one('''  if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
  const src = probe(sourcePath);
  const dst = probe(outputPath);
  if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();''', '''  const {src,dst}=await validationStage(validationReport,"stream_probe",async()=>{
    if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
    const src=probe(sourcePath),dst=probe(outputPath);
    if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
    return {src,dst};
  });''')

def validation_boundary(start, end, stage, outcome='rejected', result=None):
 global e
 a=e.index(start,e.index('const validateOutput ='))
 b=e.index(end,a)
 body=e[a:b]
 if result:
  wrapped=f'  const {{{result}}}=await validationStage(validationReport,"{stage}",async()=>{{\n'+body+f'    return {{{result}}};\n  }},"{outcome}");\n'
 else:
  wrapped=f'  await validationStage(validationReport,"{stage}",async()=>{{\n'+body+f'  }},"{outcome}");\n'
 e=e[:a]+wrapped+e[b:]

validation_boundary('  if (video.length !== 1)', '  let outputFrameScan;', 'video_stream')
validation_boundary('  if (expected.sourceFrameScan || expected.hdr10)', '  if (expected.hdr10)', 'frames')
validation_boundary('  if (expected.hdr10)', '  // 2. Audio & Subtitle', 'hdr_color')
validation_boundary('  // 2. Audio & Subtitle', '  return await validationStage(validationReport,"timelines"', 'streams', result='sourceVideo,tracks')
one('throw new Error("Video frame count unavailable")','throw validationUnavailable("Video frame count unavailable")')
validation_start=e.index('    const valResult = await validateOutput(ffprobeBin, inputPath, outputPath, {')
validation_end=e.index('    log(`[Output Validation]',validation_start)
validation_block=e[validation_start:validation_end]
options_start=validation_block.index('{')+2
options_end=validation_block.rindex('    });')
validation_options=validation_block[options_start:options_end]
if validation_options.count('subtitleCodecs: expectedSubCodecs')!=1:
 raise RuntimeError('Unexpected candidate validation options')
validation_options='\n'.join(('  '+line if line else line) for line in validation_options.splitlines())
validation_options='        validationReport,\n'+validation_options
validation_replacement='''    let validationReport;
    const validateCandidate=async()=>{
      validationReport=args.variables.user.validation_report=newValidationReport();
      return await validationStage(validationReport,"candidate_validation",()=>validateOutput(ffprobeBin, inputPath, outputPath, {
'''+validation_options+'''      }));
    };
    const clampRetryResult=await validateQsvWithSvtHdrClampFallback({
      source:qsvHdrClampRetryEligible && !softwareHdrFallback ? hdrSource : null,
      validateQsvCandidate:validateCandidate,
      encodeSvtFallback:async()=>{
        if(fs.existsSync(outputPath))fs.unlinkSync(outputPath);
        softwareHdrFallback=true;quality=28;qualityLabel="SVT-AV1 CRF";
        pipelineMode="Software SVT-AV1 HDR encode (QSV green-y clamp fallback)";
        log("[Arc AV1] QSV produced the known green-y mastering clamp; retrying once with SVT-AV1 CRF 28, then applying full candidate validation again.");
        const result=await runFfmpeg(needsProactiveHybrid,false,true);
        if(result.error)throw result.error;
        if(result.capacityError)throw result.capacityError;
        if(result.status!==0||!fs.existsSync(outputPath))throw Error(`SVT-AV1 green-y clamp retry failed (${result.status ?? result.signal ?? "unknown"}): ${extractFfmpegError(result.stderr) || "no output candidate"}`);
        if(fs.statSync(outputPath).size>=sourceBytes){fs.unlinkSync(outputPath);throw Error("SVT-AV1 green-y clamp retry did not produce a smaller candidate");}
        return outputPath;
      },
      validateSvtCandidate:async()=>await validateCandidate()
    });
    const valResult=clampRetryResult.validation;
'''
e=e[:validation_start]+validation_replacement+e[validation_end:]
one('''    assertOriginalUnchanged();
    const destinationPath = path.join(path.dirname(originalPath), path.basename(outputPath));
    if (destinationPath !== originalPath && fs.existsSync(destinationPath)) throw new Error(`Replacement destination already exists: ${destinationPath}`);''', '''    await validationStage(validationReport,"replacement_readiness",async()=>{
      assertOriginalUnchanged();
      const destinationPath=path.join(path.dirname(originalPath),path.basename(outputPath));
      if(destinationPath!==originalPath && fs.existsSync(destinationPath))throw Error(`Replacement destination already exists: ${destinationPath}`);
    });
    completeValidation(validationReport);
    log(`[Validation result] ${validationReport.outcome}; all required checks passed.`);
    for(const recovery of validationReport.recoveries)log(`[Validation recovery] QSV decode failed; full software verification passed. QSV diagnostic: ${recovery.diagnostic}`);''')
one('''    const reason=alreadyClassified?detail:originalGuard?`[Original guard] ${detail}`:`[Safety check failed] ${detail}`;''', '''    const validation=err?.validation;
    const reason=alreadyClassified?detail:originalGuard?`[Original guard] ${detail}`:validation?`[Validation ${validation.outcome}] ${detail}`:`[Safety check failed] ${detail}`;''')
one('  delete args.variables.user.failure_reason;', '  delete args.variables.user.failure_reason;\n  delete args.variables.user.validation_report;')
# Existing failure capture preserves the structured result prefix in job/Arr logs.
e=e.replace('safety check failed|source media corruption|iso guard', 'validation inconclusive|validation rejected|safety check failed|source media corruption|iso guard')
