const SERVICE_UUID = 'b82c0001-6d6a-4b2e-ae8b-3d80b18a5100';
const WRITE_UUID = 'b82c0002-6d6a-4b2e-ae8b-3d80b18a5100';
const STATUS_UUID = 'b82c0003-6d6a-4b2e-ae8b-3d80b18a5100';
const MAX_BYTES = 512;
// WeChat does not guarantee browser TextEncoder availability.
function utf8(text) {
  const bytes = [];
  for (const char of text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')) {
    const cp = char.codePointAt(0);
    if ((cp < 32 && cp !== 10) || (cp >= 0x7F && cp <= 0x9F) || (cp >= 0xD800 && cp <= 0xDFFF)) {
      throw new Error('文字包含不支持的控制字符或无效字符');
    }
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(0xC0 | cp >> 6, 0x80 | cp & 63);
    else if (cp < 65536) bytes.push(0xE0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    else bytes.push(0xF0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
  }
  return new Uint8Array(bytes);
}
function packets(text) {
  const bytes = utf8(text), total = bytes.length;
  if (total > MAX_BYTES) throw new Error('文字超过 512 字节，请缩短后发送');
  const make = (op, offset, payload = []) => new Uint8Array([
    0xA5, 1, 0, op, offset & 255, offset >> 8, total & 255, total >> 8, ...payload
  ]);
  const result = [make(1, 0)];
  for (let offset = 0; offset < total; offset += 12) result.push(make(2, offset, bytes.slice(offset, offset + 12)));
  result.push(make(3, total));
  return result;
}
function decode(buffer) {
  const b = new Uint8Array(buffer);
  if (![10, 15].includes(b.length) || b[0] !== 0x5A || b[1] !== 1 || b[7] > 1) throw new Error('屏幕响应格式不正确');
  const state = { oledReady: !!b[7], pages: b[8] | b[9] << 8 };
  if (b.length === 15) {
    if (![1, 2].includes(b[10])) throw new Error('屏幕效果协议不兼容，请更新小程序和固件');
    state.maxFontScale = b[10] === 2 ? 4 : 2;
    state.display = { scale: b[11], effect: b[12], interval: b[13] | b[14] << 8 };
    settingsPacket(state.display);
    if (state.display.scale > state.maxFontScale) throw new Error('屏幕字体响应不正确');
    state.effectsSupported = true;
  }
  return { sequence: b[2], op: b[3], result: b[4], received: b[5] | b[6] << 8,
    state };
}
function settingsPacket({ scale, effect, interval }) {
  if (![1, 2, 3, 4].includes(scale) || !Number.isInteger(effect) || effect < 0 || effect > 3 ||
      !Number.isInteger(interval) || interval < 500 || interval > 10000) throw new Error('显示设置不正确');
  return new Uint8Array([0xA5, 1, 0, 4, 0, 0, 0, 0, scale, effect, interval & 255, interval >> 8]);
}
module.exports = { SERVICE_UUID, WRITE_UUID, STATUS_UUID, MAX_BYTES, utf8, packets, settingsPacket, decode };
