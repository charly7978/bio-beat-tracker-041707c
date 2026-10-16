import type { SanityVerdict } from "./vitalsSanity";

export interface AuditEntry {
  ts: number;
  sessionId: string;
  sample: number;
  windowSize: number;
  verdict: "OK" | "CONSTANT" | "REPETITIVE" | "ZERO_VARIANCE" | "OUT_OF_RANGE";
  detail?: string;
  bpmWindow: number[];
  thresholdsId: string;
}

const MAX_ENTRIES = 500;
const SNAPSHOT_CAP = 30;

let buffer: AuditEntry[] = [];
let sessionId = "no-session";
let thresholdsId = "default";

export function startSession(id: string, profileId: string): void {
  sessionId = id;
  thresholdsId = profileId;
  buffer = [];
}

export function recordVerdict(sample: number, verdict: SanityVerdict, window: number[]): void {
  let verdictTag: AuditEntry["verdict"];
  let detail: string | undefined;
  if (verdict.ok === false) {
    verdictTag = verdict.reason;
    detail = verdict.detail;
  } else {
    verdictTag = "OK";
    detail = undefined;
  }
  const entry: AuditEntry = {
    ts: Date.now(),
    sessionId,
    sample,
    windowSize: window.length,
    verdict: verdictTag,
    detail,
    bpmWindow: window.length > SNAPSHOT_CAP ? window.slice(-SNAPSHOT_CAP) : window.slice(),
    thresholdsId,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}
