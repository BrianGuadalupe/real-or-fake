'use client';

import {
  ArrowRight,
  Check,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type Truth = 'camera' | 'ai';
type Phase =
  | 'loading'
  | 'intro'
  | 'playing'
  | 'answered'
  | 'finished'
  | 'error';

type DirectMedia = {
  provider: 'direct';
  url: string;
  poster?: string;
};

type DriveMedia = {
  provider: 'drive';
  fileId?: string;
  resourceKey?: string;
  shareUrl?: string;
  embedUrl?: string;
};

type Clip = {
  id: string;
  enabled?: boolean;
  demo?: boolean;
  truth: Truth;
  media: DirectMedia | DriveMedia;
  provenance: {
    label: string;
    detail: string;
    sourceName?: string;
    sourceUrl?: string;
    license?: string;
    licenseUrl?: string;
    model?: string;
    date?: string;
  };
};

type Catalog = {
  version: number;
  settings?: { roundCount?: number };
  clips: Clip[];
};

type Answer = {
  clipId: string;
  guess: Truth;
  truth: Truth;
  correct: boolean;
};

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute: (input: unknown) => Promise<unknown>;
};

type WebMcpContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

const DEFAULT_ROUND_COUNT = 10;

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function buildRounds(clips: Clip[], requestedCount: number) {
  const roundCount = Math.min(Math.max(1, requestedCount), clips.length);
  const camera = shuffle(clips.filter((clip) => clip.truth === 'camera'));
  const ai = shuffle(clips.filter((clip) => clip.truth === 'ai'));

  if (!camera.length || !ai.length) {
    return shuffle(clips).slice(0, roundCount);
  }

  const cameraTarget = Math.min(camera.length, Math.ceil(roundCount / 2));
  const aiTarget = Math.min(ai.length, Math.floor(roundCount / 2));
  const selected = [...camera.slice(0, cameraTarget), ...ai.slice(0, aiTarget)];
  const selectedIds = new Set(selected.map((clip) => clip.id));
  const remainder = shuffle(clips.filter((clip) => !selectedIds.has(clip.id)));

  return shuffle([
    ...selected,
    ...remainder.slice(0, roundCount - selected.length),
  ]);
}

function getDriveDetails(media: DriveMedia) {
  let fileId = media.fileId?.trim();
  let resourceKey = media.resourceKey?.trim();

  if (media.shareUrl) {
    try {
      const shareUrl = new URL(media.shareUrl);
      const pathMatch = shareUrl.pathname.match(/\/file\/d\/([^/]+)/);
      fileId ||= pathMatch?.[1] ?? shareUrl.searchParams.get('id') ?? undefined;
      resourceKey ||= shareUrl.searchParams.get('resourcekey') ?? undefined;
    } catch {
      // The validation below handles malformed links.
    }
  }

  if (media.embedUrl) {
    try {
      const embedUrl = new URL(media.embedUrl);
      if (embedUrl.hostname === 'drive.google.com') {
        const pathMatch = embedUrl.pathname.match(/\/file\/d\/([^/]+)/);
        fileId ||=
          pathMatch?.[1] ?? embedUrl.searchParams.get('id') ?? undefined;
        resourceKey ||= embedUrl.searchParams.get('resourcekey') ?? undefined;
      }
    } catch {
      return null;
    }
  }

  if (!fileId) return null;

  const encodedId = encodeURIComponent(fileId);
  const openParams = new URLSearchParams();
  const streamParams = new URLSearchParams({ id: fileId, export: 'download' });
  if (resourceKey) {
    openParams.set('resourcekey', resourceKey);
    streamParams.set('resourcekey', resourceKey);
  }
  const openSuffix = openParams.size ? `?${openParams.toString()}` : '';

  return {
    streamUrl: `https://drive.usercontent.google.com/download?${streamParams.toString()}`,
    openUrl:
      media.shareUrl ??
      `https://drive.google.com/file/d/${encodedId}/view${openSuffix}`,
  };
}

function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== 'object') return false;
  const clip = value as Partial<Clip>;
  return Boolean(
    clip.id &&
    (clip.truth === 'camera' || clip.truth === 'ai') &&
    clip.media &&
    (clip.media.provider === 'direct' || clip.media.provider === 'drive') &&
    clip.provenance?.label &&
    clip.provenance?.detail,
  );
}

