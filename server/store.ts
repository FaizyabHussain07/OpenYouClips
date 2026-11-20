import fs from 'node:fs';
import path from 'node:path';
import type { ClipItem, ClipProject, TranscriptLine } from '../src/lib/types.ts';
import { getCaptionTemplate } from '../src/lib/templates.ts';
import { buildWordTokensFromLines } from '../src/lib/clip-logic.ts';
import {
  CLIPS_DIR,
  createVideoFromBackdropImage,
  DATA_ROOT,
  ensureDataDirs,
  sliceClipFromSource,
  SOURCES_DIR,
  THUMBS_DIR,
} from './ffmpeg.ts';

const STORE_FILE = path.join(DATA_ROOT, 'store.json');

interface StoreState {
  projects: ClipProject[];
}

let state: StoreState = { projects: [] };
let seedPromise: Promise<void> | null = null;

function persistStore(): void {
  ensureDataDirs();
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function makeSeedTranscriptPodcast(): TranscriptLine[] {
  return [
    {
      startTime: '0:00',
      endTime: '0:07',
      startSeconds: 0,
      endSeconds: 7,
      text: 'Everyone thinks scaling a SaaS means adding twenty features before you launch.',
    },
    {
      startTime: '0:07',
      endTime: '0:15',
      startSeconds: 7,
      endSeconds: 15,
      text: 'When we deleted half our onboarding screens overnight, activation jumped forty percent.',
    },
    {
      startTime: '0:15',
      endTime: '0:24',
      startSeconds: 15,
      endSeconds: 24,
      text: 'Users never wanted a dashboard tutorial. They wanted one button that gave them an instant result.',
    },
    {
      startTime: '0:24',
      endTime: '0:33',
      startSeconds: 24,
      endSeconds: 33,
      text: 'The second biggest mistake founders make is hiding pricing behind an enterprise sales call.',
    },
    {
      startTime: '0:33',
      endTime: '0:42',
      startSeconds: 33,
      endSeconds: 42,
      text: 'Transparent pricing doubled our self-serve conversions within fourteen days of shipping.',
    },
    {
      startTime: '0:42',
      endTime: '0:51',
      startSeconds: 42,
      endSeconds: 51,
      text: 'Wait until you hear what happened when we turned customer support tickets into public templates.',
    },
    {
      startTime: '0:51',
      endTime: '1:02',
      startSeconds: 51,
      endSeconds: 62,
      text: 'Every single objection became a reusable workflow that cut churn below two percent monthly.',
    },
    {
      startTime: '1:02',
      endTime: '1:12',
      startSeconds: 62,
      endSeconds: 72,
      text: 'Ship the simplest path to value first, then let real usage tell you what to automate next.',
    },
  ];
}

function makeSeedTranscriptKeynote(): TranscriptLine[] {
  return [
    {
      startTime: '0:00',
      endTime: '0:08',
      startSeconds: 0,
      endSeconds: 8,
      text: 'Attention on short-form feeds is decided in the first one point four seconds.',
    },
    {
      startTime: '0:08',
      endTime: '0:17',
      startSeconds: 8,
      endSeconds: 17,
      text: 'If your opening frame starts with a greeting like hey guys, sixty percent of viewers already swiped.',
    },
    {
      startTime: '0:17',
      endTime: '0:26',
      startSeconds: 17,
      endSeconds: 26,
      text: 'Lead directly with the counter-intuitive outcome, then earn the backstory right after.',
    },
    {
      startTime: '0:26',
      endTime: '0:36',
      startSeconds: 26,
      endSeconds: 36,
      text: 'Notice how top creators pair three-word animated captions with tight speaker framing.',
    },
    {
      startTime: '0:36',
      endTime: '0:46',
      startSeconds: 36,
      endSeconds: 46,
      text: 'Seventy percent of mobile viewers watch muted on the first loop before tapping audio on.',
    },
    {
      startTime: '0:46',
      endTime: '0:56',
      startSeconds: 46,
      endSeconds: 56,
      text: 'That is why word-synced pacing and an uppercase hook banner outperform raw horizontal uploads three to one.',
    },
  ];
}

async function createSeedProjects(): Promise<ClipProject[]> {
  ensureDataDirs();
  const podcastImg = path.resolve('src/assets/images/studio_podcast_interview_1795094362500.jpg');
  const keynoteImg = path.resolve('src/assets/images/keynote_stage_speaker_1795094363137.jpg');

  const p1Id = 'demo-founder-podcast';
  const p2Id = 'demo-keynote-retention';

  const p1Thumb = path.join(THUMBS_DIR, `${p1Id}.jpg`);
  const p2Thumb = path.join(THUMBS_DIR, `${p2Id}.jpg`);
  if (fs.existsSync(podcastImg)) fs.copyFileSync(podcastImg, p1Thumb);
  if (fs.existsSync(keynoteImg)) fs.copyFileSync(keynoteImg, p2Thumb);

  const p1Source = path.join(SOURCES_DIR, `${p1Id}.mp4`);
  const p2Source = path.join(SOURCES_DIR, `${p2Id}.mp4`);
  await createVideoFromBackdropImage(podcastImg, p1Source, 75, 196);
  await createVideoFromBackdropImage(keynoteImg, p2Source, 60, 246);

  const t1 = makeSeedTranscriptPodcast();
  const t2 = makeSeedTranscriptKeynote();

  const p1ClipsMeta = [
    {
      id: 'clip-pod-1',
      order: 1,
      start: 0,
      end: 24,
      startTime: '0:00',
      endTime: '0:24',
      hookTitle: 'Deleting Half Our Onboarding Jumped Activation 40%',
      text: 'Everyone thinks scaling a SaaS means adding twenty features before you launch. When we deleted half our onboarding screens overnight, activation jumped forty percent. Users never wanted a dashboard tutorial. They wanted one button that gave them an instant result.',
      reasoning: 'Contrarian claim paired with a concrete 40% metric inside the opening 15 seconds.',
      virality: {
        hookScore: 24,
        engagementScore: 22,
        valueScore: 24,
        shareabilityScore: 22,
        totalScore: 92,
        hookType: 'Contrarian Result',
        viralityReasoning: 'Immediate pattern interrupt with quantifiable proof and zero throat-clearing.',
      },
      template: 'hormozi' as const,
      panX: -0.68,
    },
    {
      id: 'clip-pod-2',
      order: 2,
      start: 24,
      end: 42,
      startTime: '0:24',
      endTime: '0:42',
      hookTitle: 'Why Hiding Pricing Kills Self-Serve Conversions',
      text: 'The second biggest mistake founders make is hiding pricing behind an enterprise sales call. Transparent pricing doubled our self-serve conversions within fourteen days of shipping.',
      reasoning: 'Clear actionable lesson with a fast 14-day turnaround outcome.',
      virality: {
        hookScore: 21,
        engagementScore: 20,
        valueScore: 23,
        shareabilityScore: 21,
        totalScore: 85,
        hookType: 'Mistake Breakdown',
        viralityReasoning: 'Strong founder-relatable friction point that triggers saves and shares.',
      },
      template: 'podcast' as const,
      panX: 0.68,
    },
    {
      id: 'clip-pod-3',
      order: 3,
      start: 42,
      end: 72,
      startTime: '0:42',
      endTime: '1:12',
      hookTitle: 'Turning Support Tickets Into Retention Loops',
      text: 'Wait until you hear what happened when we turned customer support tickets into public templates. Every single objection became a reusable workflow that cut churn below two percent monthly. Ship the simplest path to value first, then let real usage tell you what to automate next.',
      reasoning: 'Curiosity opener leading into a tactical churn-reduction takeaway.',
      virality: {
        hookScore: 20,
        engagementScore: 19,
        valueScore: 22,
        shareabilityScore: 19,
        totalScore: 80,
        hookType: 'Story Payoff',
        viralityReasoning: 'Satisfying close with a sub-2% churn benchmark and memorable rule of thumb.',
      },
      template: 'default' as const,
      panX: 0,
    },
  ];

  const p1Clips: ClipItem[] = [];
  for (const c of p1ClipsMeta) {
    const clipPath = path.join(CLIPS_DIR, `${c.id}.mp4`);
    if (!fs.existsSync(clipPath)) {
      await sliceClipFromSource(p1Source, clipPath, c.start, c.end - c.start);
    }
    p1Clips.push({
      id: c.id,
      projectId: p1Id,
      clipOrder: c.order,
      startTime: c.startTime,
      endTime: c.endTime,
      startSeconds: c.start,
      endSeconds: c.end,
      duration: c.end - c.start,
      trimStartOffset: 0,
      trimEndOffset: 0,
      hookTitle: c.hookTitle,
      text: c.text,
      reasoning: c.reasoning,
      virality: c.virality,
      workflowRole: 'highlight',
      words: buildWordTokensFromLines(t1, c.start, c.end),
      captionStyle: getCaptionTemplate(c.template),
      framing: {
        outputFormat: 'vertical',
        panX: c.panX,
        panY: 0,
        zoom: 1.05,
        autoCenterSpeaker: true,
      },
      hookBanner: {
        enabled: true,
        text: c.hookTitle,
        bgColor: '#11141C',
        textColor: '#FFFFFF',
        durationSeconds: 3.5,
      },
      effects: {
        cutLongPauses: true,
        pauseThresholdMs: 1200,
        removeFillerWords: true,
        volume: 1,
        brightness: 0,
        contrast: 1,
        saturation: 1,
        fadeInSeconds: 0.2,
        fadeOutSeconds: 0.3,
      },
      videoUrl: `/media/clips/${c.id}.mp4`,
    });
  }

  const p2ClipsMeta = [
    {
      id: 'clip-key-1',
      order: 1,
      start: 0,
      end: 26,
      startTime: '0:00',
      endTime: '0:26',
      hookTitle: 'The 1.4-Second Rule That Stops Scroll Drop-Off',
      text: 'Attention on short-form feeds is decided in the first one point four seconds. If your opening frame starts with a greeting like hey guys, sixty percent of viewers already swiped. Lead directly with the counter-intuitive outcome, then earn the backstory right after.',
      reasoning: 'Hyper-specific opening statistic calling out a universal creator habit.',
      virality: {
        hookScore: 25,
        engagementScore: 22,
        valueScore: 23,
        shareabilityScore: 24,
        totalScore: 94,
        hookType: 'Data Hook',
        viralityReasoning: 'Specific timing benchmark and immediate actionable swap creators can use today.',
      },
      template: 'tiktok' as const,
    },
    {
      id: 'clip-key-2',
      order: 2,
      start: 26,
      end: 56,
      startTime: '0:26',
      endTime: '0:56',
      hookTitle: 'Why Muted Mobile Viewers Need Word-Synced Captions',
      text: 'Notice how top creators pair three-word animated captions with tight speaker framing. Seventy percent of mobile viewers watch muted on the first loop before tapping audio on. That is why word-synced pacing and an uppercase hook banner outperform raw horizontal uploads three to one.',
      reasoning: 'Explains the 3x performance lift behind vertical caption pacing.',
      virality: {
        hookScore: 21,
        engagementScore: 21,
        valueScore: 22,
        shareabilityScore: 22,
        totalScore: 86,
        hookType: 'Retention Framework',
        viralityReasoning: 'Backed by 70% muted-play insight and concrete 3-to-1 lift.',
      },
      template: 'mrbeast' as const,
    },
  ];

  const p2Clips: ClipItem[] = [];
  for (const c of p2ClipsMeta) {
    const clipPath = path.join(CLIPS_DIR, `${c.id}.mp4`);
    if (!fs.existsSync(clipPath)) {
      await sliceClipFromSource(p2Source, clipPath, c.start, c.end - c.start);
    }
    p2Clips.push({
      id: c.id,
      projectId: p2Id,
      clipOrder: c.order,
      startTime: c.startTime,
      endTime: c.endTime,
      startSeconds: c.start,
      endSeconds: c.end,
      duration: c.end - c.start,
      trimStartOffset: 0,
      trimEndOffset: 0,
      hookTitle: c.hookTitle,
      text: c.text,
      reasoning: c.reasoning,
      virality: c.virality,
      workflowRole: 'highlight',
      words: buildWordTokensFromLines(t2, c.start, c.end),
      captionStyle: getCaptionTemplate(c.template),
      framing: {
        outputFormat: 'vertical',
        panX: 0,
        panY: -0.1,
        zoom: 1.0,
        autoCenterSpeaker: true,
      },
      hookBanner: {
        enabled: true,
        text: c.hookTitle,
        bgColor: '#FF3B5C',
        textColor: '#FFFFFF',
        durationSeconds: 3.5,
      },
      effects: {
        cutLongPauses: true,
        pauseThresholdMs: 1200,
        removeFillerWords: true,
        volume: 1,
        brightness: 0,
        contrast: 1,
        saturation: 1,
        fadeInSeconds: 0.2,
        fadeOutSeconds: 0.3,
      },
      videoUrl: `/media/clips/${c.id}.mp4`,
    });
  }

  return [
    {
      id: p1Id,
      title: 'Founder Podcast #42 — Onboarding, Pricing & Retention',
      channelName: 'Tech & Talk Studio',
      sourceType: 'sample',
      sourceUrl: 'studio://founder-podcast-42',
      thumbnailUrl: `/media/thumbs/${p1Id}.jpg`,
      sourceVideoUrl: `/media/sources/${p1Id}.mp4`,
      durationSeconds: 75,
      workflow: 'highlights',
      outputFormat: 'vertical',
      clipLength: 'auto',
      captionTemplate: 'hormozi',
      stage: 'completed',
      progress: 100,
      stageMessage: '3 viral clips ready',
      summary:
        'Two SaaS founders break down how cutting onboarding complexity lifted activation 40%, why transparent pricing doubled self-serve revenue, and how support tickets fuel retention.',
      keyTopics: ['Onboarding UX', 'Transparent Pricing', 'Churn Reduction', 'SaaS Growth'],
      transcript: t1,
      clips: p1Clips,
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
      isSample: true,
    },
    {
      id: p2Id,
      title: 'Creator Growth Keynote — Mastering the First 1.4 Seconds',
      channelName: 'Stagecraft Media',
      sourceType: 'sample',
      sourceUrl: 'studio://keynote-retention',
      thumbnailUrl: `/media/thumbs/${p2Id}.jpg`,
      sourceVideoUrl: `/media/sources/${p2Id}.mp4`,
      durationSeconds: 60,
      workflow: 'highlights',
      outputFormat: 'vertical',
      clipLength: 'short',
      captionTemplate: 'tiktok',
      stage: 'completed',
      progress: 100,
      stageMessage: '2 viral clips ready',
      summary:
        'Keynote presentation covering hook psychology, muted mobile viewing habits, and why animated 3-word captions dramatically raise short-form completion rates.',
      keyTopics: ['Short-Form Hooks', 'Muted Viewing', 'Word-Synced Captions', '9:16 Reframing'],
      transcript: t2,
      clips: p2Clips,
      createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      isSample: true,
    },
  ];
}

export async function initStore(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    ensureDataDirs();
    if (fs.existsSync(STORE_FILE)) {
      try {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as StoreState;
        if (Array.isArray(parsed.projects) && parsed.projects.length > 0) {
          let changed = false;
          for (const p of parsed.projects) {
            if (p.stage !== 'completed' && p.stage !== 'error') {
              p.stage = 'error';
              p.progress = 100;
              p.stageMessage = 'Pipeline stopped';
              p.errorMessage = 'Processing was interrupted by a server restart. Click Retry Analysis to resume.';
              changed = true;
            }
          }
          state = parsed;
          if (changed) persistStore();
          // Ensure demo media files exist even after /tmp partial clean
          const missingDemoMedia = state.projects.some(
            (p) => p.isSample && !fs.existsSync(path.join(SOURCES_DIR, `${p.id}.mp4`)),
          );
          if (!missingDemoMedia) return;
        }
      } catch {
        // Re-seed if corrupted
      }
    }
    const seeded = await createSeedProjects();
    state = { projects: seeded };
    persistStore();
  })();
  return seedPromise;
}

