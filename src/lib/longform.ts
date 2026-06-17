/**
 * Long-form stickman explainer pipeline.
 *
 * Extends the rankforge short-form system. Reuses the same toolchain
 * (Anthropic + ElevenLabs + ffmpeg) but swaps the front end: instead of
 * "source footage -> detect segments", it goes "script (JSON beats) ->
 * image prompts -> Nano Banana images". Stages 1-3 write a single
 * `scenes.json`; stage 4 (assembly) consumes only scenes.json + audio + images.
 *
 * That data contract is the seam: the new front end and the ffmpeg back end
 * stay decoupled.
 */

import { mkdir, writeFile, readFile, copyFile, access, cp } from "fs/promises";
import { constants } from "fs";
import { createHash } from "crypto";
import path from "path";
import { spawn } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

/* ─────────────────────────── Data contract ──────────────────────────── */

export type Scene = {
  index: number;
  narration: string;
  image_prompt: string;
  audio_path?: string;
  image_path?: string;
  duration_sec?: number;
  /** true when the image stage fell back to a placeholder (no/failed API) */
  image_placeholder?: boolean;
  /** true when no voiceover could be synthesised (quota) — silent gap used */
  vo_missing?: boolean;
};

export type ScenesDoc = {
  topic: string;
  title: string;
  description: string;
  tags: string[];
  music_bed: string | null;
  scenes: Scene[];
};

export type LongformOptions = {
  topic: string;
  targetMinutes: number;
  /** avg seconds per scene; lower = more images, snappier */
  sceneDensity: number;
  scriptModel: string;
  imageModel: string;
  /** when true, skip the Gemini call and synthesise placeholder frames (free) */
  placeholderImages: boolean;
  burnCaptions: boolean;
  withMusic: boolean;
  log: (m: string) => void;
};

export type LongformResult = {
  finalPath: string;
  scenesJsonPath: string;
  stats: Stats;
};

export type Stats = {
  sceneCount: number;
  narrationWords: number;
  videoDurationSec: number;
  ttsCharsBilled: number;
  ttsCacheHits: number;
  ttsMissing: number;
  imagesGenerated: number;
  imagesFromCache: number;
  imagesFailed: number;
  timings: Record<string, number>;
};

/* ─────────────────────────── Paths & config ─────────────────────────── */

const WORK_ROOT = "/tmp/rankforge-longform";
const AUDIO_DIR = `${WORK_ROOT}/audio`;
const IMG_DIR = `${WORK_ROOT}/img`;
const CLIPS_DIR = `${WORK_ROOT}/clips`;
const WORK_ASSETS = `${WORK_ROOT}/assets`; // no-space copy so ffmpeg fontfile= is safe

const OUT_W = 1920;
const OUT_H = 1080;
const FPS = 30;

// Fixed style preamble prepended to every image prompt so all scenes match.
const STYLE_PREAMBLE =
  "minimalist hand-drawn black stick figure on a plain solid white background, " +
  "thick black marker lines, no color, generous negative space, simple consistent " +
  "art style, single clear focal subject, no text, no watermark, no signature. ";

function projectRoot(): string {
  return process.cwd();
}
function projectOutput(): string {
  return path.join(projectRoot(), "public", "output");
}
function projectAssets(): string {
  return path.join(projectRoot(), "public", "assets");
}
function voCacheDir(): string {
  return path.join(projectRoot(), ".vo-cache"); // shared with short pipeline
}
function imgCacheDir(): string {
  return path.join(projectRoot(), ".img-cache");
}
function scriptCacheDir(): string {
  return path.join(projectRoot(), ".script-cache");
}

const FONT = `${WORK_ASSETS}/fonts/Anton-Regular.ttf`;
const MUSIC_BED = `${WORK_ASSETS}/music/bed.mp3`;

/* ─────────────────────────── Small utilities ────────────────────────── */

async function ensureDirs(): Promise<void> {
  await Promise.all([
    mkdir(AUDIO_DIR, { recursive: true }),
    mkdir(IMG_DIR, { recursive: true }),
    mkdir(CLIPS_DIR, { recursive: true }),
    mkdir(WORK_ASSETS, { recursive: true }),
    mkdir(projectOutput(), { recursive: true }),
    mkdir(voCacheDir(), { recursive: true }),
    mkdir(imgCacheDir(), { recursive: true }),
    mkdir(scriptCacheDir(), { recursive: true }),
  ]);
  await cp(projectAssets(), WORK_ASSETS, { recursive: true }).catch(() => undefined);
}

