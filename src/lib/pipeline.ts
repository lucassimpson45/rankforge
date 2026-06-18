import { mkdir, writeFile, access, cp, copyFile, readdir, rm } from "fs/promises";
import { constants } from "fs";
import { createHash } from "crypto";
import path from "path";
import { spawn } from "child_process";
import axios from "axios";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ResearchItem,
  ResearchResult,
  StepId,
  SsePayload,
} from "@/lib/types";

/* ─────────────────────────── Paths & config ─────────────────────────── */

const WORK_ROOT = "/tmp/rankforge";
const CLIPS_DIR = `${WORK_ROOT}/clips`;
const AUDIO_DIR = `${WORK_ROOT}/audio`;
const ASSETS_DIR = `${WORK_ROOT}/assets`; // copied from public/assets (no-space path for ffmpeg)

const FONT = `${ASSETS_DIR}/fonts/Anton-Regular.ttf`;
const sfx = (n: string) => `${ASSETS_DIR}/sfx/${n}`;
const MUSIC_BED = `${ASSETS_DIR}/music/bed.mp3`;

const ANTHROPIC_MODEL =
  (process.env.ANTHROPIC_MODEL ?? "").trim() || "claude-sonnet-4-6";

// Per-clip runtime in the final edit
const CLIP_MIN = 5;
const CLIP_MAX = 7;

// Output canvas (vertical Short)
const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

const INTRO_DUR = 1.6;
const OUTRO_DUR = 2.2;

// Voiceover gain in the final ffmpeg mix (tune without hunting filter flags)
const VOICEOVER_VOLUME = 2.0;

// Rank → accent colour (drawtext 0xRRGGBB). #1 is gold.
const RANK_HEX: Record<number, string> = {
  1: "0xFFD23F",
  2: "0x4EE1A0",
  3: "0x4CC9FF",
  4: "0xFF8A4C",
  5: "0xFF5C8A",
};

function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

function projectPublicOutput(): string {
  if (isVercel()) return `${WORK_ROOT}/output`;
  return path.join(process.cwd(), "public", "output");
}
function projectAssets(): string {
  return path.join(process.cwd(), "public", "assets");
}
function voCacheDir(): string {
  if (isVercel()) return `${WORK_ROOT}/vo-cache`;
  return path.join(process.cwd(), ".vo-cache");
}

export type SendFn = (payload: SsePayload) => void;

/* ─────────────────────────── Small utilities ────────────────────────── */

async function ensureDirs(): Promise<void> {
  await mkdir(CLIPS_DIR, { recursive: true });
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(projectPublicOutput(), { recursive: true });
  await mkdir(voCacheDir(), { recursive: true });
}

async function syncAssets(): Promise<void> {
  // Copy bundled assets into a no-space working path so ffmpeg filter args
  // (fontfile=…) never need shell/path escaping.
  await cp(projectAssets(), ASSETS_DIR, { recursive: true }).catch(() => undefined);
}

async function wipeWorkspaceSession(): Promise<void> {
  await ensureDirs();
  for (const dir of [CLIPS_DIR, AUDIO_DIR]) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries.map((f) =>
        rm(path.join(dir, f), { force: true }).catch(() => undefined),
      ),
    );
  }
  await syncAssets();
}

function runCmd(
  command: string,
  args: string[],
  onChunk?: (line: string) => void,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (d) => onChunk?.(d.toString()));
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stderr += s;
      onChunk?.(s);
    });
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

// Like runCmd, but writes `input` to the child's stdin (for piping JSON, etc.)
function runCmdInput(
  command: string,
  args: string[],
  input: string,
  onChunk?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stderr += s;
      onChunk?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/* ─────────────────────── ffprobe: duration + audio ──────────────────── */

async function probeMedia(
  p: string,
): Promise<{ duration: number; hasAudio: boolean }> {
  const res = await runCmdStdout("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    p,
  ]);
  let duration = 0;
  let hasAudio = false;
  try {
    const info = JSON.parse(res.stdout || "{}") as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    duration = parseFloat(info.format?.duration ?? "0") || 0;
    hasAudio = (info.streams ?? []).some((s) => s.codec_type === "audio");
  } catch {
    /* defaults */
  }
  return { duration, hasAudio };
}

// Find the loudest ~0.5s window in a clip's audio (crowd roar / impact / laugh)
// — a reliable proxy for "the moment". Returns its start time in seconds, or
// null if analysis fails / there's no usable audio.
async function findAudioPeak(inputPath: string): Promise<number | null> {
  const res = await runCmdStdout("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-af",
    "aresample=44100,asetnsamples=n=22050:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f",
    "null",
    "-",
  ]).catch(() => null);
  if (!res) return null;

  let bestTime: number | null = null;
  let bestRms = -Infinity;
  let curTime: number | null = null;
  for (const line of res.stdout.split("\n")) {
    const tMatch = line.match(/pts_time:([0-9.]+)/);
    if (tMatch) {
      curTime = parseFloat(tMatch[1]);
      continue;
    }
    const rMatch = line.match(/RMS_level=(-?[0-9.]+|-?inf)/i);
    if (rMatch && curTime !== null) {
      const rms = rMatch[1].toLowerCase().includes("inf")
        ? -Infinity
        : parseFloat(rMatch[1]);
      if (rms > bestRms) {
        bestRms = rms;
        bestTime = curTime;
      }
    }
  }
  return Number.isFinite(bestRms) ? bestTime : null;
}

// Crowd-noise spike detector. Within a [winStart, winEnd] slice of the source,
// find the sharpest sudden INCREASE in short-window RMS loudness — i.e. the
// moment the crowd pops (goal / buzzer-beater / big play), which is the biggest
// *jump* in volume, not merely the loudest point. Input-seeks so only the window
// is decoded. Returns the absolute timestamp (s) of the spike, or null when
// there's no clear jump (flat audio) so the caller can fall back to the hint.
const SPIKE_MIN_DB = 5; // minimum RMS jump (dB) over ~0.5s to count as a pop

