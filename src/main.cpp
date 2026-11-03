#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "protocol.h"

namespace {
constexpr char Service[] = "b82c0001-6d6a-4b2e-ae8b-3d80b18a5100";
constexpr char Write[] = "b82c0002-6d6a-4b2e-ae8b-3d80b18a5100";
constexpr char Status[] = "b82c0003-6d6a-4b2e-ae8b-3d80b18a5100";
U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
BLECharacteristic* status;
QueueHandle_t queue;
std::atomic<bool> connected{false};
std::atomic<uint32_t> epoch{0};
struct Packet { uint32_t epoch; uint8_t size; uint8_t data[20]; };
oled::Receiver receiver;
char shown[oled::MaxText + 1] = {};
uint16_t pageStarts[oled::MaxText + 2] = {};
uint16_t pages = 1, page = 0;
bool oledReady = false;
uint32_t pageAt = 0, transferAt = 0;

uint16_t glyph(uint32_t cp) {
  return cp <= 0xFFFF && u8g2_IsGlyph(display.getU8g2(), static_cast<uint16_t>(cp)) ? cp : '?';
}
// Use the same layout pass for page boundaries and drawing, with 4 x 16px lines.
size_t layout(size_t start, bool draw) {
  const size_t size = strlen(shown);
  size_t offset = start;
  int x = 0, row = 0;
  while (offset < size) {
    const size_t before = offset; uint32_t cp;
    if (!oled::decode(shown, size, offset, cp)) break;
    if (cp == '\n') {
      x = 0;
      if (++row == 4) return offset;
      continue;
    }
    uint16_t code = glyph(cp);
    int width = u8g2_GetGlyphWidth(display.getU8g2(), code);
    if (width <= 0) width = 6;
    if (x + width > 128) {
      x = 0;
      if (++row == 4) return before;
    }
    if (draw) display.drawGlyph(x, row * 16 + 13, code);
    x += width;
  }
  return offset;
}
void render() {
  if (!oledReady) return;
  display.clearBuffer();
  layout(pageStarts[page], true);
  display.sendBuffer();
}
void show(const char* text) {
  strncpy(shown, text, sizeof(shown) - 1);
  shown[sizeof(shown) - 1] = 0;
  pages = 1; pageStarts[0] = 0;
  size_t offset = 0, size = strlen(shown);
  while (offset < size) {
    size_t next = layout(offset, false);
    if (next <= offset || next >= size) break;
    pageStarts[pages++] = next;
    offset = next;
  }
  page = 0; pageAt = millis(); render();
}
void publish(uint8_t seq, uint8_t op, uint8_t result, bool notify = true) {
  uint8_t bytes[] = {0x5A, 1, seq, op, result,
    static_cast<uint8_t>(receiver.received), static_cast<uint8_t>(receiver.received >> 8),
    static_cast<uint8_t>(oledReady), static_cast<uint8_t>(pages), static_cast<uint8_t>(pages >> 8)};
  status->setValue(bytes, sizeof(bytes));
  if (notify && connected.load()) status->notify();
  // A later read reports readiness, never a previous command's error.
  if (result) {
    bytes[2] = 0; bytes[3] = 0; bytes[4] = 0;
    status->setValue(bytes, sizeof(bytes));
  }
}
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { connected.store(true); }
  void onDisconnect(BLEServer*) override { connected.store(false); epoch.fetch_add(1); }
};
class WriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value = characteristic->getValue();
    Packet packet{};
    packet.epoch = epoch.load();
    packet.size = value.length() <= 20 ? value.length() : 0;
    memcpy(packet.data, value.c_str(), packet.size);
    // Phone waits for every ACK. No display/I2C work in the Bluetooth callback.
    xQueueSend(queue, &packet, 0);
  }
};
void initDisplay() {
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setTimeOut(50);
  for (uint8_t address : {0x3C, 0x3D}) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      display.setI2CAddress(address << 1);
      display.setBusClock(100000);
      display.begin();
      display.setFont(u8g2_font_wqy12_t_gb2312);
      oledReady = true;
      Serial.printf("OLED found at 0x%02X, SDA=%d SCL=%d\n", address, OLED_SDA, OLED_SCL);
      show("蓝牙文字屏\n请用微信小程序连接\n输入文字后点击发送");
      return;
    }
  }
  Serial.println("OLED not found at 0x3C/0x3D. Check wiring, then reset.");
}
}
void setup() {
  Serial.begin(115200);
  initDisplay();
  queue = xQueueCreate(4, sizeof(Packet));
  if (!queue) { Serial.println("Queue allocation failed"); while (true) delay(1000); }
  char name[24];
  snprintf(name, sizeof(name), "S3-OLED-%04X", static_cast<unsigned>((ESP.getEfuseMac() >> 32) & 0xFFFF));
  if (!BLEDevice::init(name)) { Serial.println("BLE init failed"); while (true) delay(1000); }
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(true);
  BLEService* service = server->createService(Service);
  auto* write = service->createCharacteristic(Write, BLECharacteristic::PROPERTY_WRITE);
  write->setCallbacks(new WriteCallbacks());
  status = service->createCharacteristic(Status, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
#if defined(CONFIG_BLUEDROID_ENABLED)
  status->addDescriptor(new BLE2902());
#endif
  publish(0, 0, 0, false);
  service->start();
  BLEAdvertisementData advertisement, scanResponse;
  advertisement.setFlags(0x06);
  advertisement.setCompleteServices(BLEUUID(Service));
  scanResponse.setName(name);
  auto* advertising = BLEDevice::getAdvertising();
  advertising->setAdvertisementData(advertisement);
  advertising->setScanResponseData(scanResponse);
  advertising->start();
  Serial.printf("BLE ready: %s, Flash=%lu PSRAM=%lu\n", name,
                static_cast<unsigned long>(ESP.getFlashChipSize()), static_cast<unsigned long>(ESP.getPsramSize()));
}
void loop() {
  static uint32_t currentEpoch = 0;
  if (currentEpoch != epoch.load()) { currentEpoch = epoch.load(); receiver.reset(); }
  if (receiver.active && millis() - transferAt > 10000) receiver.reset();
  Packet packet;
  if (xQueueReceive(queue, &packet, 0) == pdTRUE && packet.epoch == currentEpoch && connected.load()) {
    transferAt = millis();
    uint8_t result = receiver.accept(packet.data, packet.size);
    if (result == 0 && packet.data[3] == 3) {
      if (!oledReady) result = 5;
      else { show(receiver.bytes); Serial.printf("DISPLAY bytes=%u pages=%u\n", receiver.total, pages); }
    }
    publish(packet.data[2], packet.data[3], result);
  }
  if (pages > 1 && millis() - pageAt >= 3000) {
    page = (page + 1) % pages; pageAt = millis(); render();
  }
  delay(2);
}