function runCmd(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

function runCmdStdout(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function probeDuration(p: string): Promise<number> {
  const res = await runCmdStdout("ffprobe", [
    "-v",
    "quiet",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    p,
  ]);
  return parseFloat(res.stdout.trim()) || 0;
}

function extractJson<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : text.trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
    throw new Error("Could not parse JSON from model output.");
  }
}

/* ───────── drawtext escaping (mirrors short pipeline behaviour) ──────── */

function dtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\n/g, " ");
}

function wrapWords(s: string, maxChars: number): string[] {
  const words = clean(s).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ───────────────────────── Stage 1: script ──────────────────────────── */

async function generateScript(
  opts: LongformOptions,
  client: Anthropic,
): Promise<ScenesDoc> {
  const sceneCount = Math.max(
    4,
    Math.round((opts.targetMinutes * 60) / opts.sceneDensity),
  );
  // ~150 spoken words per minute.
  const targetWords = Math.round(opts.targetMinutes * 150);

  // Cache the script so re-runs reuse the exact narration — that keeps every
  // already-voiced scene a free ElevenLabs cache hit (and skips a Claude call).
  const scriptKey = createHash("sha1")
    .update(`${opts.scriptModel}|${opts.topic}|${opts.targetMinutes}|${opts.sceneDensity}`)
    .digest("hex")
    .slice(0, 16);
  const scriptCachePath = path.join(scriptCacheDir(), `${scriptKey}.json`);
  if (await fileExists(scriptCachePath)) {
    const cached = JSON.parse(await readFile(scriptCachePath, "utf8")) as ScenesDoc;
    opts.log(`Stage 1 (script): cache hit — reusing ${cached.scenes.length} scenes (no Claude call).`);
    cached.music_bed = opts.withMusic ? "assets/music/bed.mp3" : null;
    return cached;
  }

  opts.log(
    `Stage 1 (script): asking ${opts.scriptModel} for ~${sceneCount} scenes, ~${targetWords} words…`,
  );

  const prompt = `You are scripting a calm, insightful long-form psychology explainer video narrated over minimalist stick-figure drawings. Topic: "${opts.topic}".

Write a cohesive ~${opts.targetMinutes}-minute narration split into EXACTLY ${sceneCount} sequential scenes (~${targetWords} words of narration TOTAL across all scenes). Each scene is one beat of the story: a single spoken sentence or two, plus a description of the single still image shown while it is spoken.

Return ONLY valid JSON (no markdown, no commentary):
{
  "title": "<YouTube title, <=70 chars, intriguing, NO profanity>",
  "description": "<2-3 sentence YouTube description>",
  "tags": ["psychology", "...", "..."],
  "scenes": [
    {
      "narration": "<one or two spoken sentences for this beat>",
      "image_prompt": "<what the single still image depicts: ONE clear stick-figure scene. Describe subject, pose, and a few props. Do NOT mention art style, colors, or 'stick figure' — that is added automatically.>"
    }
  ]
}

Rules:
- EXACTLY ${sceneCount} scenes, in narrative order (hook -> development -> payoff/takeaway).
- Open with a strong relatable hook in scene 1. End with a satisfying takeaway.
- narration: natural spoken English, no stage directions, no emojis, no scene numbers.
- image_prompt: concrete and visual, ONE focal action per scene, easy to draw as a simple stick figure. Vary the scenes so the video isn't visually repetitive.
- Keep total narration close to ${targetWords} words so the video lands near ${opts.targetMinutes} minutes.`;

  const msg = await client.messages.create({
    model: opts.scriptModel,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

  const parsed = extractJson<{
    title?: string;
    description?: string;
    tags?: string[];
    scenes?: { narration?: string; image_prompt?: string }[];
  }>(text);

  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  if (rawScenes.length === 0) throw new Error("Script returned no scenes.");

  const scenes: Scene[] = rawScenes.map((s, i) => ({
    index: i + 1,
    narration: clean(String(s.narration ?? "")),
    image_prompt: clean(String(s.image_prompt ?? "")),
  }));

  const words = scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
  opts.log(`Stage 1 done: ${scenes.length} scenes, ${words} narration words.`);

  const doc: ScenesDoc = {
    topic: opts.topic,
    title: clean(String(parsed.title ?? opts.topic)),
    description: clean(String(parsed.description ?? "")),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => clean(String(t))) : [],
    music_bed: opts.withMusic ? "assets/music/bed.mp3" : null,
    scenes,
  };
  await writeFile(scriptCachePath, JSON.stringify(doc, null, 2)).catch(() => undefined);
  return doc;
}

/* ───────────────────── Stage 2: voiceover + durations ────────────────── */

async function ttsScene(
  text: string,
  outName: string,
  log: (m: string) => void,
): Promise<{ path: string; cached: boolean; chars: number }> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const voice = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!key || !voice) throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");

  const model = "eleven_multilingual_v2";
  const hash = createHash("sha1").update(`${voice}|${model}|${text}`).digest("hex").slice(0, 16);
  const cachePath = path.join(voCacheDir(), `${hash}.mp3`);
  const outPath = path.join(AUDIO_DIR, outName);

  if (await fileExists(cachePath)) {
    await copyFile(cachePath, outPath);
    return { path: outPath, cached: true, chars: text.length };
  }

  // ElevenLabs occasionally returns transient 429 "system_busy" / 5xx under
  // load. Retry with backoff so one blip doesn't sink a 30-scene run.
  const maxAttempts = 5;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 },
      }),
    });
    if (res.ok) break;
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const wait = Math.min(2000 * 2 ** (attempt - 1), 20000);
      log(`  ElevenLabs ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt}/${maxAttempts})…`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const body = res ? await res.text().catch(() => "") : "no response";
    throw new Error(`ElevenLabs error ${res?.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  await writeFile(cachePath, buf).catch(() => undefined);
  log(`  TTS scene "${text.slice(0, 40)}…" (${text.length} chars billed)`);
  return { path: outPath, cached: false, chars: text.length };
}

// Estimate spoken length from word count (~2.6 words/sec) for silent fallbacks.
function estimateNarrationSec(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(12, Math.max(1.8, words / 2.6 + 0.4));
}

async function makeSilentClip(durationSec: number, outPath: string): Promise<void> {
  const res = await runCmd("ffmpeg", [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    durationSec.toFixed(3),
    "-c:a",
    "libmp3lame",
    "-q:a",
    "9",
    outPath,
  ]);
  if (res.code !== 0) throw new Error(`silent clip failed: ${res.stderr.slice(-200)}`);
}

async function voiceoverStage(
  doc: ScenesDoc,
  log: (m: string) => void,
): Promise<{ chars: number; cacheHits: number; missing: number }> {
  log(`Stage 2 (voiceover): synthesising ${doc.scenes.length} narration clips…`);
  let chars = 0;
  let cacheHits = 0;
  let missing = 0;
  for (const scene of doc.scenes) {
    const outName = `scene_${String(scene.index).padStart(3, "0")}.mp3`;
    try {
      const { path: p, cached, chars: c } = await ttsScene(scene.narration, outName, log);
      scene.audio_path = p;
      scene.duration_sec = Math.round((await probeDuration(p)) * 100) / 100;
      if (cached) cacheHits++;
      else chars += c;
    } catch (e) {
      // Out of credits / hard failure: insert a silent gap so the run still
      // completes. The scene's image + caption still show for its estimated length.
      const m = e instanceof Error ? e.message : String(e);
      const dur = estimateNarrationSec(scene.narration);
      const p = path.join(AUDIO_DIR, outName);
      await makeSilentClip(dur, p);
      scene.audio_path = p;
      scene.duration_sec = dur;
      scene.vo_missing = true;
      missing++;
      log(`  scene ${scene.index}: no voiceover (${m.slice(0, 80)}) → ${dur.toFixed(1)}s silent gap.`);
    }
  }
  const total = doc.scenes.reduce((s, x) => s + (x.duration_sec ?? 0), 0);
  log(
    `Stage 2 done: ${doc.scenes.length} clips, ${total.toFixed(1)}s narration, ` +
      `${cacheHits} cache hits, ${chars} new chars billed, ${missing} silent.`,
  );
  return { chars, cacheHits, missing };
}

/* ───────────────────────── Stage 3: images ──────────────────────────── */

async function generateImage(
  prompt: string,
  outPath: string,
  model: string,
): Promise<void> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("Missing GEMINI_API_KEY.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9" },
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imgPart = parts.find((p) => p.inlineData?.data);
  if (!imgPart?.inlineData?.data) {
    throw new Error("Gemini returned no image data.");
  }
  await writeFile(outPath, Buffer.from(imgPart.inlineData.data, "base64"));
}

// Cheap, dependency-free placeholder: a numbered card on white so the pipeline
// runs end-to-end with no image API. Swapped out the moment GEMINI_API_KEY is set.
async function placeholderImage(scene: Scene, outPath: string): Promise<void> {
  const label = wrapWords(scene.image_prompt, 28).slice(0, 5);
  const lines = [
    `drawtext=fontfile=${FONT}:text='SCENE ${scene.index}':fontsize=90:fontcolor=0x111111:x=(w-text_w)/2:y=140`,
    ...label.map(
      (ln, i) =>
        `drawtext=fontfile=${FONT}:text='${dtext(ln.toUpperCase())}':fontsize=44:fontcolor=0x444444:x=(w-text_w)/2:y=320+${i * 70}`,
    ),
  ].join(",");
  const res = await runCmd("ffmpeg", [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=white:s=${OUT_W}x${OUT_H}`,
    "-vf",
    `${lines},format=yuv420p`,
    "-frames:v",
    "1",
    outPath,
  ]);
  if (res.code !== 0) throw new Error(`placeholder image failed: ${res.stderr.slice(-300)}`);
}

