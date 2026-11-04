const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const { TextClient } = require('../utils/ble');
function fixture() {
  let listener, connection;
  const writes = [];
  const control = { writes, result: 0, wrongOffset: false, disconnectOnWrite: false,
    modern: false, version: 1, display: { scale: 1, effect: 0, interval: 3000 } };
  const statusBytes = (sequence, op, result, offset, pages) => new Uint8Array([
    0x5A,1,sequence,op,result,offset & 255,offset >> 8,1,pages,0,
    ...(control.modern ? [control.version,control.display.scale,control.display.effect,control.display.interval & 255,control.display.interval >> 8] : [])
  ]).buffer;
  const wxMock = {
    onBluetoothDeviceFound() {}, offBluetoothDeviceFound() {},
    onBLECharacteristicValueChange(fn) { listener = fn; }, offBLECharacteristicValueChange() {},
    onBLEConnectionStateChange(fn) { connection = fn; }, offBLEConnectionStateChange() {},
    stopBluetoothDevicesDiscovery({success}) { success({}); },
    closeBLEConnection({success}) { success({}); },
    closeBluetoothAdapter({success}) { success({}); },
    createBLEConnection({success}) { success({}); },
    getBLEDeviceServices({success}) { success({ services:[{uuid:p.SERVICE_UUID}] }); },
    getBLEDeviceCharacteristics({success}) { success({ characteristics:[
      {uuid:p.WRITE_UUID,properties:{write:true}}, {uuid:p.STATUS_UUID,properties:{read:true,notify:true}}
    ] }); },
    notifyBLECharacteristicValueChange({success}) { success({}); },
    readBLECharacteristicValue({success}) {
      success({});
      queueMicrotask(() => listener({ deviceId:'phone', serviceId:p.SERVICE_UUID, characteristicId:p.STATUS_UUID,
        value:statusBytes(0,0,0,0,1) }));
    },
    writeBLECharacteristicValue(args) {
      const b = new Uint8Array(args.value); writes.push(b);
      args.success({});
      if (control.disconnectOnWrite) { connection({deviceId:'phone', connected:false}); return; }
      if (control.modern && !control.result && b[3] === 4) {
        control.display = { scale: b[8], effect: b[9], interval: b[10] | b[11] << 8 };
      }
      const offset = (b[4] | b[5] << 8) + (b[3] === 2 ? b.length - 8 : 0) + (control.wrongOffset ? 1 : 0);
      queueMicrotask(() => listener({ deviceId:'phone', characteristicId:p.STATUS_UUID,
        value:statusBytes(b[2],b[3],control.result,offset,2) }));
    }
  };
  global.wx = wxMock;
  const client = new TextClient({ onState() {}, onConnection() {}, onScanEnd() {} });
  client.device = {deviceId:'phone'}; client.ready = true;
  client.serviceId=p.SERVICE_UUID; client.writeId=p.WRITE_UUID; client.statusId=p.STATUS_UUID;
  return Object.assign(control, {client});
}
test('waits for matching packet ACKs and commits only after all payloads', async () => {
  const f = fixture();
  try {
    const state = await f.client.sendText('你好'.repeat(8));
    assert.equal(state.pages,2);
    assert.deepEqual(f.writes.map(b => b[3]), [1,2,2,2,2,3]);
    assert.deepEqual(f.writes.map(b => b[2]), [1,2,3,4,5,6]);
  } finally { await f.client.destroy(); }
});
test('rejects OLED failure and allows a later complete retry', async () => {
  const f=fixture();
  try {
    f.result=5;
    await assert.rejects(f.client.sendText('你好'), /OLED/);
    assert.equal(f.writes.length,1);
    f.result=0;
    await f.client.sendText('');
    assert.deepEqual(f.writes.slice(1).map(b=>b[3]),[1,3]);
  } finally { await f.client.destroy(); }
});
test('rejects incorrect offset acknowledgment', async () => {
  const f=fixture();
  try { f.wrongOffset=true; await assert.rejects(f.client.sendText('a'), /确认不匹配/); }
  finally { await f.client.destroy(); }
});
test('disconnect during sending rejects promptly without committing', async () => {
  const f=fixture();
  try {
    f.disconnectOnWrite=true;
    await assert.rejects(f.client.sendText('a'), /断开/);
    assert.equal(f.writes.length,1);
  } finally { await f.client.destroy(); }
});
test('connection reads OLED readiness through characteristic event, then sends', async () => {
  const f=fixture();
  try {
    await f.client.disconnect();
    const state=await f.client.connect({deviceId:'phone',name:'S3-OLED-TEST'});
    assert.equal(state.oledReady,true);
    assert.equal(f.client.ready,true);
    await f.client.sendText('你好');
  } finally { await f.client.destroy(); }
});
test('queued messages finish in order and never interleave chunks', async () => {
  const f=fixture();
  try {
    await Promise.all([f.client.sendText('a'), f.client.sendText('b')]);
    assert.deepEqual(f.writes.map(b=>b[3]),[1,2,3,1,2,3]);
    assert.equal(f.writes[1][8],97); assert.equal(f.writes[4][8],98);
  } finally { await f.client.destroy(); }
});

