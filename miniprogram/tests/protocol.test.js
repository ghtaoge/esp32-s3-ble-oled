const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');

test('UTF-8 supports Chinese, mixed text and supplementary Unicode', () => {
  const text = '你好，ESP32！\n😀';
  assert.deepEqual(Buffer.from(p.utf8(text)), Buffer.from(text));
});
test('normalizes Windows line breaks and tabs', () => {
  assert.equal(Buffer.from(p.utf8('a\r\nb\rc\td')).toString(), 'a\nb\nc  d');
});
test('rejects isolated surrogates and embedded control characters', () => {
  for (const text of ['a\0b', '\uD800', '\uDC00', '\x7F', '\u0085']) assert.throws(() => p.utf8(text));
});
test('packets preserve Chinese even across a multibyte character boundary', () => {
  const text = '01234567890你好世界'.repeat(5);
  const frames = p.packets(text);
  assert.equal(frames[0][3], 1);
  assert.equal(frames.at(-1)[3], 3);
  const payload = [];
  for (const f of frames.slice(1, -1)) {
    assert.ok(f.length <= 20);
    assert.equal(f[4] | f[5] << 8, payload.length);
    payload.push(...f.slice(8));
  }
  assert.equal(Buffer.from(payload).toString(), text);
  assert.equal(frames.at(-1)[4] | frames.at(-1)[5] << 8, payload.length);
});
test('empty text clears; maximum length is bytes rather than characters', () => {
  assert.deepEqual(p.packets('').map(f => f[3]), [1, 3]);
  assert.doesNotThrow(() => p.packets('a'.repeat(512)));
  assert.throws(() => p.packets('a'.repeat(513)));
  assert.doesNotThrow(() => p.packets('中'.repeat(170)));
  assert.throws(() => p.packets('中'.repeat(171)));
});
test('status decoding checks envelope and OLED readiness', () => {
  assert.deepEqual(p.decode(new Uint8Array([0x5A,1,9,3,0,1,2,1,3,0]).buffer), {
    sequence:9, op:3, result:0, received:513, state:{oledReady:true,pages:3}
  });
  assert.throws(() => p.decode(new ArrayBuffer(3)));
});

test('display settings encode a bounded BLE packet and reject invalid controls', () => {
  const config = p.settingsPacket({ scale: 2, effect: 3, interval: 3000 });
  assert.deepEqual(Array.from(config), [0xA5,1,0,4,0,0,0,0,2,3,0xB8,0x0B]);
  for (const patch of [{ scale: 5 }, { scale: 1.5 }, { effect: 4 }, { effect: 0.5 }, { interval: 499 }, { interval: 10001 }, { interval: NaN }]) {
    assert.throws(() => p.settingsPacket({ scale: 1, effect: 0, interval: 3000, ...patch }));
  }
});

test('four font sizes encode correctly and capability version 2 advertises the new sizes', () => {
  for (const scale of [1, 2, 3, 4]) {
    assert.equal(p.settingsPacket({ scale, effect: 0, interval: 3000 })[8], scale);
    const bytes = new Uint8Array([0x5A,1,7,4,0,0,0,1,6,0,2,scale,0,0xB8,0x0B]);
    const state = p.decode(bytes.buffer).state;
    assert.equal(state.maxFontScale, 4);
    assert.equal(state.display.scale, scale);
  }
});

test('extended status reports display capability and validates settings', () => {
  const bytes = new Uint8Array([0x5A,1,7,4,0,0,0,1,6,0,1,2,3,0xB8,0x0B]);
  const state = p.decode(bytes.buffer).state;
  assert.equal(state.effectsSupported, true);
  assert.deepEqual(state.display, { scale: 2, effect: 3, interval: 3000 });
  assert.equal(state.pages, 6);
  bytes[11] = 3;
  assert.throws(() => p.decode(bytes.buffer));
});
