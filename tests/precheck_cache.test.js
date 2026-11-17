const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  savePrecheckCache,
  loadPrecheckCache,
  removePrecheckCache,
  sourcePrecheckPathFor,
  saveSourcePrecheck,
  loadSourcePrecheck,
  removeSourcePrecheck,
  candidateFramesPathFor,
  saveCandidateFramesCache,
  loadCandidateFramesCache,
  removeCandidateFramesCache
} = require('../src/precheck_cache');

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-precheck-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id=`${'a'.repeat(64)}-${'b'.repeat(64)}-${'c'.repeat(24)}`;
  const directory=path.join(root,'tdarr-av1-quarantine'); fs.mkdirSync(directory);
  const candidatePath=path.join(directory,`${id}.mkv`); fs.writeFileSync(candidatePath,'candidate');
  return {root,quarantineRoot:directory,id,candidatePath,sourceHash:'b'.repeat(64)};
}
function evidence() {
  return {frameScan:{frames:2,timestamps:[0,0.04],interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0,staticInfo:{mastering:null,light:null,conflict:false},colorInfo:{expected:{},conflict:false}},audio:{streams:[{index:1,timeBase:'1/1000'}],repairs:[]}};
}
test('precheck evidence is reused only for the same source and implementation signature',t=>{
  const entry=fixture(t), data=evidence(), sig='d'.repeat(64);
  assert.equal(savePrecheckCache(entry,sig,data),true);
  assert.deepEqual(loadPrecheckCache(entry,sig),data);
  assert.equal(loadPrecheckCache(entry,'e'.repeat(64)),null);
  assert.equal(loadPrecheckCache({...entry,sourceHash:'f'.repeat(64)},sig),null);
  removePrecheckCache(entry);
  assert.equal(loadPrecheckCache(entry,sig),null);
});
test('corrupted or incomplete evidence cannot authorize reuse',t=>{
  const entry=fixture(t), sig='d'.repeat(64), data=evidence();
  assert.equal(savePrecheckCache(entry,sig,{...data,frameScan:{...data.frameScan,timestamps:[0]}}),false);
  assert.equal(savePrecheckCache(entry,sig,data),true);
  fs.writeFileSync(`${entry.candidatePath}.prechecks.gz`,'corrupt');
  assert.equal(loadPrecheckCache(entry,sig),null);
});

test('source-scoped precheck supports split video/audio invalidation and structured miss reasons',t=>{
  const entry={...fixture(t),sourceKey:'a'.repeat(64)};
  const data=evidence();
  const v1='1'.repeat(64), v2='2'.repeat(64), a1='3'.repeat(64), a2='4'.repeat(64);
  const miss=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1});
  assert.equal(miss.hit,'none');
  assert.equal(miss.videoReason,'missing');
  assert.equal(miss.audioReason,'missing');

  assert.equal(saveSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1},data),true);
  const cachePath=sourcePrecheckPathFor(entry);
  assert.equal(cachePath,path.join(entry.quarantineRoot,`${entry.sourceKey}-${entry.sourceHash}.prechecks.gz`));
  assert.equal(fs.existsSync(cachePath),true);

  const fullHit=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1});
  assert.equal(fullHit.hit,'full');
  assert.equal(fullHit.videoReason,'matched');
  assert.equal(fullHit.audioReason,'matched');
  assert.deepEqual(fullHit.frameScan,data.frameScan);
  assert.deepEqual(fullHit.audio,data.audio);

  // Audio-only change reuses video frameScan while marking audio invalidated
  const audioMiss=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a2});
  assert.equal(audioMiss.hit,'video_only');
  assert.equal(audioMiss.videoReason,'matched');
  assert.equal(audioMiss.audioReason,'audio_signature_changed');
  assert.deepEqual(audioMiss.frameScan,data.frameScan);
  assert.equal(audioMiss.audio,null);

  // Video-only change invalidates video frameScan cleanly
  const videoMiss=loadSourcePrecheck(entry,{videoSignature:v2,audioSignature:a1});
  assert.equal(videoMiss.hit,'audio_only');
  assert.equal(videoMiss.videoReason,'video_signature_changed');
  assert.equal(videoMiss.audioReason,'matched');
  assert.equal(videoMiss.frameScan,null);
  assert.deepEqual(videoMiss.audio,data.audio);

  // Source precheck path is reusable across a new candidate ID (retired old candidate)
  const newCandidate={...entry,id:`${'a'.repeat(64)}-${'b'.repeat(64)}-${'e'.repeat(24)}`,candidatePath:path.join(entry.quarantineRoot,`${'a'.repeat(64)}-${'b'.repeat(64)}-${'e'.repeat(24)}.mkv`)};
  assert.equal(loadSourcePrecheck(newCandidate,{videoSignature:v1,audioSignature:a1}).hit,'full');

  // Changing sourceHash misses with source_hash_changed and removes cleanly
  const changedHash=loadSourcePrecheck({...entry,sourceHash:'f'.repeat(64),id:`${'a'.repeat(64)}-${'f'.repeat(64)}-${'c'.repeat(24)}`,candidatePath:path.join(entry.quarantineRoot,`${'a'.repeat(64)}-${'f'.repeat(64)}-${'c'.repeat(24)}.mkv`)},{videoSignature:v1,audioSignature:a1});
  assert.equal(changedHash.hit,'none');
  assert.equal(changedHash.videoReason,'missing');

  fs.writeFileSync(cachePath,'corrupt-bytes');
  const corrupt=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1});
  assert.equal(corrupt.hit,'none');
  assert.equal(corrupt.videoReason,'corrupt');

  removeSourcePrecheck(entry);
  assert.equal(fs.existsSync(cachePath),false);
});

