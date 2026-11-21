import { useRef, useState } from 'react';
import {
  ArrowRight,
  Captions,
  Crop,
  Film,
  Link2,
  Loader2,
  SlidersHorizontal,
  Timer,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import type {
  CaptionTemplateId,
  ClipLengthPreset,
  ClipProject,
  OutputFormat,
  WorkflowMode,
} from '../lib/types';
import {
  CAPTION_TEMPLATES,
  CLIP_LENGTH_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  WORKFLOW_OPTIONS,
} from '../lib/templates';
import { formatTimestamp, parseVideoSource } from '../lib/clip-logic';

interface CreateStudioViewProps {
  projects: ClipProject[];
  defaultTemplate: CaptionTemplateId;
  geminiConfigured: boolean;
  onProjectCreated: (project: ClipProject) => void;
  onOpenProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
}

const SAMPLE_YOUTUBE_LINKS = [
  {
    label: 'Short Tech Demo (YouTube)',
    url: 'https://www.youtube.com/watch?v=Tn6-PIqc4UM',
  },
  {
    label: 'TED Talk Sample (YouTube)',
    url: 'https://www.youtube.com/watch?v=8S0FDjFBj8o',
  },
];

export function CreateStudioView({
  projects,
  defaultTemplate,
  geminiConfigured,
  onProjectCreated,
  onOpenProject,
  onDeleteProject,
}: CreateStudioViewProps) {
  const [url, setUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowMode>('highlights');
  const [topicFocus, setTopicFocus] = useState('');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('vertical');
  const [clipLength, setClipLength] = useState<ClipLengthPreset>('auto');
  const [captionTemplate, setCaptionTemplate] = useState<CaptionTemplateId>(defaultTemplate);
  const [customInstructions, setCustomInstructions] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedUrl = url.trim() ? parseVideoSource(url) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (workflow === 'topic' && !topicFocus.trim()) {
      setErrorMsg('Enter a topic keyword or phrase for Topic Focus mode.');
      return;
    }

    if (!selectedFile) {
      const parsed = parseVideoSource(url);
      if (!parsed.valid) {
        setErrorMsg(parsed.error ?? 'Paste a valid YouTube, Twitch, Kick, or MP4 video URL, or upload a file.');
        return;
      }
    }

    setSubmitting(true);
    try {
      let res: Response;
      if (selectedFile) {
        const form = new FormData();
        form.append('video', selectedFile);
        form.append('workflow', workflow);
        form.append('outputFormat', outputFormat);
        form.append('clipLength', clipLength);
        form.append('captionTemplate', captionTemplate);
        if (topicFocus.trim()) form.append('topicFocus', topicFocus.trim());
        if (customInstructions.trim()) form.append('customInstructions', customInstructions.trim());

        res = await fetch('/api/projects/upload', {
          method: 'POST',
          body: form,
        });
      } else {
        res = await fetch('/api/projects/from-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            workflow,
            outputFormat,
            clipLength,
            captionTemplate,
            topicFocus: topicFocus.trim() || undefined,
            customInstructions: customInstructions.trim() || undefined,
          }),
        });
      }

      const data = (await res.json()) as { project?: ClipProject; error?: string };
      if (!res.ok || !data.project) {
        setErrorMsg(data.error ?? 'Failed to start clipping job.');
        return;
      }

      setUrl('');
      setSelectedFile(null);
      onProjectCreated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error starting pipeline.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileSelect = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
      setErrorMsg('Please select a video file (.mp4, .mov, .webm, or .mkv).');
      return;
    }
    setErrorMsg(null);
    setSelectedFile(file);
  };

  const activeTemplateObj = CAPTION_TEMPLATES[captionTemplate];

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      {/* Studio Hero Header */}
      <div className="mb-8 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white text-balance sm:text-4xl">
            Turn long videos into viral shorts
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Paste a YouTube or video link, or upload an MP4. OpenYouClips extracts up to 20–25+
            monetization-ready viral clips per long video with clean non-overlapping captions,
            4-axis virality scoring, and full .zip download.
          </p>
        </div>

        {!geminiConfigured && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
            Configure <span className="font-mono font-semibold">GEMINI_API_KEY</span> in Secrets to run live URL/upload analysis. Studio sample projects below are ready to edit &amp; export now.
          </div>
        )}
      </div>

      {/* Main Composer Surface */}
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-white/10 bg-[#11141C] p-6"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFileSelect(e.dataTransfer.files?.[0]);
        }}
      >
        {/* Source Input Bar */}
        <div
          className={`flex flex-col gap-3 rounded-xl border p-3 transition-colors sm:flex-row sm:items-center ${
            isDragging
              ? 'border-[#FF3B5C] bg-[#FF3B5C]/5'
              : 'border-white/10 bg-[#090B10]'
          }`}
        >
          <div className="flex flex-1 items-center gap-3 px-2">
            <Link2 className="h-5 w-5 shrink-0 text-slate-400" />
            {selectedFile ? (
              <div className="flex flex-1 items-center justify-between gap-3 py-1.5">
                <div className="flex items-center gap-2 text-sm text-white">
                  <Film className="h-4 w-4 text-[#FF3B5C]" />
                  <span className="font-medium truncate max-w-xs">{selectedFile.name}</span>
                  <span className="text-xs font-mono-tabular text-slate-400">
                    {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedFile(null)}
                  className="text-xs text-slate-400 hover:text-white transition-colors whitespace-nowrap shrink-0"
                >
                  Remove file
                </button>
              </div>
            ) : (
              <input
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                aria-label="Video URL"
                placeholder="Paste YouTube, Twitch, Kick, or direct .mp4 link..."
                className="w-full bg-transparent py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none"
              />
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload Video
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-[#FF3B5C] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#FF2449] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5" />
                  Generate Clips
                </>
              )}
            </button>
          </div>
        </div>

        {/* Source hint & quick sample URLs */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <span>Quick paste:</span>
            {SAMPLE_YOUTUBE_LINKS.map((item) => (
              <button
                key={item.url}
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setUrl(item.url);
                  setErrorMsg(null);
                }}
                className="text-slate-300 underline decoration-white/20 underline-offset-4 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                {item.label}
              </button>
            ))}
          </div>
          {parsedUrl && url.trim() && (
            <span className={parsedUrl.valid ? 'text-emerald-400' : 'text-amber-400'}>
              {parsedUrl.valid
                ? `Detected ${parsedUrl.sourceType.toUpperCase()} source`
                : parsedUrl.error}
            </span>
          )}
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-2.5 text-xs text-red-200"
          >
            {errorMsg}
          </div>
        )}

        {/* Workflow Mode Segmented Selector */}
        <div className="mt-6 border-t border-white/8 pt-5">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Clipping Workflow</span>
            <span className="text-xs text-slate-400">
              {WORKFLOW_OPTIONS.find((w) => w.id === workflow)?.summary}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {WORKFLOW_OPTIONS.map((opt) => {
              const active = workflow === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setWorkflow(opt.id)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors whitespace-nowrap truncate ${
                    active
                      ? 'border-[#FF3B5C] bg-[#FF3B5C]/12 text-white'
                      : 'border-white/8 bg-[#090B10] text-slate-400 hover:border-white/20 hover:text-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {workflow === 'topic' && (
            <div className="mt-3">
              <label htmlFor="topic-focus-input" className="sr-only">
                Target Topic
              </label>
              <input
                id="topic-focus-input"
                type="text"
                value={topicFocus}
                onChange={(e) => setTopicFocus(e.target.value)}
                placeholder="Enter topic to extract (e.g. pricing strategy, AI agents, retention hooks)..."
                className="w-full rounded-lg border border-white/12 bg-[#090B10] px-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-[#FF3B5C] focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Framing, Duration & Caption Style Row */}
        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-white/8 pt-5 md:grid-cols-3">
          {/* Output Aspect Ratio */}
          <div>
            <label
              htmlFor="output-format-select"
              className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300"
            >
              <Crop className="h-3.5 w-3.5 text-slate-400" />
              Output Framing
            </label>
            <select
              id="output-format-select"
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
              className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
            >
              {OUTPUT_FORMAT_OPTIONS.map((fmt) => (
                <option key={fmt.id} value={fmt.id}>
                  {fmt.label} — {fmt.platforms}
                </option>
              ))}
            </select>
          </div>

          {/* Clip Length */}
          <div>
            <label
              htmlFor="clip-length-select"
              className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300"
            >
              <Timer className="h-3.5 w-3.5 text-slate-400" />
              Target Clip Length
            </label>
            <select
              id="clip-length-select"
              value={clipLength}
              onChange={(e) => setClipLength(e.target.value as ClipLengthPreset)}
              className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
            >
              {CLIP_LENGTH_OPTIONS.map((len) => (
                <option key={len.id} value={len.id}>
                  {len.label} · {len.rangeLabel}
                </option>
              ))}
            </select>
          </div>

          {/* Caption Template */}
          <div>
            <label
              htmlFor="caption-template-select"
              className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300"
            >
              <Captions className="h-3.5 w-3.5 text-slate-400" />
              Caption Template
            </label>
            <div className="flex items-center gap-2">
              <select
                id="caption-template-select"
                value={captionTemplate}
                onChange={(e) => setCaptionTemplate(e.target.value as CaptionTemplateId)}
                className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white focus:border-[#FF3B5C] focus:outline-none"
              >
                {(Object.keys(CAPTION_TEMPLATES) as CaptionTemplateId[]).map((tid) => (
                  <option key={tid} value={tid}>
                    {CAPTION_TEMPLATES[tid].name}
                  </option>
                ))}
              </select>
              <span
                className="shrink-0 rounded-md border border-white/10 bg-[#090B10] px-2.5 py-2 text-[11px] font-bold"
                style={{ color: activeTemplateObj.highlightColor }}
              >
                Aa
              </span>
            </div>
          </div>
        </div>

        {/* Optional AI Creative Instructions */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {showAdvanced ? 'Hide AI Creative Direction' : 'Add AI Creative Direction (optional)'}
          </button>

          {showAdvanced && (
            <div className="mt-3">
              <label htmlFor="custom-instructions" className="sr-only">
                Custom AI Creative Direction
              </label>
              <textarea
                id="custom-instructions"
                rows={2}
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Tell OpenYouClips AI what to prioritize (e.g. 'Prioritize controversial takes, concrete metrics, and fast-paced debates. Avoid sponsor reads.')"
                className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:border-[#FF3B5C] focus:outline-none"
              />
            </div>
          )}
        </div>
      </form>

      {/* Studio Library / Recent Projects */}
      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">
              Studio Projects
            </h2>
            <p className="text-xs text-slate-400">
              Open any project to review virality breakdowns, customize captions, reframe 9:16, or export MP4s.
            </p>
          </div>
          <span className="font-mono-tabular text-xs text-slate-400">
            {projects.length} {projects.length === 1 ? 'project' : 'projects'}
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-xl border border-white/8 bg-[#11141C] p-10 text-center">
            <p className="text-sm font-medium text-white">No clip projects yet</p>
            <p className="mt-1 text-xs text-slate-400">
              Paste a YouTube link or upload an MP4 above to generate your first batch of viral clips.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => {
              const topScore =
                project.clips.length > 0
                  ? Math.max(...project.clips.map((c) => c.virality.totalScore))
                  : null;
              const activeAgent =
                project.stage !== 'completed' && project.stage !== 'error'
                  ? project.agentSteps?.find((s) => s.status === 'running')?.agentName
                  : undefined;

              return (
                <div
                  key={project.id}
                  className="group flex flex-col justify-between overflow-hidden rounded-xl border border-white/8 bg-[#11141C] transition-colors hover:border-white/20"
                >
                  <div>
                    <div className="relative aspect-video w-full overflow-hidden bg-[#07090E]">
                      <img
                        src={project.thumbnailUrl}
                        alt={project.title}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      />
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                      <div className="absolute inset-x-3 bottom-2.5 flex items-center justify-between gap-2 text-xs text-white">
                        <span className="font-mono-tabular">
                          {formatTimestamp(project.durationSeconds)}
                        </span>
                        <span className="font-medium truncate">
                          {project.stage === 'completed'
                            ? `${project.clips.length} clips`
                            : project.stage === 'error'
                              ? 'Failed'
                              : activeAgent
                                ? `${activeAgent} · ${project.progress}%`
                                : `${project.progress}%`}
                        </span>
                      </div>
                    </div>

                    <div className="p-4">
                      <h3 className="font-display text-sm font-semibold leading-snug text-white line-clamp-2">
                        {project.title}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                        <span>{project.channelName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="capitalize">{project.workflow}</span>
                        {topScore !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-tabular text-emerald-400">
                              Top {topScore}/100
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-white/8 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onOpenProject(project.id)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-white hover:text-[#FF3B5C] transition-colors whitespace-nowrap shrink-0"
                    >
                      Open Clip Wall
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>

                    {!project.isSample && (
                      <button
                        type="button"
                        onClick={() => onDeleteProject(project.id)}
                        aria-label={`Delete project ${project.title}`}
                        className="rounded-md p-1.5 text-slate-500 hover:bg-white/8 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
