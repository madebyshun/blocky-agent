# Model provider marks

Rendered by `ProviderMark` (`src/app/chat/components/ProviderMark.tsx`). The filename
is the provider slug from `src/lib/model-providers.ts`, so adding a mark is: drop
`<slug>.svg` here and flip `mark: true` on that provider. No other code changes.

## Where these came from

Extracted from [simple-icons](https://github.com/simple-icons/simple-icons) v16.29.0,
which is **CC0-1.0** (public domain). Not hand-drawn, not traced. The package is not a
dependency of this repo — the SVGs are generated once and committed.

Each file is the icon's single official path at `viewBox="0 0 24 24"`, with the fill
baked in rather than `currentColor` so it renders correctly through an `<img>` tag.

Marks whose brand colour is too dark to read on the app background (`#050508`) are
lifted toward white — Anthropic `#191919`, Z.ai `#2D2D2D` and Moonshot `#000000`
would otherwise be invisible. `anthropic.svg` uses simple-icons' **Claude** mark, not
its Anthropic corporate mark: every Anthropic row in the catalog is a Claude model, and
the Claude mark carries the recognisable clay colour.

## Deliberately absent

simple-icons ships no **OpenAI** or **xAI** mark, and there is none for **Venice**,
**AION Labs**, **Nous Research** or **Inception**. Those providers render a monogram
instead. Approximating a company's logo by hand would put an inaccurate mark next to a
real model, which is a claim about provenance we cannot support — the monogram says
"no mark on file" rather than guessing.

## Regenerating

```sh
npm i simple-icons@16 --no-save   # or install into a scratch dir
node -e '...'                     # map provider slug -> simple-icons slug, write path + fill
```

The provider→icon mapping is: `anthropic→claude`, `google→googlegemini`,
`deepseek→deepseek`, `zai→zdotai`, `qwen→qwen`, `moonshot→moonshotai`,
`minimax→minimax`, `meta→meta`, `mistral→mistralai`, `nvidia→nvidia`,
`bytedance→bytedance`, `xiaomi→xiaomi`.