async function findVolumeSpike(
  inputPath: string,
  winStart: number,
  winEnd: number,
): Promise<number | null> {
  const dur = winEnd - winStart;
  if (!(dur > 0.5)) return null;

  const res = await runCmdStdout("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss",
    winStart.toFixed(3),
    "-i",
    inputPath,
    "-t",
    dur.toFixed(3),
    "-map",
    "0:a:0",
    "-af",
    "aresample=44100,asetnsamples=n=22050:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f",
    "null",
    "-",
  ]).catch(() => null);
  if (!res) return null;

  // Per-window (time, rms) samples. With input seek, pts_time restarts near 0,
  // so add winStart back to recover the absolute timestamp.
  const samples: { t: number; rms: number }[] = [];
  let curTime: number | null = null;
  for (const line of res.stdout.split("\n")) {
    const tMatch = line.match(/pts_time:([0-9.]+)/);
    if (tMatch) {
      curTime = parseFloat(tMatch[1]);
      continue;
    }
    const rMatch = line.match(/RMS_level=(-?[0-9.]+|-?inf)/i);
    if (rMatch && curTime !== null) {
      const rms = rMatch[1].toLowerCase().includes("inf")
        ? -120
        : parseFloat(rMatch[1]);
      samples.push({ t: curTime, rms });
    }
  }
  if (samples.length < 3) return null;

  // Largest positive jump between consecutive ~0.5s windows = the crowd pop.
  let bestJump = -Infinity;
  let bestTime: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const jump = samples[i].rms - samples[i - 1].rms;
    if (jump > bestJump) {
      bestJump = jump;
      bestTime = samples[i].t;
    }
  }
  if (bestTime === null || bestJump < SPIKE_MIN_DB) return null;
  return clamp(winStart + bestTime, winStart, winEnd);
}

/* ───────────────────────── drawtext escaping ─────────────────────────── */

// Escape a literal string for use inside a single-quoted drawtext `text='…'`
// value. Even inside quotes, ffmpeg's filtergraph parser needs ':' and ','
// backslash-escaped; spaces are fine.
function dtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\n/g, " ");
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/* ───────────────────────── Claude: research ──────────────────────────── */

function extractJsonObject<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : text.trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as T;
    }
    throw new Error("Could not parse research JSON from Claude.");
  }
}

function coerceResearch(raw: ResearchResult): ResearchResult {
  const items = raw.items.map((it) => {
    const clipDur = Number.isFinite(it.clipDuration)
      ? clamp(Math.round(it.clipDuration), CLIP_MIN, CLIP_MAX)
      : 6;
    const peak = Number.isFinite(it.peakOffsetPct)
      ? clamp(Math.round(it.peakOffsetPct), 0, 100)
      : 50;
    return { ...it, clipDuration: clipDur, peakOffsetPct: peak };
  });
  const total = items.reduce((s, i) => s + i.clipDuration, 0);
  return {
    ...raw,
    targetDurationSeconds: clamp(total, 25, 40),
    items,
  };
}

