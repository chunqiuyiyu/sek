#!/usr/bin/env node

import { main } from '../lib/main.js';

main(process.argv, process.env).catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
