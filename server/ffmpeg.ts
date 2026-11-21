import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CaptionStyleConfig,
  EffectsConfig,
  FramingConfig,
  HookBannerConfig,
  WordToken,
} from '../src/lib/types.ts';
import { groupWordsIntoCaptionLines } from '../src/lib/clip-logic.ts';

const execFileAsync = promisify(execFile);

export const DATA_ROOT = path.join(os.tmpdir(), 'supoclip-studio-data');
export const SOURCES_DIR = path.join(DATA_ROOT, 'sources');
export const CLIPS_DIR = path.join(DATA_ROOT, 'clips');
export const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');
export const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');
export const THUMBS_DIR = path.join(DATA_ROOT, 'thumbs');

export function ensureDataDirs(): void {
  for (const dir of [DATA_ROOT, SOURCES_DIR, CLIPS_DIR, EXPORTS_DIR, UPLOADS_DIR, THUMBS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function probeVideoDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  } catch {
    return 0;
  }
}

export async function createVideoFromBackdropImage(
  imagePath: string,
  outVideoPath: string,
  durationSeconds: number,
  toneFreqHz = 220,
): Promise<void> {
  if (fs.existsSync(outVideoPath) && fs.statSync(outVideoPath).size > 10000) {
    return;
  }
  const safeDuration = Math.max(10, Math.min(180, Math.round(durationSeconds)));
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-loop',
      '1',
      '-framerate',
      '15',
      '-i',
      imagePath,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${toneFreqHz}:sample_rate=44100:duration=${safeDuration}`,
      '-filter_complex',
      `[0:v]scale=960:540:force_original_aspect_ratio=increase,crop=960:540,format=yuv420p[v];[1:a]volume=0.04[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-t',
      String(safeDuration),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '15',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-movflags',
      '+faststart',
      outVideoPath,
    ],
    { timeout: 60000 },
  );
}

export async function extractAudioForTranscription(
  videoPath: string,
  outAudioPath: string,
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-f',
      'mp3',
      outAudioPath,
    ],
    { timeout: 60000 },
  );
}

export async function sliceClipFromSource(
  sourcePath: string,
  outClipPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<void> {
  const safeStart = Math.max(0, startSeconds);
  const safeDur = Math.max(3, durationSeconds);
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-ss',
      safeStart.toFixed(2),
      '-i',
      sourcePath,
      '-t',
      safeDur.toFixed(2),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outClipPath,
    ],
    { timeout: 90000 },
  );
}