async function claudeResearch(
  topic: string,
  client: Anthropic,
  log: (m: string) => void,
): Promise<ResearchResult> {
  log("Asking Claude to score virality and rank the top 5 clips…");
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are a short-form (YouTube Shorts / TikTok) ranking-video researcher. Topic: "${topic}".

STEP 1 — Read the topic's INTENT before picking anything:
- Identify the EMOTION/THEME word (e.g. "funniest", "most satisfying", "most shocking", "craziest", "best"). This is the #1 filter and matters MORE than the subject domain.
- Identify the subject domain (e.g. NFL, animals, kitchen).
- A clip only qualifies if it nails the EMOTION word, not just the domain. Example: for "Funniest NFL Moments", a great impressive touchdown does NOT qualify — pick moments that make people actually LAUGH (bloopers, fails, mic'd-up comedy, awkward interviews, mascot/fan fails, commentator cracking up). For "Best NFL Plays", impressive plays DO qualify.
- If the topic is broad/vague, lean into the EMOTION word hard and pick the most universally-agreed examples of it.

STEP 2 — Pick EXACTLY 5 distinct, specific, well-known moments that each strongly deliver the emotion. Prefer variety (don't pick 5 of the same sub-type). Rank 1 = the single most viral / strongest example.

STEP 3 — For EACH moment, define the SEGMENT to show. The target moment is the DECISIVE SCORING/FINISHING ACTION ITSELF — for a goal it is the SHOT being struck and the BALL HITTING THE NET; for other sports the equivalent finish (the dunk, the touchdown catch, the buzzer-beater release). It is NEVER the buildup, the run without the ball, or the standalone aftermath.
- First identify that ONE decisive action in the clip. This is the target moment.
- Valid segment content, IN ORDER of preference:
  1. The shot/strike itself + the ball hitting the net (ideal).
  2. The dribble/drive leading DIRECTLY into the shot — at most 3 seconds of buildup before the strike.
  3. The immediate celebration — ONLY if the shot itself is not present in the available footage.
- INVALID content — if a clip contains ONLY these, treat it as the wrong moment and prefer a different specific moment/query instead: a player running without the ball, pre-game warmup or training, a coach or pundit speaking, a celebration with no goal preceding it, or crowd-only shots.
- The decisive action must appear in the FIRST HALF of the segment, with the reaction/celebration filling the second half.
- If a typical clip from this query is too short to apply this logic, just use the full clip.
- If the action cannot plausibly be sourced as a real standalone clip, pick a DIFFERENT specific moment instead of settling for buildup/aftermath footage.
- Encode this with clipDuration (the segment length in seconds) and peakOffsetPct (where the decisive action sits inside that segment).

Return ONLY valid JSON (no markdown, no commentary):
{
  "topicViralityScore": <number 0-100>,
  "targetDurationSeconds": 30,
  "items": [
    {
      "rank": 1,
      "title": "<PUNCHY 2-4 word on-screen label, e.g. 'BUTT FUMBLE'>",
      "viralityReason": "<1 sentence on why it nails the emotion word>",
      "searchQuery": "<query naming the SPECIFIC moment so yt-dlp finds that exact clip>",
      "clipDuration": <integer 5-7>,
      "peakOffsetPct": <integer 0-100>
    }
  ]
}

Rules:
- EXACTLY 5 items, ranks 1-5.
- "title" is burned on screen as the rank label: 2-4 words, no punctuation. It must LITERALLY describe what is visible in that exact clip — plain and accurate, NOT exaggerated. (If a ref only points, say "REF POINTS", not "REF GETS TRUCKED". Don't invent objects/actions that may not be on screen.)
- searchQuery: search for the SPECIFIC scoring/finishing moment ITSELF, never the player or the general topic. For a goal use the format "[player] goal vs [opponent] [year] [competition]" (e.g. "Messi goal vs Chelsea 2012 Champions League"); apply the equivalent specific form for other sports. Add "full HD" or "original broadcast" to bias toward real match footage. Each of the 5 queries must target a DIFFERENT specific moment — five different goals/finishes, never five variants of the same one.
- NEVER search for compilations, "top 5"/"top 10", "best goals", highlight reels, montages, warmups, training, or interviews — these always return the wrong moments. NEVER include words like "analysis", "reaction", "react", "award", "vote", "puskas", "debate", "explained", "compilation", "highlights", "top 10". We want the RAW broadcast footage of the moment itself — not commentary, podcasts, or award/voting pages.
- Every searchQuery and title must obviously match the EMOTION word from STEP 1. If you can't justify why it's e.g. funny, pick a different moment.
- clipDuration: integer seconds 5-7 only.
- peakOffsetPct: where the decisive scoring/finishing action lands as a % through the chosen segment. Place it in the FIRST HALF (≈ 25-45) so at most a few seconds of buildup precede the action and the reaction/celebration fills the second half — never put it at the very end.`,
      },
    ],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
  const parsed = extractJsonObject<ResearchResult>(text);
  if (!parsed.items || parsed.items.length !== 5) {
    throw new Error("Research JSON must contain exactly 5 items.");
  }
  return coerceResearch(parsed);
}

/* ───────────────────────── Claude: script ────────────────────────────── */

// One spoken line per clip (in video order: rank 5 → 1), plus a closing CTA.
type ScriptLines = { lines: string[]; cta: string };

async function claudeScriptLines(
  topic: string,
  research: ResearchResult,
  client: Anthropic,
  log: (m: string) => void,
): Promise<ScriptLines> {
  log("Generating per-clip voiceover lines…");
  const ordered = [...research.items].sort((a, b) => b.rank - a.rank); // 5 → 1
  const bullets = ordered
    .map(
      (i, idx) =>
        `lines[${idx}] = #${i.rank} "${i.title}" — ${i.viralityReason} (clip is ${i.clipDuration}s)`,
    )
    .join("\n");

  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are voicing a "Top 5" countdown Short. Topic: "${topic}".

Write ONE short spoken line per clip that says what is happening, building hype toward #1. Each line plays OVER its clip, so it must be SHORT — max ~11 words, ideally 6-9 — so it finishes before the clip ends.

Clips play in this order (5 → 1):
${bullets}

Return ONLY valid JSON:
{ "lines": ["<line for lines[0]>", "<lines[1]>", "<lines[2]>", "<lines[3]>", "<lines[4]>"], "cta": "<3-5 word call to action>" }

Rules:
- EXACTLY 5 lines, matching the order above (lines[0] = the #5 clip … lines[4] = the #1 clip).
- Naturally say the rank as you go (e.g. "At five…", "Number two…", "And number one…") so it feels like a countdown.
- Describe the ACTION, punchy and energetic, like a hype narrator. No filler, no "welcome", no channel name.
- "cta" plays over the outro (e.g. "Subscribe for more.").
- Plain spoken words only. No emojis, no brackets, no stage directions.`,
      },
    ],
  });
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
  const parsed = extractJsonObject<Partial<ScriptLines>>(text);
  let lines = Array.isArray(parsed.lines) ? parsed.lines.map((l) => clean(String(l))) : [];
  if (lines.length < ordered.length) {
    // Pad defensively so every clip still gets a line.
    while (lines.length < ordered.length) {
      const it = ordered[lines.length];
      lines.push(`Number ${it.rank}. ${it.title}.`);
    }
  }
  lines = lines.slice(0, ordered.length);
  const cta = clean(String(parsed.cta ?? "Subscribe for more."));
  log(`Voiceover: ${lines.length} lines + CTA.`);
  return { lines, cta };
}

/* ───────────────────────── yt-dlp clip hunt ──────────────────────────── */

async function wipeClipSlot(rank: number): Promise<void> {
  const files = await readdir(CLIPS_DIR).catch(() => [] as string[]);
  const prefix = `clip_${rank}.`;
  await Promise.all(
    files
      .filter((f) => f.startsWith(prefix))
      .map((f) => rm(path.join(CLIPS_DIR, f), { force: true }).catch(() => undefined)),
  );
}

function clipSearchFallbacks(primary: string): string[] {
  const q = clean(primary);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const t = clean(s);
    if (t.length >= 2 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  add(q);
  const debadged = clean(q.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035'`]/g, ""));
  add(debadged);
  const words = debadged.split(/\s+/).filter(Boolean);
  for (const n of [8, 6, 5, 4]) {
    if (words.length > n) add(words.slice(0, n).join(" "));
  }
  return out;
}

async function findDownloadedClip(stem: string): Promise<string | null> {
  for (const ext of ["mp4", "mkv", "webm"]) {
    if (await fileExists(`${stem}.${ext}`)) return `${stem}.${ext}`;
  }
  const files = await readdir(CLIPS_DIR);
  const base = path.basename(stem);
  const hit = files.find((f) => f.startsWith(`${base}.`));
  return hit ? path.join(CLIPS_DIR, hit) : null;
}

type Candidate = { id: string; duration: number; title: string };

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "in", "on", "off", "to", "for", "vs", "with",
  "clip", "clips", "highlight", "highlights", "moment", "moments", "shorts",
  "short", "funny", "funniest", "best", "top", "video", "full", "hd",
  // generic descriptors that match unrelated videos
  "fail", "fails", "blooper", "bloopers", "fall", "falls", "down", "guy",
  "field", "during", "run", "runs", "running", "gets", "get", "live",
  "reaction", "epic", "crazy", "insane", "ultimate", "viral", "gone",
  "wrong", "when", "his", "her", "him", "she", "he", "they", "out", "up",
]);

