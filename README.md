# ESP32-S3 蓝牙 OLED 文字屏

微信小程序输入文字，经 BLE 发送到 ESP32-S3 N16R8，在 SSD1306 128×64 I²C OLED 上显示。

## 接线

**断电后接线，按模块上印刷的引脚名称连接，不要按排列顺序猜测。**

| OLED 引脚 | ESP32-S3 开发板 |
| --- | --- |
| VCC | 3V3 / 3.3V |
| GND | GND |
| SDA | GPIO8（板上通常标作 8） |
| SCL / SCK | GPIO9（板上通常标作 9） |

这里的 8、9 是 GPIO 编号，不是排针的第 8、9 个脚。此配置适用于这些脚已引出的普通 ESP32-S3 开发板；如果板上另有外设占用它们，在 `platformio.ini` 改 `OLED_SDA`、`OLED_SCL` 并同步改接线。使用 3.3V 供电，避免模块将 I²C 上拉到 5V。需要杜邦线四根。

## 编译和烧录

用 VS Code / PlatformIO 打开本目录，选择 `esp32-s3-n16r8` 环境，点击 Build，然后 Upload。配置已覆盖为 16 MB Flash + 8 MB OPI PSRAM。

```sh
pio run
pio device list
pio run --target upload --upload-port COM你的串口号
pio device monitor --baud 115200 --port COM你的串口号
```

如果系统没有 `pio` 命令，使用 PlatformIO 扩展的终端，或直接执行本机 PlatformIO 安装目录中的 `platformio.exe`。首次烧录无法进入下载模式时，按住 BOOT，点按 RST/EN，再松开 BOOT，然后上传。上传会替换板上的原固件。

启动时自动检查 `0x3C` 和 `0x3D`，检测成功后显示中文连接提示；串口输出 OLED 地址、SDA/SCL、BLE 名称、Flash/PSRAM 大小。若没有检测到屏幕，仍会广播蓝牙，小程序显示接线提示并禁止发送；修好接线后重启开发板。

## 微信小程序

1. 在微信开发者工具导入 `miniprogram/`，使用自己的小程序 AppID。源码中的 `touristappid` 仅用于界面预览，蓝牙需手机真机测试。
2. 如需保留公开源码里的占位 AppID，先运行 `python tools/prepare_wechat.py --appid 你的AppID`，然后导入 `.local/wechat/`。更新源码后重新运行脚本。
3. 在小程序后台配置蓝牙用途和用户隐私保护指引，使用有该 AppID 开发权限的微信账号预览。小程序提供原生隐私同意按钮。
4. 打开手机蓝牙，搜索并点击 `S3-OLED-XXXX`。无需在系统蓝牙设置中先配对。
5. 在输入框写字，点击“发送到屏幕”。收到开发板最终确认后显示发送成功和页数。“清空屏幕”不删除输入框草稿。

安卓机还可能需要微信的附近设备、定位权限或定位服务，按手机系统提示授权。模拟器可查看页面，不能代替真机蓝牙测试。

## 显示行为

- 使用 U8g2 文泉驿 12 像素 GB2312 字库，支持常用简体中文和英文、数字、标点。未覆盖的生僻字、繁体字和 emoji 显示为 `?`。
- 每页 4 行，每行按字形实际宽度换行；中文约每行 10 字。输入中的换行保留。超过一页时每 3 秒自动循环翻页。
- 每次最多 512 个 UTF-8 字节，约 170 个汉字或 512 个 ASCII 字符。界面实时显示字节数。Windows 换行统一为 LF，制表符替换为两个空格。
- 空文本表示清屏；传输失败保持旧显示；只有完整、合法的文本提交后才替换屏幕内容。
- 文字不写入 Flash，断电后恢复启动提示。断线保留当前显示，下次发送从头开始。
- 接收暂存 10 秒无新包或 BLE 断开即失效。I²C 仅在启动时检测，运行中拔掉屏幕不能实时上报；重新连接硬件后请复位。ACK 表示固件已完成显示调用，不保证物理屏幕的每个像素状态。

## BLE 协议

| 项目 | UUID | 属性 |
| --- | --- | --- |
| Service | `b82c0001-6d6a-4b2e-ae8b-3d80b18a5100` | 服务 |
| Write | `b82c0002-6d6a-4b2e-ae8b-3d80b18a5100` | Write |
| Status | `b82c0003-6d6a-4b2e-ae8b-3d80b18a5100` | Read + Notify |

每个写包最多 20 字节：`A5 01 seq op offsetLE16 totalLE16 [payload]`。seq 为 1–255 循环；op=1 开始（offset=0，无 payload），op=2 数据（最多 12 字节），op=3 提交（offset=total，无 payload）。所有包携带相同 total，各包收到 ACK 后再写下一包。UTF-8 字节可以跨包，拼接完成后再校验。

ACK 为 10 字节：`5A 01 seq op result receivedLE16 oledReady pagesLE16`。
result：0 成功，1 格式错误，2 长度错误，3 顺序错误/超时失效，4 非法 UTF-8，5 未检测到 OLED。连接时 Read 读取屏幕是否就绪，读取结果由微信的特征值变化事件返回。

本示例未启用 BLE 绑定或访问口令，附近的兼容客户端可以连接和更新文字。

## 验证

```sh
npm test
pio run
```

JavaScript 测试覆盖 UTF-8、多包边界、字节上限、ACK 校验、错误重试和中途断线。编译通过不代表已在你的屏幕上验证。

若要运行微信模板渲染测试，设置 `WXML_COMPILER` 环境变量指向微信开发者工具自带的 `wcc.exe` 后再运行 `npm test`。未设置时两项渲染测试会明确跳过。它会检查发送按钮的可用条件和原生隐私授权事件。

真机验收：依次发送 `你好，ESP32！`、含手动换行的中英文、超过 4 行的文本，再清屏；确认无乱码、每 3 秒翻页、清屏成功。发送过程中断开蓝牙后重连并重新发送，确认旧内容不会被半包替换。

## 参考

- [Arduino ESP32 I²C API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2c.html)
- [ESP32-S3-DevKitC-1 引脚与 N16R8 型号](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)
- [U8g2 字体和显示接口](https://github.com/olikraus/u8g2/wiki/u8g2reference)
- [微信 BLE 写入 API](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html)

代码复用 MIT 项目 [esp32-s3-ble-rgb](https://github.com/ghtaoge/esp32-s3-ble-rgb) 的蓝牙连接及隐私授权逻辑，保留其 LICENSE；U8g2 和所含字体的许可证见该依赖项目。

## 公开源码与本地配置

公开配置仅使用 `touristappid` 占位。本地 AppID 副本保存在 `.local/wechat/`，与构建产物、编辑器配置、环境文件和密钥文件一起排除在 Git 提交之外。

```sh
git config core.hooksPath .githooks
npm run check:public
```

提交钩子检查实际暂存内容，发现明显的 AppID、凭据或个人路径时阻止提交，且不输出匹配到的敏感值。
