import type {
  TranscriptLine,
  ViralityBreakdown,
  WordToken,
  OutputFormat,
} from './types';

export interface ParsedVideoSource {
  valid: boolean;
  sourceType: 'youtube' | 'twitch' | 'kick' | 'video_url' | 'invalid';
  normalizedUrl: string;
  youtubeId?: string;
  error?: string;
}

const YT_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export function parseVideoSource(rawInput: string): ParsedVideoSource {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: false, sourceType: 'invalid', normalizedUrl: '', error: 'Paste a YouTube, Twitch, Kick, or direct video link.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { valid: false, sourceType: 'invalid', normalizedUrl: trimmed, error: 'That does not look like a valid URL.' };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  // YouTube (watch, shorts, live, youtu.be)
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    let videoId: string | null = null;
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (url.pathname.startsWith('/shorts/')) {
      videoId = url.pathname.split('/')[2] ?? null;
    } else if (url.pathname.startsWith('/live/')) {
      videoId = url.pathname.split('/')[2] ?? null;
    } else if (url.pathname.startsWith('/embed/')) {
      videoId = url.pathname.split('/')[2] ?? null;
    } else {
      videoId = url.searchParams.get('v');
    }

    if (videoId && YT_ID_PATTERN.test(videoId)) {
      return {
        valid: true,
        sourceType: 'youtube',
        normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
        youtubeId: videoId,
      };
    }
    return { valid: false, sourceType: 'invalid', normalizedUrl: trimmed, error: 'Could not extract a valid 11-character YouTube video ID.' };
  }

  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    return { valid: true, sourceType: 'twitch', normalizedUrl: url.toString() };
  }

  if (host === 'kick.com') {
    return { valid: true, sourceType: 'kick', normalizedUrl: url.toString() };
  }

  if (/\.(mp4|mov|webm|mkv|m4v)(\?.*)?$/i.test(url.pathname) || url.protocol === 'https:' || url.protocol === 'http:') {
    return { valid: true, sourceType: 'video_url', normalizedUrl: url.toString() };
  }

  return { valid: false, sourceType: 'invalid', normalizedUrl: trimmed, error: 'Unsupported video link format.' };
}

