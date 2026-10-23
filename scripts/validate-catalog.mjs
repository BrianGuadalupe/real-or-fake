import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? 'public');
const catalogPath = path.join(root, 'clips.json');
const maxVideoBytes = 4 * 1024 * 1024;
const maxPosterBytes = 200 * 1024;
const maxPublishedVideoBytes = 750 * 1024 * 1024;
const errors = [];

function report(condition, message) {
  if (!condition) errors.push(message);
}

function resolveAsset(value, expectedDirectory, label) {
  report(typeof value === 'string' && value.length > 0, `${label} is missing.`);
  if (typeof value !== 'string' || value.length === 0) return null;

  report(
    !/^[a-z][a-z\d+.-]*:/i.test(value),
    `${label} must be a relative URL.`,
  );
  report(
    !value.startsWith('/') && !value.startsWith('//'),
    `${label} must not start with a slash.`,
  );

  const pathname = value.split(/[?#]/, 1)[0];
  const normalized = path.posix.normalize(pathname);
  report(
    normalized === expectedDirectory ||
      normalized.startsWith(`${expectedDirectory}/`),
    `${label} must be inside ${expectedDirectory}/.`,
  );
  report(
    !normalized.startsWith('../') && normalized !== '..',
    `${label} escapes the public directory.`,
  );

  const absolute = path.resolve(root, ...normalized.split('/'));
  report(
    absolute === root || absolute.startsWith(`${root}${path.sep}`),
    `${label} resolves outside the public directory.`,
  );
  return { absolute, normalized };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function inspectMp4(filePath, label) {
  const file = await open(filePath, 'r');
  try {
    const fileInfo = await file.stat();
    const header = Buffer.alloc(Math.min(fileInfo.size, 2 * 1024 * 1024));
    await file.read(header, 0, header.length, 0);
    const moov = header.indexOf('moov', 0, 'ascii');
    const mdat = header.indexOf('mdat', 0, 'ascii');
    report(
      header.indexOf('ftyp', 0, 'ascii') >= 0,
      `${label} is not an MP4 file.`,
    );
    report(
      header.indexOf('avc1', 0, 'ascii') >= 0,
      `${label} is not encoded as H.264.`,
    );
    report(moov >= 0, `${label} has no early moov atom.`);
    report(mdat >= 0, `${label} has no early mdat atom.`);
    report(
      moov >= 0 && mdat >= 0 && moov < mdat,
      `${label} is missing faststart.`,
    );
    return fileInfo.size;
  } finally {
    await file.close();
  }
}

let catalog;
try {
  catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
} catch (error) {
  console.error(`Could not read ${catalogPath}: ${error.message}`);
  process.exit(1);
}

const clips = Array.isArray(catalog.clips)
  ? catalog.clips.filter((clip) => clip?.enabled !== false)
  : [];

report(clips.length > 0, 'The catalog must contain at least one active clip.');
report(
  catalog.settings?.roundCount === clips.length,
  'settings.roundCount must match the number of active clips.',
);

const ids = new Set();
const urls = new Set();
const referencedVideos = new Set();
const truths = new Set();
let totalVideoBytes = 0;

for (const [index, clip] of clips.entries()) {
  const label = `clips[${index}]`;
  report(
    typeof clip?.id === 'string' && clip.id.length > 0,
    `${label}.id is missing.`,
  );
  report(!ids.has(clip?.id), `${label}.id is duplicated: ${clip?.id}`);
  ids.add(clip?.id);

  report(
    clip?.truth === 'camera' || clip?.truth === 'ai',
    `${label}.truth must be camera or ai.`,
  );
  truths.add(clip?.truth);
  report(
    clip?.media?.provider === 'direct',
    `${label}.media.provider must be direct.`,
  );

  const video = resolveAsset(clip?.media?.url, 'videos', `${label}.media.url`);
  if (video) {
    report(
      !urls.has(video.normalized),
      `${label}.media.url is duplicated: ${video.normalized}`,
    );
    urls.add(video.normalized);
    referencedVideos.add(path.normalize(video.absolute));
    report(
      !/(^|[-_.])(real|fake|ai)([-_.]|$)/i.test(
        path.basename(video.normalized),
      ),
      `${label} reveals its answer in the filename.`,
    );
    report(
      path.extname(video.normalized).toLowerCase() === '.mp4',
      `${label} must use an MP4 video.`,
    );
    try {
      const size = await inspectMp4(video.absolute, label);
      totalVideoBytes += size;
      report(
        size > 0 && size <= maxVideoBytes,
        `${label} exceeds the 4 MiB video budget.`,
      );
    } catch (error) {
      errors.push(`${label} video is unavailable: ${error.message}`);
    }
  }

  const poster = resolveAsset(
    clip?.media?.poster,
    'posters',
    `${label}.media.poster`,
  );
  if (poster) {
    report(
      path.extname(poster.normalized).toLowerCase() === '.webp',
      `${label} poster must use WebP.`,
    );
    try {
      const posterInfo = await stat(poster.absolute);
      report(
        posterInfo.size > 0 && posterInfo.size <= maxPosterBytes,
        `${label} poster exceeds 200 KiB.`,
      );
    } catch (error) {
      errors.push(`${label} poster is unavailable: ${error.message}`);
    }
  }
}

report(truths.has('camera'), 'The catalog needs at least one Real clip.');
report(truths.has('ai'), 'The catalog needs at least one Fake clip.');
report(
  totalVideoBytes <= maxPublishedVideoBytes,
  'Published videos exceed the 750 MiB safety budget.',
);

try {
  const videoDirectory = path.join(root, 'videos');
  const publishedVideos = (await listFiles(videoDirectory)).filter(
    (file) => path.extname(file).toLowerCase() === '.mp4',
  );
  for (const file of publishedVideos) {
    report(
      referencedVideos.has(path.normalize(file)),
      `Unreferenced video: ${path.relative(root, file)}`,
    );
  }
  report(
    publishedVideos.length === referencedVideos.size,
    'The number of published videos does not match the catalog.',
  );
} catch (error) {
  errors.push(`Could not inspect the videos directory: ${error.message}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Validated ${clips.length} clips (${(totalVideoBytes / 1024 / 1024).toFixed(2)} MiB of video).`,
);
