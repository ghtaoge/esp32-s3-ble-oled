const protocol = require('../../utils/protocol');
const { TextClient, message } = require('../../utils/ble');
Page({
  data: {
    connected: false, scanning: false, connectingId: '', devices: [], deviceName: '',
    oledReady: false, sending: false, text: '你好，今天也要开心！', byteCount: 33,
    syncText: '', errorText: '', showPrivacy: false, privacyAgreePending: false,
    privacyName: '《用户隐私保护指引》'
  },
  onLoad() {
    this.privacyResolvers = new Set(); this.scanAttempt = 0;
    this.setData({ byteCount: protocol.utf8(this.data.text).length });
    this.client = new TextClient({
      onDevice: device => {
        if (this.unloaded) return;
        const devices = this.data.devices.slice();
        const index = devices.findIndex(item => item.deviceId === device.deviceId);
        if (index < 0) devices.push(device); else devices[index] = device;
        devices.sort((a,b) => (b.RSSI || -127) - (a.RSSI || -127));
        this.setData({ devices });
      },
      onScanEnd: () => { if (!this.unloaded) this.setData({ scanning: false }); },
      onState: state => { if (!this.unloaded) this.setData({ oledReady: state.oledReady }); },
      onConnection: (connected, device) => {
        if (!this.unloaded) this.setData({ connected, connectingId: '',
          deviceName: device ? device.name : '', syncText: '',
          errorText: connected ? '' : '连接已断开，请重新搜索连接' });
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
    if (this.client && this.client.ready) this.client.refresh().catch(error => {
      if (!this.unloaded) this.setData({ errorText: message(error) });
    });
  },
  onHide() { if (this.client) this.client.stopScan(); },
  onUnload() {
    this.unloaded = true; this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    if (this.client) this.client.destroy();
  },
  inputText(event) {
    const text = event.detail.value;
    try { this.setData({ text, byteCount: protocol.utf8(text).length, syncText: '', errorText: '' }); }
    catch (error) { this.setData({ text, byteCount: 513, errorText: message(error) }); }
  },
  async search() {
    if (this.data.scanning || this.data.connectingId) return;
    const attempt = ++this.scanAttempt;
    this.setData({ scanning: true, devices: [], errorText: '' });
    try { await this.client.scan(); }
    catch (error) { if (!this.unloaded && attempt === this.scanAttempt) this.setData({ scanning: false, errorText: message(error) }); }
  },
  async connect(event) {
    if (this.data.connectingId || this.data.connected) return;
    const device = this.data.devices.find(item => item.deviceId === event.currentTarget.dataset.id);
    if (!device) return;
    this.setData({ connectingId: device.deviceId, errorText: '' });
    try { const state = await this.client.connect(device); if (!this.unloaded) this.setData({ oledReady: state.oledReady }); }
    catch (error) { if (!this.unloaded) this.setData({ connectingId: '', connected: false, errorText: message(error) }); }
  },
  async disconnect() {
    await this.client.disconnect();
    if (!this.unloaded) this.setData({ connected: false, deviceName: '', oledReady: false, syncText: '', errorText: '' });
  },
  send() { return this.transmit(this.data.text); },
  clearScreen() { return this.transmit(''); },
  async transmit(text) {
    if (this.data.sending || !this.data.connected) return;
    this.setData({ sending: true, syncText: '', errorText: '' });
    try {
      const state = await this.client.sendText(text);
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
