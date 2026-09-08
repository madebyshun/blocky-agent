# Stock company marks

Rendered by `StockMark` (`src/components/blue-hood/StockMark.tsx`) on the Blue Hood
desk. The filename is the slug in the `MARKS` table in
`src/lib/blue-hood/stock-logo.ts`, so adding a mark is: drop `<slug>.svg` here and add
a `"<chain>:<TICKER>"` entry pointing at it. `scripts/hood-logo-check.ts` fails if a
slug has no file, or a file has no slug.

## The key is chain-qualified, and that is the whole point

`MARKS` is keyed `"base:NVDA"` / `"robinhood:NVDA"`, never `"NVDA"`. A logo is an
assertion about identity, and a ticker does not identify a token — chain + address
does. MEASURED against the live registries on 2026-09-09: RH lists 181 stocks, Base
lists 8, and all 8 are dual-listed, so a bare-ticker resolver would paint a real
company's mark onto **173 tickers the Base desk has never verified**. Both numbers
move on every admission and nothing checks this paragraph — re-measure, don't quote.
That is the same posture that let a
counterfeit TSLAc — identical `symbol`, identical `name`, `isB20() == false` — look
legitimate (#280). This is the sixth bug in that family and the most persuasive one,
because a rendered mark *looks* like the result of a lookup.

Note this is deliberately **not** `rowKey`, which returns a bare ticker for robinhood
to keep legacy KV keys resolving. Reusing it here would bare-ticker half the table.

The module holds **neither registry**. `chain-token.ts` is the one file in
`lib/blue-hood` allowed to import both (asserted by `hood-chain-token-check`), so the
lookup goes through it. `listed` is gated on `isChainTicker` — the exact, uppercase,
per-chain allow-list — *before* the label is read, because `resolveChainToken` runs
`findByTicker` on RH and that also matches company **names**: `findByTicker("Micro")`
returns AMD, not Micron. Gate first, label second; the guard feeds it all 196 registry
names and 165 name-prefixes and requires every one back as unlisted.

## Where these came from

Extracted from [simple-icons](https://github.com/simple-icons/simple-icons) v16.30.0,
which is **CC0-1.0** (public domain). Not hand-drawn, not traced. The package is not a
dependency of this repo — the SVGs are generated once and committed. They are served
from `public/`, never hotlinked from a third-party CDN: a CDN that changes or dies
turns a logo into nothing, or into something else.

Each file is the icon's single official path at `viewBox="0 0 24 24"`, with the fill
baked in rather than `currentColor` so it renders correctly through an `<img>` tag.

### Colour

The app background is `#050508`, so a mark below a readability floor is invisible
rather than subtle. Rule, applied by script rather than by eye:

- Relative luminance (WCAG) floor **0.25**. That number is not invented — it is the
  luminance of the darkest mark `public/models/` already ships (deepseek `#5786FE`,
  L = 0.262), so the two icon sets agree on what "too dark" means.
- Below the floor, blend toward white in 5% steps until it is met.
- **Achromatic** brands (channel spread < 16) go straight to white instead. Blending
  pure black only to the floor yields a muddy grey — and two different black brands
  land on the *same* grey, which reads as one mark. `public/models/` already does this
  (moonshot `#000000` → `#FFFFFF`).
- `meta` and `nvidia` are **pinned** to the accents `model-providers.ts` already uses,
  so the desk and the models page never render two different blues for one company.

| slug | brand | L | rendered |
|---|---|---|---|
| apple | `#000000` | 0.000 | `#FFFFFF` (achromatic) |
| google | `#4285F4` | 0.245 | `#4B8BF5` |
| meta | `#0467DF` | 0.151 | `#6FA8ED` (pinned) |
| nvidia | `#76B900` | 0.385 | `#76B900` (pinned, above floor) |
| amd | `#ED1C24` | 0.190 | `#F2555B` |
| coinbase | `#0052FF` | 0.133 | `#4D86FF` |
| circle | `#8669AE` | 0.182 | `#9880BA` |
| intel | `#0071C5` | 0.158 | `#4095D4` |
| palantir | `#101113` | 0.006 | `#FFFFFF` (achromatic) |
| spacex | `#000000` | 0.000 | `#FFFFFF` (achromatic) |
| tesla | `#CC0000` | 0.128 | `#E06666` |

## Deliberately absent

These render a monogram — the ticker in a neutral tile, reading "no mark on file" —
rather than something drawn from memory. simple-icons v16.30.0 ships no mark for:

**AMZN** (Amazon) · **MSFT** (Microsoft) · **ORCL** (Oracle) · **MU** (Micron) ·
**SNDK** (SanDisk) · **CRWV** (CoreWeave) · **USAR** (USA Rare Earth) ·
**QQQ** / **SGOV** / **SLV** / **SPY** (Invesco, iShares, SPDR fund marks)

### Absent despite a *similar* icon existing — the near-match trap

- **MSTR.** Both registries name it "Strategy Inc.". simple-icons ships
  `siMicrostrategy`, sourced from microstrategy.com's press kit — the **retired**
  brand. A current mark for a former name is a claim about who this company is.
- **BABA.** Both registries name it "Alibaba Group". simple-icons ships only "Alibaba
  Cloud" and "Alibaba.com" — subsidiaries, not the group. This is the
  `isB20(StudentCoin) == true` shape exactly: an approximately-right attribute is not
  a substitute for the one you needed.

### Present via a documented substitution

- **GOOGL.** Registries name it "Alphabet Inc."; simple-icons has no Alphabet mark.
  The **Google** mark is used because Google is a current operating brand of that same
  entity. Same shape as `anthropic → claude` in `public/models/`.

The rule those three decisions share, stated once so it is not re-litigated case by
case: *the mark must belong to the entity our registry names — a current brand of that
entity is allowed, a retired name is not.* It admits GOOGL and rejects MSTR.

## Regenerating

```sh
npm i simple-icons@16 --no-save   # or install into a scratch dir
node -e '...'                     # slug -> simple-icons export; lift per the rule above; write path + fill
```

Slug → simple-icons export: `apple→siApple`, `google→siGoogle`, `meta→siMeta`,
`nvidia→siNvidia`, `amd→siAmd`, `coinbase→siCoinbase`, `circle→siCircle`,
`intel→siIntel`, `palantir→siPalantir`, `spacex→siSpacex`, `tesla→siTesla`.

The generator **throws** rather than falling back if an export is missing, so a
renamed upstream icon fails loudly instead of silently producing a blank mark.
