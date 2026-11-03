#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace oled {
constexpr size_t MaxText = 512;
// Strict UTF-8: reject overlong forms, surrogates, NUL and non-text controls.
inline bool decode(const char* text, size_t size, size_t& offset, uint32_t& cp) {
  if (offset >= size) return false;
  uint8_t first = static_cast<uint8_t>(text[offset++]);
  unsigned count;
  uint32_t minimum;
  if (first < 0x80) { cp = first; count = 0; minimum = 0; }
  else if (first >= 0xC2 && first <= 0xDF) { cp = first & 31; count = 1; minimum = 0x80; }
  else if (first >= 0xE0 && first <= 0xEF) { cp = first & 15; count = 2; minimum = 0x800; }
  else if (first >= 0xF0 && first <= 0xF4) { cp = first & 7; count = 3; minimum = 0x10000; }
  else return false;
  while (count--) {
    if (offset >= size) return false;
    uint8_t next = static_cast<uint8_t>(text[offset++]);
    if ((next & 0xC0) != 0x80) return false;
    cp = (cp << 6) | (next & 63);
  }
  return cp >= minimum && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) &&
         (cp == '\n' || (cp >= 32 && !(cp >= 0x7F && cp <= 0x9F)));
}
inline bool valid(const char* text, size_t size) {
  size_t offset = 0; uint32_t cp;
  while (offset < size) if (!decode(text, size, offset, cp)) return false;
  return true;
}
struct Receiver {
  char bytes[MaxText + 1] = {};
  uint16_t total = 0, received = 0;
  bool active = false;
  void reset() { active = false; total = received = 0; }
  // 0=OK, 1=packet, 2=range, 3=order, 4=UTF8, 5=OLED unavailable.
  uint8_t accept(const uint8_t* p, size_t length) {
    if (length < 8 || length > 20 || p[0] != 0xA5 || p[1] != 1 || !p[2]) return 1;
    const uint16_t offset = p[4] | (p[5] << 8), size = p[6] | (p[7] << 8);
    if (p[3] == 1) {
      reset();
      if (length != 8 || offset || size > MaxText) return 2;
      total = size; active = true; return 0;
    }
    if (!active || size != total || offset != received) return 3;
    if (p[3] == 2) {
      if (length == 8 || received + length - 8 > total) return 2;
      memcpy(bytes + received, p + 8, length - 8);
      received += length - 8; return 0;
    }
    if (p[3] != 3 || length != 8) return 1;
    if (received != total) return 3;
    active = false;
    if (!valid(bytes, total)) return 4;
    bytes[total] = 0; return 0;
  }
};
}
