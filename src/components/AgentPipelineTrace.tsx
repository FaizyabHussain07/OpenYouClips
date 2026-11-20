import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { AgentStep, PipelineStage } from '../lib/types';

interface AgentPipelineTraceProps {
  steps: AgentStep[];
  stage: PipelineStage;
  progress: number;
  stageMessage: string;
  compact?: boolean;
}

function stepDurationLabel(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AgentPipelineTrace({
  steps,
  stage,
  progress,
  stageMessage,
  compact = false,
}: AgentPipelineTraceProps) {
  const activeStep = steps.find((s) => s.status === 'running');
  const completedCount = steps.filter(
    (s) => s.status === 'completed' || s.status === 'warning',
  ).length;

  return (
    <div className="rounded-xl border border-white/10 bg-[#11141C] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-[#090B10]">
            {stage === 'completed' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : stage === 'error' ? (
              <XCircle className="h-4 w-4 text-red-400" />
            ) : (
              <Bot className="h-4 w-4 text-[#FF3B5C]" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
              <span className="font-semibold text-white">
                {activeStep
                  ? activeStep.agentName
                  : stage === 'completed'
                    ? 'All AI Agents Finished'
                    : stage === 'error'
                      ? 'Pipeline Halted'
                      : 'OpenYouClips AI Agent Pipeline'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">
                {completedCount}/{steps.length} stages complete
              </span>
            </div>
            <p className="mt-0.5 text-sm font-medium text-slate-200 truncate">
              {stageMessage}
            </p>
          </div>
        </div>

        <span className="font-mono-tabular text-base font-bold text-white shrink-0">
          {progress}%
        </span>
      </div>

      {/* Progress Track */}
      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
        <div
          className={`h-full transition-[width] duration-300 ${
            stage === 'error'
              ? 'bg-red-500'
              : stage === 'completed'
                ? 'bg-emerald-400'
                : 'bg-[#FF3B5C]'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Step-by-Step AI Agent Execution List */}
      <ol className={`mt-5 flex flex-col ${compact ? 'gap-2.5' : 'gap-3'}`}>
        {steps.map((step, index) => {
          const duration = stepDurationLabel(step.startedAt, step.completedAt);
          const isRunning = step.status === 'running';
          const isDone = step.status === 'completed';
          const isWarn = step.status === 'warning';
          const isErr = step.status === 'error';

          return (
            <li
              key={step.id}
              className={`rounded-lg border px-4 py-3 transition-colors ${
                isRunning
                  ? 'border-[#FF3B5C]/45 bg-[#FF3B5C]/6'
                  : isErr
                    ? 'border-red-500/35 bg-red-500/8'
                    : isWarn
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : isDone
                        ? 'border-white/8 bg-[#090B10]'
                        : 'border-white/5 bg-[#090B10]/55 opacity-65'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="mt-0.5 shrink-0">
                    {isRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#FF3B5C]" />
                    ) : isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : isWarn ? (
                      <AlertTriangle className="h-4 w-4 text-amber-400" />
                    ) : isErr ? (
                      <XCircle className="h-4 w-4 text-red-400" />
                    ) : (
                      <Circle className="h-4 w-4 text-slate-600" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="font-mono-tabular text-slate-500">
                        0{index + 1}
                      </span>
                      <span className="font-semibold text-white">
                        {step.agentName}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="text-slate-400">{step.title}</span>
                    </div>

                    <p className="mt-1 text-xs leading-relaxed text-slate-300">
                      {step.detail}
                    </p>

                    {step.metrics && step.metrics.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono-tabular text-slate-400">
                        {step.metrics.map((m, mIdx) => (
                          <span key={`${step.id}-m-${mIdx}`} className="inline-flex items-center gap-2">
                            {mIdx > 0 && <span aria-hidden="true">·</span>}
                            <span>{m}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="shrink-0 text-right font-mono-tabular text-[11px]">
                  {isRunning ? (
                    <span className="text-[#FF3B5C] font-medium">Running</span>
                  ) : isDone ? (
                    <span className="text-emerald-400">
                      {duration ?? 'Done'}
                    </span>
                  ) : isWarn ? (
                    <span className="text-amber-300">
                      {duration ?? 'Stream'}
                    </span>
                  ) : isErr ? (
                    <span className="text-red-400">Stopped</span>
                  ) : (
                    <span className="text-slate-500">Queued</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
