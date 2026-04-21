/*
 * BlueAgent x402 Terminal
 * ESP32-S3 Super Mini + 3.5" ILI9488 display
 *
 * Libraries required (install via Arduino Library Manager):
 *   - TFT_eSPI     by Bodmer         (configure User_Setup.h for ILI9488)
 *   - lvgl         by kisvegabor     (v8.x)
 *   - XPT2046_Touchscreen by Paul Stoffregen
 *   - ArduinoJson  by Benoit Blanchon
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <lvgl.h>
#include "config.h"

// ─────────────────────────────────────────────
// Hardware
// ─────────────────────────────────────────────
TFT_eSPI tft = TFT_eSPI();
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);

// ─────────────────────────────────────────────
// Skill registry (mirrors src/api.ts)
// ─────────────────────────────────────────────
struct Skill {
  const char* name;
  const char* label;
  float price;
  const char* category;
  const char* inputKey;
  const char* inputHint;
};

static const Skill SKILLS[] = {
  // Security
  { "risk-gate",       "Risk Gate",        0.05f, "security", "action",      "Describe the action to check..." },
  { "honeypot-check",  "Honeypot Check",   0.05f, "security", "token",       "Token contract address 0x..." },
  { "phishing-scan",   "Phishing Scan",    0.10f, "security", "target",      "URL or Twitter/X handle" },
  { "aml-screen",      "AML Screen",       0.25f, "security", "address",     "Wallet address 0x..." },
  { "mev-shield",      "MEV Shield",       0.30f, "security", "action",      "Describe the swap action..." },
  { "quantum-premium", "Quantum Scan",     1.50f, "security", "address",     "Wallet address 0x..." },
  // Data
  { "wallet-pnl",      "Wallet PnL",       1.00f, "data",     "address",     "Wallet address 0x..." },
  { "whale-tracker",   "Whale Tracker",    0.10f, "data",     "address",     "Wallet address 0x..." },
  { "dex-flow",        "DEX Flow",         0.15f, "data",     "token",       "Token contract address 0x..." },
  { "unlock-alert",    "Unlock Alert",     0.20f, "data",     "token",       "Token name or address" },
  { "airdrop-check",   "Airdrop Check",    0.10f, "data",     "address",     "Wallet address 0x..." },
  // Research
  { "deep-analysis",   "Deep Analysis",    0.35f, "research", "projectName", "Token name or address" },
  { "tokenomics-score","Tokenomics Score", 0.50f, "research", "token",       "Token name or address" },
  { "narrative-pulse", "Narrative Pulse",  0.40f, "research", "query",       "Topic e.g. AI agents" },
  { "vc-tracker",      "VC Tracker",       1.00f, "research", "query",       "VC firm or theme" },
  // Earn
  { "yield-optimizer", "Yield Optimizer",  0.15f, "earn",     "token",       "Token e.g. USDC or ETH" },
  { "lp-analyzer",     "LP Analyzer",      0.30f, "earn",     "address",     "Wallet address 0x..." },
  { "tax-report",      "Tax Report",       2.00f, "earn",     "address",     "Wallet address 0x..." },
};
static const int SKILL_COUNT = sizeof(SKILLS) / sizeof(SKILLS[0]);

// ─────────────────────────────────────────────
// LVGL display flush + touch
// ─────────────────────────────────────────────
static lv_disp_draw_buf_t drawBuf;
static lv_color_t buf1[320 * LV_BUF_LINES];

void lvglFlush(lv_disp_drv_t* disp, const lv_area_t* area, lv_color_t* px_map) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushColors((uint16_t*)px_map, w * h, true);
  tft.endWrite();
  lv_disp_flush_ready(disp);
}

void lvglReadTouch(lv_indev_drv_t* drv, lv_indev_data_t* data) {
  if (touch.touched()) {
    TS_Point p = touch.getPoint();
    // Map raw touch coordinates to screen pixels (calibrate if needed)
    int x = map(p.x, 200, 3800, 0, 320);
    int y = map(p.y, 200, 3800, 0, 480);
    x = constrain(x, 0, 319);
    y = constrain(y, 0, 479);
    data->state = LV_INDEV_STATE_PR;
    data->point.x = x;
    data->point.y = y;
  } else {
    data->state = LV_INDEV_STATE_REL;
  }
}

// ─────────────────────────────────────────────
// UI state
// ─────────────────────────────────────────────
static lv_obj_t* screenMain   = nullptr;
static lv_obj_t* screenInput  = nullptr;
static lv_obj_t* screenLoad   = nullptr;
static lv_obj_t* screenResult = nullptr;

static int selectedSkillIdx = -1;
static char inputValue[256] = {0};
static char resultBuffer[2048] = {0};

// Forward declarations
void showMain();
void showInput(int skillIdx);
void showLoading(const char* skillLabel);
void showResult(const char* skillName, float price, const char* jsonResult);

// ─────────────────────────────────────────────
// Category color coding
// ─────────────────────────────────────────────
lv_color_t categoryColor(const char* cat) {
  if (strcmp(cat, "security") == 0) return lv_color_make(220, 50,  50);
  if (strcmp(cat, "data")     == 0) return lv_color_make(50,  120, 220);
  if (strcmp(cat, "research") == 0) return lv_color_make(140, 80,  200);
  if (strcmp(cat, "earn")     == 0) return lv_color_make(40,  180, 100);
  return lv_color_make(80, 80, 80);
}

// ─────────────────────────────────────────────
// API call
// ─────────────────────────────────────────────
bool callSkill(int idx, const char* value, char* outJson, size_t outLen) {
  const Skill& sk = SKILLS[idx];

  char url[256];
  snprintf(url, sizeof(url), "%s://%s:%d/api/x402/%s",
           API_USE_HTTPS ? "https" : "http", API_HOST, API_PORT, sk.name);

  StaticJsonDocument<512> reqDoc;
  reqDoc[sk.inputKey] = value;
  char body[400];
  serializeJson(reqDoc, body, sizeof(body));

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.setTimeout(65000);

  int code = http.POST(body);
  if (code == 200) {
    String resp = http.getString();
    strncpy(outJson, resp.c_str(), outLen - 1);
    outJson[outLen - 1] = '\0';
    http.end();
    return true;
  }

  snprintf(outJson, outLen, "{\"error\":\"HTTP %d\"}", code);
  http.end();
  return false;
}

// ─────────────────────────────────────────────
// Screen: Main Menu (tabs by category)
// ─────────────────────────────────────────────
void showMain() {
  if (screenMain) { lv_obj_del(screenMain); screenMain = nullptr; }

  screenMain = lv_obj_create(nullptr);
  lv_obj_set_style_bg_color(screenMain, lv_color_make(15, 15, 25), 0);

  // Header
  lv_obj_t* header = lv_obj_create(screenMain);
  lv_obj_set_size(header, 320, 44);
  lv_obj_align(header, LV_ALIGN_TOP_MID, 0, 0);
  lv_obj_set_style_bg_color(header, lv_color_make(25, 30, 60), 0);
  lv_obj_set_style_border_width(header, 0, 0);
  lv_obj_t* title = lv_label_create(header);
  lv_label_set_text(title, "BLUEAGENT  x402 Terminal");
  lv_obj_set_style_text_color(title, lv_color_make(80, 160, 255), 0);
  lv_obj_align(title, LV_ALIGN_LEFT_MID, 8, 0);

  // WiFi status indicator
  lv_obj_t* wifiLabel = lv_label_create(header);
  lv_label_set_text(wifiLabel, WiFi.isConnected() ? "  " : " NO WiFi");
  lv_obj_set_style_text_color(wifiLabel, WiFi.isConnected() ? lv_color_make(40, 200, 80) : lv_color_make(220, 60, 60), 0);
  lv_obj_align(wifiLabel, LV_ALIGN_RIGHT_MID, -8, 0);

  // Tab view
  lv_obj_t* tabview = lv_tabview_create(screenMain, LV_DIR_TOP, 36);
  lv_obj_set_size(tabview, 320, 436);
  lv_obj_align(tabview, LV_ALIGN_BOTTOM_MID, 0, 0);
  lv_obj_set_style_bg_color(tabview, lv_color_make(15, 15, 25), 0);

  const char* categories[] = { "Security", "Data", "Research", "Earn" };
  const char* catKeys[]     = { "security", "data", "research", "earn" };

  for (int c = 0; c < 4; c++) {
    lv_obj_t* tab = lv_tabview_add_tab(tabview, categories[c]);
    lv_obj_set_style_pad_all(tab, 4, 0);

    for (int i = 0; i < SKILL_COUNT; i++) {
      if (strcmp(SKILLS[i].category, catKeys[c]) != 0) continue;

      lv_obj_t* card = lv_btn_create(tab);
      lv_obj_set_size(card, 290, 52);
      lv_obj_set_style_bg_color(card, lv_color_make(22, 26, 48), 0);
      lv_obj_set_style_bg_color(card, lv_color_make(30, 36, 70), LV_STATE_PRESSED);
      lv_obj_set_style_border_color(card, categoryColor(catKeys[c]), 0);
      lv_obj_set_style_border_width(card, 1, 0);
      lv_obj_set_style_radius(card, 6, 0);
      lv_obj_set_style_shadow_width(card, 0, 0);

      // Skill name
      lv_obj_t* nameLabel = lv_label_create(card);
      lv_label_set_text(nameLabel, SKILLS[i].label);
      lv_obj_set_style_text_color(nameLabel, lv_color_make(220, 225, 255), 0);
      lv_obj_align(nameLabel, LV_ALIGN_LEFT_MID, 8, -8);

      // Input key hint
      lv_obj_t* hintLabel = lv_label_create(card);
      lv_label_set_text(hintLabel, SKILLS[i].inputHint);
      lv_obj_set_style_text_color(hintLabel, lv_color_make(100, 110, 150), 0);
      lv_obj_set_style_text_font(hintLabel, &lv_font_montserrat_10, 0);
      lv_obj_align(hintLabel, LV_ALIGN_LEFT_MID, 8, 10);

      // Price badge
      char priceStr[16];
      snprintf(priceStr, sizeof(priceStr), "$%.2f", SKILLS[i].price);
      lv_obj_t* priceLabel = lv_label_create(card);
      lv_label_set_text(priceLabel, priceStr);
      lv_obj_set_style_text_color(priceLabel, categoryColor(catKeys[c]), 0);
      lv_obj_align(priceLabel, LV_ALIGN_RIGHT_MID, -8, 0);

      // Store skill index in user data
      lv_obj_set_user_data(card, (void*)(intptr_t)i);
      lv_obj_add_event_cb(card, [](lv_event_t* e) {
        int idx = (int)(intptr_t)lv_obj_get_user_data(lv_event_get_target(e));
        showInput(idx);
      }, LV_EVENT_CLICKED, nullptr);
    }
  }

  lv_scr_load(screenMain);
}

// ─────────────────────────────────────────────
// Screen: Input with on-screen keyboard
// ─────────────────────────────────────────────
void showInput(int skillIdx) {
  selectedSkillIdx = skillIdx;
  const Skill& sk = SKILLS[skillIdx];
  if (screenInput) { lv_obj_del(screenInput); screenInput = nullptr; }

  screenInput = lv_obj_create(nullptr);
  lv_obj_set_style_bg_color(screenInput, lv_color_make(15, 15, 25), 0);

  // Back button
  lv_obj_t* backBtn = lv_btn_create(screenInput);
  lv_obj_set_size(backBtn, 60, 32);
  lv_obj_align(backBtn, LV_ALIGN_TOP_LEFT, 6, 6);
  lv_obj_set_style_bg_color(backBtn, lv_color_make(40, 40, 80), 0);
  lv_obj_t* backLbl = lv_label_create(backBtn);
  lv_label_set_text(backLbl, "< Back");
  lv_obj_center(backLbl);
  lv_obj_add_event_cb(backBtn, [](lv_event_t*) { showMain(); }, LV_EVENT_CLICKED, nullptr);

  // Skill name + price
  char titleStr[64];
  snprintf(titleStr, sizeof(titleStr), "%s  $%.2f", sk.label, sk.price);
  lv_obj_t* titleLbl = lv_label_create(screenInput);
  lv_label_set_text(titleLbl, titleStr);
  lv_obj_set_style_text_color(titleLbl, categoryColor(sk.category), 0);
  lv_obj_align(titleLbl, LV_ALIGN_TOP_MID, 0, 14);

  // Input hint
  lv_obj_t* hintLbl = lv_label_create(screenInput);
  lv_label_set_text(hintLbl, sk.inputHint);
  lv_obj_set_style_text_color(hintLbl, lv_color_make(120, 130, 160), 0);
  lv_obj_set_style_text_font(hintLbl, &lv_font_montserrat_10, 0);
  lv_obj_align(hintLbl, LV_ALIGN_TOP_MID, 0, 38);

  // Text area
  lv_obj_t* ta = lv_textarea_create(screenInput);
  lv_obj_set_size(ta, 304, 52);
  lv_obj_align(ta, LV_ALIGN_TOP_MID, 0, 54);
  lv_textarea_set_one_line(ta, false);
  lv_textarea_set_placeholder_text(ta, sk.inputHint);
  lv_obj_set_style_bg_color(ta, lv_color_make(25, 28, 50), 0);
  lv_obj_set_style_text_color(ta, lv_color_make(220, 225, 255), 0);
  lv_obj_set_style_border_color(ta, categoryColor(sk.category), 0);

  // On-screen keyboard
  lv_obj_t* kb = lv_keyboard_create(screenInput);
  lv_obj_set_size(kb, 320, 200);
  lv_obj_align(kb, LV_ALIGN_BOTTOM_MID, 0, 0);
  lv_keyboard_set_textarea(kb, ta);
  lv_obj_set_style_bg_color(kb, lv_color_make(20, 22, 40), 0);

  // Submit button (above keyboard)
  lv_obj_t* submitBtn = lv_btn_create(screenInput);
  lv_obj_set_size(submitBtn, 200, 38);
  lv_obj_align(submitBtn, LV_ALIGN_TOP_MID, 0, 112);
  lv_obj_set_style_bg_color(submitBtn, categoryColor(sk.category), 0);
  lv_obj_t* submitLbl = lv_label_create(submitBtn);
  lv_label_set_text(submitLbl, "Call x402  >");
  lv_obj_center(submitLbl);

  // Store ta pointer in submit button user_data
  lv_obj_set_user_data(submitBtn, ta);
  lv_obj_add_event_cb(submitBtn, [](lv_event_t* e) {
    lv_obj_t* area = (lv_obj_t*)lv_obj_get_user_data(lv_event_get_target(e));
    const char* val = lv_textarea_get_text(area);
    strncpy(inputValue, val, sizeof(inputValue) - 1);

    const Skill& sk = SKILLS[selectedSkillIdx];
    showLoading(sk.label);

    // Call API (blocking — runs on loop, not task)
    char resp[2048] = {0};
    callSkill(selectedSkillIdx, inputValue, resp, sizeof(resp));
    showResult(sk.name, sk.price, resp);
  }, LV_EVENT_CLICKED, nullptr);

  lv_scr_load(screenInput);
}

// ─────────────────────────────────────────────
// Screen: Loading spinner
// ─────────────────────────────────────────────
void showLoading(const char* skillLabel) {
  if (screenLoad) { lv_obj_del(screenLoad); screenLoad = nullptr; }
  screenLoad = lv_obj_create(nullptr);
  lv_obj_set_style_bg_color(screenLoad, lv_color_make(15, 15, 25), 0);

  lv_obj_t* spinner = lv_spinner_create(screenLoad, 1000, 60);
  lv_obj_set_size(spinner, 80, 80);
  lv_obj_center(spinner);
  lv_obj_set_style_arc_color(spinner, lv_color_make(80, 160, 255), LV_PART_INDICATOR);

  char msg[64];
  snprintf(msg, sizeof(msg), "Calling %s via x402...", skillLabel);
  lv_obj_t* lbl = lv_label_create(screenLoad);
  lv_label_set_text(lbl, msg);
  lv_obj_set_style_text_color(lbl, lv_color_make(150, 160, 200), 0);
  lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 60);

  lv_obj_t* payLbl = lv_label_create(screenLoad);
  lv_label_set_text(payLbl, "Paying USDC on Base...");
  lv_obj_set_style_text_color(payLbl, lv_color_make(80, 120, 80), 0);
  lv_obj_set_style_text_font(payLbl, &lv_font_montserrat_10, 0);
  lv_obj_align(payLbl, LV_ALIGN_CENTER, 0, 80);

  lv_scr_load(screenLoad);
  lv_timer_handler();
}

// ─────────────────────────────────────────────
// Screen: Result display
// ─────────────────────────────────────────────
void showResult(const char* skillName, float price, const char* jsonResult) {
  if (screenResult) { lv_obj_del(screenResult); screenResult = nullptr; }
  screenResult = lv_obj_create(nullptr);
  lv_obj_set_style_bg_color(screenResult, lv_color_make(15, 15, 25), 0);

  // Header bar
  lv_obj_t* hdr = lv_obj_create(screenResult);
  lv_obj_set_size(hdr, 320, 40);
  lv_obj_align(hdr, LV_ALIGN_TOP_MID, 0, 0);
  lv_obj_set_style_bg_color(hdr, lv_color_make(20, 25, 50), 0);
  lv_obj_set_style_border_width(hdr, 0, 0);

  char hdrText[64];
  snprintf(hdrText, sizeof(hdrText), "Result  |  $%.2f paid", price);
  lv_obj_t* hdrLbl = lv_label_create(hdr);
  lv_label_set_text(hdrLbl, hdrText);
  lv_obj_set_style_text_color(hdrLbl, lv_color_make(80, 160, 255), 0);
  lv_obj_align(hdrLbl, LV_ALIGN_LEFT_MID, 8, 0);

  // Back button
  lv_obj_t* backBtn = lv_btn_create(hdr);
  lv_obj_set_size(backBtn, 52, 28);
  lv_obj_align(backBtn, LV_ALIGN_RIGHT_MID, -4, 0);
  lv_obj_set_style_bg_color(backBtn, lv_color_make(40, 40, 80), 0);
  lv_obj_t* backLbl = lv_label_create(backBtn);
  lv_label_set_text(backLbl, "Menu");
  lv_obj_center(backLbl);
  lv_obj_add_event_cb(backBtn, [](lv_event_t*) { showMain(); }, LV_EVENT_CLICKED, nullptr);

  // Scrollable result area
  lv_obj_t* scroll = lv_obj_create(screenResult);
  lv_obj_set_size(scroll, 320, 438);
  lv_obj_align(scroll, LV_ALIGN_BOTTOM_MID, 0, 0);
  lv_obj_set_style_bg_color(scroll, lv_color_make(15, 15, 25), 0);
  lv_obj_set_style_border_width(scroll, 0, 0);
  lv_obj_set_flex_flow(scroll, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(scroll, 4, 0);
  lv_obj_set_style_pad_all(scroll, 6, 0);

  // Parse JSON and render key-value rows
  StaticJsonDocument<2048> doc;
  DeserializationError err = deserializeJson(doc, jsonResult);

  if (err) {
    lv_obj_t* errLbl = lv_label_create(scroll);
    lv_label_set_text(errLbl, "Failed to parse response");
    lv_obj_set_style_text_color(errLbl, lv_color_make(220, 80, 80), 0);
    lv_scr_load(screenResult);
    return;
  }

  // Show error field if present
  if (doc.containsKey("error")) {
    lv_obj_t* errLbl = lv_label_create(scroll);
    char errMsg[256];
    snprintf(errMsg, sizeof(errMsg), "Error: %s", doc["error"].as<const char*>());
    lv_label_set_text(errLbl, errMsg);
    lv_obj_set_style_text_color(errLbl, lv_color_make(220, 80, 80), 0);
    lv_label_set_long_mode(errLbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(errLbl, 300);
    lv_scr_load(screenResult);
    return;
  }

  // Render each key in result object
  JsonObject result = doc["result"].as<JsonObject>();
  if (result.isNull()) result = doc.as<JsonObject>();

  for (JsonPair kv : result) {
    lv_obj_t* row = lv_obj_create(scroll);
    lv_obj_set_size(row, 306, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(row, lv_color_make(22, 26, 48), 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_radius(row, 5, 0);
    lv_obj_set_style_pad_all(row, 6, 0);

    // Key
    lv_obj_t* keyLbl = lv_label_create(row);
    lv_label_set_text(keyLbl, kv.key().c_str());
    lv_obj_set_style_text_color(keyLbl, lv_color_make(100, 140, 220), 0);
    lv_obj_set_style_text_font(keyLbl, &lv_font_montserrat_10, 0);
    lv_obj_align(keyLbl, LV_ALIGN_TOP_LEFT, 0, 0);

    // Value (truncate long strings)
    char valStr[200];
    if (kv.value().is<const char*>()) {
      strncpy(valStr, kv.value().as<const char*>(), sizeof(valStr) - 1);
    } else if (kv.value().is<float>()) {
      snprintf(valStr, sizeof(valStr), "%.4f", kv.value().as<float>());
    } else if (kv.value().is<int>()) {
      snprintf(valStr, sizeof(valStr), "%d", kv.value().as<int>());
    } else if (kv.value().is<bool>()) {
      snprintf(valStr, sizeof(valStr), "%s", kv.value().as<bool>() ? "true" : "false");
    } else {
      serializeJson(kv.value(), valStr, sizeof(valStr));
    }
    valStr[sizeof(valStr) - 1] = '\0';

    lv_obj_t* valLbl = lv_label_create(row);
    lv_label_set_text(valLbl, valStr);
    lv_label_set_long_mode(valLbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(valLbl, 290);
    lv_obj_set_style_text_color(valLbl, lv_color_make(220, 225, 255), 0);
    lv_obj_align(valLbl, LV_ALIGN_TOP_LEFT, 0, 14);
  }

  lv_scr_load(screenResult);
}

// ─────────────────────────────────────────────
// WiFi connect with retry
// ─────────────────────────────────────────────
void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    attempts++;
  }
}

// ─────────────────────────────────────────────
// LVGL tick (call every 1ms via timer)
// ─────────────────────────────────────────────
static void IRAM_ATTR lvglTickInc(void*) {
  lv_tick_inc(1);
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // Display init
  tft.init();
  tft.setRotation(0);  // portrait 320x480
  tft.fillScreen(TFT_BLACK);

  // Touch init
  touch.begin();
  touch.setRotation(0);

  // LVGL init
  lv_init();
  lv_disp_draw_buf_init(&drawBuf, buf1, nullptr, 320 * LV_BUF_LINES);

  static lv_disp_drv_t dispDrv;
  lv_disp_drv_init(&dispDrv);
  dispDrv.hor_res = 320;
  dispDrv.ver_res = 480;
  dispDrv.flush_cb = lvglFlush;
  dispDrv.draw_buf = &drawBuf;
  lv_disp_drv_register(&dispDrv);

  static lv_indev_drv_t indevDrv;
  lv_indev_drv_init(&indevDrv);
  indevDrv.type = LV_INDEV_TYPE_POINTER;
  indevDrv.read_cb = lvglReadTouch;
  lv_indev_drv_register(&indevDrv);

  // 1ms tick via ESP32 timer
  esp_timer_handle_t tickTimer;
  esp_timer_create_args_t args = { .callback = lvglTickInc, .name = "lvgl_tick" };
  esp_timer_create(&args, &tickTimer);
  esp_timer_start_periodic(tickTimer, 1000);

  // WiFi
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE);
  tft.drawString("Connecting WiFi...", 10, 20, 2);
  connectWiFi();

  // Show main UI
  showMain();
}

// ─────────────────────────────────────────────
// Loop
// ─────────────────────────────────────────────
void loop() {
  lv_timer_handler();
  delay(5);
}
