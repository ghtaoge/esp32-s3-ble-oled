const protocol = require('../../utils/protocol');
const { TextClient, message } = require('../../utils/ble');
const DEVICE_KEY = 'oled.lastDevice';
Page({
  data: {
    connected: false, scanning: false, scanHint: '', connectingId: '', deviceName: '',
    nearbyDevices: [], deviceOptions: [{ deviceId: '', label: '请选择蓝牙设备' }],
    deviceIndex: 0, selectedDeviceName: '', savedDeviceName: '',
    oledReady: false, sending: false, text: '你好，今天也要开心！', byteCount: 33,
    effectsSupported: false, fontScale: 1, effectIndex: 0, speedIndex: 1,
    fontNames: ['标准 · 1 倍', '大字 · 2 倍', '特大 · 3 倍', '超大 · 4 倍'],
    effectNames: ['自动翻页', '静态显示', '闪烁', '向上滚动'],
    speedNames: ['快 · 1 秒', '标准 · 3 秒', '慢 · 5 秒'],
    syncText: '', errorText: '', showPrivacy: false, privacyAgreePending: false,
    privacyName: '《用户隐私保护指引》'
  },
  onLoad() {
    this.privacyResolvers = new Set(); this.scanAttempt = 0;
    try {
      const saved = wx.getStorageSync(DEVICE_KEY);
      if (saved && typeof saved.deviceId === 'string' && saved.deviceId && typeof saved.name === 'string') {
        this.savedDevice = { deviceId: saved.deviceId, name: saved.name };
        this.selectedId = saved.deviceId;
        this.setData({ savedDeviceName: saved.name, selectedDeviceName: saved.name });
      }
    } catch (error) { console.warn('Cannot restore last device:', error); }
    this.setData({ byteCount: protocol.utf8(this.data.text).length });
    this.client = new TextClient({
      onScanProgress: scanHint => { if (!this.unloaded) this.setData({ scanHint }); },
      onNearbyDevice: device => {
        if (this.unloaded) return;
        const nearbyDevices = this.data.nearbyDevices.slice();
        const index = nearbyDevices.findIndex(item => item.deviceId === device.deviceId);
        if (index < 0) nearbyDevices.push(device); else nearbyDevices[index] = device;
        // 保持发现顺序，避免 RSSI 更新使下拉选项不断跳动。
        const deviceOptions = [{ deviceId: '', label: '请选择蓝牙设备' }].concat(nearbyDevices.map(item => ({
          deviceId: item.deviceId,
          label: `${item.name} · ${item.deviceId.slice(-6)}${item.compatible ? '' : ' · 未识别'}`
        })));
        const deviceIndex = Math.max(0, deviceOptions.findIndex(item => item.deviceId === this.selectedId));
        this.setData({ nearbyDevices, deviceOptions, deviceIndex });
        this.tryReconnect(device);
      },
      onDevice() {},
      onScanEnd: result => {
        if (this.unloaded) return;
        const patch = { scanning: false };
        if (result.timedOut && this.autoTarget) {
          this.autoTarget = null;
          patch.errorText = '未找到上次的文字屏，请确认已供电，或搜索后从下拉列表选择其他设备。';
        } else if (result.timedOut && !result.matched) {
          patch.errorText = result.seen
            ? `已发现 ${result.seen} 个蓝牙设备，请从下拉列表选择自己的开发板；若连接提示固件不兼容，请确认已烧录本项目固件。`
            : '未收到蓝牙设备广播。请检查系统中微信/企业微信的蓝牙、附近设备权限；部分安卓还需开启定位服务及定位权限，并确认开发板已供电。';
        }
        this.setData(patch);
      },
      onState: state => {
        if (this.unloaded) return;
        const patch = { oledReady: state.oledReady, effectsSupported: !!state.effectsSupported };
        if (state.display && !this.data.sending) {
          patch.fontScale = state.display.scale;
          patch.effectIndex = state.display.effect;
          patch.speedIndex = Math.max(0, [1000, 3000, 5000].indexOf(state.display.interval));
        }
        this.setData(patch);
      },
      onConnection: (connected, device) => {
        if (connected && !this.unloaded) {
          this.savedDevice = { deviceId: device.deviceId, name: device.name };
          this.selectedId = device.deviceId;
          let savedDeviceName = device.name;
          try { wx.setStorageSync(DEVICE_KEY, this.savedDevice); }
          catch (error) {
            savedDeviceName = '';
            console.warn('Cannot remember device:', error);
          }
          this.setData({ savedDeviceName, selectedDeviceName: device.name });
        }
        if (!this.unloaded) this.setData({ connected, connectingId: '',
          deviceName: device ? device.name : '', syncText: '',
          errorText: connected ? '' : '连接已断开，可重连上次设备或重新搜索' });
      }
    });
    if (wx.onNeedPrivacyAuthorization) {
      this.privacyHandler = resolve => {
        if (typeof resolve !== 'function' || this.unloaded) return;
        this.privacyResolvers.add(resolve); this.setData({ showPrivacy: true });
        if (wx.getPrivacySetting) wx.getPrivacySetting({ success: result => {
          if (!this.unloaded) this.setData({ privacyName: result.privacyContractName || this.data.privacyName });
        }});
      };
      wx.onNeedPrivacyAuthorization(this.privacyHandler);
    }
  },
  onShow() {
    this.active = true;
    if (this.client && this.client.ready) this.client.refresh().catch(error => {
      if (!this.unloaded) this.setData({ errorText: message(error) });
    });
    else if (this.savedDevice && !this.reconnectSuppressed && !this.scanStarting && !this.data.scanning && !this.data.connectingId) this.search(true);
  },
  onHide() {
    this.active = false; this.autoTarget = null;
    if (this.client) this.client.stopScan();
  },
  onUnload() {
    this.unloaded = true; this.settlePrivacy('disagree');
    this.active = false; this.autoTarget = null;
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    if (this.client) this.client.destroy();
  },
  inputText(event) {
    const text = event.detail.value;
    try { this.setData({ text, byteCount: protocol.utf8(text).length, syncText: '', errorText: '' }); }
    catch (error) { this.setData({ text, byteCount: 513, errorText: message(error) }); }
  },
  async search(automatic = false) {
    if (this.scanStarting || this.data.connected || this.data.scanning || this.data.connectingId) return;
    this.autoTarget = automatic === true && this.savedDevice ? this.savedDevice.deviceId : null;
    this.scanStarting = true;
    const attempt = ++this.scanAttempt;
    this.setData({ scanning: true, scanHint: this.autoTarget ? '正在查找上次连接的文字屏…' : '准备搜索文字屏…',
      nearbyDevices: [], deviceOptions: [{ deviceId: '', label: '请选择蓝牙设备' }], deviceIndex: 0, errorText: '' });
    try {
      await this.client.scan();
      this.scanStarting = false;
      if (!this.active || this.unloaded) { await this.client.stopScan(); return; }
      const target = this.data.nearbyDevices.find(item => item.deviceId === this.autoTarget);
      if (target) this.tryReconnect(target);
    } catch (error) {
      this.scanStarting = false; this.autoTarget = null;
      if (!this.unloaded && attempt === this.scanAttempt) this.setData({ scanning: false, errorText: message(error) });
    }
  },
  tryReconnect(device) {
    if (!this.active || this.scanStarting || !this.data.scanning || device.deviceId !== this.autoTarget) return;
    this.autoTarget = null;
    this.connectDevice(device);
  },
  reconnectSaved() { this.reconnectSuppressed = false; return this.search(true); },
  selectDevice(event) {
    if (this.data.connectingId || this.data.connected) return;
    const option = this.data.deviceOptions[Number(event.detail.value)];
    if (!option || !option.deviceId) return;
    const device = this.data.nearbyDevices.find(item => item.deviceId === option.deviceId);
    if (!device) return;
    this.autoTarget = null;
    this.selectedId = device.deviceId;
    this.setData({ deviceIndex: Number(event.detail.value), selectedDeviceName: device.name });
    return this.connectDevice(device);
  },
  async connectDevice(device) {
    if (this.data.connectingId || this.data.connected) return;
    this.setData({ connectingId: device.deviceId, errorText: '' });
    try {
      const state = await this.client.connect(device);
      if (!this.unloaded) this.setData({ oledReady: state.oledReady });
    }
    catch (error) { if (!this.unloaded) this.setData({ connectingId: '', connected: false, errorText: message(error) }); }
  },
  async disconnect() {
    this.reconnectSuppressed = true; this.autoTarget = null;
    await this.client.disconnect();
    if (!this.unloaded) this.setData({ connected: false, deviceName: '', oledReady: false, syncText: '', errorText: '' });
  },
  send() { return this.transmit(this.data.text); },
  clearScreen() { return this.transmit('', false); },
  chooseFont(event) {
    const scale = Number(event.detail.value) + 1;
    if (!this.data.sending && [1, 2, 3, 4].includes(scale)) this.setData({ fontScale: scale, syncText: '' });
  },
  chooseEffect(event) {
    if (!this.data.sending) this.setData({ effectIndex: Number(event.detail.value), syncText: '' });
  },
  chooseSpeed(event) {
    if (!this.data.sending) this.setData({ speedIndex: Number(event.detail.value), syncText: '' });
  },
  displaySettings() {
    return { scale: this.data.fontScale, effect: this.data.effectIndex, interval: [1000, 3000, 5000][this.data.speedIndex] };
  },
  async applyDisplay() {
    if (this.data.sending || !this.data.connected || !this.data.effectsSupported) return;
    this.setData({ sending: true, syncText: '', errorText: '' });
    try {
      const state = await this.client.configure(this.displaySettings());
      if (!this.unloaded) this.setData({ syncText: `显示效果已更新 · 共 ${state.pages} 页` });
    } catch (error) { if (!this.unloaded) this.setData({ errorText: message(error) }); }
    finally { if (!this.unloaded) this.setData({ sending: false }); }
  },
  async transmit(text, includeSettings = true) {
    if (this.data.sending || !this.data.connected) return;
    this.setData({ sending: true, syncText: '', errorText: '' });
    try {
      const state = await this.client.sendText(text, includeSettings ? this.displaySettings() : undefined);
      if (!this.unloaded) this.setData({ syncText: text ? `已发送 · 共 ${state.pages} 页` : '屏幕已清空' });
    } catch (error) { if (!this.unloaded) this.setData({ errorText: message(error) }); }
    finally { if (!this.unloaded) this.setData({ sending: false }); }
  },
  openSettings() { wx.openSetting({}); },
  openPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请先在小程序后台配置隐私指引', icon: 'none' }) });
  },
  preparePrivacyAgree() {
    if (!this.data.showPrivacy || this.data.privacyAgreePending) return;
    this.setData({ privacyAgreePending: true });
    // 普通 tap 只启动超时保护。真正同意必须等微信的原生授权事件。
    this.privacyTimer = setTimeout(() => {
      this.settlePrivacy('disagree', '微信未完成隐私授权，请重新搜索后再试；开发工具中请使用手机预览测试。');
    }, 3000);
  },
  settlePrivacy(event, reason = '') {
    clearTimeout(this.privacyTimer);
    const resolvers = Array.from(this.privacyResolvers);
    this.privacyResolvers.clear();
    let failed = false;
    try {
      resolvers.forEach(resolve => {
        try {
          resolve(event === 'agree' ? { event, buttonId: 'agree-privacy' } : { event });
        } catch (error) {
          failed = true;
          console.warn('Privacy authorization could not complete:', error);
        }
      });
    } finally {
      // 即使平台回调报错，也必须收起弹窗并让用户能够重试。
      const patch = { showPrivacy: this.privacyResolvers.size > 0, privacyAgreePending: false };
      if (event !== 'agree' || failed) {
        ++this.scanAttempt;
        patch.scanning = false;
        patch.errorText = reason || (failed ? '隐私授权未完成，请重新搜索后再试。' : '已取消连接，点击搜索可以重试。');
      }
      if (!this.unloaded) this.setData(patch);
    }
  },
  agreePrivacy() {
    this.settlePrivacy('agree');
  },
  rejectPrivacy() {
    this.settlePrivacy('disagree');
  },
  ignorePrivacyTap() {}
});
