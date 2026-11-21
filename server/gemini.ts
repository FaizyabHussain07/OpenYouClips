import fs from 'node:fs';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  ClipItem,
  ClipLengthPreset,
  TranscriptLine,
  ViralityBreakdown,
  WorkflowMode,
} from '../src/lib/types.ts';
import { CLIP_LENGTH_OPTIONS } from '../src/lib/templates.ts';
import {
  buildTimeWindows,
  computeTargetClipCount,
  dedupeOverlappingSegments,
  formatTimestamp,
  normalizeVirality,
  parseTimestampSeconds,
  snapBoundsToTranscript,
} from '../src/lib/clip-logic.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured in server environment Secrets. Add GEMINI_API_KEY in Settings > Secrets to run live AI transcription and viral clip discovery.',
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      timeout: 120000,
    },
  });
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|502|504|500|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|try again|timeout|timed out|aborted|AbortError|TimeoutError|ECONNRESET|fetch failed/i.test(
    msg,
  );
}

export function formatGeminiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: number } };
    if (parsed?.error?.message) {
      return formatGeminiErrorMessage(parsed.error.message);
    }
  } catch {
    // Not raw JSON
  }
  if (/high demand|503|UNAVAILABLE/i.test(raw)) {
    return 'Gemini is experiencing a temporary spike in demand across all free-tier models. Wait a few seconds and click Retry Analysis, or upload a video file directly.';
  }
  if (/operation was aborted|AbortError|TimeoutError|timed out/i.test(raw)) {
    return 'Gemini analysis timed out while processing this video. Click Retry Analysis or try a shorter video / direct MP4 upload.';
  }
  return raw;
}

async function withGeminiRetry<T>(
  runner: (model: string, attemptNumber: number, totalAttempts: number) => Promise<T>,
  primaryModel = 'gemini-3.1-flash-lite',
  fallbackModel = 'gemini-4-hydrogen',
  onRetry?: (info: { attempt: number; total: number; nextModel: string; reason: string }) => void,
): Promise<T> {
  const attempts: Array<{ model: string; delayMs: number }> = [
    { model: primaryModel, delayMs: 0 },
    { model: fallbackModel, delayMs: 1200 },
    { model: primaryModel, delayMs: 2800 },
    { model: fallbackModel, delayMs: 4500 },
    { model: primaryModel, delayMs: 6500 },
  ];

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { model, delayMs } = attempts[i];
    if (delayMs > 0) {
      const jitter = Math.floor(Math.random() * 450);
      await new Promise((r) => setTimeout(r, delayMs + jitter));
    }
    try {
      return await runner(model, i + 1, attempts.length);
    } catch (err) {
      lastErr = err;
      const msg = formatGeminiErrorMessage(err);
      if (!isTransientGeminiError(err) || i === attempts.length - 1) {
        throw new Error(msg);
      }
      const nextModel = attempts[i + 1].model;
      onRetry?.({
        attempt: i + 1,
        total: attempts.length,
        nextModel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new Error(formatGeminiErrorMessage(lastErr));
}

export async function transcribeAudioWithGemini(
  audioPath: string,
  durationSeconds: number,
): Promise<TranscriptLine[]> {
  const ai = getGeminiClient();
  const audioBuffer = fs.readFileSync(audioPath);
  const base64Audio = audioBuffer.toString('base64');

  const response = await withGeminiRetry(
    (model) =>
      ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/mp3',
                data: base64Audio,
              },
            },
            {
              text: `Transcribe this ${Math.max(10, durationSeconds)}-second audio accurately into timestamped spoken segments. Return valid JSON only matching the schema, with startSeconds, endSeconds, and text for each spoken sentence or phrase.`,
            },
          ],
        },
        config: {
          abortSignal: AbortSignal.timeout(90000),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    startSeconds: { type: Type.NUMBER },
                    endSeconds: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: ['startSeconds', 'endSeconds', 'text'],
                },
              },
            },
            required: ['segments'],
          },
        },
      }),
    'gemini-3.5-transcribe',
    'gemini-3.1-flash-lite',
  );

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    segments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  };
  const lines: TranscriptLine[] = [];
  for (const seg of parsed.segments ?? []) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const startSec = Math.max(0, Number(seg.startSeconds) || 0);
    const endSec = Math.max(startSec + 0.5, Number(seg.endSeconds) || startSec + 3);
    lines.push({
      startTime: formatTimestamp(startSec),
      endTime: formatTimestamp(endSec),
      startSeconds: startSec,
      endSeconds: endSec,
      text,
    });
  }
  return lines;
}