// Pull out subject/proper-noun terms (e.g. NFL, Gronkowski, Sanchez) vs generic
// words. A candidate must match a subject term or it's almost certainly wrong.
function keyTerms(query: string): { named: string[]; generic: string[] } {
  const named = new Set<string>();
  const generic = new Set<string>();
  for (const tok of clean(query).split(/\s+/)) {
    const w = tok.replace(/[^\w']/g, "");
    if (w.length < 3) continue;
    const lw = w.toLowerCase();
    const isProper = /^[A-Z]/.test(w) || /^[A-Z0-9]{2,}$/.test(w); // Capitalised or ACRONYM
    if (isProper && !STOPWORDS.has(lw)) named.add(lw);
    else if (!STOPWORDS.has(lw)) generic.add(lw);
  }
  return { named: [...named], generic: [...generic] };
}

// Penalise compilations/montages — the specific moment gets buried in them.
const COMPILATION_RE = /compilation|top\s*\d+|best of|montage|all\b|every|mix|playlist/i;

// "About the moment" pages, not the raw action: award voting, analysis, reaction.
const JUNK_RE =
  /\b(vote|puskas|nominee|nominations?|award|awards|reacts?|reaction|analysis|analy[sz]e|breakdown|explained|explains|debate|first take|undisputed|get up|review|tier list|side by side|discuss(es|ion)?|talks? about)\b/i;

const CLIP_FORMAT =
  "bestvideo[ext=mp4][height<=1280]+bestaudio[ext=m4a]/bestvideo[height<=1280]+bestaudio/best[ext=mp4]/best";

async function listCandidates(query: string): Promise<Candidate[]> {
  const res = await runCmdStdout("yt-dlp", [
    `ytsearch12:${query}`,
    "--flat-playlist",
    "--no-warnings",
    "--print",
    "%(id)s|%(duration)s|%(title)s",
  ]);
  const out: Candidate[] = [];
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("|")) continue;
    const parts = trimmed.split("|");
    const id = parts[0];
    const duration = parseFloat(parts[1]);
    const title = parts.slice(2).join("|");
    if (!id || id === "NA") continue;
    out.push({ id, duration: Number.isFinite(duration) ? duration : 0, title });
  }
  return out;
}

function scoreCandidate(c: Candidate, query: string, position: number): number {
  const { named } = keyTerms(query);
  const title = c.title.toLowerCase();
  let namedHits = 0;
  for (const n of named) if (title.includes(n)) namedHits++;

  // YouTube relevance order dominates; everything else only nudges it.
  let score = 20 - position;
  score += namedHits * 1.5; // light nudge toward subject match
  if (named.length > 0 && namedHits === 0) score -= 5; // likely wrong subject
  if (COMPILATION_RE.test(c.title)) score -= 12; // avoid montages hard
  if (JUNK_RE.test(c.title)) score -= 14; // avoid award/voting/analysis/reaction pages
  if (c.duration > 0 && c.duration <= 20) score += 3; // tight single-moment clips
  else if (c.duration > 0 && c.duration <= 45) score += 2;
  else if (c.duration > 0 && c.duration <= 90) score += 1;
  else score -= 2;
  return score;
}

async function downloadById(
  rank: number,
  id: string,
  log: (m: string) => void,
): Promise<string | null> {
  const stem = path.join(CLIPS_DIR, `clip_${rank}`);
  await wipeClipSlot(rank);
  const args = [
    `https://www.youtube.com/watch?v=${id}`,
    "-o",
    `${stem}.%(ext)s`,
    "--no-playlist",
    "--restrict-filenames",
    "-f",
    CLIP_FORMAT,
    "--merge-output-format",
    "mp4",
    "--no-warnings",
  ];
  await runCmd("yt-dlp", args, (chunk) => {
    const t = chunk.trimEnd();
    if (t) log(t);
  });
  return findDownloadedClip(stem);
}

