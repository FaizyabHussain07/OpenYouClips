import type {
  CaptionStyleConfig,
  CaptionTemplateId,
  ClipLengthPreset,
  OutputFormat,
  WorkflowMode,
} from './types';

export interface CaptionTemplateMeta extends CaptionStyleConfig {
  name: string;
  description: string;
  previewSample: string;
}

export const CAPTION_TEMPLATES: Record<CaptionTemplateId, CaptionTemplateMeta> = {
  default: {
    templateId: 'default',
    name: 'Default Viral',
    description: 'Punchy bold captions with bright yellow active-word pop',
    previewSample: 'Stop scrolling right now',
    fontFamily: 'Anton',
    fontSize: 34,
    fontColor: '#FFFFFF',
    highlightColor: '#FFE000',
    emphasisColor: '#FFE000',
    strokeColor: '#000000',
    strokeWidth: 3,
    background: false,
    backgroundColor: null,
    wordBox: false,
    wordBoxColor: null,
    animation: 'karaoke',
    wordPop: true,
    emoji: true,
    uppercase: false,
    shadow: true,
    glow: false,
    maxWordsPerLine: 4,
    positionY: 0.78,
  },
  hormozi: {
    templateId: 'hormozi',
    name: 'Hormozi',
    description: 'High-contrast uppercase words with a vivid green active pill',
    previewSample: 'THIS ONE SHIFT CHANGED EVERYTHING',
    fontFamily: 'Anton',
    fontSize: 36,
    fontColor: '#FFFFFF',
    highlightColor: '#00FF66',
    emphasisColor: '#FFE000',
    strokeColor: '#000000',
    strokeWidth: 4,
    background: false,
    backgroundColor: null,
    wordBox: true,
    wordBoxColor: '#00BF49',
    animation: 'karaoke',
    wordPop: true,
    emoji: true,
    uppercase: true,
    shadow: true,
    glow: false,
    maxWordsPerLine: 3,
    positionY: 0.74,
  },
  mrbeast: {
    templateId: 'mrbeast',
    name: 'MrBeast',
    description: 'Oversized yellow impact type with crimson emphasis pops',
    previewSample: 'WAIT UNTIL YOU SEE THIS',
    fontFamily: 'Anton',
    fontSize: 38,
    fontColor: '#FFFF00',
    highlightColor: '#FF2D2D',
    emphasisColor: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 5,
    background: false,
    backgroundColor: null,
    wordBox: false,
    wordBoxColor: null,
    animation: 'bounce',
    wordPop: true,
    emoji: true,
    uppercase: true,
    shadow: true,
    glow: false,
    maxWordsPerLine: 3,
    positionY: 0.70,
  },
  minimal: {
    templateId: 'minimal',
    name: 'Minimal',
    description: 'Clean editorial subtitles on a subtle frosted dark backing',
    previewSample: 'Most founders overlook retention early on',
    fontFamily: 'DM Sans',
    fontSize: 26,
    fontColor: '#FFFFFF',
    highlightColor: '#FBBF24',
    emphasisColor: null,
    strokeColor: null,
    strokeWidth: 0,
    background: true,
    backgroundColor: 'rgba(10, 12, 18, 0.72)',
    wordBox: false,
    wordBoxColor: null,
    animation: 'fade',
    wordPop: false,
    emoji: false,
    uppercase: false,
    shadow: false,
    glow: false,
    maxWordsPerLine: 6,
    positionY: 0.82,
  },
  tiktok: {
    templateId: 'tiktok',
    name: 'TikTok Pop',
    description: 'Crisp white geometric sans with TikTok crimson highlights',
    previewSample: 'Here is the 3-step playbook',
    fontFamily: 'Plus Jakarta Sans',
    fontSize: 30,
    fontColor: '#FFFFFF',
    highlightColor: '#FE2C55',
    emphasisColor: '#FE2C55',
    strokeColor: '#000000',
    strokeWidth: 3,
    background: false,
    backgroundColor: null,
    wordBox: false,
    wordBoxColor: null,
    animation: 'karaoke',
    wordPop: true,
    emoji: true,
    uppercase: false,
    shadow: true,
    glow: false,
    maxWordsPerLine: 4,
    positionY: 0.78,
  },
  neon: {
    templateId: 'neon',
    name: 'Neon Pulse',
    description: 'Electric cyan base with magenta active-word emphasis',
    previewSample: 'Nobody talks about this bottleneck',
    fontFamily: 'Anton',
    fontSize: 32,
    fontColor: '#22D3EE',
    highlightColor: '#F43F5E',
    emphasisColor: '#F43F5E',
    strokeColor: '#090D1A',
    strokeWidth: 3,
    background: false,
    backgroundColor: null,
    wordBox: false,
    wordBoxColor: null,
    animation: 'pop',
    wordPop: true,
    emoji: false,
    uppercase: false,
    shadow: false,
    glow: true,
    maxWordsPerLine: 4,
    positionY: 0.76,
  },
  podcast: {
    templateId: 'podcast',
    name: 'Podcast Pro',
    description: 'Broadcast-grade warm gold karaoke inside a sleek dark pill',
    previewSample: 'That single decision doubled conversion',
    fontFamily: 'Plus Jakarta Sans',
    fontSize: 28,
    fontColor: '#FFFFFF',
    highlightColor: '#FFB800',
    emphasisColor: '#FFB800',
    strokeColor: '#111111',
    strokeWidth: 2,
    background: true,
    backgroundColor: 'rgba(18, 20, 28, 0.84)',
    wordBox: false,
    wordBoxColor: null,
    animation: 'karaoke',
    wordPop: false,
    emoji: false,
    uppercase: false,
    shadow: false,
    glow: false,
    maxWordsPerLine: 5,
    positionY: 0.80,
  },
};

