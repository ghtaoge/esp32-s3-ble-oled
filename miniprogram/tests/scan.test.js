const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TextClient, message } = require('../utils/ble');
const { SERVICE_UUID } = require('../utils/protocol');

function fixture(overrides = {}) {
  const devices = [], nearby = [], ended = [], calls = [];
  let found;
  global.wx = Object.assign({
    onBluetoothDeviceFound(fn) { found = fn; }, offBluetoothDeviceFound() {},
    onBLECharacteristicValueChange() {}, offBLECharacteristicValueChange() {},
    onBLEConnectionStateChange() {}, offBLEConnectionStateChange() {},
    openBluetoothAdapter({ success }) { calls.push('open'); success({}); },
    startBluetoothDevicesDiscovery(args) { calls.push(args); args.success({}); },
    stopBluetoothDevicesDiscovery({ success }) { success({}); },
    getBluetoothDevices({ success }) { success({ devices: [] }); },
    closeBluetoothAdapter({ success }) { success({}); }
  }, overrides);
  const client = new TextClient({ onDevice: d => devices.push(d), onNearbyDevice: d => nearby.push(d), onScanEnd: r => ended.push(r) });
  return { client, devices, nearby, ended, calls, found: d => found({ devices: d }) };
}

test('scan works without authorize and leaves service filtering to the app', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    assert.equal(f.calls[0], 'open');
    assert.equal(f.calls[1].services, undefined);
    assert.equal(f.calls[1].allowDuplicatesKey, true);
    f.found([{ deviceId: 'late-name' }]);
    assert.equal(f.devices.length, 0);
    f.found([{ deviceId: 'late-name', name: 'S3-OLED-1234' }]);
    assert.equal(f.devices.length, 1);
    await f.client.stopScan(false, true);
    assert.deepEqual(f.ended.at(-1), { timedOut: true, seen: 1, matched: 1 });
  } finally { await f.client.destroy(); }
});

test('matches either device name or advertised UUID and excludes unrelated devices', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    f.found([
      { deviceId: 'name', localName: 'old-name', name: 'S3-OLED-1234' },
      { deviceId: 'uuid', advertisServiceUUIDs: [SERVICE_UUID.toUpperCase()] },
      { deviceId: 'other', name: 'Headphones' }
    ]);
    assert.deepEqual(f.devices.map(d => d.deviceId), ['name', 'uuid']);
    assert.equal(f.devices[0].name, 'S3-OLED-1234');
  } finally { await f.client.destroy(); }
});

test('cache read failure leaves live scanning and its timeout active', async () => {
  const f = fixture({ getBluetoothDevices({ fail }) { fail({ errCode: 10008 }); } });
  try {
    await f.client.scan();
    assert.ok(f.client.scanTimer);
    f.found([{ deviceId: 'live', name: 'S3-OLED-1234' }]);
    assert.equal(f.devices.length, 1);
  } finally { await f.client.destroy(); }
});

test('permission errors identify the failed API and code and never start discovery', async () => {
  const f = fixture({ openBluetoothAdapter({ fail }) { fail({ errCode: 10016, errMsg: 'permission denied' }); } });
  try {
    await assert.rejects(f.client.scan(), error => {
      assert.match(message(error), /定位/);
      assert.match(message(error), /openBluetoothAdapter \/ 10016/);
      return true;
    });
    assert.equal(f.calls.length, 0);
  } finally { await f.client.destroy(); }
});

test('scan completion distinguishes no radio results from unrelated nearby devices', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    await f.client.stopScan(false, true);
    assert.deepEqual(f.ended.at(-1), { timedOut: true, seen: 0, matched: 0 });
    await f.client.scan();
    f.found([{ deviceId: 'other', name: 'Headphones' }]);
    await f.client.stopScan(false, true);
    assert.deepEqual(f.ended.at(-1), { timedOut: true, seen: 1, matched: 0 });
  } finally { await f.client.destroy(); }
});

test('unsupported host API gives an actionable error', async () => {
  const f = fixture({ startBluetoothDevicesDiscovery: undefined });
  try {
    await assert.rejects(f.client.scan(), error => {
      assert.match(message(error), /当前客户端不支持此接口/);
      assert.match(message(error), /startBluetoothDevicesDiscovery/);
      return true;
    });
  } finally { await f.client.destroy(); }
});

test('missing privacy declaration points to AppID configuration and preserves errno and raw reason', () => {
  const raw = 'openBluetoothAdapter:fail api scope is not declared in the privacy agreement';
  const text = message({ api: 'openBluetoothAdapter', errno: 112, errMsg: raw });
  assert.match(text, /小程序后台/);
  assert.match(text, /openBluetoothAdapter \/ 112/);
  assert.ok(text.includes(raw));
  assert.doesNotMatch(text, /手机系统设置/);
});

test('privacy consent failure is distinct from Bluetooth authorization failure', () => {
  const privacy = message({ api: 'openBluetoothAdapter', errMsg: 'openBluetoothAdapter:fail privacy permission is not authorized' });
  assert.match(privacy, /隐私授权未完成/);
  assert.doesNotMatch(privacy, /手机系统设置/);
  const auth = message({ api: 'openBluetoothAdapter', errMsg: 'openBluetoothAdapter:fail auth deny' });
  assert.match(auth, /蓝牙权限设置/);
  assert.match(auth, /auth deny/);
});

test('reports unrecognized devices for manual selection and preserves identity in partial updates', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    f.found([{ deviceId: 'old-firmware', name: 'ESP32-RGB', RSSI: -55 }]);
    assert.equal(f.devices.length, 0);
    assert.equal(f.nearby[0].name, 'ESP32-RGB');
    assert.equal(f.nearby[0].compatible, false);
    f.found([{ deviceId: 'old-firmware', RSSI: -50 }]);
    assert.equal(f.nearby.at(-1).name, 'ESP32-RGB');
    f.found([{ deviceId: 'oled', advertisServiceUUIDs: [SERVICE_UUID] }]);
    f.found([{ deviceId: 'oled', RSSI: -60, advertisServiceUUIDs: [] }]);
    assert.equal(f.nearby.at(-1).compatible, true);
    assert.equal(f.client.nearby.size, 2);
    await f.client.scan();
    assert.equal(f.client.nearby.size, 0);
  } finally { await f.client.destroy(); }
});
