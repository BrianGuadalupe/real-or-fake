'use client';

import {
  Aperture,
  ArrowRight,
  Check,
  ExternalLink,
  Film,
  Info,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type Truth = 'camera' | 'ai';
type Phase = 'loading' | 'intro' | 'playing' | 'answered' | 'finished' | 'error';

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
        return {
          embedUrl: embedUrl.toString(),
          openUrl:
            media.shareUrl ?? embedUrl.toString().replace('/preview', '/view'),
        };
      }
    } catch {
      return null;
    }
  }

  if (!fileId) return null;

  const encodedId = encodeURIComponent(fileId);
  const suffix = resourceKey
    ? `?resourcekey=${encodeURIComponent(resourceKey)}`
    : '';

  return {
    embedUrl: `https://drive.google.com/file/d/${encodedId}/preview${suffix}`,
    openUrl:
      media.shareUrl ?? `https://drive.google.com/file/d/${encodedId}/view${suffix}`,
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

  if (clip.media.provider === 'drive') {
    if (!driveDetails) return null;
    return (
      <iframe
        key={`${clip.id}-${attempt}`}
        className="h-full w-full border-0"
        src={driveDetails.embedUrl}
        title="Vídeo de esta ronda"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={onReady}
      />
    );
  }

  return (
    <video
      key={`${clip.id}-${attempt}`}
      ref={videoRef}
      className="h-full w-full object-contain"
      src={clip.media.url}
      poster={clip.media.poster}
      controls
      controlsList="nodownload"
      muted
      playsInline
      preload="metadata"
      onLoadedData={onReady}
      onCanPlay={onReady}
      onError={onError}
    >
      Tu navegador no puede reproducir este vídeo.
    </video>
  );
}

