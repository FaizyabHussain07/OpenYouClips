import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import type {
  CaptionStyleConfig,
  EffectsConfig,
  FramingConfig,
  HookBannerConfig,
  WordToken,
} from '../lib/types';
import {
  computeAspectRatioCss,
  findActiveCaptionAtTime,
  formatTimecode,
  groupWordsIntoCaptionLines,
} from '../lib/clip-logic';

interface YTPlayerInstance {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  mute: () => void;
  unMute: () => void;
  setVolume: (vol: number) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
}

interface YTGlobal {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayerInstance;
}

declare global {
  interface Window {
    YT?: YTGlobal;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTGlobal | null> | null = null;

function loadYouTubeIframeApi(): Promise<YTGlobal | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(window.YT ?? null), 5000);
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      prevReady?.();
      resolve(window.YT ?? null);
    };

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => {
        window.clearTimeout(timeout);
        resolve(null);
      };
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}

export interface PreviewPlayerControl {
  togglePlay: () => void;
  seekTo: (localSeconds: number) => void;
}

interface VideoPreviewPlayerProps {
  videoUrl: string;
  posterUrl?: string;
  youtubeId?: string;
  hasDirectVideo?: boolean;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  duration: number;
  trimStartOffset?: number;
  trimEndOffset?: number;
  words: WordToken[];
  captionStyle: CaptionStyleConfig;
  framing: FramingConfig;
  hookBanner: HookBannerConfig;
  effects?: EffectsConfig;
  playbackSpeed?: number;
  showCaptions?: boolean;
  compact?: boolean;
  onTimeUpdate?: (time: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  videoElementRef?: React.RefObject<HTMLVideoElement | null>;
  playerControlRef?: React.MutableRefObject<PreviewPlayerControl | null>;
}

export function VideoPreviewPlayer({
  videoUrl,
  posterUrl,
  youtubeId,
  hasDirectVideo = true,
  clipStartSeconds = 0,
  clipEndSeconds,
  duration,
  trimStartOffset = 0,
  trimEndOffset = 0,
  words,
  captionStyle,
  framing,
  hookBanner,
  effects,
  playbackSpeed = 1,
  showCaptions = true,
  compact = false,
  onTimeUpdate,
  onPlayStateChange,
  videoElementRef,
  playerControlRef,
}: VideoPreviewPlayerProps) {
  const internalRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = videoElementRef ?? internalRef;
  const ytContainerRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YTPlayerInstance | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(trimStartOffset);
  const [ytReady, setYtReady] = useState(false);
  const [ytError, setYtError] = useState(false);

  const currentTimeRef = useRef(trimStartOffset);
  const isMutedRef = useRef(isMuted);
  const speedRef = useRef(playbackSpeed);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onPlayStateChangeRef = useRef(onPlayStateChange);

  isMutedRef.current = isMuted;
  speedRef.current = playbackSpeed;
  onTimeUpdateRef.current = onTimeUpdate;
  onPlayStateChangeRef.current = onPlayStateChange;

  const useYouTubeEmbed = Boolean(youtubeId && hasDirectVideo === false && !ytError);
  const effectiveEnd = Math.max(trimStartOffset + 1, duration - trimEndOffset);
  const effectiveDuration = Math.max(1, effectiveEnd - trimStartOffset);

  const ytStart = Math.max(0, Math.floor(clipStartSeconds + trimStartOffset));
  const ytEnd = Math.max(
    ytStart + 3,
    Math.ceil(clipEndSeconds ?? clipStartSeconds + duration),
  );

  // Initialize real YouTube IFrame Player API when playing YouTube stream clips
  useEffect(() => {
    if (!useYouTubeEmbed || !youtubeId) {
      setYtReady(false);
      return;
    }

    let cancelled = false;
    setYtReady(false);
    setIsPlaying(false);

    void loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !YT?.Player || !ytContainerRef.current) return;

      // Clear previous player mount node before instantiating
      ytContainerRef.current.innerHTML = '';
      const mount = document.createElement('div');
      mount.style.width = '100%';
      mount.style.height = '100%';
      ytContainerRef.current.appendChild(mount);

      try {
        const player = new YT.Player(mount, {
          videoId: youtubeId,
          width: '100%',
          height: '100%',
          playerVars: {
            start: ytStart,
            end: ytEnd,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              if (isMutedRef.current) {
                player.mute();
              } else {
                player.unMute();
              }
              player.setVolume(Math.round(Math.min(1, Math.max(0, effects?.volume ?? 1)) * 100));
              player.setPlaybackRate(speedRef.current);
              setYtReady(true);
            },
            onStateChange: (event) => {
              if (cancelled) return;
              if (event.data === 1) {
                setIsPlaying(true);
                onPlayStateChangeRef.current?.(true);
              } else if (event.data === 2) {
                setIsPlaying(false);
                onPlayStateChangeRef.current?.(false);
              } else if (event.data === 0) {
                player.seekTo(clipStartSeconds + trimStartOffset, true);
                player.playVideo();
              }
            },
            onError: () => {
              if (cancelled) return;
              setYtError(true);
              setYtReady(false);
            },
          },
        });
        ytPlayerRef.current = player;
      } catch {
        setYtError(true);
      }
    });

    return () => {
      cancelled = true;
      try {
        ytPlayerRef.current?.destroy();
      } catch {
        // Ignore cleanup errors
      }
      ytPlayerRef.current = null;
    };
    // Re-init only if source video/clip identity changes
  }, [useYouTubeEmbed, youtubeId, clipStartSeconds]);

  // Sync playback rate & volume onto YT player & <video>
  useEffect(() => {
    const vid = videoRef.current;
    if (vid) {
      vid.volume = Math.min(1, Math.max(0, effects?.volume ?? 1));
      vid.playbackRate = playbackSpeed;
    }
    const yt = ytPlayerRef.current;
    if (yt && ytReady) {
      try {
        yt.setVolume(Math.round(Math.min(1, Math.max(0, effects?.volume ?? 1)) * 100));
        yt.setPlaybackRate(playbackSpeed);
      } catch {
        // Ignore transient YT API call error
      }
    }
  }, [effects?.volume, playbackSpeed, ytReady, videoRef]);

  // Sync smooth playhead updates for word-by-word karaoke
  useEffect(() => {
    if (!isPlaying) return;

    if (useYouTubeEmbed && ytReady) {
      let raf = 0;
      const tickYt = () => {
        const yt = ytPlayerRef.current;
        if (yt) {
          try {
            const absTime = yt.getCurrentTime();
            let local = absTime - clipStartSeconds;
            if (local < trimStartOffset - 0.5) {
              local = trimStartOffset;
            }
            if (local >= effectiveEnd) {
              local = trimStartOffset;
              yt.seekTo(clipStartSeconds + trimStartOffset, true);
            }
            const clamped = Math.max(0, local);
            currentTimeRef.current = clamped;
            setCurrentTime(clamped);
            onTimeUpdateRef.current?.(clamped);
          } catch {
            // Ignore transient YT API read error
          }
        }
        raf = requestAnimationFrame(tickYt);
      };
      raf = requestAnimationFrame(tickYt);
      return () => cancelAnimationFrame(raf);
    }

    let raf = 0;
    const tick = () => {
      const vid = videoRef.current;
      if (vid && !vid.paused) {
        const t = vid.currentTime;
        if (t >= effectiveEnd) {
          vid.currentTime = trimStartOffset;
        } else if (t < trimStartOffset) {
          vid.currentTime = trimStartOffset;
        }
        currentTimeRef.current = vid.currentTime;
        setCurrentTime(vid.currentTime);
        onTimeUpdateRef.current?.(vid.currentTime);
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    isPlaying,
    useYouTubeEmbed,
    ytReady,
    clipStartSeconds,
    effectiveEnd,
    trimStartOffset,
    videoRef,
  ]);

  const seekTo = useCallback(
    (localSeconds: number) => {
      const clamped = Math.max(0, Math.min(duration, localSeconds));
      currentTimeRef.current = clamped;
      setCurrentTime(clamped);
      onTimeUpdateRef.current?.(clamped);

      if (useYouTubeEmbed && ytPlayerRef.current && ytReady) {
        try {
          ytPlayerRef.current.seekTo(clipStartSeconds + clamped, true);
        } catch {
          // Ignore seek errors
        }
      }
      if (videoRef.current) {
        videoRef.current.currentTime = clamped;
      }
    },
    [clipStartSeconds, duration, useYouTubeEmbed, videoRef, ytReady],
  );

  const togglePlay = useCallback(async () => {
    if (useYouTubeEmbed && ytPlayerRef.current && ytReady) {
      try {
        if (isPlaying) {
          ytPlayerRef.current.pauseVideo();
          setIsPlaying(false);
          onPlayStateChangeRef.current?.(false);
        } else {
          if (isMutedRef.current) {
            ytPlayerRef.current.mute();
          } else {
            ytPlayerRef.current.unMute();
          }
          if (currentTimeRef.current < trimStartOffset || currentTimeRef.current >= effectiveEnd) {
            ytPlayerRef.current.seekTo(clipStartSeconds + trimStartOffset, true);
          }
          ytPlayerRef.current.playVideo();
          setIsPlaying(true);
          onPlayStateChangeRef.current?.(true);
        }
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      if (vid.currentTime < trimStartOffset || vid.currentTime >= effectiveEnd) {
        vid.currentTime = trimStartOffset;
      }
      try {
        await vid.play();
        setIsPlaying(true);
        onPlayStateChangeRef.current?.(true);
      } catch {
        setIsPlaying(false);
      }
    } else {
      vid.pause();
      setIsPlaying(false);
      onPlayStateChangeRef.current?.(false);
    }
  }, [
    clipStartSeconds,
    effectiveEnd,
    isPlaying,
    trimStartOffset,
    useYouTubeEmbed,
    videoRef,
    ytReady,
  ]);

  // Expose imperative transport controls for StudioEditor
  useEffect(() => {
    if (!playerControlRef) return;
    playerControlRef.current = {
      togglePlay: () => void togglePlay(),
      seekTo,
    };
    return () => {
      playerControlRef.current = null;
    };
  }, [playerControlRef, seekTo, togglePlay]);

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (useYouTubeEmbed && ytPlayerRef.current && ytReady) {
      try {
        if (nextMuted) {
          ytPlayerRef.current.mute();
        } else {
          ytPlayerRef.current.unMute();
        }
      } catch {
        // Ignore YT mute errors
      }
    }
    if (videoRef.current) {
      videoRef.current.muted = nextMuted;
    }
  };

  const chunks = useMemo(
    () => groupWordsIntoCaptionLines(words, captionStyle.maxWordsPerLine),
    [words, captionStyle.maxWordsPerLine],
  );

  const { chunk: activeChunk, activeWordIndex } = useMemo(
    () => findActiveCaptionAtTime(chunks, currentTime),
    [chunks, currentTime],
  );

  const localElapsed = Math.max(0, currentTime - trimStartOffset);
  const showHook =
    hookBanner.enabled &&
    hookBanner.text.trim().length > 0 &&
    localElapsed <= Math.max(1.5, hookBanner.durationSeconds || 3.5);

  const posX = Math.max(0, Math.min(100, 50 + (framing.panX || 0) * 50));
  const posY = Math.max(0, Math.min(100, 50 + (framing.panY || 0) * 50));
  const zoomScale = framing.zoom || 1;
  const videoFilter = effects
    ? `brightness(${1 + (effects.brightness || 0)}) contrast(${effects.contrast || 1}) saturate(${effects.saturation || 1})`
    : undefined;

  const progressPct = Math.min(100, Math.max(0, (localElapsed / effectiveDuration) * 100));

  return (
    <div className="flex flex-col items-center gap-2 w-full">
      <div
        onClick={() => void togglePlay()}
        className="relative w-full cursor-pointer overflow-hidden rounded-xl bg-black border border-white/10 select-none"
        style={{
          aspectRatio: computeAspectRatioCss(framing.outputFormat),
          maxHeight: compact ? '380px' : '540px',
          maxWidth:
            framing.outputFormat === 'landscape'
              ? '100%'
              : framing.outputFormat === 'vertical'
                ? compact
                  ? '220px'
                  : '310px'
                : compact
                  ? '280px'
                  : '390px',
        }}
      >
        {useYouTubeEmbed ? (
          <>
            {/* Real YouTube Video Player visibly mounted & cropped to aspect ratio */}
            <div
              ref={ytContainerRef}
              className="pointer-events-none absolute top-1/2 left-1/2 h-full max-w-none"
              style={{
                width:
                  framing.outputFormat === 'landscape'
                    ? '100%'
                    : framing.outputFormat === 'square'
                      ? '178%'
                      : framing.outputFormat === 'portrait'
                        ? '222%'
                        : '316%',
                transform: `translate(${-50 - (framing.panX || 0) * 18}%, ${-50 - (framing.panY || 0) * 12}%) scale(${zoomScale})`,
                filter: videoFilter,
              }}
            />
            {/* Poster shown ONLY while YT iframe finishes initial boot */}
            {posterUrl && (
              <img
                src={posterUrl}
                alt=""
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
                  ytReady ? 'opacity-0' : 'opacity-100'
                }`}
                style={{
                  objectPosition: `${posX}% ${posY}%`,
                  transformOrigin: `${posX}% ${posY}%`,
                  transform: `scale(${zoomScale})`,
                  filter: videoFilter,
                }}
              />
            )}
          </>
        ) : (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={posterUrl}
            muted={isMuted}
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              currentTimeRef.current = t;
              setCurrentTime(t);
              onTimeUpdateRef.current?.(t);
            }}
            onPlay={() => {
              setIsPlaying(true);
              onPlayStateChangeRef.current?.(true);
            }}
            onPause={() => {
              setIsPlaying(false);
              onPlayStateChangeRef.current?.(false);
            }}
            onEnded={() => {
              setIsPlaying(false);
              onPlayStateChangeRef.current?.(false);
            }}
            className="h-full w-full object-cover transition-transform duration-150"
            style={{
              objectPosition: `${posX}% ${posY}%`,
              transformOrigin: `${posX}% ${posY}%`,
              transform: `scale(${zoomScale})`,
              filter: videoFilter,
            }}
          />
        )}

        {/* Subtle edge vignette scrim for caption readability */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/35" />

        {/* Hook Title Opening Banner */}
        {showHook && (
          <div className="pointer-events-none absolute inset-x-3 top-4 flex justify-center">
            <div
              className="rounded-lg px-3 py-1.5 text-center text-xs font-bold leading-snug shadow-md"
              style={{
                backgroundColor: hookBanner.bgColor || '#11141C',
                color: hookBanner.textColor || '#FFFFFF',
                maxWidth: '92%',
              }}
            >
              {hookBanner.text}
            </div>
          </div>
        )}

        {/* Word-Synced Animated Captions Overlay */}
        {showCaptions && activeChunk && (
          <div
            className="pointer-events-none absolute inset-x-2 flex justify-center px-2"
            style={{
              top: `${Math.round((captionStyle.positionY || 0.78) * 100)}%`,
              transform: 'translateY(-50%)',
            }}
          >
            <div
              className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-lg px-2.5 py-1 text-center leading-tight"
              style={{
                backgroundColor: captionStyle.background
                  ? captionStyle.backgroundColor || 'rgba(10,12,18,0.75)'
                  : 'transparent',
                fontFamily:
                  captionStyle.fontFamily === 'Anton'
                    ? "'Anton', 'Plus Jakarta Sans', sans-serif"
                    : captionStyle.fontFamily === 'DM Sans'
                      ? "'DM Sans', sans-serif"
                      : "'Plus Jakarta Sans', sans-serif",
                fontSize: compact
                  ? `${Math.max(13, Math.round((captionStyle.fontSize || 32) * 0.48))}px`
                  : `${Math.max(16, Math.round((captionStyle.fontSize || 32) * 0.62))}px`,
              }}
            >
              {activeChunk.words.map((w) => {
                const isActive = w.globalIndex === activeWordIndex;
                const displayWord = captionStyle.uppercase ? w.word.toUpperCase() : w.word;
                const activeColor = captionStyle.highlightColor || '#FFE000';
                const baseColor =
                  w.emphasis && captionStyle.emphasisColor
                    ? captionStyle.emphasisColor
                    : captionStyle.fontColor || '#FFFFFF';

                return (
                  <span
                    key={`${w.globalIndex}-${w.word}`}
                    className="inline-block rounded px-1 font-extrabold transition-transform duration-100"
                    style={{
                      color: isActive ? (captionStyle.wordBox ? '#FFFFFF' : activeColor) : baseColor,
                      backgroundColor:
                        isActive && captionStyle.wordBox
                          ? captionStyle.wordBoxColor || '#00BF49'
                          : 'transparent',
                      transform:
                        isActive && captionStyle.wordPop ? 'scale(1.12)' : 'scale(1)',
                      textShadow:
                        captionStyle.strokeWidth > 0
                          ? `0 2px 4px ${captionStyle.strokeColor || '#000000'}, -1px -1px 0 ${captionStyle.strokeColor || '#000000'}, 1px -1px 0 ${captionStyle.strokeColor || '#000000'}, -1px 1px 0 ${captionStyle.strokeColor || '#000000'}, 1px 1px 0 ${captionStyle.strokeColor || '#000000'}`
                          : captionStyle.glow
                            ? `0 0 12px ${activeColor}`
                            : undefined,
                    }}
                  >
                    {displayWord}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Bottom HUD Transport */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-2.5 pb-2 pt-4">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full bg-[#FF3B5C] transition-[width] duration-75"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-white/90">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void togglePlay();
                }}
                aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </button>
              <span className="font-mono-tabular text-[11px] text-white/90">
                {formatTimecode(localElapsed)} / {formatTimecode(effectiveDuration)}
              </span>
            </div>
            <button
              type="button"
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute preview audio' : 'Mute preview audio'}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/80 transition-colors"
            >
              {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