test('candidate frame scan cache keys by candidateHash and signature and rejects tampering',t=>{
  const entry={...fixture(t),candidateHash:'e'.repeat(64)};
  const frameScan=evidence().frameScan;
  const sig1='7'.repeat(64), sig2='8'.repeat(64);
  assert.equal(loadCandidateFramesCache(entry,sig1).hit,false);
  assert.equal(loadCandidateFramesCache(entry,sig1).reason,'missing');
  assert.equal(saveCandidateFramesCache(entry,sig1,frameScan),true);
  assert.equal(fs.existsSync(candidateFramesPathFor(entry)),true);
  const hit=loadCandidateFramesCache(entry,sig1);
  assert.equal(hit.hit,true);
  assert.equal(hit.reason,'matched');
  assert.deepEqual(hit.frameScan,frameScan);
  assert.deepEqual(loadCandidateFramesCache(entry,sig2),{hit:false,frameScan:null,reason:'signature_changed'});
  assert.deepEqual(loadCandidateFramesCache({...entry,candidateHash:'9'.repeat(64)},sig1),{hit:false,frameScan:null,reason:'candidate_hash_changed'});
  fs.writeFileSync(candidateFramesPathFor(entry),'corrupt');
  assert.deepEqual(loadCandidateFramesCache(entry,sig1),{hit:false,frameScan:null,reason:'corrupt'});
  removeCandidateFramesCache(entry);
  assert.equal(fs.existsSync(candidateFramesPathFor(entry)),false);
});

test('source precheck cache optionally stores and independently validates Dolby hdrPreflight metadata',t=>{
  const entry=fixture(t);
  const data=evidence();
  const hdrPreflight={
    route:'dovi5_hdr10',
    frames:24,
    level6:{max_content:1000,max_average:200,max_luminance:1000,min_luminance:0.0001},
    level9:{source_primary_index:0,frames:24}
  };
  const v1='1'.repeat(64), a1='2'.repeat(64), h1='3'.repeat(64), h2='4'.repeat(64);
  assert.equal(saveSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1,hdrSignature:h1},{...data,hdrPreflight}),true);
  const hit=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1,hdrSignature:h1});
  assert.equal(hit.hit,'full');
  assert.equal(hit.hdrReason,'matched');
  assert.deepEqual(hit.hdr,hdrPreflight);

  // Changing hdrSignature misses hdrPreflight without invalidating video/audio
  const hdrMiss=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1,hdrSignature:h2});
  assert.equal(hdrMiss.hit,'full');
  assert.equal(hdrMiss.hdrReason,'hdr_signature_changed');
  assert.equal(hdrMiss.hdr,null);
  assert.deepEqual(hdrMiss.frameScan,data.frameScan);

  // Legacy caller omitting hdrSignature still gets full video/audio hit cleanly
  const legacyCaller=loadSourcePrecheck(entry,{videoSignature:v1,audioSignature:a1});
  assert.equal(legacyCaller.hit,'full');
});
