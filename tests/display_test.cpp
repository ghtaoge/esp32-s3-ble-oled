#include <assert.h>
#include <iostream>
#include "display.h"
#include "protocol.h"

int main() {
  oled::DisplaySettings settings;
  uint8_t config[] = {0xA5, 1, 1, 4, 0, 0, 0, 0, 2, 3, 0xB8, 0x0B};
  assert(oled::parseSettings(config, sizeof(config), settings) == 0);
  assert(settings.scale == 2 && settings.effect == 3 && settings.interval == 3000);
  for (unsigned i : {0u, 1u, 2u, 3u, 4u, 6u, 8u, 9u, 11u}) {
    auto old = config[i];
    config[i] = i == 2 ? 0 : 255;
    assert(oled::parseSettings(config, sizeof(config), settings) != 0);
    assert(settings.scale == 2 && settings.effect == 3 && settings.interval == 3000);
    config[i] = old;
  }
  assert(oled::parseSettings(config, 11, settings) != 0);
  assert(oled::parseSettings(config, 0, settings) != 0);
  for (uint8_t scale : {3, 4}) {
    config[8] = scale;
    assert(oled::parseSettings(config, sizeof(config), settings) == 0 && settings.scale == scale);
    uint8_t small[oled::FrameBytes] = {}, large[oled::FrameBytes];
    oled::putPixel(small, 3, 5);
    oled::scaleFrame(small, large, scale);
    unsigned lit = 0;
    for (unsigned y = 0; y < 64; ++y) for (unsigned x = 0; x < 128; ++x) {
      bool expected = x >= 3u * scale && x < 4u * scale && y >= 5u * scale && y < 6u * scale;
      assert(oled::pixel(large, x, y) == expected);
      lit += oled::pixel(large, x, y);
    }
    assert(lit == unsigned(scale * scale));
  }
  uint8_t source[oled::FrameBytes] = {}, output[oled::FrameBytes], next[oled::FrameBytes] = {};
  oled::putPixel(source, 0, 0); oled::putPixel(source, 63, 31);
  oled::putPixel(source, 64, 0); oled::putPixel(source, 0, 32);
  oled::scaleFrame(source, output, 2);
  unsigned count = 0;
  for (unsigned y = 0; y < 64; ++y) for (unsigned x = 0; x < 128; ++x) {
    bool expected = (x < 2 && y < 2) || (x >= 126 && y >= 62);
    assert(oled::pixel(output, x, y) == expected);
    count += oled::pixel(output, x, y);
  }
  assert(count == 8);
  oled::scaleFrame(source, output, 1);
  assert(memcmp(source, output, sizeof(source)) == 0);
  oled::putPixel(next, 25, 5);
  for (unsigned shift : {0u, 1u, 35u, 63u, 64u}) {
    oled::slideFrames(source, next, output, shift);
    for (unsigned y = 0; y < 64; ++y) for (unsigned x = 0; x < 128; ++x) {
      unsigned sy = y + shift;
      assert(oled::pixel(output, x, y) == oled::pixel(sy < 64 ? source : next, x, sy % 64));
    }
  }
  oled::Animation animation;
  settings = oled::DisplaySettings();
  animation.reset(100);
  assert(!animation.tick(3099, 2, settings));
  assert(animation.tick(3100, 2, settings) && animation.page == 1);
  assert(animation.tick(6100, 2, settings) && animation.page == 0);
  settings.effect = 1; animation.reset(0);
  assert(!animation.tick(999999, 2, settings) && animation.page == 0);
  settings.effect = 2; animation.reset(0);
  assert(animation.tick(1500, 2, settings) && !animation.visible && animation.page == 0);
  assert(animation.tick(3000, 2, settings) && animation.visible && animation.page == 1);
  settings.effect = 3; animation.reset(0);
  assert(!animation.tick(2999, 2, settings));
  assert(animation.tick(4500, 2, settings) && animation.shift == 32);
  assert(!animation.tick(4501, 2, settings));
  assert(animation.tick(6000, 2, settings) && animation.shift == 0 && animation.page == 1);
  animation.reset(0);
  assert(animation.tick(6000, 1, settings) && animation.page == 0);
  settings.effect = 0; animation.reset(UINT32_MAX - 1000);
  assert(animation.tick(1999, 2, settings));
  // Text receiver continues to support the original text framing.
  oled::Receiver receiver;
  uint8_t begin[] = {0xA5,1,1,1,0,0,3,0};
  uint8_t data[] = {0xA5,1,2,2,0,0,3,0,0xE4,0xBD,0xA0};
  uint8_t commit[] = {0xA5,1,3,3,3,0,3,0};
  assert(receiver.accept(begin, sizeof(begin)) == 0);
  assert(receiver.accept(data, sizeof(data)) == 0);
  assert(receiver.accept(commit, sizeof(commit)) == 0);
  assert(receiver.total == 3 && !receiver.active && receiver.bytes[3] == 0);
  std::cout << "Settings validation, scaling pixels, scrolling frames, animation timing and UTF-8 transfer passed.\n";
}
