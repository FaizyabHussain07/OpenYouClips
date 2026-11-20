import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearClipDraftFromStorage,
  loadClipDraftFromStorage,
  loadWorkspaceFromStorage,
  mergeProjectsWithLocalStorage,
  saveClipDraftToStorage,
  saveWorkspaceToStorage,
  type StorageLike,
} from './local-storage.ts';
import { CAPTION_TEMPLATES } from './templates.ts';
import type { ClipItem, ClipProject } from './types.ts';

function createMemoryStorage(quotaBytes = 10_000_000): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      if (value.length > quotaBytes) {
        throw new Error('QuotaExceededError');
      }
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function makeStubProject(id: string, createdAt: string, clipCount = 2): ClipProject {
  return {
    id,
    title: `Project ${id}`,
    channelName: 'Creator',
    sourceType: 'youtube',
    sourceUrl: `https://youtube.com/watch?v=${id}`,
    thumbnailUrl: '/media/thumbs/demo.jpg',
    sourceVideoUrl: '',
    durationSeconds: 300,
    workflow: 'highlights',
    outputFormat: 'vertical',
    clipLength: 'auto',
    captionTemplate: 'hormozi',
    stage: 'completed',
    progress: 100,
    stageMessage: `${clipCount} clips ready`,
    summary: 'Summary',
    keyTopics: ['AI'],
    transcript: [],
    clips: Array.from({ length: clipCount }, (_, i) => ({
      id: `${id}-clip-${i}`,
      projectId: id,
      clipOrder: i + 1,
      startTime: '0:00',
      endTime: '0:25',
      startSeconds: 0,
      endSeconds: 25,
      duration: 25,
      trimStartOffset: 0,
      trimEndOffset: 0,
      hookTitle: `Clip ${i + 1}`,
      text: 'Hello world',
      reasoning: 'Strong hook',
      virality: {
        hookScore: 22,
        engagementScore: 20,
        valueScore: 21,
        shareabilityScore: 20,
        totalScore: 83,
        hookType: 'Curiosity',
        viralityReasoning: 'Fast hook',
      },
      workflowRole: 'highlight',
      words: [],
      captionStyle: { ...CAPTION_TEMPLATES.hormozi },
      framing: {
        outputFormat: 'vertical',
        panX: 0,
        panY: 0,
        zoom: 1,
        autoCenterSpeaker: true,
      },
      hookBanner: {
        enabled: true,
        text: 'Hook',
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
      videoUrl: '/media/clips/demo.mp4',
    })),
    createdAt,
  };
}

test('saveWorkspaceToStorage and loadWorkspaceFromStorage roundtrip projects and screen state', () => {
  const storage = createMemoryStorage();
  const p1 = makeStubProject('proj-a', '2026-11-20T01:00:00Z');

  const ok = saveWorkspaceToStorage(
    {
      projects: [p1],
      defaultTemplate: 'tiktok',
      lastScreen: { view: 'project', projectId: 'proj-a' },
    },
    storage,
  );

  assert.equal(ok, true);
  const loaded = loadWorkspaceFromStorage(storage);
  assert.ok(loaded);
  assert.equal(loaded.projects.length, 1);
  assert.equal(loaded.projects[0].id, 'proj-a');
  assert.equal(loaded.defaultTemplate, 'tiktok');
  assert.deepEqual(loaded.lastScreen, { view: 'project', projectId: 'proj-a' });
});

test('mergeProjectsWithLocalStorage preserves local session projects missing from server and sorts newest first', () => {
  const localOnly = makeStubProject('local-only', '2026-11-20T03:00:00Z');
  const sharedLocal = makeStubProject('shared', '2026-11-20T01:00:00Z', 1);
  const sharedServer = makeStubProject('shared', '2026-11-20T01:00:00Z', 4);
  const sampleServer = makeStubProject('demo', '2026-11-20T00:00:00Z', 2);

  const merged = mergeProjectsWithLocalStorage(
    [sharedServer, sampleServer],
    [localOnly, sharedLocal],
  );

  assert.deepEqual(
    merged.map((p) => p.id),
    ['local-only', 'shared', 'demo'],
  );
  assert.equal(merged[1].clips.length, 4);
});

test('clip draft localStorage helpers save, load, and clear unsaved editor changes', () => {
  const storage = createMemoryStorage();
  const clip: ClipItem = makeStubProject('p1', '2026-11-20T01:00:00Z').clips[0];
  clip.hookTitle = 'Edited Hook In Draft';

  saveClipDraftToStorage(clip, storage);
  const restored = loadClipDraftFromStorage(clip.id, storage);
  assert.ok(restored);
  assert.equal(restored.hookTitle, 'Edited Hook In Draft');

  clearClipDraftFromStorage(clip.id, storage);
  assert.equal(loadClipDraftFromStorage(clip.id, storage), null);
});
