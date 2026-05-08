#!/usr/bin/env node
"use strict";

// Entry point for the `blue` CLI command.
// After `tsc`, this loads dist/cli.js. During dev, run: node -r ts-node/register src/cli.ts

const path = require("path");

require(path.join(__dirname, "../dist/cli.js"));
