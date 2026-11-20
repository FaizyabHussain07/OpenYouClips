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

export async function analyzeTranscriptForClips(params: {
  title: string;
  transcript: TranscriptLine[];
  durationSeconds: number;
  workflow: WorkflowMode;
  clipLength: ClipLengthPreset;
  topicFocus?: string;
  customInstructions?: string;
}): Promise<TranscriptAnalysisResult> {
  const ai = getGeminiClient();
  const { title, transcript, durationSeconds, workflow, clipLength, topicFocus, customInstructions } = params;

  const lengthSpec = CLIP_LENGTH_OPTIONS.find((o) => o.id === clipLength) ?? CLIP_LENGTH_OPTIONS[0];
  const minClip = Math.min(lengthSpec.minSeconds, Math.max(10, Math.floor(durationSeconds * 0.4)));
  const maxClip = Math.min(lengthSpec.maxSeconds, Math.max(minClip + 10, durationSeconds));
  const clipTarget = computeTargetClipCount(durationSeconds);

  const formattedTranscript = transcript
    .slice(0, 600)
    .map((line) => `[${line.startTime} - ${line.endTime}] ${line.text}`)
    .join('\n');

  const workflowPromptMap: Record<WorkflowMode, string> = {
    highlights: `Scan the ENTIRE timeline from start to finish and extract ALL qualifying standalone high-virality highlight clips (${clipTarget.min} to ${clipTarget.max} distinct clips if the video supports them, up to 15 clips on long videos). Do not stop at just 3 if more great hooks exist.`,
    series: `Divide the video into ${clipTarget.min} to ${Math.min(12, clipTarget.max)} sequential chronological parts (Part 1, Part 2, ...) that tell a continuous multi-part story.`,
    topic: `Focus specifically on segments discussing this topic: "${topicFocus || 'core insights'}". Return ${clipTarget.min} to ${clipTarget.max} best matching clips across the full video.`,
    recap: `Select ${Math.min(8, clipTarget.max)} essential narrative beats that condense the full video into a tight high-signal recap.`,
    trailer: `Select ${clipTarget.min} to ${Math.min(10, clipTarget.max)} highest-energy, curiosity-inducing moments suitable for a punchy hype trailer.`,
  };

  const systemInstruction = `You are an expert short-form video editor and transcript analyst (OpenYouClips AI).
Your job is comprehensive span extraction and virality ranking over a timestamped transcript.

WORKFLOW MODE: ${workflow.toUpperCase()}
${workflowPromptMap[workflow]}
${customInstructions ? `USER CREATIVE DIRECTION: ${customInstructions}` : ''}

STRICT GROUNDING RULES:
1. Use ONLY timestamps and spoken text present in the provided transcript.
2. Cover the whole timeline (beginning, middle, climax, and ending) so no great clip moments are missed.
3. Every clip duration MUST be between ${minClip} and ${maxClip} seconds (unless the total source is shorter).
4. Each clip needs:
   - hookTitle: punchy <= 10 word headline for the opening banner
   - startTime / endTime: exact MM:SS or H:MM:SS timestamps from the transcript
   - text: exact verbatim excerpt from the chosen span
   - reasoning: concise 1-sentence editor note explaining why this clip retains viewers
   - virality: 4 subscores (0-25 each): hookScore, engagementScore, valueScore, shareabilityScore, plus hookType and viralityReasoning.`;

  const response = await withGeminiRetry(
    (model) =>
      ai.models.generateContent({
        model,
        contents: `VIDEO TITLE: ${title}\nTOTAL DURATION: ${formatTimestamp(durationSeconds)}\n\nTIMESTAMPED TRANSCRIPT:\n${formattedTranscript}`,
        config: {
          abortSignal: AbortSignal.timeout(60000),
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

  const roleMap: Record<WorkflowMode, AnalyzedClipCandidate['workflowRole']> = {
    highlights: 'highlight',
    series: 'part',
    topic: 'topic',
    recap: 'recap',
    trailer: 'trailer',
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

  const deduped = workflow === 'series' ? candidates : dedupeOverlappingSegments(candidates, 0.5);
  return {
    summary: (raw.summary ?? `AI-curated short-form clips from ${title}`).trim(),
    keyTopics: (raw.keyTopics ?? []).slice(0, 6),
    segments: deduped,
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
  const workflowPromptMap: Record<WorkflowMode, string> = {
    highlights:
      'Scan the ENTIRE video timeline (start, middle, peaks, finale) and extract ALL distinct qualifying high-virality highlight clips — up to 10 to 15 clips on videos over 6 minutes, or 3 to 6 clips on shorter videos under 2 minutes.',
    series:
      'Divide the full video into 4 to 10 sequential chronological parts (Part 1, Part 2, ...) telling a continuous story.',
    topic: `Focus specifically on segments discussing: "${topicFocus || 'core insights'}". Extract ALL matching clips (up to 12 clips) across the entire video.`,
    recap:
      'Select 4 to 8 essential narrative beats that condense the full video into a tight high-signal recap.',
    trailer:
      'Select 5 to 10 highest-energy moments across the whole video suitable for a punchy hype trailer.',
  };

  const systemInstruction = `You are an expert short-form video editor and transcript analyst (OpenYouClips AI).
Watch and listen to the provided YouTube video carefully from start to finish.

WORKFLOW MODE: ${workflow.toUpperCase()}
${workflowPromptMap[workflow]}
${customInstructions ? `USER CREATIVE DIRECTION: ${customInstructions}` : ''}

REQUIREMENTS:
1. Produce a timestamped "transcript" array covering all chosen segments and major timeline beats (20 to 55 entries proportional to video length), with startTime (MM:SS or H:MM:SS), endTime, and spoken/reaction text.
2. Extract ALL high-value clip "segments" strictly grounded in the video's actual timestamps — aim for 10 to 15 non-overlapping viral clips on long videos (5+ minutes), 6 to 10 on medium videos (2–5 minutes), and 3 to 6 on short videos (<2 minutes). Each clip duration should target ${lengthSpec.minSeconds} to ${lengthSpec.maxSeconds} seconds (unless the video is shorter).
3. Each segment must include:
   - startTime / endTime (MM:SS or H:MM:SS)
   - hookTitle (<= 10 words)
   - text (verbatim spoken dialogue or reaction quote from that span)
   - reasoning (1-sentence editor rationale)
   - virality scores (0-25 integers): hookScore, engagementScore, valueScore, shareabilityScore, plus hookType and viralityReasoning.
4. Also return estimatedDurationSeconds (integer total video duration in seconds).`;

  return await withGeminiRetry(
    async (model, attemptNumber) => {
      const t0 = Date.now();
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              fileData: {
                fileUri: youtubeUrl,
              },
              ...(attemptNumber <= 3 ? { videoMetadata: { fps: 0.12 } } : {}),
            },
            {
              text: `Analyze this YouTube video titled "${title}" and extract its timestamped transcript and top viral short-form clip segments in JSON.`,
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

      const roleMap: Record<WorkflowMode, AnalyzedClipCandidate['workflowRole']> = {
        highlights: 'highlight',
        series: 'part',
        topic: 'topic',
        recap: 'recap',
        trailer: 'trailer',
      };

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

      transcript.sort((a, b) => a.startSeconds - b.startSeconds);
      const deduped = workflow === 'series' ? candidates : dedupeOverlappingSegments(candidates, 0.5);
      const maxSegEnd = deduped.reduce((m, c) => Math.max(m, c.endSeconds), 0);
      const estimatedDurationSeconds = Math.max(
        raw.estimatedDurationSeconds || 0,
        maxSegEnd,
        transcript[transcript.length - 1]?.endSeconds || 60,
      );

      return {
        summary: (raw.summary ?? `AI-curated short-form clips from ${title}`).trim(),
        keyTopics: (raw.keyTopics ?? []).slice(0, 6),
        transcript,
        segments: deduped,
        estimatedDurationSeconds,
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