function Filmstrip({
  rounds,
  answers,
  currentIndex,
  phase,
}: {
  rounds: Clip[];
  answers: Answer[];
  currentIndex: number;
  phase: Phase;
}) {
  return (
    <div
      className="filmstrip"
      aria-label={`Progreso: ${answers.length} de ${rounds.length}`}
    >
      {rounds.map((round, index) => {
        const answer = answers.find((item) => item.clipId === round.id);
        const isCurrent = index === currentIndex && phase !== 'finished';
        const status = answer
          ? answer.correct
            ? 'correct'
            : 'wrong'
          : isCurrent
            ? 'current'
            : 'pending';
        return (
          <span
            key={`${round.id}-${index}`}
            className="filmstrip-frame"
            data-status={status}
            aria-hidden="true"
          >
            {answer ? (
              answer.correct ? (
                <Check />
              ) : (
                <X />
              )
            ) : (
              String(index + 1).padStart(2, '0')
            )}
          </span>
        );
      })}
    </div>
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
  const nextButtonRef = useRef<HTMLButtonElement | null>(null);
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
          throw new Error('El catálogo no contiene vídeos activos.');
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
  const currentAnswer = currentClip
    ? answers.find((answer) => answer.clipId === currentClip.id)
    : undefined;
  const score = answers.filter((answer) => answer.correct).length;
  const isDemo = Boolean(catalog?.clips.some((clip) => clip.demo));

  const cameraStats = useMemo(() => {
    const cameraAnswers = answers.filter((answer) => answer.truth === 'camera');
    return {
      correct: cameraAnswers.filter((answer) => answer.correct).length,
      total: cameraAnswers.length,
    };
  }, [answers]);

  const aiStats = useMemo(() => {
    const aiAnswers = answers.filter((answer) => answer.truth === 'ai');
    return {
      correct: aiAnswers.filter((answer) => answer.correct).length,
      total: aiAnswers.length,
    };
  }, [answers]);

  useEffect(() => {
    if (phase === 'answered') nextButtonRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!mediaReady || reducedMotion || phase !== 'playing') return;
    videoRef.current?.play().catch(() => {
      // Native controls remain available when autoplay is blocked.
    });
  }, [mediaReady, phase, reducedMotion]);

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
      if (phase !== 'playing' || !mediaReady || !currentClip) return;
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
    [currentClip, mediaReady, phase],
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
      mediaReady,
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
    mediaReady,
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
        ).catch((error) => console.error('No se pudo registrar WebMCP', error));
      } catch (error) {
        console.error('No se pudo registrar WebMCP', error);
      }
    };

    register({
      name: 'start_camera_or_ai_game',
      title: 'Empezar Cámara o IA',
      description:
        'Inicia una partida nueva y muestra el primer vídeo del juego.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        const state = toolStateRef.current;
        if (!state.startGame) throw new Error('El catálogo todavía no está listo.');
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
      title: 'Responder la ronda',
      description:
        'Responde si el vídeo actual fue grabado con cámara o generado con IA.',
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
          throw new Error('guess debe ser "camera" o "ai".');
        }
        if (
          state.phase !== 'playing' ||
          !state.mediaReady ||
          !state.currentClip ||
          !state.submitGuess
        ) {
          throw new Error('La ronda todavía no está lista para responder.');
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
      title: 'Continuar la partida',
      description:
        'Avanza a la siguiente ronda después de responder o muestra el resultado final.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        const state = toolStateRef.current;
        if (state.phase !== 'answered' || !state.advance) {
          throw new Error('Primero hay que responder la ronda actual.');
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
      if (phase === 'playing' && mediaReady) {
        if (event.key.toLowerCase() === 'c') submitGuess('camera');
        if (event.key.toLowerCase() === 'i') submitGuess('ai');
      } else if (phase === 'answered' && event.key === 'Enter') {
        advance();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance, mediaReady, phase, submitGuess]);

  const retryMedia = () => {
    setMediaError(false);
    setMediaReady(false);
    setMediaAttempt((attempt) => attempt + 1);
  };

  const skipBrokenMedia = () => {
    if (currentIndex >= rounds.length - 1) {
      setPhase('finished');
      return;
    }
    setCurrentIndex((index) => index + 1);
    setMediaReady(false);
    setMediaError(false);
    setMediaAttempt(0);
    setPhase('playing');
  };

  const resultMessage =
    score >= Math.ceil(rounds.length * 0.8)
      ? 'Tienes el ojo muy entrenado.'
      : score >= Math.ceil(rounds.length * 0.4)
        ? 'Buen ojo, aunque algunos vídeos engañan.'
        : 'La frontera ya no es tan evidente.';

  return (
    <main className="site-shell min-h-dvh text-foreground">
      <div className="ambient-grid" aria-hidden="true" />
      <header className="relative z-10 mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-5 sm:px-8 sm:py-7">
        <button
          type="button"
          onClick={() => phase !== 'loading' && setPhase('intro')}
          className="group flex items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          aria-label="Volver al inicio"
        >
          <span className="grid size-10 place-items-center border border-primary/50 bg-primary text-primary-foreground shadow-[4px_4px_0_#f3f0e8] transition-transform group-hover:-translate-y-0.5">
            <Aperture className="size-5" strokeWidth={2.4} />
          </span>
          <span>
            <span className="block font-mono text-[0.66rem] font-semibold uppercase tracking-[0.24em] text-primary">
              Prueba visual
            </span>
            <span className="block text-sm font-semibold tracking-tight text-foreground">
              Cámara / IA
            </span>
          </span>
        </button>
        <span className="hidden items-center gap-2 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground sm:flex">
          <span className="status-dot" /> Procedencia verificada
        </span>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-[1180px] flex-1 px-5 pb-8 sm:px-8 sm:pb-12">
        {phase === 'loading' && (
          <section
            className="game-card mx-auto mt-[8vh] w-full max-w-3xl p-6 sm:p-10"
            aria-live="polite"
          >
            <div className="mb-8 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Preparando el
              catálogo
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
              className="border-[#c84d42]/40 bg-[#fff7f2] p-5"
            >
              <TriangleAlert className="size-5" />
              <AlertTitle>No se pudo abrir el catálogo</AlertTitle>
              <AlertDescription>
                Revisa <code>public/clips.json</code>. Detalle: {catalogError}
              </AlertDescription>
            </Alert>
          </section>
        )}

        {phase === 'intro' && catalog && (
          <section className="intro-layout mx-auto w-full max-w-[1040px] pt-[clamp(1.5rem,6vh,5rem)]">
            <div className="relative">
              <p className="eyebrow mb-4">10 decisiones · una sola mirada</p>
              <h1 className="display-title max-w-[850px]">
                ¿CÁMARA
                <span className="title-slash" aria-hidden="true">
                  /
                </span>
                <span className="text-primary">IA?</span>
              </h1>
              <div className="mt-7 grid gap-6 border-t border-foreground/20 pt-6 md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <p className="max-w-2xl text-lg leading-relaxed text-foreground/78 sm:text-xl">
                    Mira cada vídeo y decide cómo nació. La procedencia se revela
                    solo después de votar.
                  </p>
                  <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                    Esto es un juego educativo, no un detector de vídeos
                    desconocidos.
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={startGame}
                  className="h-14 w-full rounded-none border border-primary bg-primary px-7 text-base font-bold uppercase tracking-[0.08em] text-primary-foreground shadow-[6px_6px_0_#f3f0e8] hover:bg-[#e5ff83] md:w-auto"
                >
                  <Play
                    data-icon="inline-start"
                    className="size-5 fill-current"
                  />
                  Empezar
                </Button>
              </div>
            </div>

            <div className="mt-10 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-3">
              <div className="intro-stat">
                <span>Rondas</span>
                <strong>
                  {Math.min(requestedRoundCount, catalog.clips.length)
                    .toString()
                    .padStart(2, '0')}
                </strong>
              </div>
              <div className="intro-stat">
                <span>Vídeos activos</span>
                <strong>
                  {catalog.clips.length.toString().padStart(2, '0')}
                </strong>
              </div>
              <div className="intro-stat">
                <span>Formato</span>
                <strong className="text-[1.1rem]">CÁMARA / IA</strong>
              </div>
            </div>

            {isDemo && catalog.clips.length < requestedRoundCount && (
              <div className="demo-note mt-5">
                <Film className="size-4" />
                <span>
                  Modo demostración: añade tus vídeos en{' '}
                  <code>public/clips.json</code> para completar las 10 rondas.
                </span>
              </div>
            )}
          </section>
        )}

        {(phase === 'playing' || phase === 'answered') && currentClip && (
          <section className="game-workspace mx-auto w-full max-w-[1120px] pt-2 sm:pt-5">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <p className="eyebrow">
                  Analiza el movimiento, no el archivo
                </p>
                <h1 className="mt-1 text-2xl font-black uppercase tracking-[-0.035em] sm:text-3xl">
                  Ronda {currentIndex + 1}
                  <span className="text-muted-foreground">
                    {' '}
                    / {rounds.length}
                  </span>
                </h1>
              </div>
              <div className="score-box" aria-label={`Puntuación: ${score}`}>
                <span>Aciertos</span>
                <strong>{score.toString().padStart(2, '0')}</strong>
              </div>
            </div>

            <Filmstrip
              rounds={rounds}
              answers={answers}
              currentIndex={currentIndex}
              phase={phase}
            />

            <div className="mt-4 grid overflow-hidden border border-foreground/20 bg-card text-card-foreground shadow-[10px_10px_0_rgb(0_0_0/28%)] lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
              <div className="relative border-b border-black/20 bg-[#070807] lg:border-r lg:border-b-0">
                <div className="aspect-video min-h-[220px] w-full sm:min-h-[360px]">
                  {!mediaReady && !mediaError && (
                    <div className="absolute inset-0 z-10 grid place-items-center bg-[#090a09] text-white">
                      <div className="text-center">
                        <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" />
                        <p className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">
                          Preparando vídeo…
                        </p>
                      </div>
                    </div>
                  )}

                  {mediaError ? (
                    <div className="absolute inset-0 z-20 grid place-items-center bg-[#090a09] p-6 text-white">
                      <div className="max-w-sm text-center">
                        <TriangleAlert className="mx-auto mb-4 size-7 text-[#ff7668]" />
                        <h2 className="text-xl font-bold">
                          No hemos podido cargarlo
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-white/60">
                          Comprueba que el archivo sea público y vuelve a
                          intentarlo.
                        </p>
                        <div className="mt-5 flex flex-wrap justify-center gap-3">
                          <Button
                            variant="outline"
                            onClick={retryMedia}
                            className="h-11 border-white/25 bg-white/5 text-white hover:bg-white/12 hover:text-white"
                          >
                            <RefreshCw /> Reintentar
                          </Button>
                          {rounds.length > 1 && (
                            <Button
                              variant="ghost"
                              onClick={skipBrokenMedia}
                              className="h-11 text-white/70 hover:bg-white/10 hover:text-white"
                            >
                              Saltar sin penalización
                            </Button>
                          )}
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
                        {currentClip.truth === 'camera' ? (
                          <Aperture />
                        ) : (
                          <Sparkles />
                        )}
                        {currentClip.truth === 'camera' ? 'CÁMARA' : 'IA'}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex min-h-11 items-center justify-between gap-3 border-t border-white/10 px-4 py-2 font-mono text-[0.68rem] uppercase tracking-[0.13em] text-white/48">
                  <span>
                    {currentClip.media.provider === 'drive'
                      ? 'Google Drive · reproductor insertado'
                      : 'Fuente directa · MP4/WebM'}
                  </span>
                  {currentClip.media.provider === 'drive' &&
                    getDriveDetails(currentClip.media) && (
                      <a
                        href={getDriveDetails(currentClip.media)?.openUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-white/70 underline decoration-white/25 underline-offset-4 hover:text-primary"
                      >
                        Abrir vídeo <ExternalLink className="size-3" />
                      </a>
                    )}
                </div>
              </div>

              <aside className="flex min-h-[360px] flex-col p-5 sm:p-7">
                {phase === 'playing' ? (
                  <>
                    <div>
                      <p className="font-mono text-[0.7rem] font-bold uppercase tracking-[0.18em] text-black/45">
                        Tu veredicto
                      </p>
                      <h2 className="mt-2 text-2xl font-black leading-tight tracking-[-0.035em]">
                        ¿Cómo se creó?
                      </h2>
                      <p className="mt-2 text-sm leading-relaxed text-black/58">
                        Reproduce el clip antes de elegir. No podrás cambiar la
                        respuesta.
                      </p>
                    </div>

                    <div className="mt-7 grid gap-3">
                      <Button
                        variant="outline"
                        disabled={!mediaReady || mediaError}
                        onClick={() => submitGuess('camera')}
                        className="choice-button"
                      >
                        <span className="choice-icon">
                          <Aperture />
                        </span>
                        <span className="text-left">
                          <strong>Grabado</strong>
                          <small>Cámara · tecla C</small>
                        </span>
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!mediaReady || mediaError}
                        onClick={() => submitGuess('ai')}
                        className="choice-button"
                      >
                        <span className="choice-icon">
                          <Sparkles />
                        </span>
                        <span className="text-left">
                          <strong>Generado</strong>
                          <small>Inteligencia artificial · tecla I</small>
                        </span>
                      </Button>
                    </div>

                    <p className="mt-auto pt-6 text-xs leading-relaxed text-black/43">
                      La resolución, el audio y los nombres de archivo no
                      deberían revelar la respuesta.
                    </p>
                  </>
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
                        <div>
                          <p className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.17em] text-black/40">
                            Resultado
                          </p>
                          <h2 className="text-2xl font-black tracking-[-0.035em]">
                            {currentAnswer.correct
                              ? '¡Acertaste!'
                              : 'No esta vez'}
                          </h2>
                        </div>
                      </div>

                      <div className="mt-6 border-y border-black/12 py-5">
                        <p className="font-mono text-[0.66rem] font-bold uppercase tracking-[0.16em] text-black/40">
                          Procedencia
                        </p>
                        <p className="mt-2 text-xl font-black">
                          {currentClip.provenance.label}
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-black/62">
                          {currentClip.provenance.detail}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[0.68rem] uppercase tracking-[0.08em] text-black/50">
                          {currentClip.provenance.model && (
                            <span>Modelo: {currentClip.provenance.model}</span>
                          )}
                          {currentClip.provenance.date && (
                            <span>Fecha: {currentClip.provenance.date}</span>
                          )}
                          {currentClip.provenance.license && (
                            <span>
                              Licencia: {currentClip.provenance.license}
                            </span>
                          )}
                        </div>
                        {currentClip.provenance.sourceUrl && (
                          <a
                            href={currentClip.provenance.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold underline decoration-black/25 underline-offset-4 hover:decoration-black"
                          >
                            {currentClip.provenance.sourceName ??
                              'Consultar la fuente'}{' '}
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </div>

                      <Button
                        ref={nextButtonRef}
                        onClick={advance}
                        className="mt-auto h-13 rounded-none bg-black px-5 text-sm font-bold uppercase tracking-[0.08em] text-white hover:bg-black/82"
                      >
                        {currentIndex === rounds.length - 1
                          ? 'Ver resultado'
                          : 'Siguiente vídeo'}
                        <ArrowRight data-icon="inline-end" />
                      </Button>
                      <span className="mt-2 text-center font-mono text-[0.62rem] uppercase tracking-[0.12em] text-black/35">
                        También puedes pulsar Enter
                      </span>
                    </div>
                  )
                )}
              </aside>
            </div>
          </section>
        )}

        {phase === 'finished' && (
          <section className="result-layout mx-auto w-full max-w-[900px] pt-[clamp(1.5rem,7vh,5rem)]">
            <p className="eyebrow">Prueba completada</p>
            <div className="mt-3 grid gap-7 border-y border-foreground/20 py-8 md:grid-cols-[auto_1fr] md:items-end md:gap-12">
              <div className="final-score">
                <strong>{score}</strong>
                <span>/ {rounds.length}</span>
              </div>
              <div className="pb-2">
                <h1 className="text-4xl font-black uppercase leading-none tracking-[-0.055em] sm:text-5xl">
                  {resultMessage}
                </h1>
                <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
                  Juzgar a simple vista no prueba el origen de un vídeo. La
                  procedencia documentada es una señal más fiable.
                </p>
              </div>
            </div>

            <div className="mt-6 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-3">
              <div className="result-stat">
                <span>Total</span>
                <strong>
                  {score} / {rounds.length}
                </strong>
              </div>
              <div className="result-stat">
                <span>Cámara</span>
                <strong>
                  {cameraStats.total
                    ? `${cameraStats.correct} / ${cameraStats.total}`
                    : '—'}
                </strong>
              </div>
              <div className="result-stat">
                <span>IA</span>
                <strong>
                  {aiStats.total ? `${aiStats.correct} / ${aiStats.total}` : '—'}
                </strong>
              </div>
            </div>

            <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <Button
                size="lg"
                onClick={startGame}
                className="h-13 rounded-none bg-primary px-6 font-bold uppercase tracking-[0.08em] text-primary-foreground shadow-[5px_5px_0_#f3f0e8] hover:bg-[#e5ff83]"
              >
                <RotateCcw /> Jugar otra vez
              </Button>
              <button
                type="button"
                onClick={() => setPhase('intro')}
                className="text-sm font-semibold text-muted-foreground underline decoration-foreground/25 underline-offset-4 hover:text-foreground"
              >
                Volver al inicio
              </button>
            </div>
          </section>
        )}
      </div>

      <footer className="relative z-10 mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4 border-t border-foreground/12 px-5 py-4 font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground sm:px-8">
        <span>La respuesta se basa en la procedencia conocida</span>
        <span className="hidden sm:inline">v1.0</span>
      </footer>
    </main>
  );
}
