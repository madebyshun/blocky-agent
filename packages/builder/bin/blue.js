#!/usr/bin/env node
"use strict";

// Entry point for the `blue` CLI command.
// After `tsc`, this loads dist/cli.js. During dev, run: node -r ts-node/register src/cli.ts

const path = require("path");

// Support both compiled (dist/) and ts-node dev mode
let cli;
try {
  cli = require(path.join(__dirname, "../dist/cli.js"));
} catch {
  // ts-node fallback for development
  try {
    require("ts-node").register({ transpileOnly: true });
    cli = require(path.join(__dirname, "../src/cli.ts"));
  } catch {
    console.error("Error: run `npm run build` in packages/builder first, or install ts-node for dev mode.");
    process.exit(1);
  }
}
