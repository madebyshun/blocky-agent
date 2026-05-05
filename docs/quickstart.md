# Blue Agent Quickstart

## Install

```bash
cd blue-agent
npm install
```

## Run web app

```bash
npm run dev --workspace apps/web
```

## Build

```bash
npm run build --workspace apps/web
```

## Environment variables

Copy `.env.example` to `.env` and fill in:
- `BANKR_API_KEY`
- `BASESCAN_API_KEY`

## What to check

- `/code` for the founder console
- `/chat` for model picker mock
- `/launch` for launch wizard
- `/market` for marketplace skeleton
- `/rewards` for rewards loop