async function downloadClipForQuery(
  rank: number,
  query: string,
  log: (m: string) => void,
): Promise<string> {
  const attempts = clipSearchFallbacks(query);
  // Cache listings per query so widening the cap doesn't re-fetch.
  const listings = new Map<string, Candidate[]>();
  const getList = async (q: string): Promise<Candidate[]> => {
    if (!listings.has(q)) {
      listings.set(q, await listCandidates(q).catch(() => [] as Candidate[]));
    }
    return listings.get(q)!;
  };

  // Prefer short single-moment clips; only widen the cap if nothing usable.
  for (const maxDur of [120, 400]) {
    for (const q of attempts) {
      const all = await getList(q);
      const cands = all.filter((c) => c.duration >= 3 && c.duration <= maxDur);
      if (cands.length === 0) continue;

      const ranked = cands
        .map((c, i) => ({ c, s: scoreCandidate(c, q, i) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c);

      log(
        `yt-dlp (#${rank}) ≤${maxDur}s “${q}” → best: ${ranked[0].title.slice(0, 60)} (${ranked[0].duration}s)`,
      );

      for (const cand of ranked.slice(0, 4)) {
        const found = await downloadById(rank, cand.id, log);
        if (found) return found;
      }
    }
  }

  // Last-resort fallback: let yt-dlp pick directly.
  for (const q of attempts) {
    await wipeClipSlot(rank);
    const stem = path.join(CLIPS_DIR, `clip_${rank}`);
    log(`yt-dlp (#${rank}) fallback search: ${q}`);
    await runCmd(
      "yt-dlp",
      [
        `ytsearch5:${q}`,
        "-o",
        `${stem}.%(ext)s`,
        "--max-downloads",
        "1",
        "--no-playlist",
        "--restrict-filenames",
        "-f",
        CLIP_FORMAT,
        "--merge-output-format",
        "mp4",
        "--no-warnings",
        "--match-filter",
        "duration <= 700 & duration >= 3",
      ],
      (chunk) => {
        const t = chunk.trimEnd();
        if (t) log(t);
      },
    );
    const found = await findDownloadedClip(stem);
    if (found) return found;
  }

  throw new Error(`yt-dlp found no usable video for rank ${rank}. Query: "${clean(query)}".`);
}

/* ──────────────────────── Text-to-speech (voice) ─────────────────────────
 * Default engine is LOCAL Kokoro (free, runs on this machine). ElevenLabs is
 * available as an opt-in fallback via TTS_ENGINE=elevenlabs.
 * Both cache by content hash so re-runs are instant and cost nothing.
 * ----------------------------------------------------------------------- */

type Utterance = { text: string; base: string }; // base = filename stem, no ext

function ttsEngine(): "local" | "elevenlabs" {
  return process.env.TTS_ENGINE?.trim().toLowerCase() === "elevenlabs"
    ? "elevenlabs"
    : "local";
}

function localVoiceConfig(): { voice: string; speed: string } {
  return {
    voice: process.env.TTS_VOICE?.trim() || "am_michael",
    speed: process.env.TTS_SPEED?.trim() || "1.0",
  };
}

function ttsPython(): string {
  return path.join(process.cwd(), ".tts-venv", "bin", "python");
}
function ttsScript(): string {
  return path.join(process.cwd(), "scripts", "tts_local.py");
}

// Local Kokoro TTS. Loads the model once and renders every uncached line in a
// single Python invocation. Returns one output path per utterance (in order).
async function localTtsBatch(
  utts: Utterance[],
  log: (m: string) => void,
): Promise<string[]> {
  const { voice, speed } = localVoiceConfig();
  const py = ttsPython();
  const script = ttsScript();
  if (!(await fileExists(py))) {
    throw new Error(
      `Local TTS venv missing at ${py}. Run: python3.12 -m venv .tts-venv && .tts-venv/bin/pip install kokoro soundfile`,
    );
  }

  const plan = utts.map((u) => {
    const hash = createHash("sha1")
      .update(`kokoro|${voice}|${speed}|${u.text}`)
      .digest("hex")
      .slice(0, 16);
    return {
      u,
      cachePath: path.join(voCacheDir(), `${hash}.wav`),
      workPath: path.join(AUDIO_DIR, `${u.base}.wav`),
    };
  });

  const todo: typeof plan = [];
  for (const p of plan) {
    if (!(await fileExists(p.cachePath))) todo.push(p);
  }
  if (todo.length > 0) {
    log(`Local TTS (Kokoro, voice=${voice}): rendering ${todo.length} line(s)…`);
    const payload = JSON.stringify(
      todo.map((p) => ({ text: p.u.text, out: p.cachePath })),
    );
    const res = await runCmdInput(
      py,
      [script, "--voice", voice, "--speed", speed],
      payload,
      (chunk) => {
        const t = chunk.trimEnd();
        if (t && /kokoro:|ERR |FATAL/.test(t)) log(t);
      },
    );
    if (res.code !== 0) {
      throw new Error(`Local TTS failed: ${(res.stderr || "").slice(-400)}`);
    }
    for (const p of todo) {
      if (!(await fileExists(p.cachePath))) {
        throw new Error(`Local TTS produced no audio for: “${p.u.text.slice(0, 60)}”`);
      }
    }
  } else {
    log("Local TTS: all lines cached (0 work).");
  }

  const out: string[] = [];
  for (const p of plan) {
    await copyFile(p.cachePath, p.workPath);
    out.push(p.workPath);
  }
  return out;
}

// ElevenLabs (opt-in). Renders one line, cached by text. Returns its path.
async function elevenLabsOne(
  text: string,
  base: string,
  log: (m: string) => void,
): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const voice = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!key || !voice) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");
  }

  const model = "eleven_multilingual_v2";
  const hash = createHash("sha1")
    .update(`el|${voice}|${model}|${text}`)
    .digest("hex")
    .slice(0, 16);
  const cachePath = path.join(voCacheDir(), `${hash}.mp3`);
  const outPath = path.join(AUDIO_DIR, `${base}.mp3`);

  if (await fileExists(cachePath)) {
    log(`VO cache hit: “${text.slice(0, 40)}” (0 credits).`);
    await copyFile(cachePath, outPath);
    return outPath;
  }

  log(`ElevenLabs: “${text.slice(0, 48)}”`);
  try {
    const res = await axios.post<ArrayBuffer>(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      {
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.45 },
      },
      {
        headers: {
          "xi-api-key": key,
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );
    const buf = Buffer.from(res.data);
    await writeFile(outPath, buf);
    await writeFile(cachePath, buf).catch(() => undefined);
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.data) {
      const body = Buffer.from(e.response.data as ArrayBuffer).toString("utf8");
      throw new Error(`ElevenLabs error ${e.response.status}: ${body.slice(0, 400)}`);
    }
    throw e;
  }
  return outPath;
}

// Engine-agnostic: render all utterances, return paths in the same order.
async function synthVoice(
  utts: Utterance[],
  log: (m: string) => void,
): Promise<string[]> {
  if (utts.length === 0) return [];
  if (ttsEngine() === "elevenlabs") {
    const out: string[] = [];
    for (const u of utts) out.push(await elevenLabsOne(u.text, u.base, log));
    return out;
  }
  return localTtsBatch(utts, log);
}

/* ───────────────────── Ranking overlay (drawtext) ────────────────────── */

const TITLE_X = 230;
const TITLE_MAX_WIDTH = OUT_W - TITLE_X - 48;
const TITLE_MIN_FONT = 32;
/** Approximate Anton uppercase glyph width as a fraction of fontsize. */
const TITLE_CHAR_W_RATIO = 0.56;

function titleTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * TITLE_CHAR_W_RATIO;
}

// Scale fontsize down to fit one line; wrap to a second line only if still too wide at min size.
function layoutRankTitle(
  rawTitle: string,
  baseSize: number,
): { text: string; size: number }[] {
  const text = rawTitle.toUpperCase();
  let size = baseSize;
  if (titleTextWidth(text, size) > TITLE_MAX_WIDTH) {
    size = Math.max(
      TITLE_MIN_FONT,
      Math.floor(TITLE_MAX_WIDTH / (text.length * TITLE_CHAR_W_RATIO)),
    );
  }
  if (titleTextWidth(text, size) <= TITLE_MAX_WIDTH) {
    return [{ text, size }];
  }

  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (titleTextWidth(trial, size) <= TITLE_MAX_WIDTH) {
      cur = trial;
    } else {
      if (cur) lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2).map((t) => ({ text: t, size }));
}

