# Design System

Source of truth for Blue Agent's visual design. Derived from `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`, and all components in `apps/web/src/components/`. Reference repo: `madebyshun/blueagent-web@claude/blueagent-landing-page-I2Jx5`.

---

## Color palette

Always dark. No light mode.

| Token | Hex | CSS var / Tailwind | Use |
|---|---|---|---|
| Background | `#050508` | `--bg` / `bg-bg` | Page background |
| Surface | `#0D0D14` | `--surface` / `bg-surface` | Cards, panels |
| Border | `#1A1A2E` | `--border` / `border-[#1A1A2E]` | All borders |
| Blue (primary) | `#4FC3F7` | `--blue` / `text-[#4FC3F7]` | CTAs, highlights, accents |
| Blue (hover) | `#29ABE2` | `hover:bg-[#29ABE2]` | Button hover state |
| Purple (accent) | `#A78BFA` | `--purple` / `text-[#A78BFA]` | Secondary accent, "SOON" badges |
| Text primary | `#E2E8F0` | `text-slate-200` (body default) | Body text |
| Text secondary | `#94A3B8` | `text-slate-400` | Descriptions, labels |
| Text muted | `#64748B` | `text-slate-500` / `text-slate-600` | Timestamps, hints |
| Emerald (live/success) | `#34D399` | `text-emerald-400` | Live badges, success states |
| Red (error) | `#F87171` | `text-red-400` | Error messages |

### CSS variables (`:root`)

```css
--bg:      #050508
--blue:    #4FC3F7
--purple:  #A78BFA
--surface: #0D0D14
--border:  #1A1A2E
```

---

## Theme system

Always dark. `ThemeProvider` is a no-op stub — always returns `{ theme: "dark" }`. No `data-theme`, no `localStorage`.

---

## Typography

| Font | Use | Tailwind class |
|---|---|---|
| Inter | All UI text — labels, nav, buttons, body | `font-sans` (default body) |
| JetBrains Mono | Commands, addresses, terminal text, badges | `font-mono` |

**Rule:** `font-mono` is used for virtually all visible UI text (buttons, nav links, labels, stats, command names). Inter is the body fallback for longer prose paragraphs. When in doubt, use `font-mono`.

Weights: 400, 500, 600, 700 (bold headings via `font-bold`).

---

## Background patterns

Defined in `tailwind.config.ts` as `backgroundImage` extensions:

| Class | Effect |
|---|---|
| `bg-grid-pattern` | Subtle blue dot-grid, 40×40px intervals |
| `bg-hero-glow` | Radial cyan glow from top center |
| `bg-blue-glow` | Centered radial blue glow (CTA sections) |
| `bg-purple-glow` | Centered radial purple glow |

Grid pattern usage:
```tsx
<div className="absolute inset-0 bg-grid-pattern" style={{ backgroundSize: "40px 40px" }} />
<div className="absolute inset-0 bg-hero-glow" />
```

---

## Utility classes (globals.css)

| Class | Effect |
|---|---|
| `.text-gradient-blue` | Blue→purple gradient text (`#4FC3F7 → #A78BFA`) |
| `.text-gradient-white` | White→faded-white gradient text |
| `.border-glow-blue` | Blue border + outer/inner box-shadow glow |
| `.border-glow-purple` | Purple border + outer/inner box-shadow glow |
| `.card-surface` | `bg: rgba(13,13,20,0.8) · border: #1A1A2E · backdrop-blur-xl` |
| `.card-hover` | Hover lift: `translateY(-2px)` + blue border glow on hover |
| `.glow-dot` | 8px filled blue circle (`#4FC3F7`) with radial glow |

---

## Components

### `Navbar`

Fixed top bar. `z-50`, `backdrop-blur-xl`, `border-b border-[#1A1A2E]`.

```tsx
<Navbar />
// No props. Reads pathname for active state. Links: /code /chat /launch /market /rewards
```

- Logo: `BLUE` in white + `AGENT` in `#4FC3F7`, `font-mono tracking-widest`
- Active nav link: `text-[#4FC3F7] bg-[#4FC3F7]/10`
- Inactive: `text-slate-400 hover:text-white`
- CTA button: `bg-[#4FC3F7] text-[#050508] font-mono font-semibold` → "Open Console"
- Mobile: hamburger toggle with slide-down menu

---

### `HeroSection`

Full-height hero with grid background, animated orbs, 2-column layout, animated chat mockup.

```tsx
<HeroSection />
// No props. Fetches $BLUEAGENT price live from GeckoTerminal every 30s.
```

Chat bubble styles:
- User message: `bg-[#4FC3F7] text-[#050508] rounded-br-sm`
- Agent message: `bg-[#1A1A2E] text-slate-300 border border-[#2A2A4E] rounded-bl-sm`

