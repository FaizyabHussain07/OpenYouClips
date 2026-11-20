import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import JSZip from 'jszip';
import { createServer as createViteServer } from 'vite';
import type {
  AgentStep,
  AgentStepStatus,
  CaptionTemplateId,
  ClipItem,
  ClipLengthPreset,
  ClipProject,
  OutputFormat,
  TranscriptLine,
  WorkflowMode,
} from './src/lib/types.ts';
import { getCaptionTemplate } from './src/lib/templates.ts';
import {
  buildSrtFromWords,
  buildWordTokensFromLines,
  formatSrtTimestamp,
  formatTimestamp,
  parseVideoSource,
  splitWordsAtTime,
} from './src/lib/clip-logic.ts';
import {
  CLIPS_DIR,
  DATA_ROOT,
  ensureDataDirs,
  exportRenderedClip,
  extractAudioForTranscription,
  probeVideoDuration,
  sliceClipFromSource,
  SOURCES_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
} from './server/ffmpeg.ts';
import { fetchYouTubeSource } from './server/youtube.ts';
import {
  analyzeTranscriptForClips,
  analyzeYouTubeUrlDirectlyWithGemini,
  formatGeminiErrorMessage,
  rewriteClipWithAI,
  transcribeAudioWithGemini,
} from './server/gemini.ts';
import {
  addClipToProject,
  deleteClipFromProject,
  deleteProject,
  getProject,
  initStore,
  listProjects,
  updateClipInStore,
  upsertProject,
} from './server/store.ts';

ensureDataDirs();

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 250 * 1024 * 1024 },
});

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function createInitialAgentSteps(sourceType: ClipProject['sourceType']): AgentStep[] {
  return [
    {
      id: 'ingest',
      agentName: 'Media Ingestion Agent',
      title: 'Metadata & Video Stream Probe',
      status: 'pending',
      detail:
        sourceType === 'youtube'
          ? 'Resolving YouTube metadata, thumbnail, and testing direct stream availability.'
          : 'Inspecting source video codec, resolution, and duration via FFmpeg.',
    },
    {
      id: 'audio_transcribe',
      agentName: 'Speech & Multimodal Agent',
      title: 'Audio Extraction & Transcription',
      status: 'pending',
      detail: 'Preparing spoken word timeline and sentence-level timestamps.',
    },
    {
      id: 'virality_scout',
      agentName: 'Virality & Hook Agent',
      title: '4-Axis Scoring & Highlight Discovery',
      status: 'pending',
      detail: 'Scanning for attention hooks, emotional peaks, and high-retention payoffs.',
    },
    {
      id: 'reframe_captions',
      agentName: 'Reframing & Word-Sync Agent',
      title: 'Aspect Crop & Karaoke Alignment',
      status: 'pending',
      detail: 'Aligning word-by-word caption timestamps, hook banners, and target framing.',
    },
    {
      id: 'render_clips',
      agentName: 'Clip Cutter & Studio Assembler',
      title: 'Segment Slicing & Studio Setup',
      status: 'pending',
      detail: 'Building playable studio clips with non-destructive trim, split, and export tracks.',
    },
  ];
}

function setAgentStep(
  project: ClipProject,
  stepId: string,
  status: AgentStepStatus,
  detail: string,
  metrics?: string[],
): void {
  if (!project.agentSteps || project.agentSteps.length === 0) {
    project.agentSteps = createInitialAgentSteps(project.sourceType);
  }
  const now = new Date().toISOString();
  project.agentSteps = project.agentSteps.map((step) => {
    if (step.id !== stepId) return step;
    return {
      ...step,
      status,
      detail,
      metrics: metrics ?? step.metrics,
      startedAt: step.startedAt ?? (status === 'running' ? now : undefined),
      completedAt:
        status === 'completed' || status === 'warning' || status === 'error'
          ? now
          : undefined,
    };
  });
}

