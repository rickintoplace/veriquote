#!/usr/bin/env node
// Thin process wrapper; the command logic lives in src/cli/main.ts.
import { readFile } from 'node:fs/promises';
import { main } from '../dist/cli/main.js';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readFile: (path) => readFile(path, 'utf8'),
  readStdin,
  version: pkg.version,
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});
