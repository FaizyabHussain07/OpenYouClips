import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Captions,
  Check,
  Crop,
  Download,
  Loader2,
  Palette,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Sparkles,
  Undo2,
  Upload,
  Volume2,
} from 'lucide-react';
import type {
  CaptionTemplateId,
  ClipItem,
  ClipProject,
  OutputFormat,
} from '../lib/types';
import { CAPTION_TEMPLATES, OUTPUT_FORMAT_OPTIONS, getCaptionTemplate } from '../lib/templates';
import { buildSrtFromWords, clampTrimRange, formatTimecode } from '../lib/clip-logic';
import {
  clearClipDraftFromStorage,
  loadClipDraftFromStorage,
  saveClipDraftToStorage,
} from '../lib/local-storage';
import { VideoPreviewPlayer, type PreviewPlayerControl } from './VideoPreviewPlayer';

interface StudioEditorProps {
  project: ClipProject;
  initialClipId: string;
  onBackToProject: () => void;
  onProjectUpdated: (project: ClipProject) => void;
}

type InspectorTab = 'captions' | 'framing' | 'hook' | 'audio' | 'color';

export function StudioEditor({
  project,
  initialClipId,
  onBackToProject,
  onProjectUpdated,
}: StudioEditorProps) {
  const [activeClipId, setActiveClipId] = useState(initialClipId);
  const sourceClip = project.clips.find((c) => c.id === activeClipId) ?? project.clips[0];

  const [draft, setDraft] = useState<ClipItem>(sourceClip);
  const [undoStack, setUndoStack] = useState<ClipItem[]>([]);
  const [redoStack, setRedoStack] = useState<ClipItem[]>([]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('captions');
  const [showCaptions, setShowCaptions] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [attachingSource, setAttachingSource] = useState(false);
  const [showExportSourceBanner, setShowExportSourceBanner] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerControlRef = useRef<PreviewPlayerControl | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync draft when switching clips (recovering any unsaved localStorage session edits)
  useEffect(() => {
    const found = project.clips.find((c) => c.id === activeClipId);
    if (found) {
      const savedLocalDraft = loadClipDraftFromStorage(found.id);
      const hydrated = savedLocalDraft ?? found;
      setDraft(hydrated);
      setUndoStack([]);
      setRedoStack([]);
      setPlayheadTime(hydrated.trimStartOffset || 0);
      setStatusError(null);
    }
  }, [activeClipId, project.clips]);

  // Auto-save unsaved edits to browser localStorage
  useEffect(() => {
    if (draft?.id) {
      saveClipDraftToStorage(draft);
    }
  }, [draft]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  if (!draft) {
    return (
      <div className="p-8 text-center text-sm text-slate-400">
        No clip selected.{' '}
        <button type="button" onClick={onBackToProject} className="text-white underline">
          Return to project
        </button>
      </div>
    );
  }

  const updateDraft = (updater: (prev: ClipItem) => ClipItem) => {
    setDraft((prev) => {
      const next = updater(prev);
      setUndoStack((s) => [...s.slice(-29), prev]);
      setRedoStack([]);
      return next;
    });
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, draft]);
    setUndoStack((u) => u.slice(0, -1));
    setDraft(previous);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, draft]);
    setRedoStack((r) => r.slice(0, -1));
    setDraft(next);
  };

  const seekTo = (seconds: number) => {
    const clamped = Math.max(0, Math.min(draft.duration, seconds));
    setPlayheadTime(clamped);
    if (playerControlRef.current) {
      playerControlRef.current.seekTo(clamped);
    } else if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  };

  const togglePlay = async () => {
    if (playerControlRef.current) {
      playerControlRef.current.togglePlay();
      return;
    }
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      await vid.play();
      setIsPlaying(true);
    } else {
      vid.pause();
      setIsPlaying(false);
    }
  };

  const persistDraft = async (): Promise<ClipItem | null> => {
    setSaving(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/clips/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hookTitle: draft.hookTitle,
          text: draft.words.map((w) => w.word).join(' '),
          trimStartOffset: draft.trimStartOffset,
          trimEndOffset: draft.trimEndOffset,
          words: draft.words,
          captionStyle: draft.captionStyle,
          framing: draft.framing,
          hookBanner: draft.hookBanner,
          effects: draft.effects,
        }),
      });
      const data = (await res.json()) as { clip?: ClipItem; error?: string };
      if (!res.ok || !data.clip) {
        setStatusError(data.error ?? 'Failed to save changes.');
        return null;
      }
      clearClipDraftFromStorage(draft.id);
      onProjectUpdated({
        ...project,
        clips: project.clips.map((c) => (c.id === draft.id ? data.clip! : c)),
      });
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 1800);
      return data.clip;
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Save failed.');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const executeExport = async (targetProject: ClipProject = project, targetClip: ClipItem = draft) => {
    setStatusError(null);
    setShowExportSourceBanner(false);
    const saved = await persistDraft();
    if (!saved) return;

    setExporting(true);
    try {
      const res = await fetch(`/api/projects/${targetProject.id}/clips/${targetClip.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeCaptions: showCaptions }),
      });
      const data = (await res.json()) as { exportedUrl?: string; clip?: ClipItem; error?: string };
      if (!res.ok || !data.exportedUrl) {
        setStatusError(data.error ?? 'MP4 render failed.');
        return;
      }
      if (data.clip) {
        setDraft(data.clip);
        onProjectUpdated({
          ...targetProject,
          clips: targetProject.clips.map((c) => (c.id === targetClip.id ? data.clip! : c)),
        });
      }
      const a = document.createElement('a');
      a.href = data.exportedUrl;
      a.download = `${targetClip.hookTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || targetClip.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Export request failed.');
    } finally {
      setExporting(false);
    }
  };

  const handleExport = () => {
    if (project.hasDirectVideo === false) {
      setShowExportSourceBanner((v) => !v);
      return;
    }
    void executeExport();
  };

  const handleDownloadSrt = () => {
    const srt = buildSrtFromWords(draft.words, draft.captionStyle.maxWordsPerLine);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draft.hookTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || draft.id}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleAttachSourceFile = async (file: File | undefined) => {
    if (!file) return;
    setStatusError(null);
    setAttachingSource(true);
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await fetch(`/api/projects/${project.id}/attach-source`, {
        method: 'POST',
        body: form,
      });
      const data = (await res.json()) as { project?: ClipProject; error?: string };
      if (!res.ok || !data.project) {
        setStatusError(data.error ?? 'Failed to attach source video file.');
        return;
      }
      onProjectUpdated(data.project);
      const refreshedClip =
        data.project.clips.find((c) => c.id === draft.id) ?? draft;
      setDraft(refreshedClip);
      setShowExportSourceBanner(false);
      await executeExport(data.project, refreshedClip);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Source upload failed.');
    } finally {
      setAttachingSource(false);
    }
  };

  const handleSplitAtPlayhead = async () => {
    if (playheadTime < 2 || playheadTime > draft.duration - 2) {
      setStatusError('Move the playhead at least 2 seconds away from the edges before splitting.');
      return;
    }
    setSplitting(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/clips/${draft.id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splitTimeSeconds: playheadTime }),
      });
      const data = (await res.json()) as {
        clips?: ClipItem[];
        project?: ClipProject;
        error?: string;
      };
      if (!res.ok || !data.project || !data.clips?.length) {
        setStatusError(data.error ?? 'Split failed.');
        return;
      }
      onProjectUpdated(data.project);
      setActiveClipId(data.clips[0].id);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Split request failed.');
    } finally {
      setSplitting(false);
    }
  };

  const handleAiRewrite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/clips/${draft.id}/ai-rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: aiPrompt.trim() }),
      });
      const data = (await res.json()) as { clip?: ClipItem; error?: string };
      if (!res.ok || !data.clip) {
        setStatusError(data.error ?? 'AI rewrite failed.');
        return;
      }
      setDraft(data.clip);
      onProjectUpdated({
        ...project,
        clips: project.clips.map((c) => (c.id === draft.id ? data.clip! : c)),
      });
      setAiPrompt('');
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'AI rewrite request failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const effectiveDuration = Math.max(
    2,
    draft.duration - draft.trimStartOffset - draft.trimEndOffset,
  );
  const trimStartPct = (draft.trimStartOffset / Math.max(1, draft.duration)) * 100;
  const trimEndPct = (draft.trimEndOffset / Math.max(1, draft.duration)) * 100;
  const playheadPct = (playheadTime / Math.max(1, draft.duration)) * 100;

  return (
    <div className="flex min-h-screen lg:h-screen w-full flex-col lg:overflow-hidden bg-[#090B10] text-white">
      {/* Top Studio Editor Bar */}
      <header className="flex flex-col sm:flex-row sm:min-h-14 shrink-0 sm:items-center sm:justify-between gap-2.5 border-b border-white/8 bg-[#11141C] px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 sm:flex-1">
          <button
            type="button"
            onClick={onBackToProject}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10 whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Clip Wall
          </button>

          <select
            aria-label="Select clip to edit"
            value={draft.id}
            onChange={(e) => setActiveClipId(e.target.value)}
            className="min-w-0 flex-1 sm:max-w-[260px] truncate rounded-lg border border-white/10 bg-[#090B10] px-2.5 sm:px-3 py-1.5 text-xs font-medium text-white focus:border-[#FF3B5C] focus:outline-none"
          >
            {project.clips.map((c, idx) => (
              <option key={c.id} value={c.id}>
                #{idx + 1} · {c.hookTitle}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            aria-label="Undo edit"
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 hover:text-white disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            aria-label="Redo edit"
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 hover:text-white disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => void persistDraft()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/8 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-white/14 whitespace-nowrap shrink-0"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : savedNotice ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {savedNotice ? 'Saved' : 'Save Draft'}
          </button>

          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || attachingSource}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF3B5C] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {exporting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Rendering MP4…
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Export MP4
              </>
            )}
          </button>
        </div>
      </header>

      <input
        ref={attachFileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void handleAttachSourceFile(f);
        }}
      />

      {showExportSourceBanner && project.hasDirectVideo === false && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2.5 text-xs">
          <div className="text-amber-100">
            <strong className="text-white">Full-motion MP4 export needs a local source video:</strong>{' '}
            YouTube blocks automated stream downloads on this server. Attach the .mp4 file to render real cropped footage, or download synced .SRT captions.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => attachFileInputRef.current?.click()}
              disabled={attachingSource}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#FF3B5C] px-3 py-1.5 font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60"
            >
              {attachingSource ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Attach .MP4 &amp; Render
            </button>
            <button
              type="button"
              onClick={handleDownloadSrt}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 font-medium text-white hover:bg-white/10"
            >
              <Captions className="h-3.5 w-3.5" />
              Download .SRT
            </button>
            <button
              type="button"
              onClick={() => void executeExport()}
              disabled={exporting}
              className="rounded-md px-2.5 py-1.5 text-slate-300 hover:text-white"
            >
              Export Cover Card
            </button>
            <button
              type="button"
              onClick={() => setShowExportSourceBanner(false)}
              className="text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {statusError && (
        <div
          role="alert"
          className="flex items-center justify-between border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-200"
        >
          <span>{statusError}</span>
          <button type="button" onClick={() => setStatusError(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Workspace: Preview Viewport + Right Inspector */}
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        {/* Center Video Preview Stage */}
        <div className="flex flex-1 flex-col items-center justify-between overflow-y-auto bg-[#07090E] p-5">
          <div className="flex w-full items-center justify-between text-xs text-slate-400">
            <span>
              Output:{' '}
              <strong className="text-white">
                {OUTPUT_FORMAT_OPTIONS.find((f) => f.id === draft.framing.outputFormat)?.label ??
                  draft.framing.outputFormat}
              </strong>{' '}
              · Active duration:{' '}
              <strong className="font-mono-tabular text-white">{effectiveDuration.toFixed(1)}s</strong>
            </span>
            <button
              type="button"
              onClick={() => setShowCaptions((v) => !v)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                showCaptions
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'border-white/8 bg-transparent text-slate-400'
              }`}
            >
              {showCaptions ? 'Captions On' : 'Captions Off'}
            </button>
          </div>

          <div className="my-4 flex flex-1 items-center justify-center w-full">
            <VideoPreviewPlayer
              videoUrl={draft.videoUrl}
              posterUrl={project.thumbnailUrl}
              youtubeId={project.youtubeId}
              hasDirectVideo={project.hasDirectVideo}
              clipStartSeconds={draft.startSeconds}
              clipEndSeconds={draft.endSeconds}
              duration={draft.duration}
              trimStartOffset={draft.trimStartOffset}
              trimEndOffset={draft.trimEndOffset}
              words={draft.words}
              captionStyle={draft.captionStyle}
              framing={draft.framing}
              hookBanner={draft.hookBanner}
              effects={draft.effects}
              playbackSpeed={playbackSpeed}
              showCaptions={showCaptions}
              videoElementRef={videoRef}
              playerControlRef={playerControlRef}
              onTimeUpdate={(t) => setPlayheadTime(t)}
              onPlayStateChange={(p) => setIsPlaying(p)}
            />
          </div>

          {/* Transport Controls Bar */}
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-white/8 bg-[#11141C] px-4 py-2">
            <button
              type="button"
              onClick={() => void togglePlay()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/16"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              onClick={() => seekTo(playheadTime - 1)}
              className="rounded-md px-2.5 py-1.5 text-xs font-mono-tabular text-slate-300 hover:bg-white/8"
            >
              -1s
            </button>
            <button
              type="button"
              onClick={() => seekTo(playheadTime + 1)}
              className="rounded-md px-2.5 py-1.5 text-xs font-mono-tabular text-slate-300 hover:bg-white/8"
            >
              +1s
            </button>

            <select
              aria-label="Playback speed"
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
              className="rounded-md border border-white/10 bg-[#090B10] px-2 py-1 text-xs font-mono-tabular text-slate-200"
            >
              <option value={0.75}>0.75x</option>
              <option value={1}>1.0x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
            </select>

            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />

            <button
              type="button"
              onClick={() =>
                updateDraft((p) => ({
                  ...p,
                  ...clampTrimRange(p.duration, playheadTime, p.trimEndOffset),
                }))
              }
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/8 hover:text-white"
            >
              Set In
            </button>
            <button
              type="button"
              onClick={() =>
                updateDraft((p) => ({
                  ...p,
                  ...clampTrimRange(p.duration, p.trimStartOffset, p.duration - playheadTime),
                }))
              }
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/8 hover:text-white"
            >
              Set Out
            </button>
            <button
              type="button"
              onClick={() => void handleSplitAtPlayhead()}
              disabled={splitting}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/12 disabled:opacity-50"
            >
              {splitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Scissors className="h-3.5 w-3.5" />
              )}
              Split Clip
            </button>
          </div>
        </div>

        {/* Right Inspector Panel */}
        <aside className="flex w-full shrink-0 flex-col border-t border-white/8 bg-[#11141C] lg:w-[390px] lg:border-l lg:border-t-0">
          {/* Inspector Tabs */}
          <div className="grid grid-cols-5 border-b border-white/8 bg-[#0D1017]">
            {[
              { id: 'captions', label: 'Captions', Icon: Captions },
              { id: 'framing', label: 'Frame', Icon: Crop },
              { id: 'hook', label: 'Hook AI', Icon: Sparkles },
              { id: 'audio', label: 'Audio', Icon: Volume2 },
              { id: 'color', label: 'Color', Icon: Palette },
            ].map(({ id, label, Icon }) => {
              const active = inspectorTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setInspectorTab(id as InspectorTab)}
                  className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium border-b-2 transition-colors ${
                    active
                      ? 'border-[#FF3B5C] text-white bg-[#11141C]'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {/* Inspector Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {inspectorTab === 'captions' && (
              <>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-slate-200">
                    Caption Template
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(CAPTION_TEMPLATES) as CaptionTemplateId[]).map((tid) => {
                      const active = draft.captionStyle.templateId === tid;
                      return (
                        <button
                          key={tid}
                          type="button"
                          onClick={() =>
                            updateDraft((p) => ({
                              ...p,
                              captionStyle: getCaptionTemplate(tid),
                            }))
                          }
                          className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                            active
                              ? 'border-[#FF3B5C] bg-[#FF3B5C]/12 text-white'
                              : 'border-white/8 bg-[#090B10] text-slate-300 hover:border-white/20'
                          }`}
                        >
                          {CAPTION_TEMPLATES[tid].name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3 border-t border-white/8 pt-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Font Size</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.captionStyle.fontSize}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={48}
                    value={draft.captionStyle.fontSize}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        captionStyle: { ...p.captionStyle, fontSize: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Words Per Line</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.captionStyle.maxWordsPerLine}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    value={draft.captionStyle.maxWordsPerLine}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        captionStyle: { ...p.captionStyle, maxWordsPerLine: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Vertical Position</span>
                    <span className="font-mono-tabular text-slate-400">
                      {Math.round(draft.captionStyle.positionY * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={88}
                    value={Math.round(draft.captionStyle.positionY * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        captionStyle: {
                          ...p.captionStyle,
                          positionY: Number(e.target.value) / 100,
                        },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-white/8 pt-4">
                  <label className="flex flex-col gap-1.5 text-xs text-slate-300">
                    <span>Base Color</span>
                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5">
                      <input
                        type="color"
                        value={draft.captionStyle.fontColor}
                        onChange={(e) =>
                          updateDraft((p) => ({
                            ...p,
                            captionStyle: { ...p.captionStyle, fontColor: e.target.value },
                          }))
                        }
                        className="h-5 w-5 cursor-pointer bg-transparent border-0"
                      />
                      <span className="font-mono-tabular text-[11px] uppercase text-slate-400">
                        {draft.captionStyle.fontColor}
                      </span>
                    </div>
                  </label>

                  <label className="flex flex-col gap-1.5 text-xs text-slate-300">
                    <span>Active Word</span>
                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-1.5">
                      <input
                        type="color"
                        value={draft.captionStyle.highlightColor}
                        onChange={(e) =>
                          updateDraft((p) => ({
                            ...p,
                            captionStyle: { ...p.captionStyle, highlightColor: e.target.value },
                          }))
                        }
                        className="h-5 w-5 cursor-pointer bg-transparent border-0"
                      />
                      <span className="font-mono-tabular text-[11px] uppercase text-slate-400">
                        {draft.captionStyle.highlightColor}
                      </span>
                    </div>
                  </label>
                </div>

                <div className="flex flex-col gap-2.5 border-t border-white/8 pt-4 text-xs">
                  <label className="flex items-center justify-between">
                    <span className="text-slate-300">ALL CAPS Captions</span>
                    <input
                      type="checkbox"
                      checked={draft.captionStyle.uppercase}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          captionStyle: { ...p.captionStyle, uppercase: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-[#FF3B5C]"
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span className="text-slate-300">Active Word Box Pill</span>
                    <input
                      type="checkbox"
                      checked={draft.captionStyle.wordBox}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          captionStyle: {
                            ...p.captionStyle,
                            wordBox: e.target.checked,
                            wordBoxColor: p.captionStyle.wordBoxColor || '#00BF49',
                          },
                        }))
                      }
                      className="h-4 w-4 accent-[#FF3B5C]"
                    />
                  </label>
                </div>

                {/* Inline Word-Level Transcript Correction */}
                <div className="border-t border-white/8 pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200">
                      Edit Word Captions
                    </span>
                    <span className="text-[11px] text-slate-500">Click word to seek or edit</span>
                  </div>
                  <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-white/8 bg-[#090B10] p-3">
                    {draft.words.map((w, idx) => (
                      <input
                        key={`${idx}-${w.start}`}
                        type="text"
                        value={w.word}
                        aria-label={`Word ${idx + 1}`}
                        onFocus={() => seekTo(w.start)}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateDraft((p) => ({
                            ...p,
                            words: p.words.map((item, i) =>
                              i === idx ? { ...item, word: val } : item,
                            ),
                          }));
                        }}
                        style={{ width: `${Math.max(3, w.word.length + 1.5)}ch` }}
                        className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-center text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
                      />
                    ))}
                  </div>
                </div>
              </>
            )}

            {inspectorTab === 'framing' && (
              <>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-slate-200">
                    Aspect Ratio
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {OUTPUT_FORMAT_OPTIONS.map((fmt) => {
                      const active = draft.framing.outputFormat === fmt.id;
                      return (
                        <button
                          key={fmt.id}
                          type="button"
                          onClick={() =>
                            updateDraft((p) => ({
                              ...p,
                              framing: { ...p.framing, outputFormat: fmt.id as OutputFormat },
                            }))
                          }
                          className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                            active
                              ? 'border-[#FF3B5C] bg-[#FF3B5C]/12 text-white'
                              : 'border-white/8 bg-[#090B10] text-slate-300 hover:border-white/20'
                          }`}
                        >
                          <div className="font-semibold">{fmt.label}</div>
                          <div className="text-[11px] text-slate-400">{fmt.platforms}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-white/8 pt-4">
                  <span className="mb-2 block text-xs font-semibold text-slate-200">
                    Quick Speaker Focus
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: 'Left Speaker', panX: -0.55 },
                      { label: 'Center', panX: 0 },
                      { label: 'Right Speaker', panX: 0.55 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          updateDraft((p) => ({
                            ...p,
                            framing: { ...p.framing, panX: preset.panX, panY: 0 },
                          }))
                        }
                        className="rounded-lg border border-white/10 bg-[#090B10] px-2.5 py-2 text-xs text-slate-200 hover:border-white/25"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 border-t border-white/8 pt-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Zoom</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.framing.zoom.toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min={100}
                    max={220}
                    value={Math.round(draft.framing.zoom * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        framing: { ...p.framing, zoom: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Horizontal Pan (X)</span>
                    <span className="font-mono-tabular text-slate-400">
                      {Math.round(draft.framing.panX * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    value={Math.round(draft.framing.panX * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        framing: { ...p.framing, panX: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">Vertical Pan (Y)</span>
                    <span className="font-mono-tabular text-slate-400">
                      {Math.round(draft.framing.panY * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    value={Math.round(draft.framing.panY * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        framing: { ...p.framing, panY: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>
              </>
            )}

            {inspectorTab === 'hook' && (
              <>
                <div className="space-y-3">
                  <label className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200">Show Opening Hook Banner</span>
                    <input
                      type="checkbox"
                      checked={draft.hookBanner.enabled}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          hookBanner: { ...p.hookBanner, enabled: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-[#FF3B5C]"
                    />
                  </label>

                  <div>
                    <label htmlFor="hook-banner-text" className="mb-1 block text-xs text-slate-400">
                      Hook Headline
                    </label>
                    <textarea
                      id="hook-banner-text"
                      rows={2}
                      value={draft.hookBanner.text}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          hookTitle: e.target.value,
                          hookBanner: { ...p.hookBanner, text: e.target.value },
                        }))
                      }
                      className="w-full rounded-lg border border-white/10 bg-[#090B10] p-2.5 text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs text-slate-300">
                      <span>Banner Fill</span>
                      <input
                        type="color"
                        value={draft.hookBanner.bgColor}
                        onChange={(e) =>
                          updateDraft((p) => ({
                            ...p,
                            hookBanner: { ...p.hookBanner, bgColor: e.target.value },
                          }))
                        }
                        className="h-8 w-full cursor-pointer rounded border border-white/10 bg-[#090B10]"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-slate-300">
                      <span>Banner Text</span>
                      <input
                        type="color"
                        value={draft.hookBanner.textColor}
                        onChange={(e) =>
                          updateDraft((p) => ({
                            ...p,
                            hookBanner: { ...p.hookBanner, textColor: e.target.value },
                          }))
                        }
                        className="h-8 w-full cursor-pointer rounded border border-white/10 bg-[#090B10]"
                      />
                    </label>
                  </div>
                </div>

                {/* Gemini AI Rewrite Prompt */}
                <form onSubmit={handleAiRewrite} className="border-t border-white/8 pt-4 space-y-2.5">
                  <label htmlFor="ai-rewrite-input" className="block text-xs font-semibold text-slate-200">
                    AI Hook &amp; Copy Assistant
                  </label>
                  <p className="text-[11px] text-slate-400">
                    Ask Gemini to punch up the opening banner or tailor this clip for TikTok/Reels.
                  </p>
                  <input
                    id="ai-rewrite-input"
                    type="text"
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="e.g. Make the hook curiosity-driven in 6 words..."
                    className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-[#FF3B5C] focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={aiLoading || !aiPrompt.trim()}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/16 disabled:opacity-50"
                  >
                    {aiLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Rewrite Hook with AI
                  </button>
                </form>
              </>
            )}

            {inspectorTab === 'audio' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Trim Start</span>
                    <span className="font-mono-tabular text-slate-400">
                      +{draft.trimStartOffset.toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, draft.duration - 3)}
                    step={0.5}
                    value={draft.trimStartOffset}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      updateDraft((p) => ({
                        ...p,
                        ...clampTrimRange(p.duration, val, p.trimEndOffset),
                      }));
                    }}
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Trim End</span>
                    <span className="font-mono-tabular text-slate-400">
                      -{draft.trimEndOffset.toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, draft.duration - 3)}
                    step={0.5}
                    value={draft.trimEndOffset}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      updateDraft((p) => ({
                        ...p,
                        ...clampTrimRange(p.duration, p.trimStartOffset, val),
                      }));
                    }}
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div className="border-t border-white/8 pt-4">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Master Volume</span>
                    <span className="font-mono-tabular text-slate-400">
                      {Math.round(draft.effects.volume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    value={Math.round(draft.effects.volume * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        effects: { ...p.effects, volume: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div className="flex flex-col gap-2.5 border-t border-white/8 pt-4 text-xs">
                  <label className="flex items-center justify-between">
                    <span className="text-slate-300">Auto-Cut Long Pauses</span>
                    <input
                      type="checkbox"
                      checked={draft.effects.cutLongPauses}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          effects: { ...p.effects, cutLongPauses: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-[#FF3B5C]"
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span className="text-slate-300">Remove Filler Words</span>
                    <input
                      type="checkbox"
                      checked={draft.effects.removeFillerWords}
                      onChange={(e) =>
                        updateDraft((p) => ({
                          ...p,
                          effects: { ...p.effects, removeFillerWords: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-[#FF3B5C]"
                    />
                  </label>
                </div>
              </div>
            )}

            {inspectorTab === 'color' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Brightness</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.effects.brightness.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-30}
                    max={30}
                    value={Math.round(draft.effects.brightness * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        effects: { ...p.effects, brightness: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Contrast</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.effects.contrast.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={70}
                    max={140}
                    value={Math.round(draft.effects.contrast * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        effects: { ...p.effects, contrast: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Saturation</span>
                    <span className="font-mono-tabular text-slate-400">
                      {draft.effects.saturation.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={160}
                    value={Math.round(draft.effects.saturation * 100)}
                    onChange={(e) =>
                      updateDraft((p) => ({
                        ...p,
                        effects: { ...p.effects, saturation: Number(e.target.value) / 100 },
                      }))
                    }
                    className="w-full accent-[#FF3B5C]"
                  />
                </div>

                <button
                  type="button"
                  onClick={() =>
                    updateDraft((p) => ({
                      ...p,
                      effects: { ...p.effects, brightness: 0, contrast: 1, saturation: 1 },
                    }))
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset Color Grade
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Bottom Visual NLE Timeline */}
      <footer className="shrink-0 border-t border-white/8 bg-[#11141C] px-5 py-3">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono-tabular text-white">
            Playhead: {formatTimecode(playheadTime)} / {formatTimecode(draft.duration)}
          </span>
          <span>Click timeline track to scrub · Word blocks show synced captions</span>
        </div>

        <div
          role="slider"
          tabIndex={0}
          aria-label="Clip timeline scrubber"
          aria-valuemin={0}
          aria-valuemax={draft.duration}
          aria-valuenow={Number(playheadTime.toFixed(1))}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            seekTo(ratio * draft.duration);
          }}
          className="relative h-12 w-full cursor-pointer overflow-hidden rounded-lg border border-white/10 bg-[#090B10]"
        >
          {/* Trimmed-out left/right regions */}
          {trimStartPct > 0 && (
            <div
              className="absolute inset-y-0 left-0 bg-black/75 border-r border-amber-400/70"
              style={{ width: `${trimStartPct}%` }}
            />
          )}
          {trimEndPct > 0 && (
            <div
              className="absolute inset-y-0 right-0 bg-black/75 border-l border-amber-400/70"
              style={{ width: `${trimEndPct}%` }}
            />
          )}

          {/* Word-Level Caption Blocks */}
          <div className="absolute inset-x-0 top-2 flex h-7 items-center">
            {draft.words.map((w, idx) => {
              const leftPct = (w.start / Math.max(1, draft.duration)) * 100;
              const widthPct = Math.max(
                0.8,
                ((w.end - w.start) / Math.max(1, draft.duration)) * 100,
              );
              const active = playheadTime >= w.start && playheadTime <= w.end;
              return (
                <button
                  type="button"
                  key={`${idx}-${w.start}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(w.start);
                  }}
                  className={`absolute h-6 overflow-hidden rounded px-1 text-left text-[10px] leading-6 truncate border ${
                    active
                      ? 'border-[#FF3B5C] bg-[#FF3B5C]/30 text-white'
                      : 'border-white/10 bg-white/6 text-slate-400 hover:text-white'
                  }`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {w.word}
                </button>
              );
            })}
          </div>

          {/* Playhead Needle */}
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#FF3B5C]"
            style={{ left: `${playheadPct}%` }}
          >
            <div className=" -ml-1.5 h-2.5 w-3.5 rounded-b bg-[#FF3B5C]" />
          </div>
        </div>
      </footer>
    </div>
  );
}
