export type OutputFormat = 'vertical' | 'portrait' | 'square' | 'landscape';
export type ClipLengthPreset = 'auto' | 'short' | 'medium' | 'long';
export type WorkflowMode = 'highlights' | 'series' | 'topic' | 'recap' | 'trailer';
export type CaptionTemplateId =
  | 'default'
  | 'hormozi'
  | 'mrbeast'
  | 'minimal'
  | 'tiktok'
  | 'neon'
  | 'podcast';

export interface WordToken {
  word: string;
  start: number; // seconds relative to clip start (0..duration)
  end: number;
  emphasis?: boolean;
}

export interface CaptionStyleConfig {
  templateId: CaptionTemplateId;
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  highlightColor: string;
  emphasisColor: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  background: boolean;
  backgroundColor: string | null;
  wordBox: boolean;
  wordBoxColor: string | null;
  animation: 'none' | 'karaoke' | 'pop' | 'fade' | 'bounce';
  wordPop: boolean;
  emoji: boolean;
  uppercase: boolean;
  shadow: boolean;
  glow: boolean;
  maxWordsPerLine: number;
  positionY: number; // 0.1 .. 0.92
}

export interface FramingConfig {
  outputFormat: OutputFormat;
  panX: number; // -1 .. 1 (0 = center)
  panY: number; // -1 .. 1 (0 = center)
  zoom: number; // 1 .. 2.5
  autoCenterSpeaker: boolean;
}

export interface HookBannerConfig {
  enabled: boolean;
  text: string;
  bgColor: string;
  textColor: string;
  durationSeconds: number;
}

export interface EffectsConfig {
  cutLongPauses: boolean;
  pauseThresholdMs: number;
  removeFillerWords: boolean;
  volume: number; // 0 .. 1.5
  brightness: number; // -0.3 .. 0.3
  contrast: number; // 0.7 .. 1.4
  saturation: number; // 0.5 .. 1.6
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

export interface ViralityBreakdown {
  hookScore: number; // 0..25
  engagementScore: number; // 0..25
  valueScore: number; // 0..25
  shareabilityScore: number; // 0..25
  totalScore: number; // 0..100
  hookType: string;
  viralityReasoning: string;
}

export interface ClipItem {
  id: string;
  projectId: string;
  clipOrder: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  duration: number;
  trimStartOffset: number; // seconds trimmed from clip start
  trimEndOffset: number; // seconds trimmed from clip end
  hookTitle: string;
  text: string;
  reasoning: string;
  virality: ViralityBreakdown;
  workflowRole: 'highlight' | 'part' | 'topic' | 'recap' | 'trailer';
  partNumber?: number;
  words: WordToken[];
  captionStyle: CaptionStyleConfig;
  framing: FramingConfig;
  hookBanner: HookBannerConfig;
  effects: EffectsConfig;
  videoUrl: string;
  exportedUrl?: string;
  lastExportedAt?: string;
}

export type PipelineStage =
  | 'queued'
  | 'fetching_source'
  | 'transcribing'
  | 'analyzing_virality'
  | 'rendering_clips'
  | 'completed'
  | 'error';

export interface TranscriptLine {
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
}

export type AgentStepStatus = 'pending' | 'running' | 'completed' | 'warning' | 'error';

export interface AgentStep {
  id: string;
  agentName: string;
  title: string;
  status: AgentStepStatus;
  startedAt?: string;
  completedAt?: string;
  detail: string;
  metrics?: string[];
}

export interface ClipProject {
  id: string;
  title: string;
  channelName: string;
  sourceType: 'youtube' | 'twitch' | 'kick' | 'video_url' | 'upload' | 'sample';
  sourceUrl: string;
  youtubeId?: string;
  thumbnailUrl: string;
  sourceVideoUrl: string;
  hasDirectVideo?: boolean;
  durationSeconds: number;
  workflow: WorkflowMode;
  topicFocus?: string;
  customInstructions?: string;
  outputFormat: OutputFormat;
  clipLength: ClipLengthPreset;
  captionTemplate: CaptionTemplateId;
  stage: PipelineStage;
  progress: number; // 0..100
  stageMessage: string;
  agentSteps?: AgentStep[];
  errorMessage?: string;
  summary: string;
  keyTopics: string[];
  transcript: TranscriptLine[];
  clips: ClipItem[];
  createdAt: string;
  isSample?: boolean;
}
