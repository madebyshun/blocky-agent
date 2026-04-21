#pragma once

// ── WiFi ──
#define WIFI_SSID       "YourWiFiSSID"
#define WIFI_PASSWORD   "YourWiFiPassword"

// ── BlueAgent Proxy API ──
#define API_HOST        "your-server-ip-or-domain"  // e.g. "192.168.1.100"
#define API_PORT        3402
#define API_KEY         "esp32-blueagent-key"       // must match ESP32_API_KEY on server
#define API_USE_HTTPS   false                        // set true if server has TLS

// ── Display (ILI9488 3.5" 320x480) ──
#define TFT_CS    10
#define TFT_DC     8
#define TFT_RST    9
#define TFT_MOSI  11
#define TFT_SCLK  12
#define TFT_MISO  13
#define TFT_LED   -1   // -1 = 3.3V trực tiếp, hoặc set GPIO để điều chỉnh độ sáng

// ── Touch (XPT2046 resistive) ──
#define TOUCH_CS   5
#define TOUCH_IRQ  4

// ── LVGL display buffer size ──
#define LV_BUF_LINES  10  // lines per LVGL draw buffer (more = faster, more RAM)
