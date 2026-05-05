# Blue Agent

Blue Agent is the Base-native founder console for builders on Bankr.

It is not a Telegram bot anymore.
It is a workflow-first console for thinking, building, auditing, shipping, and launching on Base.

## Product surfaces

- `/code` — founder console for `blue idea`, `blue build`, `blue audit`, `blue ship`, `blue raise`
- `/chat` — model picker + paid compute
- `/launch` — launch wizard for agents
- `/market` — marketplace for agents, prompts, and skills
- `/rewards` — points, credits, and loyalty

## What it does

- turns rough ideas into fundable briefs
- turns briefs into build plans
- reviews plans for risks
- prepares launch and deployment checklists
- lets builders pick Bankr models and pay with credits or USDC
- sets up agent launches and future marketplace monetization

## Workspace layout

- `apps/web` — Next.js app
- `apps/api` — x402 services
- `packages/core` — shared command schemas + pricing
- `packages/payments` — x402 helpers
- `packages/bankr` — Bankr LLM client
- `agents/blue-agent` — agent runtime config and tasks
- `commands/` — command contracts
- `docs/` — product brief and roadmap

## Core workflow

- `blue idea`
- `blue build`
- `blue audit`
- `blue ship`
- `blue raise`

## Later layers

- chat with model picker
- credits / USDC payments
- agent launch + publish
- marketplace monetization

## Repo rule

This repo is the single source of truth for Blue Agent.
Keep business logic in shared packages. Keep UI thin.
