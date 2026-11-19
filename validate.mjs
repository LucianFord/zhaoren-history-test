import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = path.join(root, '.validation');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(root, 'index.html')).pipe(response);
  } else {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const cdpPort = Number(process.env.CDP_PORT || 9222);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const pending = new Map();
let nextId = 0;
const errors = [];
const checks = [];
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };

try {
  const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`Cannot create Chrome tab: ${created.status}. Start the Douyin skill browser or another CDP Chrome on port ${cdpPort}.`);
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  };
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click(); true`);
  const answer = index => evaluate(`document.querySelector('#options .option[data-index="${index}"]').click(); true`);
  const navigate = async () => {
    await call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await delay(1000);
  };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate();
  assert.equal(await evaluate(`document.title`), '照人｜你的行事风格像哪位历史人物？');
  assert.equal(await evaluate(`document.querySelector('#start-view').hidden`), false);
  assert.equal(await evaluate(`window.__zhaoren.questions.length`), 12);
  assert.equal(await evaluate(`Object.keys(window.__zhaoren.figures).length`), 6);
  await screenshot('desktop-start.png');
  passed('首屏加载、12 道题和 6 类人物完整');

  await click('start-btn');
  await answer(0); await answer(1); await answer(2);
  assert.equal(await evaluate(`window.__zhaoren.getState().answers.length`), 3);
  await navigate();
  assert.match(await evaluate(`document.getElementById('start-btn').innerText`), /继续测试/);
  await click('start-btn');
  assert.equal(await evaluate(`document.getElementById('current-number').innerText`), '4');
  passed('答题进度保存、刷新恢复和继续测试');

  await click('back-btn');
  assert.equal(await evaluate(`document.getElementById('current-number').innerText`), '3');
  await answer(2);
  assert.equal(await evaluate(`document.getElementById('current-number').innerText`), '4');
  passed('上一题与修改答案');

  while (await evaluate(`document.querySelector('#result-view').hidden`)) {
    await answer(0);
    await delay(30);
  }
  assert.equal(await evaluate(`document.querySelectorAll('#matches .match').length`), 6);
  assert.ok(await evaluate(`document.getElementById('result-name').innerText.length > 0`));
  assert.equal(await evaluate(`window.__zhaoren.getEvents().filter(e => e.type === 'complete').length`), 1);
  assert.ok(await evaluate(`window.__zhaoren.drawCard().toDataURL('image/png').length > 20000`));
  await screenshot('desktop-result.png');
  passed('完整答题、结果计分、事件记录和结果卡生成');

  await click('share-btn');
  await delay(100);
  assert.match(await evaluate(`document.getElementById('toast').innerText`), /已复制/);
  assert.match(await evaluate(`window.__zhaoren.shareText()`), /我的行事风格像/);
  passed('分享文案复制与反馈');

  const figures = await evaluate(`Object.keys(window.__zhaoren.figures)`);
  for (const figure of figures) {
    await click('restart-btn');
    await click('start-btn');
    for (let question = 0; question < 12; question++) {
      const option = await evaluate(`(() => {
        const q = window.__zhaoren.questions[${question}];
        const primary = q.options.findIndex(o => o.weights[${JSON.stringify(figure)}] === 2);
        const fallback = q.options.findIndex(o => o.weights[${JSON.stringify(figure)}]);
        return primary >= 0 ? primary : (fallback >= 0 ? fallback : 0);
      })()`);
      await answer(option);
      await delay(20);
    }
    assert.equal(await evaluate(`window.__zhaoren.calculate().primary`), figure);
    assert.equal(await evaluate(`document.querySelector('#result-view').hidden`), false);
  }
  passed('6 类人物均可通过真实答题路径得到');

  await click('restart-btn');
  await click('start-btn');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (let question = 0; question < 12; question++) { await answer(1); await delay(20); }
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  await delay(2300);
  await screenshot('mobile-result.png');
  passed('390px 移动端完整流程且无横向溢出');

  assert.deepEqual(errors, []);
  passed('浏览器运行无 JavaScript 异常');
  console.log(JSON.stringify({ success: true, checks: checks.length, screenshots: fs.readdirSync(output).map(name => path.join(output, name)) }, null, 2));
  ws.close();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
} finally {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  for (const { reject } of pending.values()) reject(new Error('Validation ended'));
  pending.clear();
  await new Promise(resolve => server.close(resolve));
}
