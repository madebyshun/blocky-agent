// ============================================
// TFT_eSPI User Setup
// Board  : ESP32-S3 Super Mini
// Display: 3.5" ILI9488 480x320 SPI
// Touch  : XPT2046
// ============================================

// ── Display Driver ──
#define ILI9488_DRIVER

// ── Display Size ──
#define TFT_WIDTH  320
#define TFT_HEIGHT 480

// ── SPI Pins ──
#define TFT_MOSI  11
#define TFT_SCLK  12
#define TFT_MISO  13
#define TFT_CS    10
#define TFT_DC     8
#define TFT_RST    9

// ── Touch CS ──
#define TOUCH_CS   5

// ── SPI Frequency ──
#define SPI_FREQUENCY        20000000
#define SPI_READ_FREQUENCY   16000000
#define SPI_TOUCH_FREQUENCY   2500000

// ── Font loading ──
#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define LOAD_FONT6
#define LOAD_FONT7
#define LOAD_FONT8
#define LOAD_GFXFF

#define SMOOTH_FONT