function drawtext(
  text: string,
  size: number,
  color: string,
  x: string,
  y: number,
  opts: { alpha?: string; box?: boolean } = {},
): string {
  const parts = [
    `fontfile=${FONT}`,
    `text='${dtext(text)}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `borderw=${Math.max(3, Math.round(size / 14))}`,
    `bordercolor=0x000000`,
    `shadowcolor=0x000000AA`,
    `shadowx=4`,
    `shadowy=5`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (opts.box) parts.push("box=1", "boxcolor=0x000000B0", "boxborderw=22");
  if (opts.alpha) parts.push(`alpha='${opts.alpha}'`);
  return "drawtext=" + parts.join(":");
}

// Build the cumulative ranking overlay for the clip at `clipIndex`
// (video plays rank 5 → 1, so activeRank = total - clipIndex).
function buildRankOverlay(
  itemsByRankAsc: { rank: number; title: string }[],
  clipIndex: number,
  total: number,
  topic: string,
): string[] {
  const activeRank = total - clipIndex;
  const filters: string[] = [];

  // Top title banner
  const banner = clean(topic.replace(/^top\s*\d+\s*[:\-]?\s*/i, "")).toUpperCase();
  filters.push(
    drawtext(`TOP ${total}: ${banner}`, 52, "0xFFFFFF", "(w-text_w)/2", 120, {
      box: true,
    }),
  );

  const listTop = 360;
  const rowH = 150;

  for (let k = 0; k < total; k++) {
    const rank = k + 1;
    const row = itemsByRankAsc[k];
    const y = listTop + k * rowH;
    const revealed = rank >= activeRank; // already counted down to here
    const active = rank === activeRank;
    const color = RANK_HEX[rank] ?? "0xFFFFFF";

    const numSize = active ? 132 : revealed ? 98 : 86;
    const numAlpha = active
      ? "if(lt(t,0.28),t/0.28,1)"
      : revealed
        ? "0.96"
        : "0.32";
    filters.push(
      drawtext(`${rank}`, numSize, color, "62", y, { alpha: numAlpha }),
    );

    if (revealed) {
      const titleSize = active ? 60 : 46;
      const titleAlpha = active ? "if(lt(t,0.35),max(0,(t-0.1)/0.25),1)" : "0.96";
      const ty = active ? y + 30 : y + 26;
      for (const [li, line] of layoutRankTitle(row.title, titleSize).entries()) {
        filters.push(
          drawtext(line.text, line.size, "0xFFFFFF", String(TITLE_X), ty + li * Math.round(line.size * 1.08), {
            alpha: titleAlpha,
          }),
        );
      }
    }
  }

  return filters;
}

/* ───────────────── Render one clip (fill + overlay + audio) ──────────── */

async function renderClip(
  inputPath: string,
  rank: number,
  clipIndex: number,
  total: number,
  durationSecs: number,
  peakOffsetPct: number,
  itemsByRankAsc: { rank: number; title: string }[],
  topic: string,
  log: (m: string) => void,
): Promise<string> {
  const outPath = path.join(CLIPS_DIR, `render_${clipIndex + 1}.mp4`);
  const { duration: src, hasAudio } = await probeMedia(inputPath);

  // Choose the trim window so it reliably contains the highlight.
  //
  // Two-stage signal: Claude's peakOffsetPct says roughly WHERE the finish is,
  // and a crowd-noise VOLUME SPIKE inside that window pinpoints the EXACT moment
  // (a goal/buzzer-beater makes the crowd pop). peakOffsetPct narrows the search
  // window; the spike timestamp is the real cut anchor. We place the anchor ~40%
  // into the window (some buildup before, more reaction after), then shift inward
  // (never past the video end) to stay in-bounds.
  let start = 0;
  let how = "start";
  if (src > durationSecs + 0.5) {
    const maxStart = src - durationSecs;
    const hasPeakHint = Number.isFinite(peakOffsetPct) && peakOffsetPct > 0;

    if (hasPeakHint) {
      const peakTime = src * (peakOffsetPct / 100);
      // Search window = peakOffsetPct position ± 17.5% of source duration.
      const winRadius = src * 0.175;
      const winStart = clamp(peakTime - winRadius, 0, src);
      const winEnd = clamp(peakTime + winRadius, 0, src);
      const spike = hasAudio
        ? await findVolumeSpike(inputPath, winStart, winEnd)
        : null;
      if (spike !== null) {
        start = clamp(spike - durationSecs * 0.4, 0, maxStart);
        how = `spike@${spike.toFixed(1)}s(peak${peakOffsetPct}%)`;
      } else {
        // No clear spike in-window → use peakOffsetPct directly (prior behavior).
        start = clamp(peakTime - durationSecs * 0.4, 0, maxStart);
        how = `peak${peakOffsetPct}%@${peakTime.toFixed(1)}s`;
      }
    } else {
      // No usable hint: full-clip audio peak, else center.
      const peak = hasAudio ? await findAudioPeak(inputPath) : null;
      if (peak !== null) {
        start = clamp(peak - durationSecs * 0.4, 0, maxStart);
        how = `audio-peak@${peak.toFixed(1)}s`;
      } else {
        start = Math.max(0, maxStart / 2);
        how = "center";
      }
    }

    // Sanity guard: the opening minutes of a long broadcast (kickoff, warmups,
    // crowd shots) are never the highlight. If we landed in the first 10% of a
    // 3-min+ source, snap back to the peakOffsetPct position instead.
    if (src > 180 && start < src * 0.1) {
      const peakTime = hasPeakHint ? src * (peakOffsetPct / 100) : src * 0.5;
      start = clamp(peakTime - durationSecs * 0.4, src * 0.1, maxStart);
      how += "+openingGuard";
    }
  }
  log(
    `clip #${rank}: src ${src.toFixed(1)}s → cut @ ${start.toFixed(1)}s (${durationSecs}s, ${how}, audio:${hasAudio ? "yes" : "no"})`,
  );

  const draws = buildRankOverlay(itemsByRankAsc, clipIndex, total, topic).join(",");

  const videoChain =
    `[0:v]split=2[base][blur];` +
    `[blur]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},gblur=sigma=22,eq=brightness=-0.10:saturation=1.05[bg];` +
    `[base]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:flags=bicubic[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[ov];` +
    `[ov]${draws},fps=${FPS},format=yuv420p,setsar=1[vout]`;

  const inputArgs = [
    "-hide_banner",
    "-y",
    "-ss",
    start.toFixed(3),
    "-t",
    durationSecs.toFixed(3),
    "-i",
    inputPath,
  ];
  let audioChain: string;
  if (hasAudio) {
    audioChain = `[0:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.0[aout]`;
  } else {
    inputArgs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
    audioChain = `[1:a]aformat=channel_layouts=stereo:sample_rates=44100[aout]`;
  }

  const args = [
    ...inputArgs,
    "-filter_complex",
    `${videoChain};${audioChain}`,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    durationSecs.toFixed(3),
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
    "-shortest",
    outPath,
  ];

  log(`ffmpeg: rendering clip ${clipIndex + 1}/${total}…`);
  const result = await runCmd("ffmpeg", args, (c) => log(c.trimEnd()));
  if (result.code !== 0) {
    throw new Error(`ffmpeg render clip ${rank} failed: ${result.stderr.slice(-500)}`);
  }
  return outPath;
}