async function runProjectPipeline(params: {
  project: ClipProject;
  uploadedFilePath?: string;
  reuseExistingTranscript?: boolean;
}): Promise<void> {
  const { project, uploadedFilePath, reuseExistingTranscript } = params;
  if (!project.agentSteps || project.agentSteps.length === 0) {
    project.agentSteps = createInitialAgentSteps(project.sourceType);
  }
  const update = (patch: Partial<ClipProject>) => {
    Object.assign(project, patch);
    upsertProject(project);
  };

  try {
    let sourceVideoPath = path.join(SOURCES_DIR, `${project.id}.mp4`);
    let precomputedAnalysis: Awaited<ReturnType<typeof analyzeTranscriptForClips>> | null = null;

    if (!reuseExistingTranscript) {
      if (project.sourceType === 'youtube' && project.youtubeId) {
        setAgentStep(
          project,
          'ingest',
          'running',
          `Fetching metadata, thumbnail & testing stream download for YouTube ID ${project.youtubeId}…`,
        );
        update({
          stage: 'fetching_source',
          progress: 14,
          stageMessage: 'Media Ingestion Agent: Fetching YouTube metadata and video stream…',
        });
        const yt = await fetchYouTubeSource(project.youtubeId, project.id);
        sourceVideoPath = yt.sourceVideoPath;
        setAgentStep(
          project,
          'ingest',
          yt.downloadedDirectStream ? 'completed' : 'warning',
          yt.downloadedDirectStream
            ? `Captured YouTube video metadata and local MP4 stream for "${yt.title}".`
            : `Loaded YouTube metadata & thumbnail for "${yt.title}". Direct server MP4 download blocked by YouTube — binding live YouTube embed stream for real video playback.`,
          [
            `Channel: ${yt.channelName}`,
            `Duration: ${formatTimestamp(yt.durationSeconds)}`,
            yt.downloadedDirectStream ? 'Stream: Local MP4 Ready' : 'Stream: Live YouTube Player',
          ],
        );
        update({
          title: yt.title,
          channelName: yt.channelName,
          durationSeconds: yt.durationSeconds,
          thumbnailUrl: yt.thumbnailUrl,
          sourceVideoUrl: `/media/sources/${project.id}.mp4`,
          hasDirectVideo: yt.downloadedDirectStream,
          transcript: yt.transcript,
        });

        if (yt.transcript.length === 0) {
          if (yt.downloadedDirectStream) {
            setAgentStep(
              project,
              'audio_transcribe',
              'running',
              'Extracting 16kHz MP3 audio via FFmpeg and running Gemini speech transcription…',
            );
            update({
              stage: 'transcribing',
              progress: 38,
              stageMessage: 'Speech Agent: Extracting audio and transcribing dialogue…',
            });
            const audioPath = path.join(UPLOADS_DIR, `${project.id}.mp3`);
            await extractAudioForTranscription(sourceVideoPath, audioPath);
            const transcribed = await transcribeAudioWithGemini(audioPath, yt.durationSeconds);
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            const totalWords = transcribed.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0);
            setAgentStep(
              project,
              'audio_transcribe',
              'completed',
              `Transcribed spoken dialogue with exact start/end timestamps.`,
              [`${transcribed.length} segments`, `${totalWords} spoken words`],
            );
            update({ transcript: transcribed });
          } else {
            setAgentStep(
              project,
              'audio_transcribe',
              'running',
              'Gemini multimodal agent is watching & listening to the YouTube video to extract timestamped dialogue…',
            );
            setAgentStep(
              project,
              'virality_scout',
              'running',
              `Scanning video for ${project.workflow} hooks (${project.clipLength} length target)…`,
            );
            update({
              stage: 'analyzing_virality',
              progress: 48,
              stageMessage: 'Speech & Virality Agents: Analyzing YouTube video with Gemini AI…',
            });
            const direct = await analyzeYouTubeUrlDirectlyWithGemini({
              youtubeUrl: `https://www.youtube.com/watch?v=${project.youtubeId}`,
              title: yt.title,
              workflow: project.workflow,
              clipLength: project.clipLength,
              topicFocus: project.topicFocus,
              customInstructions: project.customInstructions,
              onRetryNotice: (notice) => {
                setAgentStep(project, 'audio_transcribe', 'running', notice);
                update({
                  stage: 'analyzing_virality',
                  progress: 52,
                  stageMessage: `Speech & Virality Agents: ${notice}`,
                });
              },
            });
            const totalWords = direct.transcript.reduce(
              (acc, l) => acc + l.text.split(/\s+/).length,
              0,
            );
            setAgentStep(
              project,
              'audio_transcribe',
              'completed',
              `Extracted timestamped transcript directly from YouTube audio/video timeline.`,
              [
                `${direct.transcript.length} timeline beats`,
                `${totalWords} spoken words`,
                `Duration: ${formatTimestamp(direct.estimatedDurationSeconds)}`,
              ],
            );
            const topScore = direct.segments.reduce(
              (m, s) => Math.max(m, s.virality.totalScore),
              0,
            );
            setAgentStep(
              project,
              'virality_scout',
              'completed',
              `Scored ${direct.segments.length} candidate viral segments across Hook, Engagement, Value & Shareability.`,
              [
                `${direct.segments.length} viral clips`,
                `Top Score: ${topScore}/100`,
                `Mode: ${project.workflow}`,
              ],
            );
            update({
              transcript: direct.transcript,
              durationSeconds: direct.estimatedDurationSeconds,
            });
            precomputedAnalysis = {
              summary: direct.summary,
              keyTopics: direct.keyTopics,
              segments: direct.segments,
            };
          }
        } else {
          const totalWords = yt.transcript.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0);
          setAgentStep(
            project,
            'audio_transcribe',
            'completed',
            'Loaded caption transcript directly from YouTube track.',
            [`${yt.transcript.length} caption lines`, `${totalWords} spoken words`],
          );
        }
      } else if (project.sourceType === 'upload' && (uploadedFilePath || fs.existsSync(sourceVideoPath))) {
        setAgentStep(
          project,
          'ingest',
          'running',
          'Copying uploaded MP4/video source and probing duration & stream metadata via FFmpeg…',
        );
        update({
          stage: 'fetching_source',
          progress: 18,
          stageMessage: 'Media Ingestion Agent: Inspecting uploaded video file…',
        });
        if (uploadedFilePath) {
          fs.copyFileSync(uploadedFilePath, sourceVideoPath);
          if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
        }

        const duration = (await probeVideoDuration(sourceVideoPath)) || 60;
        const fallbackImg = path.resolve('src/assets/images/studio_podcast_interview_1795094362500.jpg');
        const thumbPath = path.join(THUMBS_DIR, `${project.id}.jpg`);
        fs.copyFileSync(fallbackImg, thumbPath);

        setAgentStep(
          project,
          'ingest',
          'completed',
          'Local source video verified and ready for full-motion clip slicing & HD export.',
          [`Duration: ${formatTimestamp(duration)}`, 'Stream: Local MP4 Ready'],
        );
        setAgentStep(
          project,
          'audio_transcribe',
          'running',
          'Extracting 16kHz audio track via FFmpeg and transcribing speech with Gemini…',
        );

        update({
          durationSeconds: duration,
          thumbnailUrl: `/media/thumbs/${project.id}.jpg`,
          sourceVideoUrl: `/media/sources/${project.id}.mp4`,
          hasDirectVideo: true,
          stage: 'transcribing',
          progress: 40,
          stageMessage: 'Speech Agent: Extracting audio and transcribing speech…',
        });

        const audioPath = path.join(UPLOADS_DIR, `${project.id}.mp3`);
        await extractAudioForTranscription(sourceVideoPath, audioPath);
        const transcript = await transcribeAudioWithGemini(audioPath, duration);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (transcript.length === 0) {
          throw new Error('Could not detect spoken dialogue in the uploaded video.');
        }
        const totalWords = transcript.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0);
        setAgentStep(
          project,
          'audio_transcribe',
          'completed',
          'Completed word-accurate speech transcription for uploaded video.',
          [`${transcript.length} transcript lines`, `${totalWords} spoken words`],
        );
        update({ transcript });
      } else if (project.sourceType === 'video_url') {
        setAgentStep(
          project,
          'ingest',
          'running',
          'Downloading remote MP4/video stream and verifying duration…',
        );
        update({
          stage: 'fetching_source',
          progress: 20,
          stageMessage: 'Media Ingestion Agent: Downloading remote video stream…',
        });
        const res = await fetch(project.sourceUrl, { signal: AbortSignal.timeout(45000) });
        if (!res.ok) {
          throw new Error(`Failed to fetch remote video URL (HTTP ${res.status}).`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(sourceVideoPath, buf);
        const duration = (await probeVideoDuration(sourceVideoPath)) || 60;
        const fallbackImg = path.resolve('src/assets/images/keynote_stage_speaker_1795094363137.jpg');
        fs.copyFileSync(fallbackImg, path.join(THUMBS_DIR, `${project.id}.jpg`));

        setAgentStep(
          project,
          'ingest',
          'completed',
          `Downloaded remote video (${(buf.byteLength / (1024 * 1024)).toFixed(1)} MB) for full-motion slicing.`,
          [`Duration: ${formatTimestamp(duration)}`, 'Stream: Local MP4 Ready'],
        );
        setAgentStep(
          project,
          'audio_transcribe',
          'running',
          'Extracting audio track and running Gemini speech transcription…',
        );

        update({
          durationSeconds: duration,
          thumbnailUrl: `/media/thumbs/${project.id}.jpg`,
          sourceVideoUrl: `/media/sources/${project.id}.mp4`,
          hasDirectVideo: true,
          stage: 'transcribing',
          progress: 42,
          stageMessage: 'Speech Agent: Extracting audio and transcribing speech…',
        });

        const audioPath = path.join(UPLOADS_DIR, `${project.id}.mp3`);
        await extractAudioForTranscription(sourceVideoPath, audioPath);
        const transcript = await transcribeAudioWithGemini(audioPath, duration);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        const totalWords = transcript.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0);
        setAgentStep(
          project,
          'audio_transcribe',
          'completed',
          'Completed speech transcription across remote video.',
          [`${transcript.length} transcript lines`, `${totalWords} spoken words`],
        );
        update({ transcript });
      } else {
        throw new Error(
          `Direct stream ingestion for ${project.sourceType} URLs requires an MP4 download or YouTube link.`,
        );
      }
    } else {
      setAgentStep(
        project,
        'ingest',
        project.hasDirectVideo === false ? 'warning' : 'completed',
        'Reusing existing project media & transcript for new AI workflow pass.',
      );
      setAgentStep(
        project,
        'audio_transcribe',
        'completed',
        `Loaded ${project.transcript.length} existing transcript lines.`,
      );
    }

    let analysis = precomputedAnalysis;
    if (!analysis) {
      setAgentStep(
        project,
        'virality_scout',
        'running',
        `Evaluating ${project.transcript.length} transcript segments in ${project.workflow} mode (${project.clipLength})…`,
      );
      update({
        stage: 'analyzing_virality',
        progress: 65,
        stageMessage: 'Virality Agent: Scoring hooks, emotional peaks, and retention value…',
      });

      analysis = await analyzeTranscriptForClips({
        title: project.title,
        transcript: project.transcript,
        durationSeconds: project.durationSeconds,
        workflow: project.workflow,
        clipLength: project.clipLength,
        topicFocus: project.topicFocus,
        customInstructions: project.customInstructions,
      });

      const topScore = analysis.segments.reduce((m, s) => Math.max(m, s.virality.totalScore), 0);
      setAgentStep(
        project,
        'virality_scout',
        'completed',
        `Identified ${analysis.segments.length} qualifying viral segments and ranked hook strength.`,
        [
          `${analysis.segments.length} viral clips`,
          `Top Score: ${topScore}/100`,
          `Topics: ${analysis.keyTopics.slice(0, 3).join(', ') || 'Highlights'}`,
        ],
      );
    }

    if (analysis.segments.length === 0) {
      throw new Error('AI analysis did not identify any qualifying segments for the selected criteria.');
    }

    setAgentStep(
      project,
      'reframe_captions',
      'running',
      `Aligning word-level karaoke tokens, ${project.captionTemplate} caption styling, and ${project.outputFormat} framing…`,
    );
    update({
      stage: 'rendering_clips',
      progress: 82,
      stageMessage: `Reframing & Assembly Agents: Preparing ${analysis.segments.length} clips with word-synced captions…`,
      summary: analysis.summary,
      keyTopics: analysis.keyTopics,
    });

    const clips: ClipItem[] = [];
    const sourceTotalDuration = (await probeVideoDuration(sourceVideoPath)) || project.durationSeconds;
    let totalWordTokens = 0;

    setAgentStep(
      project,
      'render_clips',
      'running',
      `Assembling ${analysis.segments.length} studio clip timelines and media tracks…`,
    );

    for (let i = 0; i < analysis.segments.length; i++) {
      const seg = analysis.segments[i];
      const clipId = uid('clip');
      const clipPath = path.join(CLIPS_DIR, `${clipId}.mp4`);

      // Clamp slice timestamp inside the actual playable source file duration
      const clipDur = Math.max(4, seg.endSeconds - seg.startSeconds);
      const sliceStart =
        seg.startSeconds + clipDur <= sourceTotalDuration
          ? seg.startSeconds
          : Math.max(0, sourceTotalDuration - clipDur);

      await sliceClipFromSource(sourceVideoPath, clipPath, sliceStart, clipDur);

      const words = buildWordTokensFromLines(
        project.transcript,
        seg.startSeconds,
        seg.endSeconds,
      );
      totalWordTokens += words.length;

      clips.push({
        id: clipId,
        projectId: project.id,
        clipOrder: i + 1,
        startTime: seg.startTime,
        endTime: seg.endTime,
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        duration: Math.round(clipDur),
        trimStartOffset: 0,
        trimEndOffset: 0,
        hookTitle: seg.hookTitle,
        text: seg.text,
        reasoning: seg.reasoning,
        virality: seg.virality,
        workflowRole: seg.workflowRole,
        partNumber: seg.partNumber,
        words,
        captionStyle: getCaptionTemplate(project.captionTemplate),
        framing: {
          outputFormat: project.outputFormat,
          panX: 0,
          panY: 0,
          zoom: 1,
          autoCenterSpeaker: true,
        },
        hookBanner: {
          enabled: true,
          text: seg.hookTitle,
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
        videoUrl: `/media/clips/${clipId}.mp4`,
      });
    }

    setAgentStep(
      project,
      'reframe_captions',
      'completed',
      `Synced ${totalWordTokens} karaoke word tokens and applied ${project.captionTemplate} caption styling in ${project.outputFormat} framing.`,
      [`${totalWordTokens} word tokens`, `Template: ${project.captionTemplate}`, `Format: ${project.outputFormat}`],
    );
    setAgentStep(
      project,
      'render_clips',
      'completed',
      project.hasDirectVideo === false
        ? `${clips.length} clips assembled with live YouTube video stream preview & synced Studio tracks.`
        : `${clips.length} full-motion H.264 video clips sliced and ready for Studio editing & MP4 export.`,
      [
        `${clips.length} clips ready`,
        project.hasDirectVideo === false ? 'Playback: Live YouTube' : 'Export: Full HD MP4',
      ],
    );

    update({
      clips,
      stage: 'completed',
      progress: 100,
      stageMessage: `${clips.length} viral clips ready`,
      errorMessage: undefined,
    });
  } catch (err) {
    const message = err ? formatGeminiErrorMessage(err) : 'Unexpected clipping pipeline error';
    for (const s of project.agentSteps ?? []) {
      if (s.status === 'running') {
        setAgentStep(project, s.id, 'error', message);
      }
    }
    update({
      stage: 'error',
      progress: 100,
      stageMessage: 'Pipeline stopped',
      errorMessage: message,
    });
  }
}