async function imageStage(
  doc: ScenesDoc,
  opts: LongformOptions,
): Promise<{ generated: number; cached: number; failed: number }> {
  opts.log(
    `Stage 3 (images): ${opts.placeholderImages ? "placeholder mode" : opts.imageModel} for ${doc.scenes.length} scenes…`,
  );
  let generated = 0;
  let cached = 0;
  let failed = 0;

  for (const scene of doc.scenes) {
    const outPath = path.join(IMG_DIR, `scene_${String(scene.index).padStart(3, "0")}.png`);
    const fullPrompt = STYLE_PREAMBLE + scene.image_prompt;

    if (opts.placeholderImages) {
      await placeholderImage(scene, outPath);
      scene.image_path = outPath;
      scene.image_placeholder = true;
      generated++;
      continue;
    }

    const hash = createHash("sha1").update(`${opts.imageModel}|${fullPrompt}`).digest("hex").slice(0, 16);
    const cachePath = path.join(imgCacheDir(), `${hash}.png`);
    if (await fileExists(cachePath)) {
      await copyFile(cachePath, outPath);
      scene.image_path = outPath;
      cached++;
      continue;
    }

    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        await generateImage(fullPrompt, outPath, opts.imageModel);
        await copyFile(outPath, cachePath).catch(() => undefined);
        ok = true;
        generated++;
        opts.log(`  scene ${scene.index}/${doc.scenes.length} image ok`);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        opts.log(`  scene ${scene.index} image attempt ${attempt} failed: ${m}`);
        if (attempt === 2) {
          // Don't abort the whole run for one bad image — fall back to placeholder.
          await placeholderImage(scene, outPath).catch(() => undefined);
          scene.image_placeholder = true;
          failed++;
        }
      }
    }
    scene.image_path = outPath;
  }
  opts.log(
    `Stage 3 done: ${generated} generated, ${cached} from cache, ${failed} fell back to placeholder.`,
  );
  return { generated, cached, failed };
}

