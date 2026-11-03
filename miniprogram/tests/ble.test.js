const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const { TextClient } = require('../utils/ble');
function fixture() {
  let listener, connection;
  const writes = [];
  const control = { writes, result: 0, wrongOffset: false, disconnectOnWrite: false };
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
        value:new Uint8Array([0x5A,1,0,0,0,0,0,1,1,0]).buffer }));
    },
    writeBLECharacteristicValue(args) {
      const b = new Uint8Array(args.value); writes.push(b);
      args.success({});
      if (control.disconnectOnWrite) { connection({deviceId:'phone', connected:false}); return; }
      const offset = (b[4] | b[5] << 8) + (b[3] === 2 ? b.length - 8 : 0) + (control.wrongOffset ? 1 : 0);
      queueMicrotask(() => listener({ deviceId:'phone', characteristicId:p.STATUS_UUID,
        value:new Uint8Array([0x5A,1,b[2],b[3],control.result,offset & 255,offset >> 8,1,2,0]).buffer }));
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