Stats bar: 4 stat tiles using `.card-surface rounded-xl p-4`.

---

### `FeaturesSection`

3-column grid of command cards. Uses `.card-surface .card-hover`.

```tsx
<FeaturesSection />
// No props. Static data — 6 feature cards.
```

Command badge:
```tsx
<div className="font-mono text-[10px] text-[#4FC3F7] tracking-widest px-2 py-1 bg-[#4FC3F7]/5 border border-[#4FC3F7]/20 rounded">
  blue idea
</div>
```

---

### `HowItWorksSection`

3-step flow cards + artifacts table.

```tsx
<HowItWorksSection />
// No props. Steps: idea → build → ship.
```

Step number badge: `w-10 h-10 rounded-xl bg-[#4FC3F7]/10 border border-[#4FC3F7]/30 text-[#4FC3F7] font-mono font-bold`

---

### `TokenSection`

$BLUEAGENT token card with copy-to-clipboard address, payment rails, external links.

```tsx
<TokenSection />
// No props. Hardcoded token: 0xf895783b2931c919955e18b5e3343e7c7c456ba3
```

---

### `ComingSoonSection`

3-column product cards. Live badge = emerald, Soon badge = purple.

```tsx
<ComingSoonSection />
// No props. Static data.
```

Badge styles:
- Live: `text-emerald-400 bg-emerald-400/5 border-emerald-400/20`
- Soon: `text-[#A78BFA] bg-[#A78BFA]/5 border-[#A78BFA]/20`

---

### `FooterCTA`

Full-width CTA section with blue glow background.

```tsx
<FooterCTA />
// No props.
```

---

### `Footer`

Minimal bottom bar with logo, nav links, X icon, tagline.

```tsx
<Footer />
// No props.
```

---

### `ToolRunner`

x402 pay-per-use tool runner. Handles 402 payment flow: call → sign → pay → result.

```tsx
<ToolRunner toolId="risk-gate" price="0.05" />
// toolId: key from TOOL_SCHEMAS in packages/core/src/tool-inputs.ts
// price: display string in USDC
```

States: `idle | calling | signing | paying | done | error`

Input field:
```tsx
className="w-full bg-[#050508] border border-[#1A1A2E] rounded-lg px-3 py-2 font-mono text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#4FC3F7]/40"
```

Primary button: `bg-[#4FC3F7] hover:bg-[#29ABE2] text-[#050508] font-mono font-semibold`

Result: `<pre>` in `bg-[#050508] border-[#1A1A2E] rounded-xl font-mono text-xs text-slate-300`

---

### `ThemeProvider`

No-op stub. Always dark.

```tsx
<ThemeProvider>{children}</ThemeProvider>
// useTheme() → { theme: "dark", toggle: () => {} }
```

---

## Animations

| Class | Description |
|---|---|
| `animate-pulse-slow` | 4s slow pulse (background orbs) |
| `animate-fade-up` | 0.6s fade + slide up |
| `animate-scan-line` | 3s vertical scan (terminal aesthetic) |
| `animate-spin` | Spinner in ToolRunner |
| `animate-pulse` | Live status dots |

---

## Design rules

1. **Dark only.** Never add light mode. No `dark:` variants needed.
2. **`font-mono` for UI, Inter for prose.** Nav, buttons, badges, labels, commands → `font-mono`. Long paragraphs → default Inter.
3. **`#4FC3F7` is the primary action color.** Purple `#A78BFA` is secondary/upcoming only.
4. **Primary button:** `bg-[#4FC3F7] hover:bg-[#29ABE2] text-[#050508]` — dark text on cyan fill.
5. **Ghost button:** `border border-[#1A1A2E] hover:border-[#4FC3F7]/30 text-slate-400 hover:text-white` — no fill.
6. **Card pattern:** `.card-surface rounded-2xl p-6` + `.card-hover` for interactive cards.
7. **Glow shadows** only on primary CTAs and hover states. Not on plain cards.
8. **Border radius:** `rounded-lg` (8px) inputs/buttons, `rounded-xl` (12px) chips, `rounded-2xl` (16px) cards, `rounded-full` pills.
9. **Max widths:** `max-w-7xl` nav/footer, `max-w-5xl` content sections, `max-w-6xl` hero.
10. **No colored left-border accents.** Borders are uniform (`#1A1A2E`) or glow variants.

---

## Tone

Terminal-inspired, minimal, Linear-grade precision. Monospace text throughout the UI. Sharp dark surfaces, cyan accents, subtle purple for depth. No rounded bubbly elements — everything earns its place. Builder aesthetic: looks like a tool you'd use at 2am to ship something real.
