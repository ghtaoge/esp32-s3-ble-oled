const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../utils/protocol');
const source = fs.readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8');
const key = 'oled.lastDevice';
const board = { deviceId: 'board-123456', name: 'S3-OLED-1234', compatible: true, RSSI: -55 };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(storage = new Map(), behavior = {}) {
  const control = { scans: 0, connections: [], writes: [], stops: 0 };
  let definition;
  class FakeClient {
    constructor(events) { this.events = events; control.client = this; }
    async scan() {
      control.scans++;
      if (behavior.scan) await behavior.scan(this);
    }
    async stopScan() { control.stops++; this.events.onScanEnd({ timedOut: false }); }
    async connect(device) {
      control.connections.push(device);
      await this.stopScan();
      if (behavior.failConnect) throw new Error('不兼容');
      this.ready = true;
      this.events.onConnection(true, device);
      return { oledReady: true };
    }
    async disconnect() { this.ready = false; }
    async refresh() {}
    async configure(settings) { control.settings = settings; return { pages: 3 }; }
    async sendText(text, settings) { control.text = text; control.settings = settings; return { pages: 2 }; }
    async destroy() {}
  }
  vm.runInNewContext(source, {
    Page(value) { definition = value; },
    require(name) { return name.endsWith('/protocol') ? protocol : { TextClient: FakeClient, message: error => error.message }; },
    wx: {
      getStorageSync: name => storage.get(name),
      setStorageSync(name, value) { control.writes.push(value); storage.set(name, value); }
    },
    console, setTimeout, clearTimeout
  });
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }
  });
  page.onLoad();
  const found = device => control.client.events.onNearbyDevice(device);
  return { page, control, found, storage };
}

test('dropdown retains discovery order across RSSI updates and connects the selected device', async () => {
  const f = fixture(); f.page.onShow();
  await f.page.search();
  f.found(board);
  f.found({ deviceId: 'other', name: 'Other', RSSI: -40 });
  f.found({ ...board, RSSI: -30 });
  assert.deepEqual(Array.from(f.page.data.deviceOptions, d => d.deviceId), ['', board.deviceId, 'other']);
  await f.page.selectDevice({ detail: { value: '1' } });
  assert.equal(f.control.connections[0].deviceId, board.deviceId);
  assert.equal(f.storage.get(key).deviceId, board.deviceId);
  assert.equal(f.page.data.savedDeviceName, board.name);
});

test('a new page restores the saved device and reconnects once after discovery', async () => {
  const storage = new Map([[key, { deviceId: board.deviceId, name: board.name }]]);
  const f = fixture(storage, { scan(client) { client.events.onNearbyDevice(board); } });
  assert.equal(f.page.data.selectedDeviceName, board.name);
  f.page.onShow();
  await flush();
  f.found(board); f.found(board);
  assert.equal(f.control.scans, 1);
  assert.equal(f.control.connections.length, 1);
  assert.equal(f.page.data.connected, true);
});

test('does not reconnect a different device merely because its name matches', async () => {
  const f = fixture(new Map([[key, board]]));
  f.page.onShow(); await flush();
  f.found({ ...board, deviceId: 'different-id' });
  await flush();
  assert.equal(f.control.connections.length, 0);
  f.control.client.events.onScanEnd({ timedOut: true, seen: 1, matched: 1 });
  assert.match(f.page.data.errorText, /未找到上次/);
  assert.equal(f.storage.get(key).deviceId, board.deviceId);
});

test('failed manual connection never replaces a previously working saved device', async () => {
  const f = fixture(new Map([[key, board]]), { failConnect: true });
  f.page.active = true;
  await f.page.search();
  f.found({ deviceId: 'wrong', name: 'Other' });
  await f.page.selectDevice({ detail: { value: 1 } });
  assert.equal(f.storage.get(key).deviceId, board.deviceId);
  assert.equal(f.control.writes.length, 0);
  assert.equal(f.page.data.connected, false);
  assert.match(f.page.data.errorText, /不兼容/);
});

test('manual disconnect keeps memory but suppresses automatic reconnect until explicitly requested', async () => {
  const f = fixture(new Map([[key, board]]));
  f.page.active = true;
  await f.page.disconnect();
  f.page.onShow(); await flush();
  assert.equal(f.control.scans, 0);
  assert.equal(f.storage.get(key).deviceId, board.deviceId);
  await f.page.reconnectSaved();
  f.found(board); await flush();
  assert.equal(f.control.connections.length, 1);
});

test('hidden pages never auto-connect from late discovery callbacks', async () => {
  const f = fixture(new Map([[key, board]]));
  f.page.onShow(); await flush();
  f.page.onHide();
  f.found(board); await flush();
  assert.equal(f.control.connections.length, 0);
});

test('malformed storage is ignored and first-time users are not scanned automatically', async () => {
  for (const saved of [undefined, 'invalid', { name: 'board' }, { deviceId: 123, name: 'board' }]) {
    const f = fixture(new Map([[key, saved]]));
    f.page.onShow(); await flush();
    assert.equal(f.control.scans, 0);
    assert.equal(f.page.data.savedDeviceName, '');
  }
});

test('display controls apply to current text, send with drafts and do not block plain clearing', async () => {
  const f = fixture();
  f.page.setData({ connected: true, effectsSupported: true, oledReady: true });
  f.page.chooseFont({ detail: { value: '1' } });
  f.page.chooseEffect({ detail: { value: '3' } });
  f.page.chooseSpeed({ detail: { value: '0' } });
  await f.page.applyDisplay();
  assert.equal(f.control.settings.scale, 2);
  assert.equal(f.control.settings.effect, 3);
  assert.equal(f.control.settings.interval, 1000);
  assert.equal(f.control.text, undefined);
  await f.page.send();
  assert.equal(f.control.text, f.page.data.text);
  assert.equal(f.control.settings.scale, 2);
  await f.page.clearScreen();
  assert.equal(f.control.text, '');
  assert.equal(f.control.settings, undefined);
});

test('font dropdown includes four choices and maps their indices to valid font scales', () => {
  const f = fixture();
  assert.equal(f.page.data.fontNames.length, 4);
  for (let index = 0; index < 4; ++index) {
    f.page.chooseFont({ detail: { value: String(index) } });
    assert.equal(f.page.data.fontScale, index + 1);
  }
  f.page.chooseFont({ detail: { value: '4' } });
  assert.equal(f.page.data.fontScale, 4);
});
