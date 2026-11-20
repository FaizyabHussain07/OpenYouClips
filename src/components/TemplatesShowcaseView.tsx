import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { CAPTION_TEMPLATES } from '../lib/templates';
import type { CaptionTemplateId } from '../lib/types';

interface TemplatesShowcaseViewProps {
  selectedTemplate: CaptionTemplateId;
  onSelectDefaultTemplate: (templateId: CaptionTemplateId) => void;
}

const TEMPLATE_IDS = Object.keys(CAPTION_TEMPLATES) as CaptionTemplateId[];

export function TemplatesShowcaseView({
  selectedTemplate,
  onSelectDefaultTemplate,
}: TemplatesShowcaseViewProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((prev) => prev + 1);
    }, 480);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-8 flex flex-col gap-2 border-b border-white/8 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-white">
            Caption Templates
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Live word-synced subtitle styles burned directly into exported MP4 clips via FFmpeg.
          </p>
        </div>
        <div className="text-xs text-slate-400">
          Active default:{' '}
          <span className="font-semibold text-white">
            {CAPTION_TEMPLATES[selectedTemplate].name}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {TEMPLATE_IDS.map((id) => {
          const tpl = CAPTION_TEMPLATES[id];
          const isSelected = selectedTemplate === id;
          const words = tpl.previewSample.split(' ');
          const activeIndex = tick % words.length;

          return (
            <div
              key={id}
              className={`flex flex-col justify-between rounded-xl border bg-[#11141C] p-5 transition-colors ${
                isSelected ? 'border-[#FF3B5C]' : 'border-white/8 hover:border-white/20'
              }`}
            >
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-display text-base font-semibold text-white">{tpl.name}</h2>
                  <span className="text-xs font-mono-tabular text-slate-400">
                    {tpl.maxWordsPerLine} words · {tpl.animation}
                  </span>
                </div>

                {/* Live Animated Preview Stage */}
                <div className="mb-4 flex h-36 items-center justify-center rounded-lg bg-[#07090E] px-4 border border-white/6">
                  <div
                    className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg px-3 py-1.5 text-center leading-tight"
                    style={{
                      backgroundColor: tpl.background
                        ? tpl.backgroundColor || 'rgba(10,12,18,0.8)'
                        : 'transparent',
                      fontFamily:
                        tpl.fontFamily === 'Anton'
                          ? "'Anton', 'Plus Jakarta Sans', sans-serif"
                          : tpl.fontFamily === 'DM Sans'
                            ? "'DM Sans', sans-serif"
                            : "'Plus Jakarta Sans', sans-serif",
                      fontSize: '21px',
                    }}
                  >
                    {words.map((word, idx) => {
                      const active = idx === activeIndex;
                      const label = tpl.uppercase ? word.toUpperCase() : word;
                      return (
                        <span
                          key={`${id}-${idx}`}
                          className="inline-block rounded px-1 font-extrabold transition-transform duration-150"
                          style={{
                            color: active
                              ? tpl.wordBox
                                ? '#FFFFFF'
                                : tpl.highlightColor
                              : tpl.fontColor,
                            backgroundColor:
                              active && tpl.wordBox
                                ? tpl.wordBoxColor || '#00BF49'
                                : 'transparent',
                            transform: active && tpl.wordPop ? 'scale(1.1)' : 'scale(1)',
                            textShadow:
                              tpl.strokeWidth > 0
                                ? `0 2px 4px ${tpl.strokeColor || '#000'}`
                                : tpl.glow
                                  ? `0 0 10px ${tpl.highlightColor}`
                                  : undefined,
                          }}
                        >
                          {label}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <p className="text-sm leading-relaxed text-slate-400">{tpl.description}</p>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-white/8 pt-4">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span
                    className="inline-block h-3 w-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: tpl.fontColor }}
                  />
                  <span>Base</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className="inline-block h-3 w-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: tpl.highlightColor }}
                  />
                  <span>Active</span>
                </div>

                <button
                  type="button"
                  onClick={() => onSelectDefaultTemplate(id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    isSelected
                      ? 'bg-[#FF3B5C] text-white'
                      : 'bg-white/8 text-slate-200 hover:bg-white/14'
                  }`}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" />}
                  {isSelected ? 'Default Active' : 'Use Template'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
