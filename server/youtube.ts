import fs from 'node:fs';
import path from 'node:path';
import { Innertube } from 'youtubei.js';
import type { TranscriptLine } from '../src/lib/types.ts';
import { formatTimestamp } from '../src/lib/clip-logic.ts';
import { createVideoFromBackdropImage, probeVideoDuration, SOURCES_DIR, THUMBS_DIR } from './ffmpeg.ts';

export interface YouTubeFetchResult {
  title: string;
  channelName: string;
  durationSeconds: number;
  thumbnailPath: string;
  thumbnailUrl: string;
  sourceVideoPath: string;
  transcript: TranscriptLine[];
  downloadedDirectStream: boolean;
}

export async function fetchYouTubeSource(
  youtubeId: string,
  projectId: string,
): Promise<YouTubeFetchResult> {
  let title = `YouTube Video (${youtubeId})`;
  let channelName = 'YouTube Creator';
  let durationSeconds = 120;
  let remoteThumb = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
  const transcript: TranscriptLine[] = [];

  // 1. Fetch oEmbed metadata reliably first
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (oembedRes.ok) {
      const oembed = (await oembedRes.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (oembed.title) title = oembed.title;
      if (oembed.author_name) channelName = oembed.author_name;
      if (oembed.thumbnail_url) remoteThumb = oembed.thumbnail_url;
    }
  } catch {
    // Continue
  }

  // 2. Download thumbnail locally so frontend never hits broken external host issues
  const thumbPath = path.join(THUMBS_DIR, `${projectId}.jpg`);
  for (const thumbCandidate of [
    remoteThumb,
    `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
  ]) {
    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 2000) break;
    try {
      const imgRes = await fetch(thumbCandidate, { signal: AbortSignal.timeout(8000) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.byteLength > 2000) {
          fs.writeFileSync(thumbPath, buf);
        }
      }
    } catch {
      // Try next thumbnail
    }
  }

  if (!fs.existsSync(thumbPath)) {
    const fallbackImg = path.resolve('src/assets/images/studio_podcast_interview_1795094362500.jpg');
    fs.copyFileSync(fallbackImg, thumbPath);
  }

  // 3. Try Innertube (youtubei.js) for transcript & stream when not blocked by YouTube edge
  const sourceVideoPath = path.join(SOURCES_DIR, `${projectId}.mp4`);
  let downloadedDirectStream = false;

  try {
    const yt = await Innertube.create({ retrieve_player: true });
    const info = await yt.getInfo(youtubeId);

    if (info.basic_info?.title) title = info.basic_info.title;
    if (info.basic_info?.author) channelName = info.basic_info.author;
    if (info.basic_info?.duration && info.basic_info.duration > 0) {
      durationSeconds = info.basic_info.duration;
    }

    try {
      const transcriptData = await info.getTranscript();
      const segments =
        transcriptData?.transcript?.content?.body?.initial_segments ?? [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] as {
          start_ms?: string | number;
          end_ms?: string | number;
          snippet?: { text?: string; toString?: () => string };
        };
        const text = (seg.snippet?.text ?? seg.snippet?.toString?.() ?? '').trim();
        if (!text) continue;
        const startMs = Number(seg.start_ms ?? 0);
        const endMs = Number(seg.end_ms ?? startMs + 4000);
        const startSec = Math.max(0, Number((startMs / 1000).toFixed(2)));
        const endSec = Math.max(startSec + 0.5, Number((endMs / 1000).toFixed(2)));
        transcript.push({
          startTime: formatTimestamp(startSec),
          endTime: formatTimestamp(endSec),
          startSeconds: startSec,
          endSeconds: endSec,
          text,
        });
      }
    } catch {
      // Fallback to Gemini direct YouTube URL analysis in server.ts
    }

    try {
      const stream = await info.download({
        type: 'video+audio',
        quality: '360p',
        format: 'mp4',
      });
      const fileStream = fs.createWriteStream(sourceVideoPath);
      const reader = stream.getReader();
      let downloadedBytes = 0;
      const maxBytes = 120 * 1024 * 1024;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          downloadedBytes += value.byteLength;
          if (downloadedBytes > maxBytes) {
            await reader.cancel();
            break;
          }
          fileStream.write(value);
        }
      }
      await new Promise<void>((resolve) => fileStream.end(() => resolve()));

      const probed = await probeVideoDuration(sourceVideoPath);
      if (probed >= 5) {
        downloadedDirectStream = true;
        durationSeconds = probed;
      } else if (fs.existsSync(sourceVideoPath)) {
        fs.unlinkSync(sourceVideoPath);
      }
    } catch {
      if (fs.existsSync(sourceVideoPath)) {
        fs.unlinkSync(sourceVideoPath);
      }
    }
  } catch {
    // Innertube failed/blocked — server.ts uses Gemini direct YouTube URL analysis + embed preview
  }

  if (!downloadedDirectStream) {
    // Synthesize a local MP4 backdrop source for FFmpeg slice/export fallback
    await createVideoFromBackdropImage(thumbPath, sourceVideoPath, 60, 210);
  }

  return {
    title,
    channelName,
    durationSeconds,
    thumbnailPath: thumbPath,
    thumbnailUrl: `/media/thumbs/${projectId}.jpg`,
    sourceVideoPath,
    transcript,
    downloadedDirectStream,
  };
}