export function parseTimestampSeconds(timestamp: string): number {
  const clean = timestamp.trim().replace(/^\[|\]$/g, '');
  const parts = clean.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const tenths = Math.floor((clamped - Math.floor(clamped)) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function snapBoundsToTranscript(
  lines: TranscriptLine[],
  requestedStart: number,
  requestedEnd: number,
  toleranceSeconds = 8,
): { startSeconds: number; endSeconds: number; startTime: string; endTime: string } | null {
  if (!lines.length || requestedEnd <= requestedStart) return null;

  let bestStart = lines[0];
  let bestStartDist = Math.abs(lines[0].startSeconds - requestedStart);
  for (const line of lines) {
    const dist = Math.abs(line.startSeconds - requestedStart);
    if (dist < bestStartDist) {
      bestStartDist = dist;
      bestStart = line;
    }
  }

  let bestEnd = lines[lines.length - 1];
  let bestEndDist = Math.abs(lines[lines.length - 1].endSeconds - requestedEnd);
  for (const line of lines) {
    const dist = Math.abs(line.endSeconds - requestedEnd);
    if (dist < bestEndDist) {
      bestEndDist = dist;
      bestEnd = line;
    }
  }

  if (bestStartDist > toleranceSeconds || bestEndDist > toleranceSeconds) {
    return {
      startSeconds: Math.max(0, requestedStart),
      endSeconds: Math.max(requestedStart + 1, requestedEnd),
      startTime: formatTimestamp(requestedStart),
      endTime: formatTimestamp(requestedEnd),
    };
  }

  if (bestEnd.endSeconds <= bestStart.startSeconds) {
    return null;
  }

  return {
    startSeconds: bestStart.startSeconds,
    endSeconds: bestEnd.endSeconds,
    startTime: bestStart.startTime,
    endTime: bestEnd.endTime,
  };
}

export function computeViralityTotal(
  hookScore: number,
  engagementScore: number,
  valueScore: number,
  shareabilityScore: number,
): number {
  const clamp25 = (v: number) => Math.max(0, Math.min(25, Math.round(v)));
  return clamp25(hookScore) + clamp25(engagementScore) + clamp25(valueScore) + clamp25(shareabilityScore);
}

export function normalizeVirality(v: Partial<ViralityBreakdown>): ViralityBreakdown {
  const clamp25 = (n: unknown, fallback: number) => {
    const num = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    return Math.max(0, Math.min(25, Math.round(num)));
  };
  const hookScore = clamp25(v.hookScore, 18);
  const engagementScore = clamp25(v.engagementScore, 18);
  const valueScore = clamp25(v.valueScore, 17);
  const shareabilityScore = clamp25(v.shareabilityScore, 17);
  const totalScore = computeViralityTotal(hookScore, engagementScore, valueScore, shareabilityScore);
  return {
    hookScore,
    engagementScore,
    valueScore,
    shareabilityScore,
    totalScore,
    hookType: v.hookType?.trim() || 'Curiosity Hook',
    viralityReasoning: v.viralityReasoning?.trim() || 'Strong self-contained argument with clear opening tension.',
  };
}

export function viralityTierLabel(score: number): { label: string; tone: 'high' | 'mid' | 'low' } {
  if (score >= 85) return { label: 'High Viral', tone: 'high' };
  if (score >= 70) return { label: 'Strong', tone: 'mid' };
  return { label: 'Standard', tone: 'low' };
}

export function dedupeOverlappingSegments<T extends { startSeconds: number; endSeconds: number; virality: { totalScore: number } }>(
  segments: T[],
  maxOverlapRatio = 0.5,
): T[] {
  const sorted = [...segments].sort((a, b) => b.virality.totalScore - a.virality.totalScore);
  const kept: T[] = [];

  for (const candidate of sorted) {
    const candDur = Math.max(1, candidate.endSeconds - candidate.startSeconds);
    const overlaps = kept.some((existing) => {
      const overlapStart = Math.max(existing.startSeconds, candidate.startSeconds);
      const overlapEnd = Math.min(existing.endSeconds, candidate.endSeconds);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const existingDur = Math.max(1, existing.endSeconds - existing.startSeconds);
      return overlap / Math.min(candDur, existingDur) > maxOverlapRatio;
    });
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

export function buildWordTokensFromLines(
  lines: TranscriptLine[],
  clipStartSeconds: number,
  clipEndSeconds: number,
): WordToken[] {
  const relevant = lines
    .filter((l) => l.endSeconds > clipStartSeconds && l.startSeconds < clipEndSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const tokens: WordToken[] = [];
  let prevEnd = 0;

  for (const line of relevant) {
    const rawSegStart = Math.max(clipStartSeconds, line.startSeconds) - clipStartSeconds;
    const rawSegEnd = Math.min(clipEndSeconds, line.endSeconds) - clipStartSeconds;
    const rawWords = line.text.trim().split(/\s+/).filter(Boolean);
    if (!rawWords.length || rawSegEnd <= 0) continue;

    // Enforce strict non-overlapping monotonic timeline so overlapping transcript lines
    // never stack on screen at the same instant.
    const segStart = Math.max(prevEnd, rawSegStart);
    const minSpan = Math.min(rawWords.length * 0.22, 1.4);
    const segEnd = Math.max(segStart + 0.15, Math.min(clipEndSeconds - clipStartSeconds, Math.max(rawSegEnd, segStart + minSpan)));
    if (segEnd <= segStart) continue;

    const totalChars = rawWords.reduce((acc, w) => acc + Math.max(1, w.length), 0);
    let cursor = segStart;
    const span = segEnd - segStart;

    for (let i = 0; i < rawWords.length; i++) {
      const word = rawWords[i];
      const weight = Math.max(1, word.length) / totalChars;
      const wDur = span * weight;
      const end = i === rawWords.length - 1 ? segEnd : cursor + wDur;
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      const emphasis = clean.length >= 7 || /^\d+[%$xMkK]?$/.test(clean);
      tokens.push({
        word,
        start: Number(cursor.toFixed(3)),
        end: Number(end.toFixed(3)),
        emphasis,
      });
      cursor = end;
    }
    prevEnd = segEnd;
  }

  return tokens;
}

export interface CaptionChunk {
  words: Array<WordToken & { globalIndex: number }>;
  start: number;
  end: number;
}

export function groupWordsIntoCaptionLines(
  words: WordToken[],
  maxWordsPerLine: number,
): CaptionChunk[] {
  const size = Math.max(1, Math.min(8, Math.round(maxWordsPerLine || 4)));
  const chunks: CaptionChunk[] = [];
  let prevEnd = 0;

  for (let i = 0; i < words.length; i += size) {
    const slice = words.slice(i, i + size).map((w, offset) => ({
      ...w,
      globalIndex: i + offset,
    }));
    if (slice.length > 0) {
      const start = Math.max(prevEnd, slice[0].start);
      const end = Math.max(start + 0.12, slice[slice.length - 1].end);
      chunks.push({
        words: slice,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
      });
      prevEnd = end;
    }
  }
  return chunks;
}

export function findActiveCaptionAtTime(
  chunks: CaptionChunk[],
  localTimeSeconds: number,
): { chunk: CaptionChunk | null; activeWordIndex: number } {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const nextStart = i + 1 < chunks.length ? chunks[i + 1].start : chunk.end + 0.15;
    const windowStart = i === 0 ? Math.max(0, chunk.start - 0.04) : chunk.start;
    const windowEnd = Math.min(nextStart, chunk.end + 0.12);

    if (localTimeSeconds >= windowStart && localTimeSeconds < windowEnd) {
      let activeWordIndex = chunk.words[0]?.globalIndex ?? -1;
      for (const w of chunk.words) {
        if (localTimeSeconds >= w.start - 0.02) {
          activeWordIndex = w.globalIndex;
        }
      }
      return { chunk, activeWordIndex };
    }
  }
  return { chunk: null, activeWordIndex: -1 };
}

export function clampTrimRange(
  duration: number,
  trimStart: number,
  trimEnd: number,
  minLength = 3,
): { trimStartOffset: number; trimEndOffset: number } {
  const safeDur = Math.max(minLength, duration);
  const start = Math.max(0, Math.min(trimStart, safeDur - minLength));
  const end = Math.max(0, Math.min(trimEnd, safeDur - start - minLength));
  return {
    trimStartOffset: Number(start.toFixed(2)),
    trimEndOffset: Number(end.toFixed(2)),
  };
}

export function computeAspectRatioCss(format: OutputFormat): string {
  switch (format) {
    case 'vertical':
      return '9 / 16';
    case 'portrait':
      return '4 / 5';
    case 'square':
      return '1 / 1';
    case 'landscape':
      return '16 / 9';
  }
}

export function splitWordsAtTime(
  words: WordToken[],
  splitTimeSeconds: number,
): { firstHalf: WordToken[]; secondHalf: WordToken[] } {
  const firstHalf: WordToken[] = [];
  const secondHalf: WordToken[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (mid < splitTimeSeconds) {
      firstHalf.push({ ...w });
    } else {
      secondHalf.push({
        ...w,
        start: Math.max(0, Number((w.start - splitTimeSeconds).toFixed(3))),
        end: Math.max(0.05, Number((w.end - splitTimeSeconds).toFixed(3))),
      });
    }
  }
  return { firstHalf, secondHalf };
}

export function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const adjustedSecs = ms === 1000 ? secs + 1 : secs;
  const adjustedMs = ms === 1000 ? 0 : ms;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(adjustedSecs).padStart(2, '0')},${String(adjustedMs).padStart(3, '0')}`;
}

export function buildSrtFromWords(words: WordToken[], wordsPerLine = 4): string {
  const chunks = groupWordsIntoCaptionLines(words, wordsPerLine);
  let prevEnd = 0;
  return chunks
    .map((c, idx) => {
      const start = Math.max(prevEnd, c.start);
      const nextStart = idx + 1 < chunks.length ? chunks[idx + 1].start : Number.POSITIVE_INFINITY;
      const rawEnd = Math.max(start + 0.15, c.end);
      const end = Math.min(rawEnd, nextStart - 0.01);
      const safeEnd = Math.max(start + 0.08, end);
      prevEnd = safeEnd;
      const text = c.words.map((w) => w.word).join(' ');
      return `${idx + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(safeEnd)}\n${text}\n`;
    })
    .join('\n');
}

export function computeTargetClipCount(durationSeconds: number): { min: number; max: number } {
  const safeDur = Math.max(0, Number(durationSeconds) || 0);
  if (safeDur <= 120) {
    return { min: 3, max: 6 };
  }
  if (safeDur <= 300) {
    return { min: 6, max: 12 };
  }
  if (safeDur <= 600) {
    return { min: 12, max: 18 };
  }
  if (safeDur <= 1200) {
    return { min: 18, max: 25 };
  }
  return { min: 22, max: 28 };
}

export interface TimelineWindow {
  index: number;
  startSeconds: number;
  endSeconds: number;
}

export function buildTimeWindows(
  durationSeconds: number,
  maxWindows = 5,
): TimelineWindow[] {
  const safeDur = Math.max(30, Math.round(Number(durationSeconds) || 60));
  if (safeDur < 240 || maxWindows <= 1) {
    return [{ index: 0, startSeconds: 0, endSeconds: safeDur }];
  }

  const desiredWindows = safeDur >= 1500 ? Math.min(maxWindows, 5) : safeDur >= 720 ? Math.min(maxWindows, 4) : 3;
  const step = Math.ceil(safeDur / desiredWindows);
  const windows: TimelineWindow[] = [];

  for (let i = 0; i < desiredWindows; i++) {
    const startSeconds = Math.max(0, i * step - (i > 0 ? 15 : 0));
    const endSeconds = i === desiredWindows - 1 ? safeDur : Math.min(safeDur, (i + 1) * step + 10);
    if (endSeconds > startSeconds + 20) {
      windows.push({ index: i, startSeconds, endSeconds });
    }
  }
  return windows;
}