function MediaStage({
  clip,
  attempt,
  onReady,
  onError,
  videoRef,
}: {
  clip: Clip;
  attempt: number;
  onReady: () => void;
  onError: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const driveDetails =
    clip.media.provider === 'drive' ? getDriveDetails(clip.media) : null;

  useEffect(() => {
    if (clip.media.provider === 'drive' && !driveDetails) onError();
  }, [clip.media.provider, driveDetails, onError]);

  const mediaUrl =
    clip.media.provider === 'drive' ? driveDetails?.streamUrl : clip.media.url;

  if (!mediaUrl) return null;

  return (
    <video
      key={`${clip.id}-${attempt}`}
      ref={videoRef}
      className="h-full w-full object-contain"
      src={mediaUrl}
      poster={clip.media.provider === 'direct' ? clip.media.poster : undefined}
      crossOrigin={clip.media.provider === 'drive' ? 'anonymous' : undefined}
      controls
      controlsList="nodownload noremoteplayback"
      disablePictureInPicture
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={onReady}
      onLoadedData={onReady}
      onCanPlay={onReady}
      onError={onError}
    >
      Your browser cannot play this video.
    </video>
  );
}

export function Game() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [rounds, setRounds] = useState<Clip[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const toolStateRef = useRef<{
    phase: Phase;
    mediaReady: boolean;
    currentClip?: Clip;
    currentIndex: number;
    roundCount: number;
    startGame?: () => void;
    submitGuess?: (guess: Truth) => void;
    advance?: () => void;
  }>({
    phase: 'loading',
    mediaReady: false,
    currentIndex: 0,
    roundCount: 0,
  });

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(preference.matches);
    updatePreference();
    preference.addEventListener('change', updatePreference);
    return () => preference.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/clips.json', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Catalog;
      })
      .then((data) => {
        const clips = Array.isArray(data.clips)
          ? data.clips.filter((clip) => isClip(clip) && clip.enabled !== false)
          : [];
        if (!clips.length) {
          throw new Error('The catalog does not contain any active videos.');
        }
        setCatalog({ ...data, clips });
        setPhase('intro');
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setCatalogError(error.message);
        setPhase('error');
      });
    return () => controller.abort();
  }, []);

  const requestedRoundCount =
    catalog?.settings?.roundCount ?? DEFAULT_ROUND_COUNT;
  const currentClip = rounds[currentIndex];
  const canGuess = mediaReady && !mediaError;
  const currentAnswer = currentClip
    ? answers.find((answer) => answer.clipId === currentClip.id)
    : undefined;
  const score = answers.filter((answer) => answer.correct).length;

  useEffect(() => {
    if (!mediaReady || reducedMotion || phase !== 'playing') return;
    videoRef.current?.play().catch(() => {
      // Native controls remain available when autoplay is blocked.
    });
  }, [mediaReady, phase, reducedMotion]);

  useEffect(() => {
    if (phase !== 'playing' || mediaReady || mediaError) {
      return;
    }
    const timeout = window.setTimeout(() => setMediaError(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, [
    currentClip?.id,
    currentClip?.media.provider,
    mediaAttempt,
    mediaError,
    mediaReady,
    phase,
  ]);

  const startGame = useCallback(() => {
    if (!catalog) return;
    const nextRounds = buildRounds(catalog.clips, requestedRoundCount);
    setRounds(nextRounds);
    setAnswers([]);
    setCurrentIndex(0);
    setMediaReady(false);
    setMediaError(false);
    setMediaAttempt(0);
    setPhase('playing');
  }, [catalog, requestedRoundCount]);

  const submitGuess = useCallback(
    (guess: Truth) => {
      if (phase !== 'playing' || !canGuess || !currentClip) return;
      const correct = guess === currentClip.truth;
      setAnswers((previous) => [
        ...previous,
        {
          clipId: currentClip.id,
          guess,
          truth: currentClip.truth,
          correct,
        },
      ]);
      videoRef.current?.pause();
      setPhase('answered');
    },
    [canGuess, currentClip, phase],
  );

  const advance = useCallback(() => {
    if (phase !== 'answered') return;
    if (currentIndex >= rounds.length - 1) {
      setPhase('finished');
      return;
    }
    setCurrentIndex((index) => index + 1);
    setMediaReady(false);
    setMediaError(false);
    setMediaAttempt(0);
    setPhase('playing');
  }, [currentIndex, phase, rounds.length]);

  useEffect(() => {
    toolStateRef.current = {
      phase,
      mediaReady: canGuess,
      currentClip,
      currentIndex,
      roundCount: rounds.length,
      startGame,
      submitGuess,
      advance,
    };
  }, [
    advance,
    currentClip,
    currentIndex,
    canGuess,
    phase,
    rounds.length,
    startGame,
    submitGuess,
  ]);

  useEffect(() => {
    if (!catalog) return;
    const context = (
      document as Document & { readonly modelContext?: WebMcpContext }
    ).modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const afterPaint = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const register = (tool: WebMcpTool) => {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch((error) => console.error('WebMCP registration failed', error));
      } catch (error) {
        console.error('WebMCP registration failed', error);
      }
    };

    register({
      name: 'start_camera_or_ai_game',
      title: 'Start Real or Fake',
      description: 'Starts a new game and shows the first video in the test.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        const state = toolStateRef.current;
        if (!state.startGame) throw new Error('The catalog is not ready yet.');
        state.startGame();
        await afterPaint();
        return {
          status: 'started',
          roundCount: Math.min(requestedRoundCount, catalog.clips.length),
        };
      },
    });

    register({
      name: 'answer_camera_or_ai_round',
      title: 'Answer Real or Fake',
      description: 'Answers Real or Fake for the current video.',
      inputSchema: {
        type: 'object',
        properties: {
          guess: { type: 'string', enum: ['camera', 'ai'] },
        },
        required: ['guess'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const state = toolStateRef.current;
        const guess = (input as { guess?: unknown } | null)?.guess;
        if (guess !== 'camera' && guess !== 'ai') {
          throw new Error('The answer must be Real or Fake.');
        }
        if (
          state.phase !== 'playing' ||
          !state.mediaReady ||
          !state.currentClip ||
          !state.submitGuess
        ) {
          throw new Error('The current round is not ready for an answer yet.');
        }
        const truth = state.currentClip.truth;
        state.submitGuess(guess);
        await afterPaint();
        return {
          status: 'answered',
          correct: guess === truth,
          truth,
        };
      },
    });

    register({
      name: 'continue_camera_or_ai_game',
      title: 'Continue the game',
      description:
        'Moves to the next round after an answer or shows the final result.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        const state = toolStateRef.current;
        if (state.phase !== 'answered' || !state.advance) {
          throw new Error('Answer the current round first.');
        }
        const finished = state.currentIndex >= state.roundCount - 1;
        state.advance();
        await afterPaint();
        return { status: finished ? 'finished' : 'next_round' };
      },
    });

    return () => lifecycle.abort();
  }, [catalog, requestedRoundCount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'a, button, input, select, textarea, [contenteditable="true"]',
        )
      ) {
        return;
      }
      if (phase === 'playing' && canGuess) {
        if (event.key.toLowerCase() === 'r') submitGuess('camera');
        if (event.key.toLowerCase() === 'f') submitGuess('ai');
      } else if (phase === 'answered' && event.key === 'Enter') {
        advance();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance, canGuess, phase, submitGuess]);

  const retryMedia = () => {
    setMediaError(false);
    setMediaReady(false);
    setMediaAttempt((attempt) => attempt + 1);
  };

  const skipBrokenMedia = () => {
    const remainingRounds = rounds.filter((_, index) => index !== currentIndex);
    setRounds(remainingRounds);
    setMediaReady(false);
    setMediaError(false);
    setMediaAttempt(0);

    if (!remainingRounds.length) {
      setCurrentIndex(0);
      setPhase('intro');
    } else if (currentIndex >= remainingRounds.length) {
      setCurrentIndex(remainingRounds.length - 1);
      setPhase('finished');
    } else {
      setPhase('playing');
    }
  };

  return (
    <main className="site-shell min-h-dvh text-foreground">
      <div className="ambient-grid" aria-hidden="true" />
      <header className="relative z-10 mx-auto flex w-full max-w-[1180px] items-center border-b border-foreground/20 px-5 py-4 sm:px-8">
        <button
          type="button"
          onClick={() => catalog && phase !== 'loading' && setPhase('intro')}
          disabled={!catalog || phase === 'loading'}
          className="group flex items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          aria-label="Return to the start"
        >
          <span className="brand-mark grid size-10 place-items-center bg-primary text-primary-foreground transition-transform group-hover:-translate-y-0.5">
            <span aria-hidden="true">R/F</span>
          </span>
          <span className="text-sm font-black uppercase tracking-[-0.02em] text-foreground">
            Real or Fake?
          </span>
        </button>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-[1180px] flex-1 px-5 pb-8 sm:px-8 sm:pb-12">
        {phase === 'loading' && (
          <section
            className="game-card mx-auto mt-[8vh] w-full max-w-3xl p-6 sm:p-10"
            aria-live="polite"
          >
            <div className="mb-8 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Loading the
              collection
            </div>
            <Skeleton className="mb-5 h-16 w-4/5 bg-black/10" />
            <Skeleton className="mb-3 h-5 w-full bg-black/10" />
            <Skeleton className="h-5 w-2/3 bg-black/10" />
          </section>
        )}

        {phase === 'error' && (
          <section className="game-card mx-auto mt-[8vh] w-full max-w-2xl p-6 sm:p-10">
            <Alert
              variant="destructive"
              className="border-primary/40 bg-primary/5 p-5"
            >
              <TriangleAlert className="size-5" />
              <AlertTitle>The video collection could not be opened</AlertTitle>
              <AlertDescription>
                Check <code>public/clips.json</code>. Details: {catalogError}
              </AlertDescription>
            </Alert>
            <Button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 rounded-none bg-black text-white hover:bg-primary"
            >
              <RefreshCw /> Try again
            </Button>
          </section>
        )}

        {phase === 'intro' && catalog && (
          <section className="intro-layout mx-auto flex w-full max-w-[1040px] flex-col justify-center py-12">
            <h1 className="display-title max-w-[850px]">
              REAL
              <span className="title-slash" aria-hidden="true">
                /
              </span>
              <span className="text-primary">FAKE?</span>
            </h1>
            <Button
              size="lg"
              onClick={startGame}
              className="mt-10 h-14 w-full rounded-none border border-primary bg-primary px-8 text-base font-bold uppercase tracking-[0.08em] text-primary-foreground hover:border-black hover:bg-black sm:w-auto sm:self-start"
            >
              Start
            </Button>
          </section>
        )}

        {(phase === 'playing' || phase === 'answered') && currentClip && (
          <section className="game-workspace mx-auto w-full max-w-[1120px] pt-2 sm:pt-5">
            <div className="mb-4 flex items-end justify-between gap-4">
              <h1 className="text-2xl font-black uppercase tracking-[-0.035em] sm:text-3xl">
                {String(currentIndex + 1).padStart(2, '0')}
                <span className="text-muted-foreground">
                  {' '}
                  / {String(rounds.length).padStart(2, '0')}
                </span>
              </h1>
              <div className="score-box" aria-label={`Score: ${score}`}>
                <span>Score</span>
                <strong>{score.toString().padStart(2, '0')}</strong>
              </div>
            </div>

            <div className="grid overflow-hidden border border-foreground bg-card text-card-foreground lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
              <div className="relative border-b border-black/20 bg-[#070807] lg:border-r lg:border-b-0">
                <div className="aspect-video min-h-[220px] w-full sm:min-h-[360px]">
                  {!mediaReady && !mediaError && (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-[#090a09] text-white">
                      <div className="text-center">
                        <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" />
                        <p className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">
                          Loading video…
                        </p>
                      </div>
                    </div>
                  )}

                  {mediaError ? (
                    <div className="absolute inset-0 z-20 grid place-items-center bg-[#090a09] p-6 text-white">
                      <div className="max-w-sm text-center">
                        <TriangleAlert className="mx-auto mb-4 size-7 text-primary" />
                        <h2 className="text-xl font-bold">
                          This video did not load
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-white/60">
                          Check that the source is available and, for Drive,
                          shared publicly. Then try again.
                        </p>
                        <div className="mt-5 flex flex-wrap justify-center gap-3">
                          <Button
                            variant="outline"
                            onClick={retryMedia}
                            className="h-11 border-white/25 bg-white/5 text-white hover:bg-white/12 hover:text-white"
                          >
                            <RefreshCw /> Retry
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={skipBrokenMedia}
                            className="h-11 text-white/80 hover:bg-white/10 hover:text-white"
                          >
                            Skip without penalty
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <MediaStage
                      clip={currentClip}
                      attempt={mediaAttempt}
                      onReady={() => setMediaReady(true)}
                      onError={() => setMediaError(true)}
                      videoRef={videoRef}
                    />
                  )}

                  {phase === 'answered' && currentAnswer && (
                    <div className="verdict-layer" aria-hidden="true">
                      <span
                        className="verdict-stamp"
                        data-truth={currentClip.truth}
                      >
                        {currentClip.truth === 'camera' ? 'REAL' : 'FAKE'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <aside className="flex min-h-[360px] flex-col p-5 sm:p-7">
                {phase === 'playing' ? (
                  <div className="flex h-full flex-col justify-center">
                    <h2 className="text-3xl font-black uppercase leading-none tracking-[-0.05em]">
                      Real or Fake?
                    </h2>
                    <div className="mt-8 grid gap-3">
                      <Button
                        variant="outline"
                        disabled={!canGuess}
                        onClick={() => submitGuess('camera')}
                        className="choice-button"
                      >
                        <strong>Real</strong>
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!canGuess}
                        onClick={() => submitGuess('ai')}
                        className="choice-button"
                      >
                        <strong>Fake</strong>
                      </Button>
                    </div>
                  </div>
                ) : (
                  currentAnswer && (
                    <div className="flex h-full flex-col" aria-live="polite">
                      <div className="flex items-center gap-3">
                        <span
                          className="result-icon"
                          data-correct={currentAnswer.correct}
                        >
                          {currentAnswer.correct ? <Check /> : <X />}
                        </span>
                        <h2 className="text-2xl font-black uppercase tracking-[-0.035em]">
                          {currentAnswer.correct ? 'Correct' : 'Incorrect'}
                        </h2>
                      </div>

                      <div className="mt-6 border-y border-black/12 py-5">
                        <p className="text-2xl font-black uppercase tracking-[-0.035em]">
                          {currentClip.truth === 'camera' ? 'Real' : 'Fake'}
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-black/62">
                          {currentClip.provenance.detail}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-[0.08em] text-black/65">
                          {currentClip.provenance.model && (
                            <span>Model: {currentClip.provenance.model}</span>
                          )}
                          {currentClip.provenance.date && (
                            <span>Date: {currentClip.provenance.date}</span>
                          )}
                          {currentClip.provenance.license &&
                            (currentClip.provenance.licenseUrl ? (
                              <a
                                href={currentClip.provenance.licenseUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 underline decoration-black/25 underline-offset-4 hover:decoration-black"
                              >
                                License: {currentClip.provenance.license}
                                <ExternalLink className="size-3" />
                              </a>
                            ) : (
                              <span>
                                License: {currentClip.provenance.license}
                              </span>
                            ))}
                        </div>
                        {currentClip.provenance.sourceUrl && (
                          <a
                            href={currentClip.provenance.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold underline decoration-black/25 underline-offset-4 hover:decoration-black"
                          >
                            {currentClip.provenance.sourceName ?? 'View source'}{' '}
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </div>

                      <Button
                        onClick={advance}
                        className="mt-auto h-13 rounded-none bg-black px-5 text-sm font-bold uppercase tracking-[0.08em] text-white hover:bg-black/82"
                      >
                        {currentIndex === rounds.length - 1 ? 'Score' : 'Next'}
                        <ArrowRight data-icon="inline-end" />
                      </Button>
                    </div>
                  )
                )}
              </aside>
            </div>
          </section>
        )}

        {phase === 'finished' && (
          <section className="result-layout mx-auto flex w-full max-w-[900px] flex-col justify-center py-12">
            <div className="final-score border-y border-foreground/20 py-10">
              <strong>{score}</strong>
              <span>/ {rounds.length}</span>
            </div>
            <Button
              size="lg"
              onClick={startGame}
              className="mt-8 h-13 rounded-none bg-primary px-6 font-bold uppercase tracking-[0.08em] text-primary-foreground hover:bg-black sm:self-start"
            >
              <RotateCcw /> Play again
            </Button>
          </section>
        )}
      </div>
    </main>
  );
}