export function getCaptionTemplate(id: CaptionTemplateId): CaptionStyleConfig {
  const tpl = CAPTION_TEMPLATES[id] ?? CAPTION_TEMPLATES.default;
  const { name: _n, description: _d, previewSample: _p, ...style } = tpl;
  return { ...style };
}

export const OUTPUT_FORMAT_OPTIONS: Array<{
  id: OutputFormat;
  label: string;
  ratio: string;
  width: number;
  height: number;
  platforms: string;
}> = [
  { id: 'vertical', label: '9:16 Vertical', ratio: '9:16', width: 1080, height: 1920, platforms: 'Shorts · Reels · TikTok' },
  { id: 'portrait', label: '4:5 Portrait', ratio: '4:5', width: 1080, height: 1350, platforms: 'LinkedIn · IG Feed' },
  { id: 'square', label: '1:1 Square', ratio: '1:1', width: 1080, height: 1080, platforms: 'X · Feeds' },
  { id: 'landscape', label: '16:9 Wide', ratio: '16:9', width: 1920, height: 1080, platforms: 'YouTube · Web' },
];

export const CLIP_LENGTH_OPTIONS: Array<{
  id: ClipLengthPreset;
  label: string;
  rangeLabel: string;
  minSeconds: number;
  maxSeconds: number;
}> = [
  { id: 'auto', label: 'Auto (25–50s)', rangeLabel: 'Best natural pacing', minSeconds: 20, maxSeconds: 55 },
  { id: 'short', label: 'Short (<30s)', rangeLabel: '15–30s punchy hooks', minSeconds: 15, maxSeconds: 30 },
  { id: 'medium', label: 'Medium (30–60s)', rangeLabel: '30–60s story arcs', minSeconds: 30, maxSeconds: 60 },
  { id: 'long', label: 'Long (60–90s)', rangeLabel: '55–90s deep dives', minSeconds: 55, maxSeconds: 90 },
];

export const WORKFLOW_OPTIONS: Array<{
  id: WorkflowMode;
  label: string;
  summary: string;
}> = [
  { id: 'highlights', label: 'Viral Highlights', summary: 'Ranks up to 20–25+ highest-retention monetization hooks' },
  { id: 'series', label: 'Multi-Part Series', summary: 'Splits narrative into sequential Part 1..N clips' },
  { id: 'topic', label: 'Topic Focus', summary: 'Finds every segment discussing your target topic' },
  { id: 'recap', label: 'Tight Recap', summary: 'Condenses core argument into a high-density recap' },
  { id: 'trailer', label: 'Hype Trailer', summary: 'High-energy teaser clips built for opening retention' },
];
