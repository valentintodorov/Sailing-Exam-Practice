// Tests for exam-trainer.html. Runs the page's script against a minimal fake DOM, localStorage
// and fetch, then exercises the app through its own event handlers.
//
//   node tests/trainer.test.js [path/to/exam-trainer.html] [path/to/questions.json]
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const htmlPath = process.argv[2] || path.join(root, 'exam-trainer.html');
const questionsPath = process.argv[3] || path.join(root, 'vodach-40bt-questions-embedded.json');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const qs = fs.readFileSync(questionsPath, 'utf8');
new Function(script); // syntax check

const QKEY = 'examTrainer.questions.v1';
const flush = () => new Promise(r => setTimeout(r, 20));

// Boots a fresh copy of the app. `store` is the initial localStorage content; `fetchImpl`
// replaces window.fetch (default: always fails, like opening the page from file://).
function boot({ store = {}, fetchImpl = () => Promise.reject(new Error('offline')) } = {}){
  const env = { store, listeners: {}, lastHTML: '', full: false, fetchCalls: [], lastAlert: null, importText: '' };
  const el = () => ({ innerHTML: '', classList: { toggle(){} }, querySelector: () => null, focus(){} });
  const app = el(), nav = el();
  Object.defineProperty(app, 'innerHTML', { set(v){ env.lastHTML = v; }, get(){ return env.lastHTML; } });
  global.localStorage = {
    getItem: k => env.store[k] ?? null,
    setItem: (k, v) => { if (k === QKEY && env.full) throw new Error('quota'); env.store[k] = v; },
  };
  global.document = {
    activeElement: null,
    querySelector: s => s === '#app' ? app : s === '#nav' ? nav : s === '#import-text' ? { value: env.importText } : null,
    querySelectorAll: () => [],
    addEventListener: (t, f) => { env.listeners[t] = f; },
  };
  global.window = { scrollTo(){}, addEventListener: (t, f) => { env.listeners['w' + t] = f; } };
  global.fetch = (url, ...rest) => { env.fetchCalls.push(url); return fetchImpl(url, ...rest); };
  global.confirm = () => true;
  global.alert = m => { env.lastAlert = m; };
  new Function(script)();
  env.Logic = window.__app.Logic;
  env.state = () => window.__app.state;
  env.click = (action, data = {}) => env.listeners.click({ target: { closest: () => ({ disabled: false, dataset: { action, ...data } }) } });
  env.key = (k, extra = {}) => env.listeners.keydown({ key: k, ...extra });
  return env;
}

const okResponse = text => Promise.resolve({ ok: true, text: () => Promise.resolve(text) });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const parsed = (() => { boot(); return window.__app.Logic.parseQuestions(qs); })();

test('question file parses without errors', () => {
  assert.ok(parsed.questions.length > 0);
  assert.strictEqual(parsed.errors.length, 0);
});

test('first visit auto-loads the bundled question file', async () => {
  const env = boot({ fetchImpl: () => okResponse(qs) });
  await flush();
  assert.deepStrictEqual(env.fetchCalls, ['vodach-40bt-questions-embedded.json']);
  assert.strictEqual(Object.keys(env.state().questions).length, parsed.questions.length);
  assert.ok(env.store[QKEY], 'loaded questions are saved to localStorage');
});

test('no auto-load when questions are already stored', async () => {
  const first = boot({ fetchImpl: () => okResponse(qs) });
  await flush();
  const env = boot({ store: first.store, fetchImpl: () => okResponse(qs) });
  await flush();
  assert.strictEqual(env.fetchCalls.length, 0);
  assert.strictEqual(Object.keys(env.state().questions).length, parsed.questions.length);
});

test('failed auto-load leaves an empty, working app', async () => {
  const env = boot({ fetchImpl: () => Promise.resolve({ ok: false, status: 404 }) });
  await flush();
  assert.strictEqual(env.fetchCalls.length, 1);
  assert.strictEqual(Object.keys(env.state().questions).length, 0);
});

test('import, keyboard handling, storage quota, session repair, backup restore', async () => {
  const env = boot();
  await flush();
  const S = env.state;

  // import via the app path
  env.importText = qs;
  env.click('import-text');
  assert.strictEqual(Object.keys(S().questions).length, parsed.questions.length);

  // start a session by category
  env.click('start-cat', { cat: Object.values(S().questions)[0].category });
  assert.ok(S().session && S().session.ids.length > 0);
  const s = S().session;

  // Ctrl+S / Cmd+V must NOT skip / reveal; auto-repeat is ignored
  env.key('s', { ctrlKey: true }); env.key('v', { metaKey: true });
  assert.strictEqual(s.idx, 0); assert.ok(!s.answers[s.ids[0]]);
  env.key('1', { repeat: true }); assert.ok(!s.answers[s.ids[0]]);

  // digit answers; Enter on a focused button is left to the button
  env.key('1'); assert.ok(s.answers[s.ids[0]]);
  document.activeElement = { tagName: 'BUTTON', dataset: {} };
  env.key('Enter'); assert.strictEqual(s.idx, 0, 'Enter on focused button should not double-advance');
  document.activeElement = null;
  env.key('Enter'); assert.strictEqual(s.idx, 1);

  // progress is saved even when question storage is full
  env.full = true;
  env.click('import-text'); // forces a question rewrite, which fails
  env.key('2');
  const saved = JSON.parse(env.store['examTrainer.v1']);
  assert.ok(saved.progress[s.ids[1]], 'progress must be saved despite quota error on questions');
  env.full = false;

  // repairSession: option count changed for a session question
  const id = s.ids[2];
  S().questions[id] = { ...S().questions[id], options: S().questions[id].options.slice(0, 2), answer: [0] };
  env.Logic.repairSession(S());
  assert.strictEqual(S().session.perm[id].length, 2);
  // a session referring to a deleted question is dropped
  delete S().questions[s.ids[3]]; env.Logic.repairSession(S()); assert.strictEqual(S().session, null);

  // backup restore keeps valid questions/progress and reports malformed ones
  const good = Object.values(S().questions).slice(0, 3);
  const bad = { id: 'x', question: 'q', category: 'c', options: ['a'], answer: [5] };
  const backup = { questions: { a: good[0], b: good[1], c: good[2], x: bad },
    progress: { [good[0].id]: { attempts: 1, correct: 1, last: true, streak: 1 }, zz: {} } };
  env.listeners.change({ target: { id: 'backup-file', value: 'f', files: [{ text: () => Promise.resolve(JSON.stringify(backup)) }] } });
  await flush();
  assert.strictEqual(Object.keys(S().questions).length, 3);
  assert.deepStrictEqual(Object.keys(S().progress), [good[0].id]);
  assert.ok(/1 malformed/.test(env.lastAlert));
});

(async () => {
  let failed = 0;
  for (const t of tests){
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e){ failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} tests failed` : `\nAll ${tests.length} tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
