# $BLUEAGENT on Robinhood — Virtuals launch kit

Everything you need to paste into `app.virtuals.io` at T-day, plus the
supporting content for the announcement window. Written to be copy-pasted;
don't rewrite unless you deliberately want to change the tone.

Two chain surfaces to keep straight — same name, two contracts:

- **Base — $BLUEAGENT** (`0xf895…6ba3`) — utility token for x402 payments
  and staked credits. **Not affected by this launch.**
- **Robinhood — $BLUEAGENT** (address TBD at curve creation) — new
  Virtuals-launched agent-economy token. Separate contract, separate
  supply, same name. This is what we're shipping.

Reference doc for holders: `/docs/blueagent-on-robinhood`.
Public announce page: `/blueagent-on-robinhood`.

---

## 1. Agent metadata (paste into the Virtuals form)

The Virtuals form expects an agent identity, not just a token. Fill each
field with the block below.

### Name
```
BlueAgent
```

### Ticker
```
BLUEAGENT
```

### One-line tagline (≤80 chars)
```
The AI copilot for Base builders — now on Robinhood via Virtuals.
```

### Short description (≤280 chars — Twitter-style)
```
BlueAgent is the AI copilot for Base builders. Runs inside Claude Desktop,
Cursor & Claude Code. Ships an x402 tool catalog + MCP surface. Base
$BLUEAGENT stays the utility unit; Robinhood $BLUEAGENT is the
agent-economy leg. Two tokens, one name.
```

### Full bio (long description — Virtuals typically renders this as markdown)
```
BlueAgent is a builder's copilot for Base — an AI agent + tool surface that
takes a founder from idea → build → audit → ship → raise without leaving
their IDE. It runs as an MCP server (Claude Desktop, Cursor, Claude Code),
an x402 tool catalog (pay-per-call USDC on Base), and a chat surface at
blueagent.dev.

Today BlueAgent already ships:
· 74 live x402 tools across research, safety, DeFi, launchpad, and DD
· A hosted MCP server at blueagent.dev/api/mcp (57 curated tools)
· B20HUB — a Uniswap V4 launchpad for real B20 tokens on Base, with a
  built-in Base $BLUEAGENT buyback flywheel
· /app/launches — a unified market feed for Base + Robinhood-chain
  Virtuals launches, updated live
· Robinhood Chain in chat — swap live, bridge + send + token↔token swap
  shipping alongside this launch

Robinhood $BLUEAGENT is a NEW, INDEPENDENT token from Base $BLUEAGENT.
Same ticker, different contract, different chain, different job. Base
$BLUEAGENT (0xf895…6ba3) remains the internal utility unit — you spend it
on x402 tool calls and stake it for credits. Robinhood $BLUEAGENT is the
market-facing instrument: Virtuals bonding curve, 1B fixed supply, LP
locked 10 years at graduation, 1% swap fee (70% creator / 30% Virtuals
Treasury).

Post-graduation the plan is direct: route creator-share fees into
Robinhood $BLUEAGENT buybacks, connect the accrual to Base $BLUEAGENT
stakers, ship a token detail page on blueagent.dev, and treat holder
weight as a governance signal for product direction. No bridge between
the two tokens — they serve different jobs on purpose. Full docs:
blueagent.dev/docs/blueagent-on-robinhood.
```

### Category / tags
Pick these on the form if the taxonomy allows:
```
Category: Agent / Developer Tools
Tags: base, mcp, x402, ai-copilot, builder-tools, launchpad, robinhood-chain
```

### Purpose (some forms label this "what does the agent do")
```
Automates the full Base builder loop — idea shaping, architecture, security
audit, deploy checklist, fundraise narrative — and exposes it as MCP tools
+ x402 paid endpoints so any AI client can call BlueAgent as a service.
Now expanding chat with Robinhood Chain skills: bridge, send, and swap.
```

### Persona
```
Builder's copilot for Base. Terse, technical, ships more than it talks.
Optimizes for the developer who is trying to actually launch, not the
speculator who just wants a chart.
```

### Website / links
```
Website:  https://blueagent.dev
Docs:     https://blueagent.dev/docs/blueagent-on-robinhood
Landing:  https://blueagent.dev/blueagent-on-robinhood
Twitter:  https://x.com/blueagent_
Telegram: https://t.me/blueagent_hub
```

