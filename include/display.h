#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace oled {
struct DisplaySettings {
  uint8_t scale = 1;
  // 0=auto pages, 1=static first page, 2=blink, 3=slide upward.
  uint8_t effect = 0;
  uint16_t interval = 3000;
};
inline uint8_t parseSettings(const uint8_t* p, size_t size, DisplaySettings& settings) {
  if (size != 12 || p[0] != 0xA5 || p[1] != 1 || !p[2] || p[3] != 4 ||
      p[4] || p[5] || p[6] || p[7]) return 1;
  uint16_t interval = p[10] | (p[11] << 8);
  if (p[8] < 1 || p[8] > 4 || p[9] > 3 || interval < 500 || interval > 10000) return 6;
  settings.scale = p[8]; settings.effect = p[9]; settings.interval = interval;
  return 0;
}
constexpr size_t FrameBytes = 128 * 64 / 8;
inline bool pixel(const uint8_t* frame, unsigned x, unsigned y) {
  return frame[(y / 8) * 128 + x] & (1u << (y % 8));
}
inline void putPixel(uint8_t* frame, unsigned x, unsigned y) {
  frame[(y / 8) * 128 + x] |= 1u << (y % 8);
}
// U8g2 SSD1306 R0 full-buffer format: 8 vertical pixels per byte.
// Source and destination must be separate buffers.
inline void scaleFrame(const uint8_t* source, uint8_t* output, uint8_t scale) {
  if (scale == 1) { memcpy(output, source, FrameBytes); return; }
  memset(output, 0, FrameBytes);
  if (scale < 1 || scale > 4) return;
  for (unsigned y = 0; y < 64; ++y)
    for (unsigned x = 0; x < 128; ++x)
      if (pixel(source, x / scale, y / scale)) putPixel(output, x, y);
}
inline void slideFrames(const uint8_t* first, const uint8_t* next, uint8_t* output, unsigned shift) {
  if (shift > 64) shift = 64;
  memset(output, 0, FrameBytes);
  for (unsigned y = 0; y < 64; ++y) {
    unsigned sourceY = y + shift;
    for (unsigned x = 0; x < 128; ++x)
      if (pixel(sourceY < 64 ? first : next, x, sourceY % 64)) putPixel(output, x, y);
  }
}
struct Animation {
  uint16_t page = 0;
  uint8_t shift = 0;
  bool visible = true;
  uint32_t at = 0, frameAt = 0;
  void reset(uint32_t now) { page = 0; shift = 0; visible = true; at = frameAt = now; }
  bool tick(uint32_t now, uint16_t pages, const DisplaySettings& settings) {
    if (!pages || settings.effect == 1) return false;
    uint32_t elapsed = now - at;
    if (settings.effect == 2) {
      if (elapsed < settings.interval / 2u) return false;
      visible = !visible; at = now;
      if (visible) page = (page + 1) % pages;
      return true;
    }
    if (settings.effect == 3) {
      if (elapsed < settings.interval || now - frameAt < 100) return false;
      frameAt = now;
      if (elapsed >= 2u * settings.interval) {
        page = (page + 1) % pages; shift = 0; at = now;
      } else shift = (elapsed - settings.interval) * 64u / settings.interval;
      return true;
    }
    if (pages < 2 || elapsed < settings.interval) return false;
    page = (page + 1) % pages; at = now;
    return true;
  }
};
}
