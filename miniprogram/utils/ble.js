const protocol = require('./protocol');
const same = (a, b) => (a || '').toLowerCase() === b.toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function call(name, args = {}) {
  return new Promise((resolve, reject) => wx[name](Object.assign({}, args, { success: resolve, fail: reject })));
}
function message(error) {
  const code = error && error.errCode;
  if (code === 10001) return '请打开手机蓝牙后重试';
  if (code === 10008 || code === 10012) return '连接超时，请靠近开发板后重试';
  if (code === 10006) return '设备已断开，请重新连接';
  if (code === 10009) return '当前系统不支持低功耗蓝牙';
  if (code === 10003) return '连接失败，请确认文字屏未被其他手机占用';
  if (code === 10016 || /auth|permission|privacy/i.test((error && error.errMsg) || '')) {
    return '请允许微信使用蓝牙；部分安卓手机还需开启定位服务和附近设备权限';
  }
  return (error && (error.message || error.errMsg)) || '连接失败，请稍后重试';
}

class TextClient {
  constructor(events) {
    this.events = events;
    this.device = null;
    this.ready = false;
    this.sequence = 0;
    this.chain = Promise.resolve();
    this.found = ({ devices }) => this.acceptDevices(devices || []);
    this.value = event => this.onValue(event);
    this.connection = event => {
      if (this.device && event.deviceId === this.device.deviceId && !event.connected) {
        this.ready = false;
        this.rejectPending(new Error('设备已断开，请重新连接'));
        this.device = null;
        if (!this.disposed) this.events.onConnection(false);
      }
    };
    wx.onBluetoothDeviceFound(this.found);
    wx.onBLECharacteristicValueChange(this.value);
    wx.onBLEConnectionStateChange(this.connection);
  }
  acceptDevices(devices) {
    devices.forEach(device => {
      const name = device.localName || device.name || '';
      const advertised = (device.advertisServiceUUIDs || []).some(id => same(id, protocol.SERVICE_UUID));
      if (name.startsWith('S3-OLED-') || advertised) {
        this.events.onDevice(Object.assign({}, device, { name: name || 'S3 OLED 文字屏' }));
      }
    });
  }
  async scan() {
    // 由实际蓝牙接口在需要时触发隐私授权，避免强制模拟一次授权请求。
    await call('authorize', { scope: 'scope.bluetooth' });
    await call('openBluetoothAdapter', { mode: 'central' });
    await this.stopScan(true);
    await call('startBluetoothDevicesDiscovery', { services: [protocol.SERVICE_UUID], allowDuplicatesKey: false });
    const cached = await call('getBluetoothDevices');
    this.acceptDevices(cached.devices || []);
    this.scanTimer = setTimeout(() => this.stopScan(), 12000);
  }
  async stopScan(silent = false) {
    clearTimeout(this.scanTimer);
    await call('stopBluetoothDevicesDiscovery').catch(() => {});
    if (!this.disposed && !silent) this.events.onScanEnd();
  }
  async connect(device) {
    await this.stopScan();
    await this.disconnect();
    this.device = device;
    try {
      await call('createBLEConnection', { deviceId: device.deviceId, timeout: 10000 });
      await sleep(250);
      const services = await call('getBLEDeviceServices', { deviceId: device.deviceId });
      const service = services.services.find(item => same(item.uuid, protocol.SERVICE_UUID));
      if (!service) throw new Error('这不是兼容的文字屏固件');
      this.serviceId = service.uuid;
      const result = await call('getBLEDeviceCharacteristics', { deviceId: device.deviceId, serviceId: this.serviceId });
      const write = result.characteristics.find(item => same(item.uuid, protocol.WRITE_UUID) && item.properties.write);
      const status = result.characteristics.find(item => same(item.uuid, protocol.STATUS_UUID) && item.properties.read && item.properties.notify);
      if (!write || !status) throw new Error('文字屏服务不完整，请重新烧录固件');
      this.writeId = write.uuid;
      this.statusId = status.uuid;
      await call('notifyBLECharacteristicValueChange', Object.assign(this.ids(this.statusId), { state: true }));
      // 真机读取结果通过 onBLECharacteristicValueChange 返回，而不是 read 的 success。
      const initialStatus = await this.readState();
      this.ready = true;
      this.events.onConnection(true, device);
      return initialStatus.state;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }
  ids(characteristicId) {
    return { deviceId: this.device.deviceId, serviceId: this.serviceId, characteristicId };
  }
  async readState() {
    const initial = this.waitForStatus(null);
    const read = call('readBLECharacteristicValue', this.ids(this.statusId)).catch(error => {
      this.rejectPending(error);
      throw error;
    });
    const [state] = await Promise.all([initial, read]);
    return state;
  }
  refresh() {
    const session = this.device;
    const operation = this.chain.catch(() => {}).then(() => {
      if (!this.ready || !this.device || this.device !== session) throw new Error('请先连接文字屏');
      return this.readState();
    });
    this.chain = operation;
    return operation;
  }
  waitForStatus(sequence) {
    return new Promise((resolve, reject) => {
      this.pending = { sequence, resolve, reject, timer: setTimeout(() => {
        this.rejectPending(new Error('文字屏没有响应，请重新连接'));
      }, 3500) };
    });
  }
  rejectPending(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  onValue(event) {
    if (!this.device || (event.serviceId && !same(event.serviceId, this.serviceId)) || event.deviceId !== this.device.deviceId || !same(event.characteristicId, this.statusId || protocol.STATUS_UUID)) return;
    let status;
    try { status = protocol.decode(event.value); }
    catch (error) { this.rejectPending(error); return; }
    if (this.pending && (this.pending.sequence === null || this.pending.sequence === status.sequence)) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (status.result) pending.reject(new Error(({1:'数据包格式错误',2:'文字长度超限',3:'传输中断，请重新发送',4:'文字编码不正确',5:'未检测到 OLED，请检查接线后重启'})[status.result] || '文字屏拒绝了这次发送'));
      else pending.resolve(status);
    }
    if (!status.result) this.events.onState(status.state);
  }
  sendText(text) {
    const session = this.device;
    const frames = protocol.packets(text);
    const operation = this.chain.catch(() => {}).then(async () => {
      let confirmed;
      for (const frame of frames) {
        if (!this.ready || !this.device || this.device !== session) throw new Error('请先连接文字屏');
        this.sequence = (this.sequence % 255) + 1;
        frame[2] = this.sequence;
        const acknowledgment = this.waitForStatus(this.sequence);
        const written = call('writeBLECharacteristicValue', Object.assign(this.ids(this.writeId), {
          value: frame.buffer, writeType: 'write'
        })).catch(error => { this.rejectPending(error); throw error; });
        const [ack] = await Promise.all([acknowledgment, written]);
        const expected = (frame[4] | frame[5] << 8) + (frame[3] === 2 ? frame.length - 8 : 0);
        if (ack.op !== frame[3] || ack.received !== expected) throw new Error('分包确认不匹配，请重新发送');
        confirmed = ack.state;
        await sleep(25);
      }
      return confirmed;
    });
    this.chain = operation;
    return operation;
  }
  async disconnect() {
    this.ready = false;
    this.rejectPending(new Error('连接已关闭'));
    const previous = this.device;
    this.device = null;
    if (previous) await call('closeBLEConnection', { deviceId: previous.deviceId }).catch(() => {});
  }
  async destroy() {
    this.disposed = true;
    await this.stopScan();
    await this.disconnect();
    wx.offBluetoothDeviceFound(this.found);
    wx.offBLECharacteristicValueChange(this.value);
    wx.offBLEConnectionStateChange(this.connection);
    await call('closeBluetoothAdapter').catch(() => {});
  }
}
module.exports = { TextClient, message };