### Image / avatar

Use the existing BlueAgent mark — the blue "BA" tile. If the form asks for
a square PNG, export from the mark used in the Navbar (`#4FC3F7` on
`#050508`, rounded corner). If it asks for a hero banner:

Prompt for the banner (content only — house design system supplies style):
```
Wordmark "$BLUEAGENT" in a large, mono, bold display face, left-aligned.
Under it in small caps: "BlueAgent · via Virtuals · Robinhood Chain".
Right side: a schematic diagram — two circles both labeled "$BLUEAGENT",
one tinted Base blue (#0052FF) captioned "Base · 0xf895…6ba3", the other
tinted Robinhood green (#0AC18E) captioned "Robinhood · new". Between
them a dashed vertical line labeled "same name · two contracts · no
bridge". Bottom-right micro chip: "1B supply · LP 🔒 10y · 1% fee".
```

---

## 2. Pre-launch checklist (do these BEFORE hitting submit on Virtuals)

- [ ] Deployer wallet on Robinhood Chain (chainId 4663) holds ≥ 105
      $VIRTUAL (100 entry + gas headroom).
- [ ] Deployer wallet is a fresh Blue-controlled address — not a shared
      hot wallet, not the Base $BLUEAGENT treasury (`0xB058…3b5F`).
- [ ] Landing page `/blueagent-on-robinhood` deployed on prod
      (blueagent.dev).
- [ ] Docs page `/docs/blueagent-on-robinhood` deployed on prod.
- [ ] Announce thread drafted on X (see § 4).
- [ ] `@blueagent_` bio + pinned post updated to reference the Robinhood
      leg (once T-day is set).
- [ ] Telegram community pinned message updated.
- [ ] `/app/launches` Robinhood tab visually spot-checked so people
      arriving from the announcement see something real.