/* ───────────────────── Stage 4: assembly (ffmpeg) ────────────────────── */

function captionFilters(narration: string): string {
  const lines = wrapWords(narration, 38).slice(0, 4);
  const fontsize = 46;
  const lineH = 62;
  const blockH = lines.length * lineH;
  const baseY = OUT_H - blockH - 70; // sit near the bottom
  return lines
    .map((ln, i) => {
      const parts = [
        `fontfile=${FONT}`,
        `text='${dtext(ln)}'`,
        `fontsize=${fontsize}`,
        `fontcolor=0x111111`,
        `x=(w-text_w)/2`,
        `y=${baseY + i * lineH}`,
        `box=1`,
        `boxcolor=0xFFFFFFCC`,
        `boxborderw=16`,
      ];
      return "drawtext=" + parts.join(":");
    })
    .join(",");
}

async function renderScene(
  scene: Scene,
  opts: LongformOptions,
): Promise<string> {
  const dur = (scene.duration_sec ?? 3) + 0.45; // small tail so it doesn't cut abruptly
  const outPath = path.join(CLIPS_DIR, `clip_${String(scene.index).padStart(3, "0")}.mp4`);

  // Gentle Ken Burns zoom keeps a still image from feeling dead.
  const frames = Math.max(1, Math.round(dur * FPS));
  const vChain =
    `[0:v]scale=${OUT_W * 2}:${OUT_H * 2}:force_original_aspect_ratio=increase,` +
    `crop=${OUT_W * 2}:${OUT_H * 2},` +
    `zoompan=z='min(zoom+0.0006,1.12)':d=${frames}:s=${OUT_W}x${OUT_H}:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
    `setsar=1` +
    (opts.burnCaptions ? `,${captionFilters(scene.narration)}` : "") +
    `,format=yuv420p[v]`;

  const args = [
    "-hide_banner",
    "-y",
    "-loop",
    "1",
    "-i",
    scene.image_path!,
    "-i",
    scene.audio_path!,
    "-filter_complex",
    `${vChain};[1:a]apad,aresample=44100,aformat=channel_layouts=stereo[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    dur.toFixed(3),
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "44100",
    "-ac",
    "2",
    outPath,
  ];
  const res = await runCmd("ffmpeg", args);
  if (res.code !== 0) throw new Error(`render scene ${scene.index} failed: ${res.stderr.slice(-400)}`);
  return outPath;
}

