const protocol = require('./protocol');
const same = (a, b) => (a || '').toLowerCase() === b.toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function call(name, args = {}) {
  return new Promise((resolve, reject) => {
    const fail = error => reject(Object.assign({ api: name }, error));
    if (typeof wx[name] !== 'function') {
      fail({ errMsg: `${name}: 当前客户端不支持此接口，请升级微信或企业微信后重试` });
      return;
    }
    try { wx[name](Object.assign({}, args, { success: resolve, fail })); }
    catch (error) { fail({ message: error.message }); }
  });
}
function message(error) {
  const code = error && (error.errCode !== undefined ? error.errCode : error.errno);
  const detail = error && error.api ? `（${error.api}${code !== undefined ? ` / ${code}` : ''}）` : '';
  const summary = errorMessage(error);
  const raw = error && error.errMsg;
  // 不丢弃平台原因：privacy agreement、auth deny 和系统权限失败的处理方式不同。
  return summary + detail + (error && error.api && raw && raw !== summary ? `\n微信返回：${raw}` : '');
}
function errorMessage(error) {
  const code = error && error.errCode;
  const raw = (error && error.errMsg) || '';
  if (/api scope.*not declared|not declared.*privacy|未.*声明.*隐私/i.test(raw)) {
    return '小程序后台未在用户隐私保护指引中声明蓝牙用途。请由管理员为当前 AppID 补充蓝牙相关声明，生效后重新预览';
  }
  if (/privacy|隐私/i.test(raw)) {
    return '小程序隐私授权未完成，请重新搜索并同意隐私指引；若未出现授权弹窗，请检查当前 AppID 后台的隐私配置';
  }
  if (code === 10001) return '请打开手机蓝牙后重试';
  if (code === 10008 || code === 10012) return '连接超时，请靠近开发板后重试';
  if (code === 10006) return '设备已断开，请重新连接';
  if (code === 10009) return '当前系统不支持低功耗蓝牙';
  if (code === 10003) return '连接失败，请确认文字屏未被其他手机占用';
  if (code === 10016 || /location/i.test(raw)) {
    return '蓝牙扫描所需定位权限或定位服务不可用，请检查手机系统设置';
  }
  if (/auth|permission/i.test(raw)) {
    return '蓝牙授权未通过。请检查页面“蓝牙权限设置”，以及手机系统设置中微信/企业微信的蓝牙权限';
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
    this.nearby = new Map();
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
      if (!device.deviceId) return;
      const previous = this.nearby.get(device.deviceId) || {};
      // 后续 RSSI 更新不一定再带名称或服务列表，保留先前收到的信息。
      device = Object.assign({}, previous, device, {
        name: device.name || previous.name,
        localName: device.localName || previous.localName,
        advertisServiceUUIDs: device.advertisServiceUUIDs && device.advertisServiceUUIDs.length
          ? device.advertisServiceUUIDs : previous.advertisServiceUUIDs
      });
      this.nearby.set(device.deviceId, device);
      if (this.scanSeen) this.scanSeen.add(device.deviceId);
      const names = [device.localName, device.name].filter(Boolean);
      const name = names.find(value => value.startsWith('S3-OLED-')) || names[0] || '';
      const advertised = (device.advertisServiceUUIDs || []).some(id => same(id, protocol.SERVICE_UUID));
      const compatible = name.startsWith('S3-OLED-') || advertised;
      const result = Object.assign({}, device, { compatible, name: name || (compatible ? 'S3 OLED 文字屏' : '未命名设备') });
      if (this.events.onNearbyDevice) this.events.onNearbyDevice(result);
      if (compatible) {
        if (this.scanMatched) this.scanMatched.add(device.deviceId);
        this.events.onDevice(result);
      }
    });
  }
  async scan() {
    if (this.events.onScanProgress) this.events.onScanProgress('正在开启蓝牙，请留意微信或系统的授权提示');
    // 由适配器接口触发实际授权，避免额外依赖宿主对 authorize scope 的支持。
    await call('openBluetoothAdapter', { mode: 'central' });
    await this.stopScan(true);
    this.scanSeen = new Set();
    this.scanMatched = new Set();
    this.nearby.clear();
    if (this.events.onScanProgress) this.events.onScanProgress('正在搜索附近的文字屏，请保持开发板供电');
    // 不在系统层过滤 UUID，让名称匹配也能兜底。连接后仍会校验服务及特征。
    // 允许更新：有些手机第一次上报没有名称，收到扫描响应后才补齐。
    await call('startBluetoothDevicesDiscovery', { allowDuplicatesKey: true });
    this.scanTimer = setTimeout(() => this.stopScan(false, true), 12000);
    // 缓存读取失败不应中止已经启动的实时扫描。
    try {
      const cached = await call('getBluetoothDevices');
      this.acceptDevices(cached.devices || []);
    } catch (error) { console.warn('BLE cache unavailable:', error); }
  }
  async stopScan(silent = false, timedOut = false) {
    clearTimeout(this.scanTimer);
    await call('stopBluetoothDevicesDiscovery').catch(() => {});
    if (!this.disposed && !silent) this.events.onScanEnd({
      timedOut, seen: this.scanSeen ? this.scanSeen.size : 0,
      matched: this.scanMatched ? this.scanMatched.size : 0
    });
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
      this.effectsSupported = !!initialStatus.state.effectsSupported;
      this.maxFontScale = initialStatus.state.maxFontScale || 1;
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
      if (status.result) pending.reject(new Error(({1:'数据包格式错误',2:'文字长度超限',3:'传输中断，请重新发送',4:'文字编码不正确',5:'未检测到 OLED，请检查接线后重启',6:'显示设置不支持，请更新固件'})[status.result] || '文字屏拒绝了这次发送'));
      else pending.resolve(status);
    }
    if (!status.result) this.events.onState(status.state);
  }
  sendText(text, settings) {
    const frames = protocol.packets(text);
    if (settings) {
      const config = protocol.settingsPacket(settings);
      this.checkFontScale(settings);
      if (this.effectsSupported) frames.unshift(config);
      else if (settings.scale !== 1 || settings.effect !== 0 || settings.interval !== 3000) {
        throw new Error('当前固件不支持字体放大和动态效果，请先更新 ESP32 固件');
      }
    }
    return this.sendFrames(frames);
  }
  configure(settings) {
    if (!this.effectsSupported) throw new Error('当前固件不支持显示设置，请先更新 ESP32 固件');
    this.checkFontScale(settings);
    return this.sendFrames([protocol.settingsPacket(settings)]);
  }
  checkFontScale(settings) {
    const maximum = this.maxFontScale || (this.effectsSupported ? 2 : 1);
    if (settings.scale > maximum) throw new Error(`当前固件最多支持 ${maximum} 倍字体，请更新 ESP32 固件后使用 ${settings.scale} 倍字体`);
  }
  sendFrames(frames) {
    const session = this.device;
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