test('manual selection of an incompatible device disconnects before writing data', async () => {
  const f = fixture();
  try {
    await f.client.disconnect();
    wx.getBLEDeviceServices = ({ success }) => success({ services: [{ uuid: 'other-service' }] });
    await assert.rejects(f.client.connect({ deviceId: 'old-firmware', name: 'ESP32-RGB' }), /不是兼容的文字屏固件/);
    assert.equal(f.client.ready, false);
    assert.equal(f.client.device, null);
    assert.equal(f.writes.length, 0);
  } finally { await f.client.destroy(); }
});

test('display configuration is acknowledged before text starts, without interleaving', async () => {
  const f = fixture();
  f.client.effectsSupported = true;
  try {
    const config = { scale: 2, effect: 3, interval: 1000 };
    await Promise.all([f.client.sendText('你好', config), f.client.configure({ ...config, effect: 2 })]);
    assert.deepEqual(f.writes.map(b => b[3]), [4,1,2,3,4]);
    assert.equal(f.writes[0][8], 2);
    assert.equal(f.writes[0][9], 3);
    assert.equal(f.writes.at(-1)[9], 2);
  } finally { await f.client.destroy(); }
});

test('legacy firmware can send default text but rejects new settings before any writes', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.client.sendText('你好', { scale: 2, effect: 0, interval: 3000 }), /更新 ESP32 固件/);
    assert.throws(() => f.client.configure({ scale: 1, effect: 0, interval: 3000 }), /更新 ESP32 固件/);
    assert.equal(f.writes.length, 0);
    await f.client.sendText('', { scale: 1, effect: 0, interval: 3000 });
    assert.deepEqual(f.writes.map(b => b[3]), [1,3]);
  } finally { await f.client.destroy(); }
});

test('rejected settings stop the operation before sending text', async () => {
  const f = fixture(); f.client.effectsSupported = true; f.result = 6;
  try {
    await assert.rejects(f.client.sendText('你好', { scale: 2, effect: 3, interval: 1000 }), /显示设置不支持/);
    assert.deepEqual(f.writes.map(b => b[3]), [4]);
  } finally { await f.client.destroy(); }
});

test('connection detects modern firmware and reads back confirmed display settings', async () => {
  const f = fixture(); f.modern = true;
  try {
    await f.client.disconnect();
    const initial = await f.client.connect({ deviceId: 'phone', name: 'S3-OLED-TEST' });
    assert.equal(initial.effectsSupported, true);
    assert.equal(f.client.effectsSupported, true);
    const settings = { scale: 2, effect: 2, interval: 5000 };
    const state = await f.client.configure(settings);
    assert.deepEqual(state.display, settings);
    assert.deepEqual((await f.client.refresh()).state.display, settings);
  } finally { await f.client.destroy(); }
});

test('3x and 4x fonts require the upgraded firmware and can be read back after configuration', async () => {
  const f = fixture(); f.modern = true;
  try {
    await f.client.disconnect();
    await f.client.connect({ deviceId: 'phone', name: 'S3-OLED-TEST' });
    assert.throws(() => f.client.configure({ scale: 3, effect: 0, interval: 3000 }), /最多支持 2 倍字体/);
    assert.equal(f.writes.length, 0);
    await f.client.disconnect(); f.version = 2;
    await f.client.connect({ deviceId: 'phone', name: 'S3-OLED-TEST' });
    for (const scale of [3, 4]) {
      const state = await f.client.configure({ scale, effect: 0, interval: 3000 });
      assert.equal(state.display.scale, scale);
      assert.equal(state.maxFontScale, 4);
    }
  } finally { await f.client.destroy(); }
});
