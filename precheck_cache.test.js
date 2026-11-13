const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {savePrecheckCache, loadPrecheckCache, removePrecheckCache} = require('./precheck_cache');

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
