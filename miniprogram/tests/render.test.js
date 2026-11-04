const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const compiler = process.env.WXML_COMPILER || '';
let render;
if (fs.existsSync(compiler)) {
  const mini = path.resolve(__dirname, '..');
  const output = path.resolve(mini, '../.local/wxml-test.js');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const result = spawnSync(compiler,['-o',output,'pages/index/index.wxml'],{cwd:mini,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr || result.stdout);
  const context = {window:{},console}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(output,'utf8'),context);
  const registry={}; context.$gwx(undefined,registry);
  context.renderTemplate=context.$gwx(Object.keys(registry.entrys)[0],registry);
  // 编译器按运行环境识别数组；测试数据也需在同一个 VM 中构造。
  render=data=>{
    context.renderData=JSON.stringify(data);
    return vm.runInContext('renderTemplate(JSON.parse(renderData))',context);
  };
}
function find(tree,predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  for (const child of tree.children || []) { const value=find(child,predicate); if(value) return value; }
}
const options={skip:render ? false : 'Set WXML_COMPILER to WeChat wcc.exe to test compiled templates'};
const base={connected:false,scanning:false,connectingId:'',devices:[],text:'你好',byteCount:6,oledReady:false,sending:false,showPrivacy:false};
const button=(tree,action)=>find(tree,node=>node.attr?.bindtap===action);

test('compiled search button uses a boolean disabled state and enables initial taps', options, () => {
  assert.equal(button(render(base), 'search').attr.disabled, false);
  assert.equal(button(render(base), 'disconnect'), undefined);
  for (const patch of [{ scanning: true }, { connectingId: 'device-id' }]) {
    assert.equal(button(render({ ...base, ...patch }), 'search').attr.disabled, true);
  }
});
test('compiled screen enables sending only when connected and OLED is ready',options,()=>{
  let tree=render(base);
  assert.ok(button(tree,'search'));
  assert.ok(button(tree,'send').attr.disabled);
  tree=render({...base,connected:true,oledReady:true});
  assert.ok(button(tree,'disconnect'));
  assert.equal(!!button(tree,'send').attr.disabled,false);
  for (const patch of [{sending:true},{byteCount:513},{oledReady:false}]) {
    tree=render({...base,connected:true,oledReady:true,...patch});
    assert.ok(button(tree,'send').attr.disabled);
  }
});
test('compiled privacy dialog uses native authorization event',options,()=>{
  const tree=render({...base,showPrivacy:true});
  const agree=find(tree,node=>node.attr?.id==='agree-privacy');
  assert.equal(agree.attr.openType,'agreePrivacyAuthorization');
  assert.equal(agree.attr.bindagreeprivacyauthorization,'agreePrivacy');
});

test('compiled device dropdown keeps the page compact and disables selection during connection', options, () => {
  const data = { ...base, deviceIndex: 0, nearbyDevices: [{ deviceId: 'old-firmware' }],
    deviceOptions: [{ deviceId: '', label: '请选择蓝牙设备' }, { deviceId: 'old-firmware', label: 'ESP32-RGB' }] };
  const picker = tree => find(tree, node => node.attr?.bindchange === 'selectDevice');
  let tree = render(data);
  assert.equal(picker(tree).attr.mode, 'selector');
  assert.equal(picker(tree).attr.rangeKey, 'label');
  assert.equal(picker(tree).attr.range.length, 2);
  assert.equal(picker(tree).attr.disabled, false);
  assert.equal(button(tree, 'connect'), undefined);
  assert.equal(picker(render({ ...data, connectingId: 'old-firmware' })).attr.disabled, true);
  assert.equal(picker(render({ ...data, nearbyDevices: [] })).attr.disabled, true);
  assert.equal(picker(render({ ...data, connected: true })), undefined);
  assert.ok(button(render({ ...data, savedDeviceName: 'S3-OLED-1234' }), 'reconnectSaved'));
});

test('compiled display controls require capable firmware and lock while sending', options, () => {
  const data = { ...base, connected: true, oledReady: true, effectsSupported: true,
    fontScale: 2, effectIndex: 3, speedIndex: 1,
    effectNames: ['自动翻页','静态显示','闪烁','向上滚动'], speedNames: ['快','标准','慢'] };
  assert.equal(button(render(data), 'applyDisplay').attr.disabled, false);
  for (const patch of [{ effectsSupported: false }, { sending: true }, { oledReady: false }, { connected: false }]) {
    assert.equal(button(render({ ...data, ...patch }), 'applyDisplay').attr.disabled, true);
  }
  const speed = tree => find(tree, node => node.attr?.bindchange === 'chooseSpeed');
  assert.equal(speed(render({ ...data, effectIndex: 1 })).attr.disabled, true);
  assert.equal(speed(render({ ...data, sending: true })).attr.disabled, true);
  assert.equal(speed(render(data)).attr.disabled, false);
  const font = tree => find(tree, node => node.attr?.bindchange === 'chooseFont');
  const fonts = ['标准 · 1 倍', '大字 · 2 倍', '特大 · 3 倍', '超大 · 4 倍'];
  assert.equal(font(render({ ...data, fontNames: fonts })).attr.mode, 'selector');
  assert.equal(font(render({ ...data, fontNames: fonts })).attr.range.length, 4);
  assert.equal(font(render({ ...data, fontNames: fonts, fontScale: 4 })).attr.value, 3);
  assert.equal(font(render(data)).attr.value, 1);
  assert.equal(font(render({ ...data, fontScale: 1 })).attr.value, 0);
  assert.equal(font(render({ ...data, sending: true })).attr.disabled, true);
});
