import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const maxDuration = 6.5;
const maxOutputBytes = 4 * 1024 * 1024;
const videoExtensions = new Set([
  '.3gp',
  '.avi',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.webm',
]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--'))
      throw new Error(`Unknown argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function normalizeMode(value) {
  const mode = (value || 'fake').toLowerCase();
  if (mode === 'fake' || mode === 'ai') return 'ai';
  if (mode === 'real' || mode === 'camera') return 'camera';
  if (mode === 'subfolders' || mode === 'categorized') return 'subfolders';
  throw new Error('Folder mode must be fake, real, or subfolders.');
}

function normalizeDriveFolder(value) {
  if (!value) throw new Error('A Google Drive folder URL is required.');
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) {
    return `https://drive.google.com/drive/folders/${value}`;
  }

  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') {
    throw new Error('The folder must use an https://drive.google.com URL.');
  }
  const match = url.pathname.match(
    /\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/,
  );
  if (!match)
    throw new Error(
      'The Google Drive folder ID could not be read from the URL.',
    );
  return `https://drive.google.com/drive/folders/${match[1]}`;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(
      `${executable} exited with code ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return options.capture ? result.stdout : '';
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function probeVideo(ffprobe, filePath) {
  const output = run(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ],
    { capture: true },
  );
  const probe = JSON.parse(output);
  const duration = Number.parseFloat(probe.format?.duration);
  if (
    !probe.streams?.some((stream) => stream.codec_type === 'video') ||
    !Number.isFinite(duration)
  ) {
    throw new Error(`No playable video stream found in ${filePath}.`);
  }
  return { duration };
}

function truthForPath(mode, relativePath) {
  if (mode !== 'subfolders') return mode;
  const categories = new Set(
    relativePath
      .split('/')
      .map((part) => part.toLowerCase())
      .filter((part) => part === 'real' || part === 'fake'),
  );
  if (categories.size !== 1) {
    throw new Error(
      `${relativePath} must be inside exactly one subfolder named Real or Fake.`,
    );
  }
  return categories.has('real') ? 'camera' : 'ai';
}

function assetPath(publicRoot, value) {
  if (typeof value !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(value))
    return null;
  const normalized = path.posix.normalize(value.split(/[?#]/, 1)[0]);
  if (
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.startsWith('/')
  )
    return null;
  const absolute = path.resolve(publicRoot, ...normalized.split('/'));
  if (!absolute.startsWith(`${publicRoot}${path.sep}`)) return null;
  return absolute;
}

async function transcode({ ffmpeg, input, output, poster, duration }) {
  const start = Math.max(0, (duration - maxDuration) / 2);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0.05) args.push('-ss', start.toFixed(3));
  args.push(
    '-i',
    input,
    '-t',
    maxDuration.toString(),
    '-map',
    '0:v:0',
    '-vf',
    "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '23',
    '-maxrate',
    '2500k',
    '-bufsize',
    '5000k',
    '-profile:v',
    'high',
    '-level:v',
    '4.0',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-keyint_min',
    '48',
    '-sc_threshold',
    '0',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    '-y',
    output,
  );
  run(ffmpeg, args);

  run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    '0.3',
    '-i',
    output,
    '-frames:v',
    '1',
    '-vf',
    "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v',
    'libwebp',
    '-quality',
    '72',
    '-compression_level',
    '6',
    '-y',
    poster,
  ]);

  const outputInfo = await stat(output);
  if (outputInfo.size <= 0 || outputInfo.size > maxOutputBytes) {
    throw new Error(`${path.basename(input)} exceeds the 4 MiB output budget.`);
  }
}

const options = parseArguments(process.argv.slice(2));
const publicRoot = path.resolve(
  options.public ?? process.env.PUBLIC_DIR ?? 'public',
);
const catalogPath = path.join(publicRoot, 'clips.json');
const mode = normalizeMode(options.mode ?? process.env.DRIVE_FOLDER_MODE);
const sourceDirectoryOption = options['source-directory'];
const folderUrl = sourceDirectoryOption
  ? (options.folder ??
    process.env.DRIVE_FOLDER_URL ??
    'https://drive.google.com/drive/folders/local-preview')
  : normalizeDriveFolder(options.folder ?? process.env.DRIVE_FOLDER_URL);
const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = options.ffprobe ?? process.env.FFPROBE_PATH ?? 'ffprobe';
const gdown = options.gdown ?? process.env.GDOWN_PATH ?? 'gdown';
const stagingRoot = await mkdtemp(path.join(tmpdir(), 'real-fake-drive-'));

try {
  const sourceRoot = sourceDirectoryOption
    ? path.resolve(sourceDirectoryOption)
    : path.join(stagingRoot, 'download');

  if (!sourceDirectoryOption) {
    await mkdir(sourceRoot, { recursive: true });
    run(gdown, [
      folderUrl,
      '--folder',
      '--quiet',
      '--output',
      `${sourceRoot}${path.sep}`,
    ]);
  }

  const sourceFiles = (await walk(sourceRoot)).sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }),
  );
  const candidates = [];
  for (const filePath of sourceFiles) {
    if (!videoExtensions.has(path.extname(filePath).toLowerCase())) continue;
    const relativePath = path
      .relative(sourceRoot, filePath)
      .split(path.sep)
      .join('/');
    const probe = probeVideo(ffprobe, filePath);
    candidates.push({
      filePath,
      relativePath,
      truth: truthForPath(mode, relativePath),
      duration: probe.duration,
    });
  }
  if (candidates.length === 0)
    throw new Error('The selected folder contains no supported videos.');

  const generatedVideoDir = path.join(stagingRoot, 'videos');
  const generatedPosterDir = path.join(stagingRoot, 'posters');
  await mkdir(generatedVideoDir, { recursive: true });
  await mkdir(generatedPosterDir, { recursive: true });

  const generatedClips = [];
  const seenHashes = new Set();
  for (const [index, candidate] of candidates.entries()) {
    const hash = await hashFile(candidate.filePath);
    if (seenHashes.has(hash)) {
      console.log(`Skipping duplicate: ${candidate.relativePath}`);
      continue;
    }
    seenHashes.add(hash);
    const shortHash = hash.slice(0, 12);
    const baseName = `clip-${shortHash}`;
    const videoName = `${baseName}.mp4`;
    const posterName = `${baseName}.webp`;
    const output = path.join(generatedVideoDir, videoName);
    const poster = path.join(generatedPosterDir, posterName);
    console.log(
      `Optimizing ${index + 1}/${candidates.length}: ${candidate.relativePath}`,
    );
    await transcode({
      ffmpeg,
      ffprobe,
      input: candidate.filePath,
      output,
      poster,
      duration: candidate.duration,
    });

    const isCamera = candidate.truth === 'camera';
    generatedClips.push({
      id: `drive-${shortHash}`,
      enabled: true,
      truth: candidate.truth,
      media: {
        provider: 'direct',
        url: `videos/drive/${videoName}`,
        poster: `posters/drive/${posterName}`,
      },
      provenance: {
        label: isCamera ? 'Shot on camera' : 'Generated by AI',
        detail: 'Imported from the selected Google Drive collection.',
        sourceName: `Google Drive · ${path.basename(candidate.relativePath)}`,
        sourceUrl: folderUrl,
      },
    });
  }

  const existingCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const existingClips = Array.isArray(existingCatalog.clips)
    ? existingCatalog.clips.filter((clip) => clip?.enabled !== false)
    : [];
  const retainedClips =
    mode === 'subfolders'
      ? []
      : existingClips.filter((clip) => clip.truth !== mode);
  const removedClips = existingClips.filter(
    (clip) => !retainedClips.includes(clip),
  );
  const nextClips = [...retainedClips, ...generatedClips];
  if (
    !nextClips.some((clip) => clip.truth === 'camera') ||
    !nextClips.some((clip) => clip.truth === 'ai')
  ) {
    throw new Error(
      'The resulting game needs at least one Real and one Fake video.',
    );
  }

  for (const clip of retainedClips) {
    if (clip.media?.url?.startsWith('videos/drive/')) {
      const retainedVideo = assetPath(publicRoot, clip.media.url);
      if (retainedVideo) {
        await copyFile(
          retainedVideo,
          path.join(generatedVideoDir, path.basename(retainedVideo)),
        );
      }
    }
    if (clip.media?.poster?.startsWith('posters/drive/')) {
      const retainedPoster = assetPath(publicRoot, clip.media.poster);
      if (retainedPoster) {
        await copyFile(
          retainedPoster,
          path.join(generatedPosterDir, path.basename(retainedPoster)),
        );
      }
    }
  }

  const targetVideoDir = path.join(publicRoot, 'videos', 'drive');
  const targetPosterDir = path.join(publicRoot, 'posters', 'drive');
  await rm(targetVideoDir, { recursive: true, force: true });
  await rm(targetPosterDir, { recursive: true, force: true });
  await mkdir(targetVideoDir, { recursive: true });
  await mkdir(targetPosterDir, { recursive: true });
  for (const filePath of await walk(generatedVideoDir)) {
    await copyFile(
      filePath,
      path.join(targetVideoDir, path.basename(filePath)),
    );
  }
  for (const filePath of await walk(generatedPosterDir)) {
    await copyFile(
      filePath,
      path.join(targetPosterDir, path.basename(filePath)),
    );
  }

  const nextCatalog = {
    ...existingCatalog,
    version: 3,
    settings: { ...existingCatalog.settings, roundCount: nextClips.length },
    clips: nextClips,
  };
  const temporaryCatalogPath = `${catalogPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryCatalogPath,
    `${JSON.stringify(nextCatalog, null, 2)}\n`,
    'utf8',
  );
  await rename(temporaryCatalogPath, catalogPath);

  const retainedAssets = new Set(
    nextClips
      .flatMap((clip) => [clip.media?.url, clip.media?.poster])
      .filter(Boolean),
  );
  for (const clip of removedClips) {
    for (const value of [clip.media?.url, clip.media?.poster]) {
      if (!value || retainedAssets.has(value)) continue;
      const filePath = assetPath(publicRoot, value);
      if (filePath) await rm(filePath, { force: true });
    }
  }

  console.log(
    `Drive sync complete: ${generatedClips.length} imported, ${retainedClips.length} retained, ${nextClips.length} total.`,
  );
} finally {
  const safePrefix = `${path.resolve(tmpdir())}${path.sep}`;
  if (
    stagingRoot.startsWith(safePrefix) &&
    path.basename(stagingRoot).startsWith('real-fake-drive-')
  ) {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