function hexToAssColor(hex: string | null | undefined, alphaHex = '00'): string {
  const clean = (hex || '#FFFFFF').trim();
  const match = /^#?([0-9a-f]{6})/i.exec(clean);
  if (!match) return `&H${alphaHex}FFFFFF`;
  const rgb = match[1];
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

export function generateAssSubtitleContent(params: {
  words: WordToken[];
  captionStyle: CaptionStyleConfig;
  hookBanner: HookBannerConfig;
  trimStartOffset: number;
  width: number;
  height: number;
}): string {
  const { words, captionStyle, hookBanner, trimStartOffset, width, height } = params;
  const shiftedWords: WordToken[] = words
    .map((w) => ({
      ...w,
      start: Number((w.start - trimStartOffset).toFixed(3)),
      end: Number((w.end - trimStartOffset).toFixed(3)),
    }))
    .filter((w) => w.end > 0);

  const chunks = groupWordsIntoCaptionLines(shiftedWords, captionStyle.maxWordsPerLine);
  const primaryColor = hexToAssColor(captionStyle.fontColor, '00');
  const highlightColor = hexToAssColor(captionStyle.highlightColor, '00');
  const outlineColor = hexToAssColor(captionStyle.strokeColor ?? '#000000', '00');
  const backColor = captionStyle.background
    ? hexToAssColor('#090B10', '55')
    : hexToAssColor('#000000', '80');
  const fontSize = Math.round((captionStyle.fontSize || 32) * (width / 540));
  const marginV = Math.max(40, Math.round(height * (1 - (captionStyle.positionY || 0.78))));
  const outlineWidth = captionStyle.strokeWidth ?? 3;
  const borderStyle = captionStyle.background ? 3 : 1;

  const hookFontSize = Math.round(22 * (width / 540));
  const hookMarginV = Math.round(height * 0.07);
  const hookTextColor = hexToAssColor(hookBanner.textColor || '#FFFFFF', '00');
  const hookBackColor = hexToAssColor(hookBanner.bgColor || '#11141C', '20');

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,DejaVu Sans,${fontSize},${primaryColor},${highlightColor},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${captionStyle.shadow ? 2 : 0},2,44,44,${marginV},1`,
    `Style: HookBanner,DejaVu Sans,${hookFontSize},${hookTextColor},${hookTextColor},${hookBackColor},${hookBackColor},-1,0,0,0,100,100,0,0,3,8,0,8,48,48,${hookMarginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  if (hookBanner.enabled && hookBanner.text.trim()) {
    const endHook = Math.max(2, hookBanner.durationSeconds || 4);
    lines.push(
      `Dialogue: 2,0:00:00.00,${formatAssTime(endHook)},HookBanner,,0,0,0,,${escapeAssText(hookBanner.text.trim())}`,
    );
  }

  let prevCueEnd = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const cueStart = Math.max(prevCueEnd, Math.max(0, chunk.start));
    const nextStart = i + 1 < chunks.length ? chunks[i + 1].start : Number.POSITIVE_INFINITY;
    const rawCueEnd = Math.max(cueStart + 0.18, chunk.end);
    const cueEnd = Math.max(cueStart + 0.1, Math.min(rawCueEnd, nextStart - 0.01));
    prevCueEnd = cueEnd;

    const totalCs = Math.max(10, Math.round((cueEnd - cueStart) * 100));
    const rawTotalCs = chunk.words.reduce(
      (sum, w) => sum + Math.max(10, Math.round((w.end - w.start) * 100)),
      0,
    );
    const scale = rawTotalCs > 0 ? totalCs / rawTotalCs : 1;

    const startStr = formatAssTime(cueStart);
    const endStr = formatAssTime(cueEnd);
    const wordParts = chunk.words.map((w) => {
      const display = captionStyle.uppercase ? w.word.toUpperCase() : w.word;
      const csDur = Math.max(8, Math.round(Math.max(10, (w.end - w.start) * 100) * scale));
      return `{\\kf${csDur}}${escapeAssText(display)}`;
    });
    lines.push(`Dialogue: 1,${startStr},${endStr},Caption,,0,0,0,,${wordParts.join(' ')}`);
  }

  return lines.join('\n');
}

export async function exportRenderedClip(params: {
  sourceClipPath: string;
  outExportPath: string;
  trimStartOffset: number;
  effectiveDuration: number;
  framing: FramingConfig;
  captionStyle: CaptionStyleConfig;
  hookBanner: HookBannerConfig;
  effects: EffectsConfig;
  words: WordToken[];
  includeCaptions: boolean;
}): Promise<void> {
  const {
    sourceClipPath,
    outExportPath,
    trimStartOffset,
    effectiveDuration,
    framing,
    captionStyle,
    hookBanner,
    effects,
    words,
    includeCaptions,
  } = params;

  const targetDims: Record<FramingConfig['outputFormat'], { w: number; h: number }> = {
    vertical: { w: 720, h: 1280 },
    portrait: { w: 720, h: 900 },
    square: { w: 720, h: 720 },
    landscape: { w: 1280, h: 720 },
  };
  const { w: targetW, h: targetH } = targetDims[framing.outputFormat];

  const zoom = Math.max(1, Math.min(2.5, framing.zoom || 1));
  const panX = Math.max(-1, Math.min(1, framing.panX || 0));
  const panY = Math.max(-1, Math.min(1, framing.panY || 0));

  // Scale source so it fills target dimensions * zoom, then crop with pan offsets
  const scaledW = Math.round(targetW * zoom);
  const scaledH = Math.round(targetH * zoom);
  const xOffsetExpr = `(iw-${targetW})*(${((panX + 1) / 2).toFixed(3)})`;
  const yOffsetExpr = `(ih-${targetH})*(${((panY + 1) / 2).toFixed(3)})`;

  const videoFilters: string[] = [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
    `crop=${targetW}:${targetH}:x='max(0,min(iw-${targetW},${xOffsetExpr}))':y='max(0,min(ih-${targetH},${yOffsetExpr}))'`,
  ];

  const brightness = Number((effects.brightness || 0).toFixed(2));
  const contrast = Number((effects.contrast || 1).toFixed(2));
  const saturation = Number((effects.saturation || 1).toFixed(2));
  if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
    videoFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  }

  let assFilePath: string | null = null;
  if (includeCaptions || (hookBanner.enabled && hookBanner.text.trim())) {
    assFilePath = `${outExportPath}.ass`;
    const assContent = generateAssSubtitleContent({
      words: includeCaptions ? words : [],
      captionStyle,
      hookBanner,
      trimStartOffset,
      width: targetW,
      height: targetH,
    });
    fs.writeFileSync(assFilePath, assContent, 'utf8');
    const escapedAssPath = assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    videoFilters.push(`ass='${escapedAssPath}'`);
  }

  videoFilters.push('format=yuv420p');

  const safeDur = Math.max(2, effectiveDuration);
  const audioFilters: string[] = [`volume=${Math.max(0, Math.min(2, effects.volume ?? 1)).toFixed(2)}`];
  if (effects.fadeInSeconds > 0) {
    audioFilters.push(`afade=t=in:st=0:d=${Math.min(2, effects.fadeInSeconds)}`);
  }
  if (effects.fadeOutSeconds > 0 && safeDur > effects.fadeOutSeconds + 0.5) {
    const fadeStart = Math.max(0, safeDur - effects.fadeOutSeconds);
    audioFilters.push(`afade=t=out:st=${fadeStart.toFixed(2)}:d=${Math.min(2, effects.fadeOutSeconds)}`);
  }

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        Math.max(0, trimStartOffset).toFixed(2),
        '-i',
        sourceClipPath,
        '-t',
        safeDur.toFixed(2),
        '-vf',
        videoFilters.join(','),
        '-af',
        audioFilters.join(','),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outExportPath,
      ],
      { timeout: 120000 },
    );
  } finally {
    if (assFilePath && fs.existsSync(assFilePath)) {
      fs.unlinkSync(assFilePath);
    }
  }
}
