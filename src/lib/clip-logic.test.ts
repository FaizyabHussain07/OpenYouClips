import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoSource,
  parseTimestampSeconds,
  formatTimestamp,
  snapBoundsToTranscript,
  computeViralityTotal,
  dedupeOverlappingSegments,
  buildWordTokensFromLines,
  groupWordsIntoCaptionLines,
  findActiveCaptionAtTime,
  clampTrimRange,
  splitWordsAtTime,
  formatSrtTimestamp,
  buildSrtFromWords,
  computeTargetClipCount,
  buildTimeWindows,
} from './clip-logic';

test('parseVideoSource extracts YouTube IDs across watch, shorts, and youtu.be', () => {
  const watch = parseVideoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
  assert.equal(watch.valid, true);
  assert.equal(watch.sourceType, 'youtube');
  assert.equal(watch.youtubeId, 'dQw4w9WgXcQ');

  const short = parseVideoSource('https://youtube.com/shorts/abc123XYZ_0');
  assert.equal(short.valid, true);
  assert.equal(short.youtubeId, 'abc123XYZ_0');

  const share = parseVideoSource('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(share.valid, true);
  assert.equal(share.youtubeId, 'dQw4w9WgXcQ');

  const empty = parseVideoSource('   ');
  assert.equal(empty.valid, false);
});

test('timestamp parsing and formatting roundtrip cleanly', () => {
  assert.equal(parseTimestampSeconds('01:25'), 85);
  assert.equal(parseTimestampSeconds('[1:02:05]'), 3725);
  assert.equal(formatTimestamp(85), '1:25');
  assert.equal(formatTimestamp(3725), '1:02:05');
});

test('snapBoundsToTranscript snaps near boundaries and preserves order', () => {
  const lines = [
    { startTime: '0:00', endTime: '0:08', startSeconds: 0, endSeconds: 8, text: 'Intro line' },
    { startTime: '0:08', endTime: '0:22', startSeconds: 8, endSeconds: 22, text: 'Hook line' },
    { startTime: '0:22', endTime: '0:38', startSeconds: 22, endSeconds: 38, text: 'Payoff line' },
  ];
  const snapped = snapBoundsToTranscript(lines, 10, 36, 8);
  assert.ok(snapped);
  assert.equal(snapped.startSeconds, 8);
  assert.equal(snapped.endSeconds, 38);
});

test('computeViralityTotal clamps each subscore to 0..25', () => {
  assert.equal(computeViralityTotal(24, 22, 20, 21), 87);
  assert.equal(computeViralityTotal(40, -5, 25, 25), 75);
});

test('dedupeOverlappingSegments keeps higher virality clip when overlap exceeds ratio', () => {
  const clips = [
    { id: 'low', startSeconds: 10, endSeconds: 40, virality: { totalScore: 72 } },
    { id: 'high', startSeconds: 12, endSeconds: 42, virality: { totalScore: 91 } },
    { id: 'distinct', startSeconds: 60, endSeconds: 90, virality: { totalScore: 84 } },
  ];
  const kept = dedupeOverlappingSegments(clips, 0.5);
  assert.deepEqual(
    kept.map((c) => c.id),
    ['high', 'distinct'],
  );
});

test('word token building enforces strictly monotonic non-overlapping timing even on overlapping transcript cues', () => {
  const lines = [
    { startTime: '0:10', endTime: '0:16', startSeconds: 10, endSeconds: 16, text: 'One two three' },
    { startTime: '0:13', endTime: '0:19', startSeconds: 13, endSeconds: 19, text: 'Four five six' },
  ];
  const words = buildWordTokensFromLines(lines, 10, 20);
  assert.equal(words.length, 6);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].end - 0.001);
  }

  const chunks = groupWordsIntoCaptionLines(words, 3);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].start >= chunks[0].end - 0.001);

  const active1 = findActiveCaptionAtTime(chunks, 1.5);
  assert.equal(active1.chunk?.words[0].word, 'One');

  const active2 = findActiveCaptionAtTime(chunks, chunks[1].start + 0.5);
  assert.equal(active2.chunk?.words[0].word, 'Four');
});

test('clampTrimRange and splitWordsAtTime enforce minimum duration and shift split timestamps', () => {
  const clamped = clampTrimRange(40, 20, 30, 5);
  assert.equal(clamped.trimStartOffset, 20);
  assert.equal(clamped.trimEndOffset, 15);

  const split = splitWordsAtTime(
    [
      { word: 'First', start: 0, end: 2 },
      { word: 'Second', start: 4, end: 6 },
    ],
    3,
  );
  assert.equal(split.firstHalf.length, 1);
  assert.equal(split.secondHalf.length, 1);
  assert.equal(split.secondHalf[0].start, 1);
  assert.equal(split.secondHalf[0].end, 3);
});

test('formatSrtTimestamp and buildSrtFromWords produce non-overlapping valid SRT subtitle cues', () => {
  assert.equal(formatSrtTimestamp(65.432), '00:01:05,432');
  const srt = buildSrtFromWords(
    [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'world', start: 0.5, end: 1.2 },
    ],
    2,
  );
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,200\nHello world/);
});

test('computeTargetClipCount and buildTimeWindows scale up to 20-28 clips across full timeline', () => {
  assert.deepEqual(computeTargetClipCount(90), { min: 3, max: 6 });
  assert.deepEqual(computeTargetClipCount(300), { min: 6, max: 12 });
  assert.deepEqual(computeTargetClipCount(900), { min: 18, max: 25 });
  assert.deepEqual(computeTargetClipCount(1800), { min: 22, max: 28 });

  const windows = buildTimeWindows(1800, 5);
  assert.equal(windows.length, 5);
  assert.equal(windows[0].startSeconds, 0);
  assert.equal(windows[windows.length - 1].endSeconds, 1800);
});
