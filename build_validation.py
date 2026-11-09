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
one('''    const valResult = await validateOutput(ffprobeBin, inputPath, outputPath, {''', '''    const validationReport=args.variables.user.validation_report=newValidationReport();
    const valResult = await validationStage(validationReport,"candidate_validation",()=>validateOutput(ffprobeBin, inputPath, outputPath, {
      validationReport,''')
one('''      subtitleCodecs: expectedSubCodecs
    });''','''      subtitleCodecs: expectedSubCodecs
    }));''')
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