async function startServer() {
  // Kick off seed initialization immediately without blocking port 3000 binding
  const storeReady = initStore().catch((err) => {
    console.error('Store initialization error:', err);
  });

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Serve generated/uploaded/exported media with byte-range support
  app.use('/media', express.static(DATA_ROOT));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    });
  });

  app.get('/api/projects', async (_req, res) => {
    await storeReady;
    res.json({ projects: listProjects() });
  });

  app.get('/api/projects/:id', async (req, res) => {
    await storeReady;
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const removed = deleteProject(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/projects/restore', async (req, res) => {
    await storeReady;
    const { project } = req.body as { project?: ClipProject };
    if (!project || !project.id || !project.title) {
      res.status(400).json({ error: 'Invalid project backup payload.' });
      return;
    }
    const existing = getProject(project.id);
    if (existing) {
      res.json({ project: existing });
      return;
    }
    const safeProject: ClipProject = {
      ...project,
      isSample: false,
      stage: project.stage === 'completed' || project.stage === 'error' ? project.stage : 'completed',
      hasDirectVideo: project.hasDirectVideo ?? false,
    };
    upsertProject(safeProject);
    res.status(201).json({ project: safeProject });
  });

  app.post('/api/projects/from-url', async (req, res) => {
    const body = req.body as {
      url?: string;
      workflow?: WorkflowMode;
      outputFormat?: OutputFormat;
      clipLength?: ClipLengthPreset;
      captionTemplate?: CaptionTemplateId;
      topicFocus?: string;
      customInstructions?: string;
    };

    const parsed = parseVideoSource(body.url ?? '');
    if (!parsed.valid || parsed.sourceType === 'invalid') {
      res.status(400).json({ error: parsed.error ?? 'Invalid video URL' });
      return;
    }

    const projectId = uid('proj');
    const project: ClipProject = {
      id: projectId,
      title: parsed.youtubeId ? `YouTube Import (${parsed.youtubeId})` : 'Remote Video Import',
      channelName: parsed.sourceType === 'youtube' ? 'YouTube' : 'Web Video',
      sourceType: parsed.sourceType,
      sourceUrl: parsed.normalizedUrl,
      youtubeId: parsed.youtubeId,
      thumbnailUrl: '/media/thumbs/demo-founder-podcast.jpg',
      sourceVideoUrl: '',
      durationSeconds: 60,
      workflow: body.workflow ?? 'highlights',
      topicFocus: body.topicFocus?.trim() || undefined,
      customInstructions: body.customInstructions?.trim() || undefined,
      outputFormat: body.outputFormat ?? 'vertical',
      clipLength: body.clipLength ?? 'auto',
      captionTemplate: body.captionTemplate ?? 'default',
      stage: 'queued',
      progress: 8,
      stageMessage: 'Queued for AI clipping…',
      agentSteps: createInitialAgentSteps(parsed.sourceType),
      summary: '',
      keyTopics: [],
      transcript: [],
      clips: [],
      createdAt: new Date().toISOString(),
    };

    upsertProject(project);
    void runProjectPipeline({ project });
    res.status(201).json({ project });
  });

  app.post('/api/projects/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No video file uploaded.' });
      return;
    }

    const body = req.body as {
      title?: string;
      workflow?: WorkflowMode;
      outputFormat?: OutputFormat;
      clipLength?: ClipLengthPreset;
      captionTemplate?: CaptionTemplateId;
      topicFocus?: string;
      customInstructions?: string;
    };

    const projectId = uid('proj');
    const baseName = req.file.originalname.replace(/\.[^.]+$/, '') || 'Uploaded Video';
    const project: ClipProject = {
      id: projectId,
      title: body.title?.trim() || baseName,
      channelName: 'Local Upload',
      sourceType: 'upload',
      sourceUrl: `upload://${req.file.originalname}`,
      thumbnailUrl: '/media/thumbs/demo-founder-podcast.jpg',
      sourceVideoUrl: '',
      durationSeconds: 60,
      workflow: (body.workflow as WorkflowMode) || 'highlights',
      topicFocus: body.topicFocus?.trim() || undefined,
      customInstructions: body.customInstructions?.trim() || undefined,
      outputFormat: (body.outputFormat as OutputFormat) || 'vertical',
      clipLength: (body.clipLength as ClipLengthPreset) || 'auto',
      captionTemplate: (body.captionTemplate as CaptionTemplateId) || 'default',
      stage: 'queued',
      progress: 10,
      stageMessage: 'Upload received, preparing audio extraction…',
      agentSteps: createInitialAgentSteps('upload'),
      summary: '',
      keyTopics: [],
      transcript: [],
      clips: [],
      createdAt: new Date().toISOString(),
    };

    upsertProject(project);
    void runProjectPipeline({ project, uploadedFilePath: req.file.path });
    res.status(201).json({ project });
  });

  app.post('/api/projects/:id/reclip', async (req, res) => {
    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const body = req.body as {
      workflow?: WorkflowMode;
      outputFormat?: OutputFormat;
      clipLength?: ClipLengthPreset;
      captionTemplate?: CaptionTemplateId;
      topicFocus?: string;
      customInstructions?: string;
    };

    const newId = uid('proj');
    const sourceSrc = path.join(SOURCES_DIR, `${existing.id}.mp4`);
    const sourceDest = path.join(SOURCES_DIR, `${newId}.mp4`);
    const thumbSrc = path.join(THUMBS_DIR, `${existing.id}.jpg`);
    const thumbDest = path.join(THUMBS_DIR, `${newId}.jpg`);

    if (fs.existsSync(sourceSrc)) fs.copyFileSync(sourceSrc, sourceDest);
    if (fs.existsSync(thumbSrc)) fs.copyFileSync(thumbSrc, thumbDest);

    const cloned: ClipProject = {
      ...existing,
      id: newId,
      isSample: false,
      workflow: body.workflow ?? existing.workflow,
      outputFormat: body.outputFormat ?? existing.outputFormat,
      clipLength: body.clipLength ?? existing.clipLength,
      captionTemplate: body.captionTemplate ?? existing.captionTemplate,
      topicFocus: body.topicFocus?.trim() || undefined,
      customInstructions: body.customInstructions?.trim() || undefined,
      thumbnailUrl: `/media/thumbs/${newId}.jpg`,
      sourceVideoUrl: `/media/sources/${newId}.mp4`,
      stage: 'analyzing_virality',
      progress: 50,
      stageMessage: 'Re-analyzing transcript with new workflow settings…',
      agentSteps: createInitialAgentSteps(existing.sourceType),
      errorMessage: undefined,
      clips: [],
      createdAt: new Date().toISOString(),
    };

    upsertProject(cloned);
    void runProjectPipeline({ project: cloned, reuseExistingTranscript: true });
    res.status(201).json({ project: cloned });
  });

  app.post('/api/projects/:id/retry', async (req, res) => {
    await storeReady;
    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    existing.stage = 'queued';
    existing.progress = 10;
    existing.errorMessage = undefined;
    existing.stageMessage = 'Retrying AI clipping pipeline…';
    existing.agentSteps = createInitialAgentSteps(existing.sourceType);
    existing.clips = [];
    upsertProject(existing);

    const reuseTranscript = existing.transcript.length > 0;
    void runProjectPipeline({ project: existing, reuseExistingTranscript: reuseTranscript });
    res.status(200).json({ project: existing });
  });

  app.post('/api/projects/:id/attach-source', upload.single('video'), async (req, res) => {
    await storeReady;
    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Select an MP4/MOV/WebM source video file.' });
      return;
    }

    try {
      const sourceVideoPath = path.join(SOURCES_DIR, `${existing.id}.mp4`);
      fs.copyFileSync(req.file.path, sourceVideoPath);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

      const probedDuration = (await probeVideoDuration(sourceVideoPath)) || existing.durationSeconds;
      for (const clip of existing.clips) {
        const clipPath = path.join(CLIPS_DIR, `${clip.id}.mp4`);
        const clipDur = Math.max(4, clip.endSeconds - clip.startSeconds);
        const sliceStart =
          clip.startSeconds + clipDur <= probedDuration
            ? clip.startSeconds
            : Math.max(0, probedDuration - clipDur);
        await sliceClipFromSource(sourceVideoPath, clipPath, sliceStart, clipDur);
      }

      existing.hasDirectVideo = true;
      existing.durationSeconds = probedDuration;
      setAgentStep(
        existing,
        'ingest',
        'completed',
        'Attached full-motion source MP4 video and verified codec/duration.',
        [`Duration: ${formatTimestamp(probedDuration)}`, 'Stream: Local MP4 Ready'],
      );
      setAgentStep(
        existing,
        'render_clips',
        'completed',
        `Re-sliced ${existing.clips.length} full-motion video clips from attached MP4 for HD export.`,
        [`${existing.clips.length} clips ready`, 'Export: Full HD MP4'],
      );
      upsertProject(existing);
      res.json({ project: existing });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to attach source video file.',
      });
    }
  });

  app.patch('/api/projects/:projectId/clips/:clipId', (req, res) => {
    const patch = req.body as Partial<ClipItem>;
    const updated = updateClipInStore(req.params.projectId, req.params.clipId, (clip) => ({
      ...clip,
      hookTitle: patch.hookTitle ?? clip.hookTitle,
      text: patch.text ?? clip.text,
      trimStartOffset: patch.trimStartOffset ?? clip.trimStartOffset,
      trimEndOffset: patch.trimEndOffset ?? clip.trimEndOffset,
      words: patch.words ?? clip.words,
      captionStyle: patch.captionStyle ?? clip.captionStyle,
      framing: patch.framing ?? clip.framing,
      hookBanner: patch.hookBanner ?? clip.hookBanner,
      effects: patch.effects ?? clip.effects,
    }));

    if (!updated) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.json({ clip: updated });
  });

  app.post('/api/projects/:projectId/clips/:clipId/split', async (req, res) => {
    const project = getProject(req.params.projectId);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }

    const { splitTimeSeconds } = req.body as { splitTimeSeconds?: number };
    const splitAt = Number(splitTimeSeconds ?? clip.duration / 2);
    if (!Number.isFinite(splitAt) || splitAt < 2 || splitAt > clip.duration - 2) {
      res.status(400).json({ error: 'Split point must leave at least 2 seconds on both sides.' });
      return;
    }

    const srcClipFile = path.join(CLIPS_DIR, `${clip.id}.mp4`);
    if (!fs.existsSync(srcClipFile)) {
      res.status(404).json({ error: 'Clip media file missing on disk.' });
      return;
    }

    const firstId = uid('clip');
    const secondId = uid('clip');
    const firstFile = path.join(CLIPS_DIR, `${firstId}.mp4`);
    const secondFile = path.join(CLIPS_DIR, `${secondId}.mp4`);

    try {
      await sliceClipFromSource(srcClipFile, firstFile, 0, splitAt);
      await sliceClipFromSource(srcClipFile, secondFile, splitAt, clip.duration - splitAt);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'FFmpeg split failed' });
      return;
    }

    const { firstHalf, secondHalf } = splitWordsAtTime(clip.words, splitAt);
    const midSourceSec = clip.startSeconds + splitAt;

    const firstClip: ClipItem = {
      ...clip,
      id: firstId,
      endSeconds: midSourceSec,
      endTime: formatTimestamp(midSourceSec),
      duration: Math.round(splitAt),
      trimStartOffset: 0,
      trimEndOffset: 0,
      hookTitle: `${clip.hookTitle} (Part A)`,
      words: firstHalf,
      text: firstHalf.map((w) => w.word).join(' ') || clip.text,
      videoUrl: `/media/clips/${firstId}.mp4`,
      exportedUrl: undefined,
    };

    const secondClip: ClipItem = {
      ...clip,
      id: secondId,
      clipOrder: project.clips.length + 1,
      startSeconds: midSourceSec,
      startTime: formatTimestamp(midSourceSec),
      duration: Math.round(clip.duration - splitAt),
      trimStartOffset: 0,
      trimEndOffset: 0,
      hookTitle: `${clip.hookTitle} (Part B)`,
      words: secondHalf,
      text: secondHalf.map((w) => w.word).join(' ') || clip.text,
      videoUrl: `/media/clips/${secondId}.mp4`,
      exportedUrl: undefined,
    };

    deleteClipFromProject(project.id, clip.id);
    addClipToProject(project.id, firstClip);
    addClipToProject(project.id, secondClip);

    res.json({ clips: [firstClip, secondClip], project: getProject(project.id) });
  });

  app.delete('/api/projects/:projectId/clips/:clipId', (req, res) => {
    const ok = deleteClipFromProject(req.params.projectId, req.params.clipId);
    if (!ok) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/projects/:projectId/clips/:clipId/ai-rewrite', async (req, res) => {
    const project = getProject(req.params.projectId);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }

    const { instruction } = req.body as { instruction?: string };
    if (!instruction?.trim()) {
      res.status(400).json({ error: 'Enter an instruction for the AI editor.' });
      return;
    }

    try {
      const rewritten = await rewriteClipWithAI(clip, instruction.trim());
      const updated = updateClipInStore(project.id, clip.id, (c) => ({
        ...c,
        hookTitle: rewritten.hookTitle,
        reasoning: rewritten.reasoning,
        hookBanner: {
          ...c.hookBanner,
          text: rewritten.hookBannerText,
        },
      }));
      res.json({ clip: updated });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gemini AI rewrite failed.',
      });
    }
  });

  app.post('/api/projects/:projectId/clips/:clipId/export', async (req, res) => {
    const project = getProject(req.params.projectId);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }

    const { includeCaptions = true } = (req.body as { includeCaptions?: boolean }) ?? {};
    const srcClipPath = path.join(CLIPS_DIR, `${clip.id}.mp4`);
    if (!fs.existsSync(srcClipPath)) {
      res.status(404).json({ error: 'Source clip file not found.' });
      return;
    }

    const exportFilename = `${clip.id}-${Date.now()}.mp4`;
    const outExportPath = path.join(DATA_ROOT, 'exports', exportFilename);
    const effectiveDuration = Math.max(
      2,
      clip.duration - clip.trimStartOffset - clip.trimEndOffset,
    );

    try {
      await exportRenderedClip({
        sourceClipPath: srcClipPath,
        outExportPath,
        trimStartOffset: clip.trimStartOffset,
        effectiveDuration,
        framing: clip.framing,
        captionStyle: clip.captionStyle,
        hookBanner: clip.hookBanner,
        effects: clip.effects,
        words: clip.words,
        includeCaptions,
      });

      const exportedUrl = `/media/exports/${exportFilename}`;
      const updated = updateClipInStore(project.id, clip.id, (c) => ({
        ...c,
        exportedUrl,
        lastExportedAt: new Date().toISOString(),
      }));

      res.json({
        exportedUrl,
        clip: updated,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'FFmpeg MP4 export failed.',
      });
    }
  });

  const handleExportProjectZip = async (req: express.Request, res: express.Response) => {
    await storeReady;
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    try {
      const zip = new JSZip();
      const slugify = (s: string) =>
        s
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 48) || 'clip';

      const projectSlug = slugify(project.title);
      const sortedClips = [...project.clips].sort(
        (a, b) => b.virality.totalScore - a.virality.totalScore,
      );

      // 1. Metadata & Ranked Viral Clips Report
      const reportLines: string[] = [
        `# ${project.title}`,
        `Channel: ${project.channelName} · Source: ${project.sourceUrl}`,
        `Workflow: ${project.workflow} · Output Format: ${project.outputFormat} · Clips: ${sortedClips.length}`,
        '',
        '## AI Summary',
        project.summary || 'No summary generated.',
        '',
        `Topics: ${project.keyTopics.join(', ') || 'None'}`,
        '',
        '## Extracted Viral Clips (Ranked by Virality Score)',
      ];

      let exportedVideoCount = 0;
      const ytTimestampLinks: string[] = [];

      for (let i = 0; i < sortedClips.length; i++) {
        const clip = sortedClips[i];
        const prefix = String(i + 1).padStart(2, '0');
        const clipSlug = `${prefix}-${slugify(clip.hookTitle)}`;

        reportLines.push(
          '',
          `### #${i + 1} — ${clip.hookTitle} (${clip.virality.totalScore}/100 · ${clip.virality.hookType})`,
          `Time: ${clip.startTime} - ${clip.endTime} (${clip.duration}s) · Hook ${clip.virality.hookScore}/25 · Engagement ${clip.virality.engagementScore}/25 · Value ${clip.virality.valueScore}/25 · Shareability ${clip.virality.shareabilityScore}/25`,
          `AI Insight: ${clip.virality.viralityReasoning || clip.reasoning}`,
          `Transcript: "${clip.text}"`,
        );

        // Per-clip .srt & .txt
        const srtContent = buildSrtFromWords(clip.words, clip.captionStyle.maxWordsPerLine);
        zip.file(`clips/${clipSlug}.srt`, srtContent || `1\n00:00:00,000 --> 00:00:05,000\n${clip.text}\n`);
        zip.file(
          `clips/${clipSlug}.txt`,
          `${clip.hookTitle}\nTime: ${clip.startTime} - ${clip.endTime}\nScore: ${clip.virality.totalScore}/100 (${clip.virality.hookType})\n\n${clip.text}\n`,
        );

        if (project.youtubeId) {
          const ytSec = Math.max(0, Math.floor(clip.startSeconds));
          ytTimestampLinks.push(
            `${prefix}. [${clip.startTime} - ${clip.endTime}] ${clip.hookTitle}\n    https://www.youtube.com/watch?v=${project.youtubeId}&t=${ytSec}s`,
          );
        }

        // Attach already-rendered MP4 or render on-the-fly for full-motion direct video projects
        let mp4Path: string | null = null;
        if (clip.exportedUrl) {
          const existingExport = path.join(DATA_ROOT, 'exports', path.basename(clip.exportedUrl));
          if (fs.existsSync(existingExport)) {
            mp4Path = existingExport;
          }
        }

        if (!mp4Path && project.hasDirectVideo !== false) {
          const srcClipPath = path.join(CLIPS_DIR, `${clip.id}.mp4`);
          if (fs.existsSync(srcClipPath)) {
            const exportFilename = `${clip.id}-zip-${Date.now()}.mp4`;
            const outExportPath = path.join(DATA_ROOT, 'exports', exportFilename);
            const effDur = Math.max(2, clip.duration - clip.trimStartOffset - clip.trimEndOffset);
            await exportRenderedClip({
              sourceClipPath: srcClipPath,
              outExportPath,
              trimStartOffset: clip.trimStartOffset,
              effectiveDuration: effDur,
              framing: clip.framing,
              captionStyle: clip.captionStyle,
              hookBanner: clip.hookBanner,
              effects: clip.effects,
              words: clip.words,
              includeCaptions: true,
            });
            mp4Path = outExportPath;
          }
        }

        if (mp4Path && fs.existsSync(mp4Path)) {
          zip.file(`clips/${clipSlug}.mp4`, fs.readFileSync(mp4Path));
          exportedVideoCount++;
        }
      }

      if (ytTimestampLinks.length > 0) {
        zip.file('clips/youtube-timestamps.txt', ytTimestampLinks.join('\n\n') + '\n');
      }

      // Full Transcript (.txt & .srt)
      const fullTxt = project.transcript
        .map((line) => `[${line.startTime} - ${line.endTime}] ${line.text}`)
        .join('\n');
      const fullSrt = project.transcript
        .map(
          (line, idx) =>
            `${idx + 1}\n${formatSrtTimestamp(line.startSeconds)} --> ${formatSrtTimestamp(Math.max(line.startSeconds + 0.5, line.endSeconds))}\n${line.text}\n`,
        )
        .join('\n');
      zip.file('transcript/full-transcript.txt', fullTxt || 'No transcript lines available.');
      zip.file('transcript/full-transcript.srt', fullSrt || '');

      // Thumbnail
      const thumbPath = path.join(THUMBS_DIR, `${project.id}.jpg`);
      if (fs.existsSync(thumbPath)) {
        zip.file('assets/thumbnail.jpg', fs.readFileSync(thumbPath));
      }

      // Metadata JSON & Package README
      zip.file('metadata/viral-clips-report.md', reportLines.join('\n'));
      zip.file('metadata/project.json', JSON.stringify(project, null, 2));
      zip.file(
        'README.txt',
        [
          `OpenYouClips Creator Pack — ${project.title}`,
          `Generated: ${new Date().toISOString()}`,
          `Included Clips: ${sortedClips.length}`,
          `Rendered MP4 Videos Included: ${exportedVideoCount}`,
          '',
          'Contents:',
          '- clips/*.mp4  : Rendered vertical/cropped video clips with burned-in captions (present for uploaded/MP4/attached sources)',
          '- clips/*.srt  : Word-synced SRT subtitle files ready for Premiere, CapCut, DaVinci Resolve, or YouTube',
          '- clips/*.txt  : Per-clip spoken script & hook headline',
          '- transcript/  : Full source timestamped transcript (.txt and .srt)',
          '- metadata/    : Ranked virality report (.md) and full OpenYouClips session backup (.json)',
          exportedVideoCount === 0 && project.hasDirectVideo === false
            ? '\nNote: YouTube blocked automated server MP4 download for this URL. Use "Attach Video File (.mp4)" inside OpenYouClips to bundle full-motion MP4s into the ZIP.'
            : '',
        ].join('\n'),
      );

      const zipBuf = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 5 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="openyouclips-${projectSlug}-pack.zip"`,
      );
      res.send(zipBuf);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to assemble project ZIP package.',
      });
    }
  };

  app.get('/api/projects/:id/export-zip', handleExportProjectZip);
  app.post('/api/projects/:id/export-zip', handleExportProjectZip);

  // Vite dev middleware or production static assets
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`OpenYouClips Studio server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start OpenYouClips Studio server:', err);
  process.exit(1);
});
