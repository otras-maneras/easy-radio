export type Limits = {
  maxUploadBytes: number;
  maxLibraryBytes: number;
  maxTracks: number;
  maxConcurrentUploads: number;
  maxStreams: number;
  maxPreviews: number;
  minFreeDiskBytes: number;
};
export function readLimits(overrides: Partial<Limits> = {}): Limits {
  const values: Limits = {
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 ** 2),
    maxLibraryBytes: Number(process.env.MAX_LIBRARY_BYTES ?? 5 * 1024 ** 3),
    maxTracks: Number(process.env.MAX_TRACKS ?? 5000),
    maxConcurrentUploads: Number(process.env.MAX_CONCURRENT_UPLOADS ?? 2),
    maxStreams: Number(process.env.MAX_STREAMS ?? 100),
    maxPreviews: Number(process.env.MAX_PREVIEWS ?? 4),
    minFreeDiskBytes: Number(process.env.MIN_FREE_DISK_BYTES ?? 512 * 1024 ** 2),
    ...overrides
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < (key === 'minFreeDiskBytes' ? 0 : 1)) throw new Error(`Límite no válido: ${key}`);
  }
  return values;
}
