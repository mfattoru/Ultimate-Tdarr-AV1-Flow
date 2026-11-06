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

test('controlled and unexpected failures both pass through deduplicated alerts',()=>{
 const has=(a,b)=>flow.flowEdges.some(e=>e.source===a&&e.target===b);
 assert.ok(has('cleanup_failure','notify_failure'));
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

test('failure plugin uses a processing category instead of its testing defaults',()=>{
 const node=flow.flowPlugins.find(p=>p.id==='fail_flow');
 assert.equal(node.inputsDB.failureCategory,'custom');
 assert.equal(node.inputsDB.customCategoryName,'transcode');
 assert.equal(node.inputsDB.analyzeVariables,false);
});
