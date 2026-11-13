const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname,'flow.json')));
const engine=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code;

test('PGS validation compares segments rather than container packet counts',()=>{
 assert.ok(engine.includes('verifyPgsSegments'),'missing PGS validation');
 assert.ok(engine.includes('hdmv_pgs_subtitle'),'missing PGS codec routing');
});

test('whole-job lock is replaced by owned concurrent capacity reservations',()=>{
 assert.equal(engine.includes('await acquireCapacityLock('),false,'global job lock still present');
 assert.ok(engine.includes('await reserveCapacity('),'missing capacity reservation');
 for(const id of ['cleanup_success','cleanup_failure','cleanup_on_error']) {
  const code=flow.flowPlugins.find(p=>p.id===id).inputsDB.code;
  assert.ok(code.includes('await releaseCapacity('),`missing reservation release: ${id}`);
 }
});

test('interlace is decided from a full decoded source scan, and output field order remains guarded',()=>{
 assert.ok(engine.includes('const sampleEligible=canUseSamplePrecheck(preflightBasic,mainVideo);'),'source sampling must use the tested interlace policy');
 assert.ok(engine.includes('validateAspect(mainVideo, mainVideo, false)'),'source metadata must not be treated as output metadata after its frame scan');
 assert.ok(engine.includes('if (frameScan.interlaced) throw Error("Interlaced video frames are unsupported")'),'decoded interlaced source frames must remain held');
 assert.ok(engine.includes('if (order && ![\'progressive\',\'unknown\'].includes(order)) throw Error(\'Output has interlaced field order\')'),'encoded output field-order guard must remain');
});

test('canceled workers leave reclaimable reservations with job-owned scratch paths',()=>{
 assert.ok(engine.includes('heartbeatCapacityReservation'),'active reservations need a lease heartbeat');
 assert.ok(engine.includes('registerReservationWorkspace'),'the lease must identify only its own scratch directory');
 assert.ok(engine.includes('reservationStaleAfterMs'),'orphan cleanup needs a bounded lease');
 assert.ok(engine.includes('trackReservationChild'),'nested FFmpeg/FFprobe processes must be tracked');
 assert.ok(engine.includes('detached:true'),'process groups must be killable when Tdarr cancels the worker');
 for(const id of ['cleanup_success','cleanup_failure','cleanup_on_error']) assert.ok(flow.flowPlugins.find(p=>p.id===id).inputsDB.code.includes('await releaseCapacity('));
});

test('controlled and unexpected failures both pass through deduplicated alerts',()=>{
 const has=(a,b)=>flow.flowEdges.some(e=>e.source===a&&e.target===b);
 assert.ok(has('cleanup_failure','notify_arr_iso'));
 assert.ok(has('notify_arr_iso','notify_failure'));
 assert.ok(has('notify_failure','fail_flow'));
 assert.ok(has('cleanup_on_error','notify_failure_on_error'));
 assert.equal(flow.flowEdges.some(e=>e.source==='notify_failure_on_error'&&e.target==='fail_flow'),false);
});

test('ISO deletion uses the central notifier after the Arr scan without marking a delivery prematurely',()=>{
 assert.ok(flow.flowEdges.some(e=>e.source==='notify_arr_iso'&&e.target==='notify_failure'));
 assert.equal(engine.includes('failure_notified=true; // ISO deletion'),false);
});

test('RAM-backed caches are not admitted using only tmpfs free-space estimates',()=>{
 assert.equal(engine.includes('TDARR_USE_RAM_CACHE'),false);
 assert.ok(engine.includes('16914836n'),'missing tmpfs filesystem check');
});

test('frame timestamp comparison supplies the count check without a second full frame decode',()=>{
 const validation=engine.slice(engine.indexOf('const validateOutput'),engine.indexOf('const getFreeSpaceMB'));
 assert.ok(engine.includes('compareVideoTimestamps(expected.sourceFrameScan,outputFrameScan)'));
 assert.ok(engine.includes('a.length!==b.length'),'timestamp comparison must reject frame-count changes');
 assert.ok(validation.includes('if (!expected.sourceFrameScan) {'),'fallback count must run only when no source frame scan exists');
 assert.ok(validation.includes('const countFrames = (file, index)'),'missing fallback frame count');
});

test('failure plugin uses a processing category instead of its testing defaults',()=>{
 const node=flow.flowPlugins.find(p=>p.id==='fail_flow');
 assert.equal(node.inputsDB.failureCategory,'custom');
 assert.equal(node.inputsDB.customCategoryName,'transcode');
 assert.equal(node.inputsDB.analyzeVariables,false);
});