export interface AnalyzedClipCandidate {
  startSeconds: number;
  endSeconds: number;
  startTime: string;
  endTime: string;
  hookTitle: string;
  text: string;
  reasoning: string;
  virality: ViralityBreakdown;
  workflowRole: 'highlight' | 'part' | 'topic' | 'recap' | 'trailer';
  partNumber?: number;
}

export interface TranscriptAnalysisResult {
  summary: string;
  keyTopics: string[];
  segments: AnalyzedClipCandidate[];
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function analyzeTranscriptForClips(params: {
  title: string;
  transcript: TranscriptLine[];
  durationSeconds: number;
  workflow: WorkflowMode;
  clipLength: ClipLengthPreset;
  topicFocus?: string;
  customInstructions?: string;
  onProgressNotice?: (message: string) => void;
}): Promise<TranscriptAnalysisResult> {
  const ai = getGeminiClient();
  const {
    title,
    transcript,
    durationSeconds,
    workflow,
    clipLength,
    topicFocus,
    customInstructions,
    onProgressNotice,
  } = params;

  const lengthSpec = CLIP_LENGTH_OPTIONS.find((o) => o.id === clipLength) ?? CLIP_LENGTH_OPTIONS[0];
  const minClip = Math.min(lengthSpec.minSeconds, Math.max(10, Math.floor(durationSeconds * 0.4)));
  const maxClip = Math.min(lengthSpec.maxSeconds, Math.max(minClip + 10, durationSeconds));
  const clipTarget = computeTargetClipCount(durationSeconds);

  const roleMap: Record<WorkflowMode, AnalyzedClipCandidate['workflowRole']> = {
    highlights: 'highlight',
    series: 'part',
    topic: 'topic',
    recap: 'recap',
    trailer: 'trailer',
  };

  const windows =
    durationSeconds >= 240 || transcript.length > 180
      ? buildTimeWindows(durationSeconds, 5)
      : [{ index: 0, startSeconds: 0, endSeconds: Math.max(30, durationSeconds) }];

  const perWindowMax =
    windows.length === 1
      ? clipTarget.max
      : Math.max(5, Math.min(8, Math.ceil(clipTarget.max / windows.length) + 2));

  const analyzeWindow = async (
    windowLines: TranscriptLine[],
    windowLabel: string,
    avoidRangesNote?: string,
  ): Promise<{
    summary: string;
    keyTopics: string[];
    candidates: AnalyzedClipCandidate[];
  }> => {
    const formattedTranscript = windowLines
      .slice(0, 320)
      .map((line) => `[${line.startTime} - ${line.endTime}] ${line.text}`)
      .join('\n');

    const workflowPromptMap: Record<WorkflowMode, string> = {
      highlights: `Extract ALL qualifying standalone high-retention YouTube Shorts / TikTok / Reels viral clips in this segment (target ${perWindowMax} distinct clips, up to ${clipTarget.max} total across the full video). Prioritize advertiser-friendly, replay-worthy hooks that maximize views & watch time.`,
      series: `Divide this segment into ${Math.max(3, perWindowMax)} sequential chronological parts telling a continuous story.`,
      topic: `Focus specifically on segments discussing "${topicFocus || 'core insights'}". Extract up to ${perWindowMax} matching viral clips in this window.`,
      recap: `Select ${Math.min(6, perWindowMax)} essential narrative beats from this segment for a tight recap.`,
      trailer: `Select ${Math.min(6, perWindowMax)} highest-energy curiosity moments in this segment for a hype trailer.`,
    };

    const systemInstruction = `You are an expert short-form video editor and viral growth strategist (OpenYouClips AI).
Your job is exhaustive span extraction and virality ranking for YouTube Shorts, TikTok Creativity Program, and Instagram Reels monetization.

WORKFLOW MODE: ${workflow.toUpperCase()}
${workflowPromptMap[workflow]}
${avoidRangesNote ? `\nDO NOT REPEAT ALREADY COVERED TIME RANGES:\n${avoidRangesNote}\nFind NEW non-overlapping viral moments outside those ranges.` : ''}
${customInstructions ? `\nUSER CREATIVE DIRECTION: ${customInstructions}` : ''}

STRICT GROUNDING RULES:
1. Use ONLY timestamps and spoken text present in the provided transcript window (${windowLabel}).
2. Mine the entire window evenly — do not stop after 2-3 clips if more strong hooks, emotional spikes, stories, or valuable insights exist.
3. Every clip duration MUST be between ${minClip} and ${maxClip} seconds (unless the total source is shorter).
4. Each clip needs:
   - hookTitle: catchy <= 9 word Shorts/TikTok headline
   - startTime / endTime: exact MM:SS or H:MM:SS timestamps from the transcript
   - text: exact verbatim spoken quote from the chosen span
   - reasoning: concise 1-sentence monetization/retention note
   - virality: 4 integer subscores (0-25 each): hookScore, engagementScore, valueScore, shareabilityScore, plus hookType and viralityReasoning.`;

    const response = await withGeminiRetry(
      (model) =>
        ai.models.generateContent({
          model,
          contents: `VIDEO TITLE: ${title}\nWINDOW: ${windowLabel} (Total video duration: ${formatTimestamp(durationSeconds)})\n\nTIMESTAMPED TRANSCRIPT:\n${formattedTranscript}`,
          config: {
            abortSignal: AbortSignal.timeout(65000),
            ...(model === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                keyTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
                segments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startTime: { type: Type.STRING },
                      endTime: { type: Type.STRING },
                      hookTitle: { type: Type.STRING },
                      text: { type: Type.STRING },
                      reasoning: { type: Type.STRING },
                      hookScore: { type: Type.INTEGER },
                      engagementScore: { type: Type.INTEGER },
                      valueScore: { type: Type.INTEGER },
                      shareabilityScore: { type: Type.INTEGER },
                      hookType: { type: Type.STRING },
                      viralityReasoning: { type: Type.STRING },
                    },
                    required: [
                      'startTime',
                      'endTime',
                      'hookTitle',
                      'text',
                      'reasoning',
                      'hookScore',
                      'engagementScore',
                      'valueScore',
                      'shareabilityScore',
                      'hookType',
                      'viralityReasoning',
                    ],
                  },
                },
              },
              required: ['summary', 'keyTopics', 'segments'],
            },
          },
        }),
      'gemini-3.1-flash-lite',
      'gemini-4-hydrogen',
    );

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      summary?: string;
      keyTopics?: string[];
      segments?: Array<{
        startTime: string;
        endTime: string;
        hookTitle: string;
        text: string;
        reasoning: string;
        hookScore: number;
        engagementScore: number;
        valueScore: number;
        shareabilityScore: number;
        hookType: string;
        viralityReasoning: string;
      }>;
    };

    const candidates: AnalyzedClipCandidate[] = [];
    for (let i = 0; i < (raw.segments ?? []).length; i++) {
      const seg = raw.segments![i];
      const reqStart = parseTimestampSeconds(seg.startTime);
      const reqEnd = parseTimestampSeconds(seg.endTime);
      const snapped = snapBoundsToTranscript(transcript, reqStart, reqEnd, 8);
      if (!snapped) continue;

      candidates.push({
        startSeconds: snapped.startSeconds,
        endSeconds: snapped.endSeconds,
        startTime: snapped.startTime,
        endTime: snapped.endTime,
        hookTitle: (seg.hookTitle || `Clip ${i + 1}`).trim().slice(0, 72),
        text: (seg.text || '').trim(),
        reasoning: (seg.reasoning || '').trim(),
        virality: normalizeVirality({
          hookScore: seg.hookScore,
          engagementScore: seg.engagementScore,
          valueScore: seg.valueScore,
          shareabilityScore: seg.shareabilityScore,
          hookType: seg.hookType,
          viralityReasoning: seg.viralityReasoning,
        }),
        workflowRole: roleMap[workflow],
        partNumber: workflow === 'series' ? i + 1 : undefined,
      });
    }

    return {
      summary: (raw.summary ?? '').trim(),
      keyTopics: raw.keyTopics ?? [],
      candidates,
    };
  };

  let allCandidates: AnalyzedClipCandidate[] = [];
  let mainSummary = '';
  const allTopics = new Set<string>();
  let completedWindows = 0;

  if (windows.length === 1) {
    const first = await analyzeWindow(
      transcript,
      `0:00 – ${formatTimestamp(durationSeconds)}`,
    );
    mainSummary = first.summary;
    first.keyTopics.forEach((t) => allTopics.add(t));
    allCandidates.push(...first.candidates);

    // If first pass under-extracted on a 90s+ video, run 1 supplement pass targeting uncovered spans
    if (allCandidates.length < clipTarget.min && durationSeconds >= 90 && transcript.length >= 12) {
      onProgressNotice?.(
        `Virality Agent: Found ${allCandidates.length} clips in pass 1 — deep-mining additional viral moments…`,
      );
      try {
        const covered = allCandidates.map((c) => `${c.startTime}–${c.endTime}`).join(', ');
        const second = await analyzeWindow(
          transcript,
          `0:00 – ${formatTimestamp(durationSeconds)} (Supplement Pass)`,
          covered,
        );
        second.keyTopics.forEach((t) => allTopics.add(t));
        allCandidates.push(...second.candidates);
      } catch {
        // Keep first-pass candidates if supplement fails transiently
      }
    }
  } else {
    const windowResults = await runWithConcurrency(windows, 2, async (win) => {
      const label = `${formatTimestamp(win.startSeconds)} – ${formatTimestamp(win.endSeconds)}`;
      const slice = transcript.filter(
        (l) => l.endSeconds >= win.startSeconds - 5 && l.startSeconds <= win.endSeconds + 5,
      );
      if (slice.length < 3) {
        return { summary: '', keyTopics: [] as string[], candidates: [] as AnalyzedClipCandidate[] };
      }
      try {
        const res = await analyzeWindow(slice, label);
        completedWindows += 1;
        onProgressNotice?.(
          `Virality Agent: Scanned window ${completedWindows}/${windows.length} (${label}) — ${res.candidates.length} hooks mined…`,
        );
        return res;
      } catch {
        return { summary: '', keyTopics: [] as string[], candidates: [] as AnalyzedClipCandidate[] };
      }
    });

    for (const r of windowResults) {
      if (!mainSummary && r.summary) mainSummary = r.summary;
      r.keyTopics.forEach((t) => allTopics.add(t));
      allCandidates.push(...r.candidates);
    }

    if (allCandidates.length === 0) {
      // Fallback full-transcript attempt if every segmented window came up empty
      const fallback = await analyzeWindow(
        transcript.slice(0, 350),
        `0:00 – ${formatTimestamp(durationSeconds)}`,
      );
      mainSummary = mainSummary || fallback.summary;
      fallback.keyTopics.forEach((t) => allTopics.add(t));
      allCandidates.push(...fallback.candidates);
    }
  }

  let finalSegments =
    workflow === 'series'
      ? [...allCandidates].sort((a, b) => a.startSeconds - b.startSeconds)
      : dedupeOverlappingSegments(allCandidates, 0.35);

  finalSegments = finalSegments.slice(0, clipTarget.max);
  if (workflow === 'series') {
    finalSegments = finalSegments.map((s, idx) => ({ ...s, partNumber: idx + 1 }));
  }

  return {
    summary: (mainSummary || `AI-curated short-form clips from ${title}`).trim(),
    keyTopics: Array.from(allTopics).slice(0, 8),
    segments: finalSegments,
  };
}

