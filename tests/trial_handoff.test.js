// Run: node --test tests/trial_handoff.test.js
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../rosboard/html/js/subt_experiment.js'), 'utf8');
async function setup(condition, failPrepare = false) {
  const calls = [], topics = new Map();
  const element = () => ({style: {}, appendChild() {}, addEventListener() {}});
  const window = {SUBT: {experiment: {enabled: true}, studyFlow: {enabled: true},
    whitelist: [], isReplay: condition !== 'D', isDraw: condition === 'W',
    getSelectedSegment: () => 'config_1'}};
  const services = [];
  const ROSLIB = {
    Ros: class {
      constructor() { this.idCounter=0; this.responses=new Map(); }
      on(event, cb) { if (event === 'connection') setTimeout(cb, 0); }
      once(id, cb) { this.responses.set(id, cb); }
      removeListener(id) { this.responses.delete(id); }
      callOnConnection(request) {
        assert.equal(request.timeout, 60, 'handoff must exceed rosbridge default timeout');
        services.push(request.service);
        const cb=this.responses.get(request.id); this.responses.delete(request.id);
        cb({result:true, values:{success: !(failPrepare && request.service.endsWith('/prepare')), message:'test failure'}});
      }
    },
    Topic: class { constructor(opts) { this.name = opts.name; topics.set(this.name, this); }
      subscribe(cb) { this.cb = cb; } publish() { calls.push(this.name); } },
    ServiceRequest: class { constructor(v) { Object.assign(this,v); } },
    Message: class { constructor(v) { Object.assign(this,v); } },
    Service: class { constructor(opts) { this.name = opts.name; }
      callService(req, cb) {
        services.push(this.name);
        if (this.name === '/rosapi/subscribers') return cb({subscribers: ['coordinator']});
        if (this.name === '/rosapi/publishers') return cb({publishers: ['sensor']});
        cb({success: !(failPrepare && this.name.endsWith('/prepare')), message: 'test failure'});
      }
    }
  };
  if (condition === 'W') window.SUBT.startDrawSegment = (name, opts) => {
    calls.push(['draw', name, opts]); return Promise.resolve({ok:true});
  };
  const context = {window, ROSLIB, document: {readyState: 'complete', body: element(),
    createElement: element, getElementById: () => null},
    location: {search: '', protocol: 'http:', port: '8888', hostname: 'localhost'},
    URLSearchParams, console, setTimeout, clearTimeout,
    setInterval: cb => setInterval(cb, 5), clearInterval,
    fetch: (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return Promise.resolve({json: () => Promise.resolve({ok:true})}); }};
  vm.runInNewContext(source, context);
  const ctrl = window.SUBT.experimentController;
  for (let i=0; i<100 && !ctrl.isReady(); i++) await new Promise(r => setTimeout(r,5));
  assert.equal(ctrl.isReady(), true);
  topics.get('/clock').cb({clock:{sec:10}});
  return {ctrl, calls, services, clock: topics.get('/clock')};
}
for (const condition of ['D','R','W']) test(`${condition}: preparation holds until explicit release`, async () => {
  const h = await setup(condition);
  await new Promise((resolve,reject) => h.ctrl.startTrial({condition, deferStart:true, noOverlay:true, onError:reject}, resolve));
  assert.equal(h.services.includes('/experiment/resume'), false);
  assert.equal(h.calls.some(c => Array.isArray(c) && c[0] === '/segments/resume'), false);
  assert.equal(h.ctrl.trialElapsedSimSec(), 0);
  if (condition === 'D') assert.ok(h.services.includes('/experiment/prepare'));
  else {
    const open = h.calls.find(c => Array.isArray(c) && (c[0] === '/segments/play' || c[0] === 'draw'));
    assert.equal((condition === 'W' ? open[2] : open[1]).paused, true);
    assert.ok(h.calls.some(c => c[0] === '/segments/seek'));
  }
  await h.ctrl.resumeTrial();
  if (condition === 'D') assert.ok(h.services.includes('/experiment/resume'));
  else assert.ok(h.calls.some(c => c[0] === '/segments/resume'));
  h.clock.cb({clock:{sec:12}});
  assert.equal(h.ctrl.trialElapsedSimSec(), 2);
  await assert.rejects(h.ctrl.resumeTrial(), /not prepared/);
  h.ctrl.stopTrial();
});
test('failed preparation cannot release a trial', async () => {
  const h = await setup('D', true);
  const error = await new Promise(resolve => h.ctrl.startTrial({condition:'D', deferStart:true, onError:resolve}, () => assert.fail('must not report ready')));
  assert.match(error.message, /test failure/);
  assert.equal(h.services.includes('/experiment/resume'), false);
  await assert.rejects(h.ctrl.resumeTrial(), /not prepared/);
});
test('whack-a-mole gates preparation and releases only after the reveal paints, including debug', async () => {
  const flow = fs.readFileSync(path.join(__dirname, '../rosboard/html/js/subt_study_flow.js'), 'utf8');
  const text = flow.slice(flow.indexOf('  function runTrialSet('), flow.indexOf('  function trialCountForSet('));
  const events = []; let ready, gameDone, options, finishTrial;
  const window = {SUBT: {experimentController: {currentTrial: () => 0, showOverlay: () => assert.fail('unexpected failure')},
    showMinigame: (done, opts) => {gameDone=done; options=opts;}}};
  const context = {window, Promise, cumulativeWhackamoleScore:0, hideShell(){},showTrialProgress(){},hideTrialProgress(){},
    debugMode: () => true, trialWhackamoleOptions: () => ({}), collectData(){},
    requestAnimationFrame: cb => {events.push('paint'); queueMicrotask(cb);},
    runRobotTrial: (condition,label,prepared) => new Promise(resolve => {
      finishTrial=resolve;
      ready=() => prepared(() => {events.push('release'); finishTrial(); return Promise.resolve();});
    })};
  vm.runInNewContext(text, context);
  const done = context.runTrialSet('R',1);
  await new Promise(r => setImmediate(r));
  assert.ok(options.waitFor, 'debug must not bypass the readiness gate');
  assert.deepEqual(events,[]);
  ready(); await options.waitFor;
  assert.deepEqual(events,[], 'preparing the trial must not release it');
  gameDone({}); await done;
  assert.deepEqual(events,['paint','paint','release']);
});
test('paused camera readiness uses a finite cached JPEG when MJPEG never decoded', async () => {
  const layout = fs.readFileSync(path.join(__dirname, '../rosboard/html/js/subt_layout.js'),'utf8');
  const text=layout.slice(layout.indexOf('  window.SUBT.waitForCameraReady ='),layout.indexOf('  function closeImg(img)'));
  const old={naturalWidth:0};const events=[];
  const context={window:{SUBT:{}},fixedCameraImg:old,Date,Promise,setTimeout,
    URL:{createObjectURL:()=>'blob:prepared-frame'},
    fetch:async url=>{assert.match(url,/camera\/preview.jpg/);return {ok:true,blob:async()=>({})};},
    makeImg:url=>{assert.equal(url,'blob:prepared-frame');const image={naturalWidth:0};queueMicrotask(()=>{image.naturalWidth=640;image.onload();});return image;},
    positionFixedCameraImg:()=>events.push('show-preview'),closeImg:image=>{assert.equal(image,old);events.push('close-broken-stream');},
    recycleCameraImg:()=>events.push('open-live-stream')};
  vm.runInNewContext(text,context);
  await context.window.SUBT.waitForCameraReady();
  assert.equal(context.fixedCameraImg.naturalWidth,640);
  assert.deepEqual(events,['show-preview','close-broken-stream']);
  context.window.SUBT.releaseCameraPreview();
  assert.equal(events.at(-1),'open-live-stream');
});