/* ───────────────────────── Intro / outro bumpers ─────────────────────── */

async function renderBumper(
  kind: "intro" | "outro",
  topic: string,
  log: (m: string) => void,
): Promise<string> {
  const dur = kind === "intro" ? INTRO_DUR : OUTRO_DUR;
  const out = path.join(CLIPS_DIR, `${kind}.mp4`);
  const sfxFile = kind === "intro" ? sfx("riser.wav") : sfx("ding.wav");
  const banner = clean(topic.replace(/^top\s*\d+\s*[:\-]?\s*/i, "")).toUpperCase();

  const lines =
    kind === "intro"
      ? [
          drawtext("GOATED RANK", 120, "0xFFD23F", "(w-text_w)/2", 740),
          drawtext(`TOP 5: ${banner}`, 52, "0xFFFFFF", "(w-text_w)/2", 920),
        ]
      : [
          drawtext("SUBSCRIBE", 116, "0xFFFFFF", "(w-text_w)/2", 720),
          drawtext("FOR MORE RANKINGS", 58, "0xFFD23F", "(w-text_w)/2", 880),
          drawtext("@GOATEDRANK", 64, "0xFFFFFF", "(w-text_w)/2", 1020),
        ];

  const args = [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x0B0B12:s=${OUT_W}x${OUT_H}:r=${FPS}`,
    "-i",
    sfxFile,
    "-filter_complex",
    `[0:v]${lines.join(",")},format=yuv420p,setsar=1[v];` +
      `[1:a]volume=0.8,apad,aformat=channel_layouts=stereo:sample_rates=44100,asetpts=N/SR/TB[a]`,
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
    "-shortest",
    out,
  ];

  log(`ffmpeg: rendering ${kind} bumper…`);
  const result = await runCmd("ffmpeg", args, (c) => log(c.trimEnd()));
  if (result.code !== 0) {
    throw new Error(`ffmpeg ${kind} bumper failed: ${result.stderr.slice(-400)}`);
  }
  return out;
}

/* ─────────────────────────── Concat parts ────────────────────────────── */

async function concatParts(parts: string[], log: (m: string) => void): Promise<string> {
  const merged = path.join(AUDIO_DIR, "montage.mp4");
  const inputs: string[] = [];
  for (const p of parts) inputs.push("-i", p);
  const n = parts.length;
  const map = parts.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const args = [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    `${map}concat=n=${n}:v=1:a=1[v][a]`,
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
    merged,
  ];
  log("ffmpeg: concatenating intro + clips + outro…");
  const result = await runCmd("ffmpeg", args, (c) => log(c.trimEnd()));
  if (result.code !== 0) {
    throw new Error(`ffmpeg concat failed: ${result.stderr.slice(-500)}`);
  }
  return merged;
}

/* ───────────────────────── Final audio mix ───────────────────────────── */

type SfxEvent = { file: string; at: number; gain: number };
type VoEvent = { path: string; at: number };

async function finalMix(
  montage: string,
  voEvents: VoEvent[],
  clipDurations: number[],
  outputFile: string,
  log: (m: string) => void,
): Promise<void> {
  const hasVo = voEvents.length > 0;

  // Timeline: clips (rank 5 → 1), then outro. No intro — video opens on #5.
  const events: SfxEvent[] = [];
  let t = 0;
  for (let i = 0; i < clipDurations.length; i++) {
    const isLast = i === clipDurations.length - 1; // rank 1
    events.push({
      file: isLast ? sfx("ding.wav") : sfx("pop.wav"),
      at: t + 0.04,
      gain: isLast ? 0.85 : 0.7,
    });
    if (isLast) events.push({ file: sfx("impact.wav"), at: t + 0.04, gain: 0.7 });
    events.push({ file: sfx("whoosh.wav"), at: t + clipDurations[i] - 0.12, gain: 0.5 });
    t += clipDurations[i];
  }

  // Inputs: montage(0), music bed(looped), VO lines…, SFX…
  const inputs: string[] = ["-i", montage];
  let idx = 1;
  inputs.push("-stream_loop", "-1", "-i", MUSIC_BED);
  const bedIdx = idx++;
  const voIdx: number[] = [];
  for (const v of voEvents) {
    inputs.push("-i", v.path);
    voIdx.push(idx++);
  }
  const sfxIdx: number[] = [];
  for (const e of events) {
    inputs.push("-i", e.file);
    sfxIdx.push(idx++);
  }

  const chains: string[] = [];
  const mixLabels: string[] = [];

  if (hasVo) {
    // Combine the timed VO lines into one track.
    voEvents.forEach((v, j) => {
      const ms = Math.max(0, Math.round(v.at * 1000));
      chains.push(`[${voIdx[j]}:a]adelay=${ms}|${ms},volume=${VOICEOVER_VOLUME}[vl${j}]`);
    });
    if (voEvents.length === 1) {
      chains.push(`[vl0]asplit=2[vosc][vomix]`);
    } else {
      const vl = voEvents.map((_, j) => `[vl${j}]`).join("");
      chains.push(`${vl}amix=inputs=${voEvents.length}:normalize=0[voall]`);
      chains.push(`[voall]asplit=2[vosc][vomix]`);
    }
    // Clip audio + music, ducked under the voice via sidechain.
    chains.push(`[0:a]volume=0.55[ca]`);
    chains.push(`[${bedIdx}:a]volume=0.09[bd]`);
    chains.push(`[ca][bd]amix=inputs=2:normalize=0[under]`);
    chains.push(
      `[under][vosc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=260[ducked]`,
    );
    mixLabels.push("[ducked]", "[vomix]");
  } else {
    // No narration: clip audio carries, with a light bed.
    chains.push(`[0:a]volume=0.85[ca]`);
    chains.push(`[${bedIdx}:a]volume=0.1[bd]`);
    mixLabels.push("[ca]", "[bd]");
  }

  events.forEach((e, j) => {
    const ms = Math.max(0, Math.round(e.at * 1000));
    chains.push(`[${sfxIdx[j]}:a]adelay=${ms}|${ms},volume=${e.gain}[s${j}]`);
    mixLabels.push(`[s${j}]`);
  });

  chains.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:duration=first[mixraw]`,
  );
  chains.push(`[mixraw]alimiter=limit=0.95[mix]`);

  const args = [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "0:v",
    "-map",
    "[mix]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outputFile,
  ];

  log(`ffmpeg: mixing ${hasVo ? "voiceover + " : ""}clip audio + music + SFX…`);
  const result = await runCmd("ffmpeg", args, (c) => log(c.trimEnd()));
  if (result.code !== 0) {
    throw new Error(`ffmpeg final mix failed: ${result.stderr.slice(-600)}`);
  }
}

/* ─────────────────────────── Orchestration ───────────────────────────── */

function setStep(
  send: SendFn,
  step: StepId,
  status: "idle" | "running" | "done" | "error",
  detail?: string,
) {
  send({ type: "step", step, status, detail });
}

export async function runPipeline(topic: string, send: SendFn): Promise<void> {
  const trimTopic = topic.trim();
  if (!trimTopic) {
    send({ type: "error", message: "Topic is required." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    send({ type: "error", message: "Missing ANTHROPIC_API_KEY." });
    return;
  }

  const head = await fetch("https://www.youtube.com", {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (head && !head.ok) {
    send({
      type: "log",
      message: "Warning: YouTube preflight non-OK (downloads may still work).",
    });
  }

  const log = (message: string) => send({ type: "log", message });
  const skipVoiceover = envFlag("SKIP_VOICEOVER");

  await wipeWorkspaceSession();
  const anthropic = new Anthropic({ apiKey });

  let currentStep: StepId = "research";

  try {
    /* Research */
    currentStep = "research";
    setStep(send, "research", "running");
    log("— Research —");
    const research = await claudeResearch(trimTopic, anthropic, log);
    log(
      `Virality ${research.topicViralityScore}/100 · target ~${research.targetDurationSeconds}s · 5 clips ranked.`,
    );
    setStep(send, "research", "done");

    /* Script */
    currentStep = "script";
    setStep(send, "script", "running");
    log("— Script —");
    let scriptLines: ScriptLines | null = null;
    if (skipVoiceover) {
      log("Skipping script (SKIP_VOICEOVER=1).");
    } else {
      scriptLines = await claudeScriptLines(trimTopic, research, anthropic, log);
    }
    setStep(send, "script", "done");

    /* Clip hunt (rank 5 → 1 order) */
    currentStep = "clip_hunt";
    setStep(send, "clip_hunt", "running");
    log("— Clip hunt —");
    const ranked = [...research.items].sort((a, b) => b.rank - a.rank);
    const segments: { path: string; item: ResearchItem }[] = [];
    for (const item of ranked) {
      const p = await downloadClipForQuery(item.rank, item.searchQuery, log);
      segments.push({ path: p, item });
      send({ type: "clips", paths: segments.map((s) => s.path) });
    }
    setStep(send, "clip_hunt", "done");

    /* Voiceover — one timed line per clip + a CTA over the outro */
    currentStep = "voiceover";
    setStep(send, "voiceover", "running");
    log("— Voiceover —");
    const clipDurations = segments.map((s) => s.item.clipDuration);
    const voEvents: VoEvent[] = [];
    if (skipVoiceover) {
      log("Skipping voiceover (SKIP_VOICEOVER=1); export will have no narration.");
    } else if (scriptLines) {
      // Build the list of utterances (one per clip + a CTA over the outro).
      const utts: Utterance[] = [];
      const ats: number[] = [];
      let at = 0;
      for (let i = 0; i < segments.length; i++) {
        const line = scriptLines.lines[i];
        if (line) {
          utts.push({ text: line, base: `vo_${i}` });
          ats.push(at + 0.12); // land just as the clip opens
        }
        at += clipDurations[i];
      }
      if (scriptLines.cta) {
        utts.push({ text: scriptLines.cta, base: "vo_cta" });
        ats.push(at + 0.2); // over the outro
      }
      log(`Voiceover engine: ${ttsEngine()}.`);
      const paths = await synthVoice(utts, log);
      paths.forEach((p, j) => voEvents.push({ path: p, at: ats[j] }));
    }
    setStep(send, "voiceover", "done");

    /* Assemble */
    currentStep = "assemble";
    setStep(send, "assemble", "running");
    log("— Assemble —");
    const total = segments.length;
    const itemsByRankAsc = [...research.items].sort((a, b) => a.rank - b.rank);

    const renderedClips: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const rendered = await renderClip(
        seg.path,
        seg.item.rank,
        i,
        total,
        seg.item.clipDuration,
        seg.item.peakOffsetPct,
        itemsByRankAsc,
        trimTopic,
        log,
      );
      renderedClips.push(rendered);
    }

    const outro = await renderBumper("outro", trimTopic, log);

    const montage = await concatParts([...renderedClips, outro], log);

    const filename = `rankforge-${Date.now()}.mp4`;
    const outPath = path.join(projectPublicOutput(), filename);
    await finalMix(montage, voEvents, clipDurations, outPath, log);
    setStep(send, "assemble", "done");

    /* Export */
    currentStep = "export";
    setStep(send, "export", "running");
    log("— Export —");
    const downloadPath = `/output/${filename}`;
    send({ type: "done", downloadPath, filename });
    setStep(send, "export", "done");
    log(`Ready → ${downloadPath}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`ERROR: ${message}`);
    setStep(send, currentStep, "error", message);
    send({ type: "error", message });
  }
}