export interface DirectYouTubeAnalysisResult extends TranscriptAnalysisResult {
  transcript: TranscriptLine[];
  estimatedDurationSeconds: number;
}

export async function analyzeYouTubeUrlDirectlyWithGemini(params: {
  youtubeUrl: string;
  title: string;
  workflow: WorkflowMode;
  clipLength: ClipLengthPreset;
  topicFocus?: string;
  customInstructions?: string;
  onRetryNotice?: (message: string) => void;
}): Promise<DirectYouTubeAnalysisResult> {
  const ai = getGeminiClient();
  const {
    youtubeUrl,
    title,
    workflow,
    clipLength,
    topicFocus,
    customInstructions,
    onRetryNotice,
  } = params;

  const lengthSpec = CLIP_LENGTH_OPTIONS.find((o) => o.id === clipLength) ?? CLIP_LENGTH_OPTIONS[0];
  const roleMap: Record<WorkflowMode, AnalyzedClipCandidate['workflowRole']> = {
    highlights: 'highlight',
    series: 'part',
    topic: 'topic',
    recap: 'recap',
    trailer: 'trailer',
  };

  const runDirectCall = async (opts: {
    startOffsetSec?: number;
    endOffsetSec?: number;
    fps: number;
    targetClipHint: string;
    avoidSpans?: string;
  }): Promise<{
    summary: string;
    estimatedDurationSeconds: number;
    keyTopics: string[];
    transcript: TranscriptLine[];
    candidates: AnalyzedClipCandidate[];
  }> => {
    const windowNote =
      opts.startOffsetSec !== undefined && opts.endOffsetSec !== undefined
        ? `WINDOW FOCUS: ${formatTimestamp(opts.startOffsetSec)} to ${formatTimestamp(opts.endOffsetSec)} ONLY.`
        : 'Scan the ENTIRE video timeline (start, middle, peaks, finale).';

    const workflowPromptMap: Record<WorkflowMode, string> = {
      highlights: `${windowNote} Extract ${opts.targetClipHint} distinct, non-overlapping high-virality YouTube Shorts / TikTok / Reels highlight clips optimized for watch-time, retention, and monetization.`,
      series: `${windowNote} Divide into ${opts.targetClipHint} sequential chronological parts telling a continuous story.`,
      topic: `${windowNote} Focus specifically on segments discussing "${topicFocus || 'core insights'}". Extract ${opts.targetClipHint} matching viral clips.`,
      recap: `${windowNote} Select ${opts.targetClipHint} essential narrative beats for a tight recap.`,
      trailer: `${windowNote} Select ${opts.targetClipHint} highest-energy moments for a hype trailer.`,
    };

    const systemInstruction = `You are an expert short-form video editor and viral growth strategist (OpenYouClips AI).
Watch and listen to the provided YouTube video segment carefully.

WORKFLOW MODE: ${workflow.toUpperCase()}
${workflowPromptMap[workflow]}
${opts.avoidSpans ? `AVOID OVERLAPPING ALREADY FOUND SPANS: ${opts.avoidSpans}` : ''}
${customInstructions ? `USER CREATIVE DIRECTION: ${customInstructions}` : ''}

REQUIREMENTS:
1. Produce a timestamped "transcript" array with verbatim dialogue / reaction beats (15 to 45 entries across this span), using exact MM:SS or H:MM:SS timestamps from the full source timeline.
2. Extract ${opts.targetClipHint} qualifying clip "segments" grounded in exact timestamps (${lengthSpec.minSeconds}–${lengthSpec.maxSeconds}s each unless source is shorter). Keep reasoning concise (1 short sentence).
3. Each segment must include startTime, endTime, hookTitle (<= 9 words), text (verbatim spoken dialogue quote), reasoning, hookScore, engagementScore, valueScore, shareabilityScore (0-25), hookType, and viralityReasoning.
4. Return estimatedDurationSeconds (integer total source video duration in seconds).`;

    return await withGeminiRetry(
      async (model, attemptNumber) => {
        const t0 = Date.now();
        const videoMeta: { fps?: number; startOffset?: string; endOffset?: string } = {};
        if (attemptNumber <= 3) {
          videoMeta.fps = opts.fps;
        }
        if (opts.startOffsetSec !== undefined && opts.endOffsetSec !== undefined) {
          videoMeta.startOffset = `${Math.max(0, Math.floor(opts.startOffsetSec))}s`;
          videoMeta.endOffset = `${Math.max(10, Math.ceil(opts.endOffsetSec))}s`;
        }

        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                fileData: { fileUri: youtubeUrl },
                ...(Object.keys(videoMeta).length > 0 ? { videoMetadata: videoMeta } : {}),
              },
              {
                text: `Analyze "${title}"${opts.startOffsetSec !== undefined ? ` between ${formatTimestamp(opts.startOffsetSec)} and ${formatTimestamp(opts.endOffsetSec!)}` : ''} and return timestamped transcript + all viral short-form clip segments in JSON.`,
              },
            ],
          },
          config: {
            abortSignal: AbortSignal.timeout(70000),
            ...(model === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                estimatedDurationSeconds: { type: Type.INTEGER },
                keyTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
                transcript: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startTime: { type: Type.STRING },
                      endTime: { type: Type.STRING },
                      text: { type: Type.STRING },
                    },
                    required: ['startTime', 'endTime', 'text'],
                  },
                },
                segments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startTime: { type: Type.STRING },
                      endTime: { type: Type.STRING },
                      hookTitle: { type: Type.STRING },
                      text: { type: Type.STRING },
                      reasoning: { type: Type.STRING },
                      hookScore: { type: Type.INTEGER },
                      engagementScore: { type: Type.INTEGER },
                      valueScore: { type: Type.INTEGER },
                      shareabilityScore: { type: Type.INTEGER },
                      hookType: { type: Type.STRING },
                      viralityReasoning: { type: Type.STRING },
                    },
                    required: [
                      'startTime',
                      'endTime',
                      'hookTitle',
                      'text',
                      'reasoning',
                      'hookScore',
                      'engagementScore',
                      'valueScore',
                      'shareabilityScore',
                      'hookType',
                      'viralityReasoning',
                    ],
                  },
                },
              },
              required: ['summary', 'estimatedDurationSeconds', 'keyTopics', 'transcript', 'segments'],
            },
          },
        });

        const raw = JSON.parse((response.text ?? '{}').trim()) as {
          summary?: string;
          estimatedDurationSeconds?: number;
          keyTopics?: string[];
          transcript?: Array<{ startTime: string; endTime: string; text: string }>;
          segments?: Array<{
            startTime: string;
            endTime: string;
            hookTitle: string;
            text: string;
            reasoning: string;
            hookScore: number;
            engagementScore: number;
            valueScore: number;
            shareabilityScore: number;
            hookType: string;
            viralityReasoning: string;
          }>;
        };

        const transcript: TranscriptLine[] = (raw.transcript ?? [])
          .map((line) => {
            const startSec = parseTimestampSeconds(line.startTime);
            const endSec = Math.max(startSec + 1, parseTimestampSeconds(line.endTime));
            return {
              startTime: formatTimestamp(startSec),
              endTime: formatTimestamp(endSec),
              startSeconds: startSec,
              endSeconds: endSec,
              text: (line.text ?? '').trim(),
            };
          })
          .filter((l) => l.text.length > 0);

        const candidates: AnalyzedClipCandidate[] = [];
        for (let i = 0; i < (raw.segments ?? []).length; i++) {
          const seg = raw.segments![i];
          const startSec = parseTimestampSeconds(seg.startTime);
          const endSec = Math.max(startSec + 4, parseTimestampSeconds(seg.endTime));

          const hasCoveringLines = transcript.some(
            (l) => l.endSeconds > startSec && l.startSeconds < endSec,
          );
          if (!hasCoveringLines && seg.text?.trim()) {
            transcript.push({
              startTime: formatTimestamp(startSec),
              endTime: formatTimestamp(endSec),
              startSeconds: startSec,
              endSeconds: endSec,
              text: seg.text.trim(),
            });
          }

          candidates.push({
            startSeconds: startSec,
            endSeconds: endSec,
            startTime: formatTimestamp(startSec),
            endTime: formatTimestamp(endSec),
            hookTitle: (seg.hookTitle || `Clip ${i + 1}`).trim().slice(0, 72),
            text: (seg.text || '').trim(),
            reasoning: (seg.reasoning || '').trim(),
            virality: normalizeVirality({
              hookScore: seg.hookScore,
              engagementScore: seg.engagementScore,
              valueScore: seg.valueScore,
              shareabilityScore: seg.shareabilityScore,
              hookType: seg.hookType,
              viralityReasoning: seg.viralityReasoning,
            }),
            workflowRole: roleMap[workflow],
            partNumber: workflow === 'series' ? i + 1 : undefined,
          });
        }

        if (candidates.length === 0) {
          console.warn(
            `[Gemini] Empty segments from ${model} in ${Date.now() - t0}ms for ${youtubeUrl}. Summary: ${(raw.summary ?? '').slice(0, 120)}`,
          );
          throw new Error('UNAVAILABLE: Model returned 0 clip segments, retrying fallback model.');
        }

        return {
          summary: (raw.summary ?? '').trim(),
          estimatedDurationSeconds: raw.estimatedDurationSeconds || 0,
          keyTopics: raw.keyTopics ?? [],
          transcript,
          candidates,
        };
      },
      'gemini-3.1-flash-lite',
      'gemini-4-hydrogen',
      ({ attempt, total, nextModel }) => {
        onRetryNotice?.(
          `Model demand spike on attempt ${attempt}/${total} — switching to ${nextModel} automatically…`,
        );
      },
    );
  };

  // Pass 1: Overview scan across full YouTube timeline
  const pass1 = await runDirectCall({
    fps: 0.12,
    targetClipHint: '8 to 14',
  });

  const combinedTranscript = [...pass1.transcript];
  const combinedCandidates = [...pass1.candidates];
  const topics = new Set<string>(pass1.keyTopics);

  const maxSegEnd = combinedCandidates.reduce((m, c) => Math.max(m, c.endSeconds), 0);
  let estimatedDurationSeconds = Math.max(
    pass1.estimatedDurationSeconds || 0,
    maxSegEnd,
    combinedTranscript[combinedTranscript.length - 1]?.endSeconds || 60,
  );

  const clipTarget = computeTargetClipCount(estimatedDurationSeconds);

  // Pass 2: Deep-mine chronological video windows for 20-25+ viral moments on longer videos (>= 4 min)
  if (estimatedDurationSeconds >= 240 && combinedCandidates.length < clipTarget.min) {
    const windows = buildTimeWindows(estimatedDurationSeconds, 5);
    const coveredSpans = combinedCandidates
      .map((c) => `${c.startTime}–${c.endTime}`)
      .slice(0, 18)
      .join(', ');
    let scannedCount = 0;

    onRetryNotice?.(
      `Pass 1 captured ${combinedCandidates.length} clips — deep-scanning ${windows.length} timeline windows for up to ${clipTarget.max} viral clips…`,
    );

    const windowResults = await runWithConcurrency(windows, 2, async (win) => {
      try {
        const res = await runDirectCall({
          startOffsetSec: win.startSeconds,
          endOffsetSec: win.endSeconds,
          fps: 0.2,
          targetClipHint: '5 to 7',
          avoidSpans: coveredSpans,
        });
        scannedCount += 1;
        onRetryNotice?.(
          `Scanned timeline window ${scannedCount}/${windows.length} (${formatTimestamp(win.startSeconds)}–${formatTimestamp(win.endSeconds)}) · +${res.candidates.length} viral moments found…`,
        );
        return res;
      } catch {
        return null;
      }
    });

    for (const r of windowResults) {
      if (!r) continue;
      r.keyTopics.forEach((t) => topics.add(t));
      combinedTranscript.push(...r.transcript);
      combinedCandidates.push(...r.candidates);
      if (r.estimatedDurationSeconds > estimatedDurationSeconds) {
        estimatedDurationSeconds = r.estimatedDurationSeconds;
      }
    }
  }

  // Deduplicate & sort transcript chronologically
  const seenLines = new Set<string>();
  const cleanTranscript = combinedTranscript
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .filter((l) => {
      const sig = `${Math.round(l.startSeconds)}:${l.text.slice(0, 40).toLowerCase()}`;
      if (seenLines.has(sig)) return false;
      seenLines.add(sig);
      return true;
    });

  let finalSegments =
    workflow === 'series'
      ? [...combinedCandidates].sort((a, b) => a.startSeconds - b.startSeconds)
      : dedupeOverlappingSegments(combinedCandidates, 0.35);

  finalSegments = finalSegments.slice(0, clipTarget.max);
  if (workflow === 'series') {
    finalSegments = finalSegments.map((s, idx) => ({ ...s, partNumber: idx + 1 }));
  }

  return {
    summary: (pass1.summary || `AI-curated short-form clips from ${title}`).trim(),
    keyTopics: Array.from(topics).slice(0, 8),
    transcript: cleanTranscript,
    segments: finalSegments,
    estimatedDurationSeconds,
  };
}

