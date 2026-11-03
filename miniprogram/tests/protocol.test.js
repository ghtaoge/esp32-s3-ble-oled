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
