'use strict';

const fs = require('node:fs');
const path = require('node:path');

const engineSource = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow.json'), 'utf8'))
  .flowPlugins.find(plugin => plugin.id === 'arc_av1_monolithic').inputsDB.code;
const engineExports = {
  testPolicy: 'selectQualityValue',
  testRun: 'runSingleQuality',
  testDone: 'isCompletedEncode',
  testClassify: 'classifyVideo',
  testHdr: 'validateHdr10',
  testColor: 'validateSdrColor',
  testVideoGuard: 'guardSourceVideo',
  testQsvDecode: 'useQsvDecode',
  testAspect: 'validateAspect',
  testIsInterlacedFieldOrderTag: 'isInterlacedFieldOrderTag',
  testMissingSar: 'isMissingSampleAspectRatio',
  testSquareMediaInfoPar: 'isSquareMediaInfoPixelAspectRatio',
  testHasVerifiedCandidateFrameTimestamps: 'hasVerifiedCandidateFrameTimestamps',
  testHdrRoute: 'determineHdrRoute',
  testHybridPreflight: 'preflightHybridHdr',
  testMergeHdr: 'mergeHdrMetadata',
  testRecordFrame: 'recordHdrFrame',
  testScanFrames: 'inspectVideoFrames',
  testDecodeThreads: 'getDecodeThreadCount',
  testFrameScanArgs: 'buildFrameScanArguments',
  testWithDecoderThreads: 'withDecoderThreads',
  testL6: 'parseDolbyLevel6',
  testCompareTimes: 'compareVideoTimestamps',
  testHlg: 'validateHlg',
  testProcess: 'runTimelineProcess',
  testSdrSignal: 'isVerifiedSdr',
  testL6Rows: 'summarizeLevel6Rows',
  testResolveLight: 'resolveHdrLight',
  testDolbyPreflight: 'preflightDolbyHdrRoute',
  testVerifyP5RpuRange: 'verifyDolbyProfile5RpuFullRange',
  testL9: 'parseDolbyLevel9',
  testL9Rows: 'summarizeLevel9Rows',
  testBuildDovi5Target: 'buildDovi5HdrTarget',
  testMasteringDisplayArg: 'formatMasteringDisplayArg',
  testExtractP5: 'extractDolbyProfile5HdrMetadata',
  testHdrFrameRequirements: 'hdrFrameMetadataRequirements',
  testHdrStatic: 'checkHdrFrameStatic',
  testVideoFilter: 'composeVideoFilterChain',
  testVideoEncodeFilter: 'buildVideoEncodeFilterChain',
  testSdrTransfer: 'validateEffectiveSdrTransfer',
  testSdrFrameSignaling: 'validateSdrFrameSignaling',
  testMediaInfoColors: 'validateMediaInfoHdrColors',
  testSdrSource: 'effectiveSdrSource',
  testUntagged: 'isUntaggedVideo',
  testUntaggedOutput: 'validateUntaggedOutput',
  testUntaggedRange: 'inferUntaggedColorRange',
  testUntaggedRangeArgs: 'untaggedColorRangeArgs',
  testFreeSpace: 'getFreeSpaceMB',
  testKnownQsvHdrClamp: 'isKnownQsvHdrMasteringClamp',
  testKnownQsvHdrClampRisk: 'isQsvHdrMasteringClampRisk',
  testKnownQsvHdrClampRetry: 'shouldRetrySvtForQsvHdrClamp',
  testQsvHdrFallbackRunner: 'validateQsvWithSvtHdrClampFallback',
  testNormalizeIntroMasteringSplice: 'normalizeIntroMasteringSplice',
  testMustRetainOriginalAtQualityFloor: 'mustRetainOriginalAtQualityFloor',
  testIsVerifiedHdrColorRange: 'isVerifiedHdrColorRange',
  testIsExplicitSdrColorTriplet: 'isExplicitSdrColorTriplet',
  testIsSdrWithOrphanStaticHdr: 'isSdrWithOrphanStaticHdr',
  testHasFrameDolbyRpu: 'hasFrameDolbyRpu',
  testReconcileDolbyLevel6FrameCount: 'reconcileDolbyLevel6FrameCount',
  testValidate: 'validateOutput',
  releaseForTest: 'releaseCapacity'
};
const engineTestExports = Object.entries(engineExports)
  .map(([exportName, functionName]) => `module.exports.${exportName} = typeof ${functionName} === "function" ? ${functionName} : null;`)
  .join('\n');

function runFlowCode(parameters, code, values) {
  let body = code;
  const isEngineCode = code === engineSource
    || (typeof code === 'string' && code.startsWith('const STAGE_CODE_HASHES=') && code.includes('const runV6ArcJob ='));
  if (isEngineCode) body += `\n${engineTestExports}\nmodule.exports.testPlugin = module.exports;`;
  return new Function(...parameters, body)(...values);
}

module.exports = {runFlowCode};
