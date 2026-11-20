import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  FolderArchive,
  Loader2,
  RefreshCw,
  Scissors,
  Search,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import type {
  CaptionTemplateId,
  ClipItem,
  ClipProject,
  WorkflowMode,
} from '../lib/types';
import { CAPTION_TEMPLATES, WORKFLOW_OPTIONS } from '../lib/templates';
import { buildSrtFromWords, formatTimestamp, viralityTierLabel } from '../lib/clip-logic';
import { AgentPipelineTrace } from './AgentPipelineTrace';
import { VideoPreviewPlayer } from './VideoPreviewPlayer';

interface ProjectClipWallProps {
  project: ClipProject;
  onBack: () => void;
  onEditClip: (clipId: string) => void;
  onProjectUpdated: (project: ClipProject) => void;
  onReclipCreated: (newProject: ClipProject) => void;
}

type SortMode = 'virality' | 'chronological' | 'duration';

export function ProjectClipWall({
  project,
  onBack,
  onEditClip,
  onProjectUpdated,
  onReclipCreated,
}: ProjectClipWallProps) {
  const [sortBy, setSortBy] = useState<SortMode>('virality');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'clips' | 'transcript'>('clips');
  const [exportingClipId, setExportingClipId] = useState<string | null>(null);
  const [exportingZip, setExportingZip] = useState(false);
  const [exportChoiceClipId, setExportChoiceClipId] = useState<string | null>(null);
  const [attachingSource, setAttachingSource] = useState(false);
  const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showAgentTrace, setShowAgentTrace] = useState(false);

  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachClipRef = useRef<ClipItem | null>(null);

  // Re-clip modal/panel state
  const [showReclip, setShowReclip] = useState(false);
  const [reclipWorkflow, setReclipWorkflow] = useState<WorkflowMode>(project.workflow);
  const [reclipTemplate, setReclipTemplate] = useState<CaptionTemplateId>(project.captionTemplate);
  const [reclipTopic, setReclipTopic] = useState(project.topicFocus ?? '');
  const [reclipLoading, setReclipLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const filteredClips = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = project.clips.filter((c) => {
      if (!q) return true;
      return (
        c.hookTitle.toLowerCase().includes(q) ||
        c.text.toLowerCase().includes(q) ||
        c.virality.hookType.toLowerCase().includes(q)
      );
    });

    if (sortBy === 'virality') {
      return [...list].sort((a, b) => b.virality.totalScore - a.virality.totalScore);
    }
    if (sortBy === 'duration') {
      return [...list].sort((a, b) => b.duration - a.duration);
    }
    return [...list].sort((a, b) => a.startSeconds - b.startSeconds);
  }, [project.clips, searchQuery, sortBy]);

  const restoreProjectOnServer = async (targetProject: ClipProject) => {
    await fetch('/api/projects/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: targetProject }),
    });
  };

  const executeExportClip = async (clip: ClipItem, currentProject: ClipProject = project) => {
    setExportError(null);
    setExportChoiceClipId(null);
    setExportingClipId(clip.id);
    try {
      let res = await fetch(`/api/projects/${currentProject.id}/clips/${clip.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeCaptions: true }),
      });
      if (res.status === 404) {
        await restoreProjectOnServer(currentProject);
        res = await fetch(`/api/projects/${currentProject.id}/clips/${clip.id}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeCaptions: true }),
        });
      }
      const data = (await res.json()) as {
        exportedUrl?: string;
        clip?: ClipItem;
        error?: string;
      };
      if (!res.ok || !data.exportedUrl) {
        setExportError(data.error ?? 'Failed to export rendered MP4.');
        return;
      }
      if (data.clip) {
        onProjectUpdated({
          ...currentProject,
          clips: currentProject.clips.map((c) => (c.id === clip.id ? data.clip! : c)),
        });
      }
      const a = document.createElement('a');
      a.href = data.exportedUrl;
      a.download = `${clip.hookTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || clip.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export request failed.');
    } finally {
      setExportingClipId(null);
    }
  };

  const handleExportButtonClick = (clip: ClipItem) => {
    if (project.hasDirectVideo === false) {
      setExportChoiceClipId((prev) => (prev === clip.id ? null : clip.id));
      return;
    }
    void executeExportClip(clip);
  };

  const handleDownloadSrt = (clip: ClipItem) => {
    const srt = buildSrtFromWords(clip.words, clip.captionStyle.maxWordsPerLine);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${clip.hookTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || clip.id}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadZip = async () => {
    setExportError(null);
    setExportingZip(true);
    try {
      let res = await fetch(`/api/projects/${project.id}/export-zip`);
      if (res.status === 404) {
        // Re-hydrate browser-saved session project onto server if /tmp restarted
        await restoreProjectOnServer(project);
        res = await fetch(`/api/projects/${project.id}/export-zip`);
      }
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setExportError(errData.error ?? 'Failed to build full .zip package.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const slug =
        project.title
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 40) || project.id;
      const a = document.createElement('a');
      a.href = url;
      a.download = `openyouclips-${slug}-pack.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'ZIP download failed.');
    } finally {
      setExportingZip(false);
    }
  };

  const handleAttachSourceFile = async (file: File | undefined) => {
    const targetClip = pendingAttachClipRef.current;
    pendingAttachClipRef.current = null;
    if (!file) return;

    setExportError(null);
    setAttachingSource(true);
    try {
      const makeForm = () => {
        const form = new FormData();
        form.append('video', file);
        return form;
      };
      let res = await fetch(`/api/projects/${project.id}/attach-source`, {
        method: 'POST',
        body: makeForm(),
      });
      if (res.status === 404) {
        await restoreProjectOnServer(project);
        res = await fetch(`/api/projects/${project.id}/attach-source`, {
          method: 'POST',
          body: makeForm(),
        });
      }
      const data = (await res.json()) as { project?: ClipProject; error?: string };
      if (!res.ok || !data.project) {
        setExportError(data.error ?? 'Failed to attach local source video.');
        return;
      }
      onProjectUpdated(data.project);
      setExportChoiceClipId(null);
      if (targetClip) {
        const updatedClip =
          data.project.clips.find((c) => c.id === targetClip.id) ?? targetClip;
        await executeExportClip(updatedClip, data.project);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to upload source video.');
    } finally {
      setAttachingSource(false);
    }
  };

  const handleCopyText = async (clip: ClipItem) => {
    try {
      await navigator.clipboard.writeText(`${clip.hookTitle}\n\n${clip.text}`);
      setCopiedClipId(clip.id);
      window.setTimeout(() => setCopiedClipId(null), 1600);
    } catch {
      // Ignore clipboard permission failure
    }
  };

  const handleReclip = async () => {
    setReclipLoading(true);
    try {
      let res = await fetch(`/api/projects/${project.id}/reclip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: reclipWorkflow,
          captionTemplate: reclipTemplate,
          topicFocus: reclipTopic.trim() || undefined,
        }),
      });
      if (res.status === 404) {
        await restoreProjectOnServer(project);
        res = await fetch(`/api/projects/${project.id}/reclip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workflow: reclipWorkflow,
            captionTemplate: reclipTemplate,
            topicFocus: reclipTopic.trim() || undefined,
          }),
        });
      }
      const data = (await res.json()) as { project?: ClipProject; error?: string };
      if (res.ok && data.project) {
        setShowReclip(false);
        onReclipCreated(data.project);
      } else {
        setExportError(data.error ?? 'Failed to start re-clip job.');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setReclipLoading(false);
    }
  };

  const handleRetry = async () => {
    setExportError(null);
    setRetrying(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/retry`, {
        method: 'POST',
      });
      const data = (await res.json()) as { project?: ClipProject; error?: string };
      if (res.ok && data.project) {
        onProjectUpdated(data.project);
      } else {
        setExportError(data.error ?? 'Failed to retry analysis.');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error retrying pipeline.');
    } finally {
      setRetrying(false);
    }
  };

  const isProcessing = project.stage !== 'completed' && project.stage !== 'error';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-7">
      {/* Top Breadcrumb Bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/8 pb-5">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold text-white truncate">
              {project.title}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
              <span>{project.channelName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">{formatTimestamp(project.durationSeconds)}</span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{project.workflow} mode</span>
              <span aria-hidden="true">·</span>
              <span>{project.outputFormat}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {project.stage === 'completed' && project.clips.length > 0 && (
            <button
              type="button"
              onClick={() => void handleDownloadZip()}
              disabled={exportingZip}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF3B5C] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {exportingZip ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Bundling .ZIP…
                </>
              ) : (
                <>
                  <FolderArchive className="h-3.5 w-3.5" />
                  Download Full Pack (.zip)
                </>
              )}
            </button>
          )}
          {!isProcessing && project.agentSteps && project.agentSteps.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAgentTrace((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Bot className="h-3.5 w-3.5 text-[#FF3B5C]" />
              AI Agent Trace
              {showAgentTrace ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {project.youtubeId && (
            <a
              href={`https://www.youtube.com/watch?v=${project.youtubeId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Source Video
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => setShowReclip((v) => !v)}
            disabled={isProcessing || project.transcript.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/8 px-3.5 py-2 text-xs font-semibold text-white hover:bg-white/14 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Re-Clip with AI
          </button>
        </div>
      </div>

      {/* Hidden input for attaching local MP4 source onto a YouTube stream project */}
      <input
        ref={attachInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void handleAttachSourceFile(f);
        }}
      />

      {/* Optional Re-Clip Configuration Drawer */}
      {showReclip && (
        <div className="mb-6 rounded-xl border border-white/12 bg-[#11141C] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-white">
              Re-Clip Source With New AI Strategy
            </h2>
            <button
              type="button"
              onClick={() => setShowReclip(false)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="reclip-workflow" className="mb-1 block text-xs text-slate-400">
                Workflow Mode
              </label>
              <select
                id="reclip-workflow"
                value={reclipWorkflow}
                onChange={(e) => setReclipWorkflow(e.target.value as WorkflowMode)}
                className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white"
              >
                {WORKFLOW_OPTIONS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reclip-template" className="mb-1 block text-xs text-slate-400">
                Caption Template
              </label>
              <select
                id="reclip-template"
                value={reclipTemplate}
                onChange={(e) => setReclipTemplate(e.target.value as CaptionTemplateId)}
                className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white"
              >
                {(Object.keys(CAPTION_TEMPLATES) as CaptionTemplateId[]).map((tid) => (
                  <option key={tid} value={tid}>
                    {CAPTION_TEMPLATES[tid].name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleReclip}
                disabled={reclipLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#FF3B5C] px-4 py-2 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60"
              >
                {reclipLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                )}
                Run New AI Pass
              </button>
            </div>
          </div>
          {reclipWorkflow === 'topic' && (
            <input
              type="text"
              value={reclipTopic}
              onChange={(e) => setReclipTopic(e.target.value)}
              placeholder="Enter target topic focus..."
              className="mt-3 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white"
            />
          )}
        </div>
      )}

      {/* Pipeline Live Multi-Agent Step Trace */}
      {isProcessing && (
        <div className="mb-6">
          {project.agentSteps && project.agentSteps.length > 0 ? (
            <AgentPipelineTrace
              steps={project.agentSteps}
              stage={project.stage}
              progress={project.progress}
              stageMessage={project.stageMessage}
            />
          ) : (
            <div className="rounded-xl border border-white/10 bg-[#11141C] p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-[#FF3B5C]" />
                  <div>
                    <p className="text-sm font-semibold text-white">{project.stageMessage}</p>
                    <p className="text-xs text-slate-400">
                      Pipeline stage: {project.stage.replace('_', ' ')}
                    </p>
                  </div>
                </div>
                <span className="font-mono-tabular text-sm font-semibold text-white">
                  {project.progress}%
                </span>
              </div>
              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/8">
                <div
                  className="h-full bg-[#FF3B5C] transition-[width] duration-300"
                  style={{ width: `${project.progress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expandable Completed/Stopped Agent Execution Audit */}
      {!isProcessing && showAgentTrace && project.agentSteps && project.agentSteps.length > 0 && (
        <div className="mb-6">
          <AgentPipelineTrace
            steps={project.agentSteps}
            stage={project.stage}
            progress={project.progress}
            stageMessage={project.stageMessage}
            compact
          />
        </div>
      )}

      {/* Error State Banner */}
      {project.stage === 'error' && (
        <div
          role="alert"
          className="mb-6 flex flex-col gap-3 rounded-xl border border-red-500/35 bg-red-500/10 p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">Pipeline Stopped</h2>
              <p className="mt-1 text-xs leading-relaxed text-red-200">
                {project.errorMessage || 'An error occurred while processing this video.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF3B5C] px-4 py-2 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {retrying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Retrying…
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry Analysis
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 whitespace-nowrap shrink-0"
            >
              Back to Create
            </button>
          </div>
        </div>
      )}

      {exportError && (
        <div
          role="alert"
          className="mb-5 flex items-center justify-between rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-xs text-red-200"
        >
          <span>{exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="text-red-300 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Project Summary & Key Topics */}
      {project.summary && (
        <div className="mb-6 rounded-xl border border-white/8 bg-[#11141C] p-5">
          <p className="text-sm leading-relaxed text-slate-300">{project.summary}</p>
          {project.keyTopics.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Topics:</span>
              {project.keyTopics.map((topic, idx) => (
                <span key={topic} className="inline-flex items-center gap-2">
                  {idx > 0 && <span aria-hidden="true">·</span>}
                  <span>{topic}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Clip Wall Controls Bar */}
      {project.stage === 'completed' && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 rounded-lg bg-[#11141C] p-1 border border-white/8 w-fit">
            <button
              type="button"
              onClick={() => setActiveTab('clips')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'clips'
                  ? 'bg-white/12 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Film className="h-3.5 w-3.5" />
              Viral Clips ({project.clips.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('transcript')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'transcript'
                  ? 'bg-white/12 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Full Transcript ({project.transcript.length})
            </button>
          </div>

          {activeTab === 'clips' && (
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Filter clips"
                  placeholder="Search hook or transcript..."
                  className="w-56 rounded-lg border border-white/10 bg-[#11141C] py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-slate-500 focus:border-[#FF3B5C] focus:outline-none"
                />
              </div>

              <select
                aria-label="Sort clips"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortMode)}
                className="rounded-lg border border-white/10 bg-[#11141C] px-3 py-1.5 text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
              >
                <option value="virality">Sort: Virality Score</option>
                <option value="chronological">Sort: Timeline Order</option>
                <option value="duration">Sort: Clip Duration</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* Clips List */}
      {activeTab === 'clips' && project.stage === 'completed' && (
        <div className="flex flex-col gap-5">
          {filteredClips.length === 0 ? (
            <div className="rounded-xl border border-white/8 bg-[#11141C] p-10 text-center text-sm text-slate-400">
              No clips match your current search filter.
            </div>
          ) : (
            filteredClips.map((clip, idx) => {
              const tier = viralityTierLabel(clip.virality.totalScore);
              const isExporting = exportingClipId === clip.id;
              const effectiveDuration = Math.max(
                2,
                clip.duration - clip.trimStartOffset - clip.trimEndOffset,
              );

              return (
                <article
                  key={clip.id}
                  className="grid grid-cols-1 gap-6 rounded-2xl border border-white/10 bg-[#11141C] p-5 lg:grid-cols-[260px_1fr]"
                >
                  {/* Left: Live Playable Video Preview */}
                  <div className="flex flex-col items-center justify-start">
                    <VideoPreviewPlayer
                      videoUrl={clip.videoUrl}
                      posterUrl={project.thumbnailUrl}
                      youtubeId={project.youtubeId}
                      hasDirectVideo={project.hasDirectVideo}
                      clipStartSeconds={clip.startSeconds}
                      clipEndSeconds={clip.endSeconds}
                      duration={clip.duration}
                      trimStartOffset={clip.trimStartOffset}
                      trimEndOffset={clip.trimEndOffset}
                      words={clip.words}
                      captionStyle={clip.captionStyle}
                      framing={clip.framing}
                      hookBanner={clip.hookBanner}
                      effects={clip.effects}
                      compact
                    />
                  </div>

                  {/* Right: Hook Title, Virality Breakdown & Studio Actions */}
                  <div className="flex flex-col justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
                            <span className="font-mono-tabular font-semibold text-white">
                              #{idx + 1}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-tabular">
                              {clip.startTime} – {clip.endTime} ({effectiveDuration}s)
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{clip.virality.hookType}</span>
                            <span aria-hidden="true">·</span>
                            <span>{CAPTION_TEMPLATES[clip.captionStyle.templateId]?.name ?? 'Custom'}</span>
                          </div>
                          <h3 className="mt-1.5 font-display text-lg font-bold text-white leading-snug">
                            {clip.hookTitle}
                          </h3>
                        </div>

                        {/* Virality Score Readout */}
                        <div className="flex items-baseline gap-2 shrink-0 text-right">
                          <span
                            className={`font-mono-tabular text-2xl font-bold ${
                              tier.tone === 'high'
                                ? 'text-emerald-400'
                                : tier.tone === 'mid'
                                  ? 'text-amber-400'
                                  : 'text-slate-300'
                            }`}
                          >
                            {clip.virality.totalScore}
                          </span>
                          <div className="text-xs text-slate-400">
                            <span className="font-mono-tabular">/100</span>
                            <div
                              className={
                                tier.tone === 'high'
                                  ? 'text-emerald-400 font-medium'
                                  : 'text-slate-300'
                              }
                            >
                              {tier.label}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 4-Dimension Virality Breakdown */}
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {[
                          { label: 'Hook', val: clip.virality.hookScore },
                          { label: 'Engagement', val: clip.virality.engagementScore },
                          { label: 'Value', val: clip.virality.valueScore },
                          { label: 'Shareability', val: clip.virality.shareabilityScore },
                        ].map((m) => (
                          <div key={m.label} className="rounded-lg bg-[#090B10] px-3 py-2 border border-white/6">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-400">{m.label}</span>
                              <span className="font-mono-tabular font-semibold text-white">
                                {m.val}/25
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full bg-[#FF3B5C]"
                                style={{ width: `${(m.val / 25) * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Editor Reasoning & Verbatim Transcript */}
                      <p className="mt-4 text-xs leading-relaxed text-slate-400">
                        <span className="font-semibold text-slate-200">AI Insight: </span>
                        {clip.virality.viralityReasoning || clip.reasoning}
                      </p>

                      <blockquote className="mt-3 rounded-lg border border-white/6 bg-[#090B10] p-3 text-xs leading-relaxed text-slate-300">
                        &ldquo;{clip.text}&rdquo;
                      </blockquote>
                    </div>

                    {/* Action Row */}
                    <div className="flex flex-col gap-3 border-t border-white/8 pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onEditClip(clip.id)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-xs font-semibold text-[#090B10] hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Scissors className="h-3.5 w-3.5" />
                            Edit in Studio
                          </button>

                          <button
                            type="button"
                            onClick={() => handleExportButtonClick(clip)}
                            disabled={isExporting || attachingSource}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF3B5C] px-4 py-2 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                          >
                            {isExporting ? (
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

                          <button
                            type="button"
                            onClick={() => handleDownloadSrt(clip)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Captions className="h-3.5 w-3.5" />
                            .SRT
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleCopyText(clip)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
                          >
                            {copiedClipId === clip.id ? (
                              <>
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-3.5 w-3.5" />
                                Copy Text
                              </>
                            )}
                          </button>
                        </div>

                        {clip.exportedUrl && (
                          <a
                            href={clip.exportedUrl}
                            download
                            className="text-xs font-medium text-emerald-400 hover:underline whitespace-nowrap shrink-0"
                          >
                            Download Last Render
                          </a>
                        )}
                      </div>

                      {exportChoiceClipId === clip.id && project.hasDirectVideo === false && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3.5 text-xs">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-white">
                                YouTube stream download is blocked for server-side rendering
                              </p>
                              <p className="mt-1 text-slate-300 leading-relaxed">
                                Live preview streams the cropped YouTube video directly, while full-motion MP4 export requires a local video file (.mp4/.mov).
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setExportChoiceClipId(null)}
                              className="text-slate-400 hover:text-white shrink-0"
                            >
                              Close
                            </button>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                pendingAttachClipRef.current = clip;
                                attachInputRef.current?.click();
                              }}
                              disabled={attachingSource}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF3B5C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60"
                            >
                              {attachingSource ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Upload className="h-3.5 w-3.5" />
                              )}
                              Attach Video File (.mp4) &amp; Render
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDownloadSrt(clip)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10"
                            >
                              <Captions className="h-3.5 w-3.5" />
                              Download .SRT Captions
                            </button>
                            <button
                              type="button"
                              onClick={() => void executeExportClip(clip)}
                              disabled={isExporting}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs text-slate-300 hover:text-white"
                            >
                              Export Cover Card (.mp4)
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}

      {/* Full Source Transcript Tab */}
      {activeTab === 'transcript' && project.stage === 'completed' && (
        <div className="rounded-xl border border-white/10 bg-[#11141C] divide-y divide-white/6">
          {project.transcript.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No transcript lines recorded for this project.
            </div>
          ) : (
            project.transcript.map((line, i) => (
              <div key={`${line.startTime}-${i}`} className="flex items-start gap-4 px-5 py-3 text-xs">
                <span className="font-mono-tabular text-slate-500 shrink-0 w-24">
                  {line.startTime} – {line.endTime}
                </span>
                <p className="text-slate-200 leading-relaxed">{line.text}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
