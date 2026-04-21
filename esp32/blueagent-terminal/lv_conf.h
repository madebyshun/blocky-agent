#if 1  /* Set this to "1" to enable content */

#ifndef LV_CONF_H
#define LV_CONF_H

#include <stdint.h>

/* Color depth: 1 (1 byte per pixel), 8, 16, 32 */
#define LV_COLOR_DEPTH 16

/* Swap 2 bytes of RGB565 color — needed for ILI9488 over SPI */
#define LV_COLOR_16_SWAP 1

/* Memory */
#define LV_MEM_CUSTOM 0
#define LV_MEM_SIZE (48U * 1024U)  /* 48KB heap for LVGL */

/* HAL */
#define LV_TICK_CUSTOM 0
#define LV_DPI_DEF 130

/* Display resolution */
#define LV_HOR_RES_MAX 480
#define LV_VER_RES_MAX 320

/* Logging */
#define LV_USE_LOG 0

/* Asserts */
#define LV_USE_ASSERT_NULL          1
#define LV_USE_ASSERT_MALLOC        1
#define LV_USE_ASSERT_STYLE         0
#define LV_USE_ASSERT_MEM_INTEGRITY 0
#define LV_USE_ASSERT_OBJ           0

/* ── Fonts ── */
#define LV_FONT_MONTSERRAT_10  1
#define LV_FONT_MONTSERRAT_12  1
#define LV_FONT_MONTSERRAT_14  1
#define LV_FONT_MONTSERRAT_16  1
#define LV_FONT_MONTSERRAT_18  0
#define LV_FONT_MONTSERRAT_20  0
#define LV_FONT_MONTSERRAT_22  0
#define LV_FONT_MONTSERRAT_24  0
#define LV_FONT_MONTSERRAT_26  0
#define LV_FONT_MONTSERRAT_28  0
#define LV_FONT_DEFAULT &lv_font_montserrat_14

/* ── Widgets ── */
#define LV_USE_ARC         1
#define LV_USE_BAR         1
#define LV_USE_BTN         1
#define LV_USE_BTNMATRIX   0
#define LV_USE_CANVAS      0
#define LV_USE_CHECKBOX    0
#define LV_USE_DROPDOWN    1
#define LV_USE_IMG         0
#define LV_USE_LABEL       1
#define   LV_LABEL_TEXT_SELECTION 0
#define   LV_LABEL_LONG_TXT_HINT  0
#define LV_USE_LINE        0
#define LV_USE_ROLLER      0
#define LV_USE_SLIDER      0
#define LV_USE_SWITCH      0
#define LV_USE_TEXTAREA    1
#define   LV_TEXTAREA_DEF_PWD_SHOW_TIME 1500
#define LV_USE_TABLE       0

/* ── Extra Widgets ── */
#define LV_USE_ANIMIMG     0
#define LV_USE_CALENDAR    0
#define LV_USE_CHART       0
#define LV_USE_COLORWHEEL  0
#define LV_USE_IMGBTN      0
#define LV_USE_KEYBOARD    1
#define LV_USE_LED         0
#define LV_USE_LIST        1
#define LV_USE_MENU        0
#define LV_USE_METER       0
#define LV_USE_MSGBOX      0
#define LV_USE_SPAN        0
#define LV_USE_SPINBOX     0
#define LV_USE_SPINNER     1
#define LV_USE_TABVIEW     1
#define LV_USE_TILEVIEW    0
#define LV_USE_WIN         0

/* ── Layouts ── */
#define LV_USE_FLEX  1
#define LV_USE_GRID  0

/* ── Misc ── */
#define LV_USE_MONKEY        0
#define LV_USE_GRIDNAV       0
#define LV_USE_FRAGMENT      0
#define LV_USE_IMGFONT       0
#define LV_USE_MSG           0
#define LV_USE_SNAPSHOT      0

#endif /* LV_CONF_H */
#endif /* End of "Content enable" */
