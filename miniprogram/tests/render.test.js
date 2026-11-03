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
  render=context.$gwx(Object.keys(registry.entrys)[0],registry);
}
function find(tree,predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  for (const child of tree.children || []) { const value=find(child,predicate); if(value) return value; }
}
const options={skip:render ? false : 'Set WXML_COMPILER to WeChat wcc.exe to test compiled templates'};
const base={connected:false,devices:[],text:'你好',byteCount:6,oledReady:false,sending:false,showPrivacy:false};
const button=(tree,action)=>find(tree,node=>node.attr?.bindtap===action);
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
