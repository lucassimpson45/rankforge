export type StepId =
  | "research"
  | "script"
  | "clip_hunt"
  | "voiceover"
  | "assemble"
  | "export";

export type StepStatus = "idle" | "running" | "done" | "error";

export type SsePayload =
  | { type: "step"; step: StepId; status: StepStatus; detail?: string }
  | { type: "log"; message: string }
  | { type: "clips"; paths: string[] }
  | { type: "done"; downloadPath: string; filename: string }
  | { type: "error"; message: string };

export type ResearchItem = {
  rank: number;
  title: string;
  viralityReason: string;
  searchQuery: string;
  /** Seconds this clip should occupy in the final Short (Claude-assigned) */
  clipDuration: number;
  /** Claude's estimate of where the key moment is, 0–100% through the video */
  peakOffsetPct: number;
};

export type ResearchResult = {
  topicViralityScore: number;
  /** Total target runtime in seconds — Claude keeps this 30-45 */
  targetDurationSeconds: number;
  items: ResearchItem[];
};