async function concatClips(parts: string[], outPath: string): Promise<void> {
  const inputs: string[] = [];
  for (const p of parts) inputs.push("-i", p);
  const map = parts.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const args = [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    `${map}concat=n=${parts.length}:v=1:a=1[v][a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "44100",
    "-ac",
    "2",
    outPath,
  ];
  const res = await runCmd("ffmpeg", args);
  if (res.code !== 0) throw new Error(`concat failed: ${res.stderr.slice(-400)}`);
}

async function mixMusic(montage: string, outPath: string): Promise<void> {
  const hasBed = await fileExists(MUSIC_BED);
  if (!hasBed) {
    await copyFile(montage, outPath);
    return;
  }
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    montage,
    "-stream_loop",
    "-1",
    "-i",
    MUSIC_BED,
    "-filter_complex",
    `[0:a]volume=1.0[vo];[1:a]volume=0.07[bed];[vo][bed]amix=inputs=2:duration=first:normalize=0[mix];[mix]alimiter=limit=0.95[a]`,
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outPath,
  ];
  const res = await runCmd("ffmpeg", args);
  if (res.code !== 0) throw new Error(`music mix failed: ${res.stderr.slice(-400)}`);
}

/* ─────────────────────────── Orchestration ───────────────────────────── */

export async function runLongform(opts: LongformOptions): Promise<LongformResult> {
  const timings: Record<string, number> = {};
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const r = await fn();
    timings[name] = Math.round((Date.now() - t0) / 100) / 10;
    return r;
  };

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY.");
  const client = new Anthropic({ apiKey });

  await ensureDirs();

  const doc = await mark("script", () => generateScript(opts, client));
  const vo = await mark("voiceover", () => voiceoverStage(doc, opts.log));
  const img = await mark("images", () => imageStage(doc, opts));

  // Persist the data contract before assembly (the seam).
  const scenesJsonPath = path.join(projectOutput(), `scenes-${Date.now()}.json`);
  await writeFile(scenesJsonPath, JSON.stringify(doc, null, 2));
  opts.log(`Wrote ${scenesJsonPath}`);

  const finalPath = await mark("assembly", async () => {
    opts.log(`Stage 4 (assembly): rendering ${doc.scenes.length} scene clips…`);
    const clips: string[] = [];
    for (const scene of doc.scenes) {
      clips.push(await renderScene(scene, opts));
      opts.log(`  rendered clip ${scene.index}/${doc.scenes.length}`);
    }
    const montage = path.join(CLIPS_DIR, "montage.mp4");
    opts.log(`Concatenating ${clips.length} clips…`);
    await concatClips(clips, montage);

    const out = path.join(projectOutput(), `longform-${Date.now()}.mp4`);
    if (opts.withMusic) {
      opts.log("Mixing music bed under narration…");
      await mixMusic(montage, out);
    } else {
      await copyFile(montage, out);
    }
    return out;
  });

  const videoDurationSec = await probeDuration(finalPath);
  const narrationWords = doc.scenes.reduce(
    (n, s) => n + s.narration.split(/\s+/).filter(Boolean).length,
    0,
  );

  const stats: Stats = {
    sceneCount: doc.scenes.length,
    narrationWords,
    videoDurationSec: Math.round(videoDurationSec * 10) / 10,
    ttsCharsBilled: vo.chars,
    ttsCacheHits: vo.cacheHits,
    ttsMissing: vo.missing,
    imagesGenerated: img.generated,
    imagesFromCache: img.cached,
    imagesFailed: img.failed,
    timings,
  };

  return { finalPath, scenesJsonPath, stats };
}

export async function loadScenesDoc(p: string): Promise<ScenesDoc> {
  return JSON.parse(await readFile(p, "utf8")) as ScenesDoc;
}
