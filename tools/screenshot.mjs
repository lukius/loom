#!/usr/bin/env node
// Capture a screenshot of the SPA canvas (or any selector) for the docs.
//
// Requires a running server (default http://127.0.0.1:8000) and the system
// Chromium that Playwright already uses for e2e tests. No browser download.
//
// Usage:
//   node tools/screenshot.mjs <output.png> [options]
//   npm run screenshot -- <output.png> [options]
//
// Options:
//   --url=URL              Base URL of the running SPA (default http://127.0.0.1:8000)
//   --viewport=WxH         Browser viewport (default 1400x900)
//   --selector=CSS         What to clip to (default #canvas — the SVG only)
//   --delay=MS             Pause before capture so animations settle (default 800)
//   --load-yaml=PATH       Read the YAML at PATH and import it into the SPA
//                          before capturing (overrides whatever is in localStorage).
//   --exec-file=PATH       Read the JS at PATH and run it in the page context
//                          after --load-yaml and before capture. Use to script
//                          a scenario (start sim, select a node, run a command).
//                          The file body is wrapped in an async function — use
//                          top-level `await` freely. Has access to dynamic
//                          import() of the SPA's modules (e.g. await import('/sim.js')).
//   --help                 Show this message.
//
// The --load-yaml flow drives the same import path the Reset toolbar button
// uses, so anything the user could load by reset is loadable here.
// Scenario scripts live under tools/scenarios/ by convention.
import { chromium } from '@playwright/test';
import fs from 'fs';

function parseArgs(argv) {
  const opts = { positional: [] };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const v = eq === -1 ? true : a.slice(eq + 1);
      opts[k] = v;
    } else {
      opts.positional.push(a);
    }
  }
  return opts;
}

function parseViewport(s) {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) throw new Error(`viewport must look like 1400x900, got ${JSON.stringify(s)}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.positional.length === 0) {
  console.log(`Usage: node tools/screenshot.mjs <output.png> [--url=...] [--viewport=WxH] [--selector=#canvas] [--delay=800] [--load-yaml=path] [--exec-file=path]`);
  process.exit(args.help ? 0 : 1);
}

const out = args.positional[0];
const url = args.url || 'http://127.0.0.1:8000';
const viewport = parseViewport(args.viewport || '1400x900');
const selector = args.selector || '#canvas';
const delay = Number(args.delay || 800);
const loadYamlPath = args['load-yaml'];
const execFilePath = args['exec-file'];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(url);

  if (loadYamlPath) {
    const yaml = fs.readFileSync(loadYamlPath, 'utf8');
    // Wait until the SPA's init() ran (it creates the canvas node).
    await page.waitForSelector('#canvas', { timeout: 5000 });
    // Drive the same import path as the Reset toolbar — the listener lives
    // in app.js and calls importYaml(). The bus is the `bus` export from
    // /state.js; the SPA's modules are cached so importing again returns
    // the same instance.
    await page.evaluate(async (yamlText) => {
      const { bus } = await import('/state.js');
      bus.dispatchEvent(new CustomEvent('sim:topology-import-requested', {
        detail: { yaml: yamlText },
      }));
    }, yaml);
    // Let importYaml + renderAll + fitView settle.
    await page.waitForTimeout(500);
  }

  if (execFilePath) {
    const code = fs.readFileSync(execFilePath, 'utf8');
    // Run the scenario body in the page context. The Function constructor
    // wraps it in an async IIFE so the file can use top-level await and
    // import('/state.js') etc. Errors propagate out of evaluate.
    await page.evaluate(async (src) => {
      // eslint-disable-next-line no-new-func
      const run = new Function('return (async () => {\n' + src + '\n})()');
      await run();
    }, code);
  }

  await page.waitForSelector(selector, { timeout: 5000 });
  await page.waitForTimeout(delay);
  await page.locator(selector).screenshot({ path: out });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