export async function rewriteClipWithAI(
  clip: ClipItem,
  instruction: string,
): Promise<{ hookTitle: string; hookBannerText: string; reasoning: string }> {
  const ai = getGeminiClient();
  const response = await withGeminiRetry((model) =>
    ai.models.generateContent({
      model,
      contents: `Clip Transcript: "${clip.text}"\nCurrent Hook Title: "${clip.hookTitle}"\nUser Edit Request: "${instruction}"`,
      config: {
        abortSignal: AbortSignal.timeout(25000),
        ...(model === 'gemini-4-hydrogen'
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
          : {}),
        systemInstruction:
          'You are a viral short-form video editor assistant. Rewrite the hook title and opening banner text to match the user request while staying 100% faithful to the clip transcript. Keep hookTitle under 10 words and hookBannerText punchy under 8 words.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            hookTitle: { type: Type.STRING },
            hookBannerText: { type: Type.STRING },
            reasoning: { type: Type.STRING },
          },
          required: ['hookTitle', 'hookBannerText', 'reasoning'],
        },
      },
    }),
  );

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    hookTitle?: string;
    hookBannerText?: string;
    reasoning?: string;
  };
  return {
    hookTitle: (parsed.hookTitle || clip.hookTitle).trim(),
    hookBannerText: (parsed.hookBannerText || parsed.hookTitle || clip.hookBanner.text).trim(),
    reasoning: (parsed.reasoning || clip.reasoning).trim(),
  };
}