- [ ] `hub_rh_send` shipped in Blue Chat (see task #81) — proves the RH
      chat surface is real before token launch.

## 3. T-day operational steps

1. Open `app.virtuals.io` → **Launch on Robinhood Chain**.
2. Connect the Blue-controlled deployer wallet.
3. Paste the metadata block from § 1 into the form fields.
4. Upload the avatar / banner.
5. Confirm 100 $VIRTUAL entry, sign the transaction.
6. **Copy the resulting Robinhood $BLUEAGENT contract address immediately.**
   Post it in three places within 60 seconds of confirmation:
   - Reply in the pre-drafted X announce thread.
   - Pin to `@blueagent_` timeline.
   - Post to `t.me/blueagent_hub`.
7. Update this repo:
   - `apps/web/src/app/blueagent-on-robinhood/page.tsx` → swap the
     `https://app.virtuals.io` stub in the Hero CTA for the real Virtuals
     agent URL, and replace the "TBD after launch" in the TokenCard for
     the real address.
   - Add a `BLUEAGENT_RH_ADDRESS` constant in `apps/web/src/lib/robinhood/`.
   - Wire the address into `RobinhoodSwapCard` token picker so users can
     buy/sell RH $BLUEAGENT via the existing swap surface.
8. Watch the curve. Do **not** buy from the deployer wallet — anti-sniper
   optics.

## 4. Announce copy (draft)

### X thread (T-minus, i.e. before Virtuals submit)

```
1/ We're launching a second $BLUEAGENT on Robinhood Chain via Virtuals.

Two tokens. One name. One agent.

Base $BLUEAGENT stays put. The new Robinhood $BLUEAGENT is a separate
contract on a fresh chain. Independent supplies, no bridge. ↓

2/ Why the split?

· Base $BLUEAGENT = the utility. You spend it on x402 tools, stake it
  for credits. Immutable, no mint.
· Robinhood $BLUEAGENT = the agent-economy. Virtuals bonding curve, 1B
  supply, LP locked 10 years, 1% swap fee.

Same name, different jobs.

3/ Why Virtuals?

Best distribution channel for agent tokens right now. Virtuals is native
on Robinhood Chain. Existing cohort — Project VEX, Clawbank — validates
the venue.

We plug straight in. No launchpad bootstrap required.

4/ Why not another launch on Base?

Base $BLUEAGENT already has a mature Uniswap V4 pool. Doubling up on
Base would fragment liquidity for zero distribution gain.

Robinhood is fresh territory + real Virtuals cohort. Different venue,
different job.

5/ Alongside the launch: Blue Chat gets new Robinhood Chain skills.

· Bridge any token Base ⇅ Robinhood (LayerZero, Clawbank-style card)
· Send any RH ERC-20 from chat
· Swap token↔token on RH (extending the existing card)

Operate on Robinhood without leaving the conversation.

6/ Post-grad plan (after 42K VIRTUAL):

· Route swap-fee revenue → Robinhood $BLUEAGENT buybacks
· Buyback accrual connects to Base $BLUEAGENT stakers
· Token detail page in /app/launches
· Governance-signal weight for product decisions

7/ Full docs (2-token model, mechanics, chat skills):
blueagent.dev/docs/blueagent-on-robinhood

Landing:
blueagent.dev/blueagent-on-robinhood

T-day + contract address drop in this thread.
Anything before that = not us.
```

### X reply (T-day, immediately after Virtuals submit)

```
Live.

Robinhood $BLUEAGENT — via Virtuals — is now trading.

Address: {PASTE_ADDRESS_HERE}
Virtuals: {PASTE_VIRTUALS_URL_HERE}

Independent from Base $BLUEAGENT (0xf895…6ba3). Same name, different
contract, different chain.

1B supply. 1% swap fee (70% creator / 30% Virtuals Treasury). Bonding
curve open. Graduation at 42K VIRTUAL.

Docs: blueagent.dev/docs/blueagent-on-robinhood
```

### Telegram pin

```
Robinhood $BLUEAGENT is live via Virtuals.

Address: {PASTE}
Virtuals: {PASTE}

Base $BLUEAGENT (0xf895…6ba3) is unchanged.
Robinhood $BLUEAGENT is a NEW, INDEPENDENT token — same ticker, different
contract, different chain, different job. There is NO bridge between the
two.

Full docs: blueagent.dev/docs/blueagent-on-robinhood
Scam check: any Robinhood $BLUEAGENT address that isn't the one above is
fake.
```

## 5. Post-graduation follow-up (blocks until 42K VIRTUAL raised)

- [ ] Deploy a Robinhood-side buyback contract (equivalent to the Base
      `BlueBuyBack` used by B20HUB) — routes creator-share fees into
      Robinhood $BLUEAGENT buybacks.
- [ ] Wire the buyback contract into the Virtuals fee-claim flow.
- [ ] Add Robinhood $BLUEAGENT to `apps/web/src/app/api/blue-stream` so
      it lights up in the Robinhood tab of `/app/launches`.
- [ ] Ship `/app/launches/robinhood/blueagent` — dedicated token detail
      page.
- [ ] Update Navbar so Robinhood $BLUEAGENT shows a live price ticker
      alongside the Base $BLUEAGENT tile.
- [ ] Discuss holder perks in the console (e.g. discounted x402 credits
      for RH $BLUEAGENT + Base $BLUEAGENT dual-holders) — case-by-case,
      no promises.

## 6. Things not to do

- Do not swap or wrap Base $BLUEAGENT for Robinhood $BLUEAGENT. They're
  independent contracts — attempting to bridge one to the other via a
  generic bridge just gives you a wrapped Base $BLUEAGENT on Robinhood
  Chain, which has zero economic weight there.
- Do not build a bridge between the two $BLUEAGENT tokens themselves.
  `hub_rh_bridge` bridges OTHER tokens (USDC, ETH, VIRTUAL, VEX), not
  $BLUEAGENT.
- Do not seed Robinhood $BLUEAGENT liquidity from the treasury. Let the
  curve fill organically — that's the whole point of Virtuals.
- Do not pre-share the contract address to any private channel.
- Do not deploy from `main`. Update `apps/web` on `dev` → PR → merge
  only after the Vercel preview is green.

---

_Last updated: matches the state of `/blueagent-on-robinhood` and
`/docs/blueagent-on-robinhood` on `dev` at the time of writing. If those
pages change, this doc probably needs to change too._
