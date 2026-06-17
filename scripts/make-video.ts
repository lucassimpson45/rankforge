#!/usr/bin/env tsx
/**
 * CLI entry for the long-form stickman explainer pipeline.
 *
 *   npm run longform -- --topic "why we procrastinate"
 *   npm run longform -- --topic "the spotlight effect" --minutes 10 --density 4
 *   npm run longform -- --topic "test" --placeholder-images   # free, no Gemini
 *
 * Flags:
 *   --topic <str>         (required) subject of the video
 *   --minutes <num>       target runtime, default 3
 *   --density <num>       avg seconds per scene, default 6
 *   --image-model <str>   default gemini-3.1-flash-image
 *   --script-model <str>  default claude-sonnet-4-6
 *   --placeholder-images  skip Gemini, synthesise free placeholder frames
 *   --no-captions         don't burn narration captions
 *   --no-music            don't mix the music bed
 */

import { readFile } from "fs/promises";
import path from "path";
import { runLongform, type LongformOptions } from "../src/lib/longform";

// Minimal .env loader (the Next app loads .env automatically; a standalone
// tsx process does not, so we read it ourselves).
async function loadEnv(): Promise<void> {
  const envPath = path.join(process.cwd(), ".env");
  const raw = await readFile(envPath, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  await loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const topic = typeof args.topic === "string" ? args.topic : "";
  if (!topic) {
    console.error('Error: --topic is required, e.g. --topic "why we procrastinate"');
    process.exit(1);
  }

  const opts: LongformOptions = {
    topic,
    targetMinutes: args.minutes ? Number(args.minutes) : 3,
    sceneDensity: args.density ? Number(args.density) : 6,
    scriptModel:
      typeof args["script-model"] === "string"
        ? (args["script-model"] as string)
        : (process.env.SCRIPT_MODEL?.trim() || "claude-sonnet-4-6"),
    imageModel:
      typeof args["image-model"] === "string"
        ? (args["image-model"] as string)
        : (process.env.IMAGE_MODEL?.trim() || "gemini-3.1-flash-image"),
    placeholderImages:
      args["placeholder-images"] === true || !process.env.GEMINI_API_KEY?.trim(),
    burnCaptions: args["no-captions"] !== true,
    withMusic: args["no-music"] !== true,
    log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
  };

  if (opts.placeholderImages && args["placeholder-images"] !== true) {
    console.log(
      "Note: GEMINI_API_KEY not set — falling back to free placeholder images. " +
        "Add the key to .env for real Nano Banana stickman art.",
    );
  }

  console.log(
    `\n▶ Long-form pipeline\n  topic:   ${opts.topic}\n  minutes: ${opts.targetMinutes}\n  density: ${opts.sceneDensity}s/scene\n  images:  ${opts.placeholderImages ? "placeholder (free)" : opts.imageModel}\n  script:  ${opts.scriptModel}\n`,
  );

  const t0 = Date.now();
  const { finalPath, scenesJsonPath, stats } = await runLongform(opts);
  const wall = Math.round((Date.now() - t0) / 100) / 10;

  console.log("\n──────────── DONE ────────────");
  console.log(`Final video : ${finalPath}`);
  console.log(`scenes.json : ${scenesJsonPath}`);
  console.log(`Wall time   : ${wall}s`);
  console.log("Stats       :", JSON.stringify(stats, null, 2));
}

main().catch((e) => {
  console.error("\nPipeline failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