export function listProjects(): ClipProject[] {
  return [...state.projects].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function getProject(id: string): ClipProject | undefined {
  return state.projects.find((p) => p.id === id);
}

export function upsertProject(project: ClipProject): void {
  const idx = state.projects.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    state.projects[idx] = project;
  } else {
    state.projects.unshift(project);
  }
  persistStore();
}

export function deleteProject(id: string): boolean {
  const before = state.projects.length;
  state.projects = state.projects.filter((p) => p.id !== id);
  if (state.projects.length !== before) {
    persistStore();
    return true;
  }
  return false;
}

export function updateClipInStore(
  projectId: string,
  clipId: string,
  updater: (clip: ClipItem) => ClipItem,
): ClipItem | null {
  const project = getProject(projectId);
  if (!project) return null;
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const updated = updater(project.clips[idx]);
  project.clips[idx] = updated;
  persistStore();
  return updated;
}

export function addClipToProject(projectId: string, clip: ClipItem): boolean {
  const project = getProject(projectId);
  if (!project) return false;
  project.clips.push(clip);
  persistStore();
  return true;
}

export function deleteClipFromProject(projectId: string, clipId: string): boolean {
  const project = getProject(projectId);
  if (!project) return false;
  const before = project.clips.length;
  project.clips = project.clips.filter((c) => c.id !== clipId);
  if (project.clips.length !== before) {
    persistStore();
    return true;
  }
  return false;
}
