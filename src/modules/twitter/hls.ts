// Remuxes X's HLS (separate fragmented MP4 video and audio playlists) into a
// regular, non-fragmented MP4 with interleaved chunks. Regular MP4s with full
// sample tables, edit lists and composition offsets play correctly in every
// player, unlike files made of thousands of single-sample fragments.

const FETCH_CONCURRENCY = 8;
const MOVIE_TIMESCALE = 1000;
const CHUNK_SECONDS = 0.5;
const UND_LANGUAGE = 0x55c4;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

interface Box {
  type: string;
  start: number;
  headerSize: number;
  end: number;
}

interface TrackInit {
  trackId: number;
  timescale: number;
  handler: string;
  widthFixed: number;
  heightFixed: number;
  stsd: Uint8Array<ArrayBuffer>;
  defaultDuration: number;
  defaultSize: number;
  defaultFlags: number;
  // Media time where presentation starts, from the init edit list (0 if none).
  presentationShift: number;
}

interface MediaSample {
  data: Uint8Array<ArrayBuffer>;
  duration: number;
  dts: number;
  cts: number;
  isSync: boolean;
}

interface ParsedTrack {
  init: TrackInit;
  samples: MediaSample[];
}

interface Chunk {
  track: number;
  first: number;
  count: number;
  size: number;
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = fourcc(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, start: offset, headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function children(view: DataView, box: Box): Box[] {
  return readBoxes(view, box.start + box.headerSize, box.end);
}

function child(view: DataView, box: Box | undefined, type: string): Box | undefined {
  return box ? children(view, box).find((entry) => entry.type === type) : undefined;
}

function childPath(view: DataView, box: Box | undefined, path: string[]): Box | undefined {
  return path.reduce<Box | undefined>((current, type) => child(view, current, type), box);
}

function content(box: Box): number {
  return box.start + box.headerSize;
}

function parseInit(buffer: ArrayBuffer): TrackInit {
  const view = new DataView(buffer);
  const moov = readBoxes(view, 0, buffer.byteLength).find((box) => box.type === 'moov');
  const trak = child(view, moov, 'trak');
  const tkhd = child(view, trak, 'tkhd');
  const mdhd = childPath(view, trak, ['mdia', 'mdhd']);
  const hdlr = childPath(view, trak, ['mdia', 'hdlr']);
  const stsd = childPath(view, trak, ['mdia', 'minf', 'stbl', 'stsd']);
  if (!moov || !tkhd || !mdhd || !hdlr || !stsd) {
    throw new Error('The HLS init segment is missing track metadata.');
  }

  const tkhdVersion = view.getUint8(content(tkhd));
  const trackId = view.getUint32(content(tkhd) + (tkhdVersion === 1 ? 20 : 12));
  const mdhdVersion = view.getUint8(content(mdhd));
  const timescale = view.getUint32(content(mdhd) + (mdhdVersion === 1 ? 20 : 12));

  let defaultDuration = 0;
  let defaultSize = 0;
  let defaultFlags = 0;
  const mvex = child(view, moov, 'mvex');
  for (const trex of mvex ? children(view, mvex).filter((box) => box.type === 'trex') : []) {
    const c = content(trex);
    if (view.getUint32(c + 4) !== trackId) continue;
    defaultDuration = view.getUint32(c + 12);
    defaultSize = view.getUint32(c + 16);
    defaultFlags = view.getUint32(c + 20);
  }

  let presentationShift = 0;
  const elst = childPath(view, trak, ['edts', 'elst']);
  if (elst) {
    const c = content(elst);
    const version = view.getUint8(c);
    const count = view.getUint32(c + 4);
    const entrySize = version === 1 ? 20 : 12;
    for (let index = 0; index < count; index += 1) {
      const entry = c + 8 + index * entrySize;
      const mediaTime =
        version === 1 ? Number(view.getBigInt64(entry + 8)) : view.getInt32(entry + 4);
      if (mediaTime >= 0) {
        presentationShift = mediaTime;
        break;
      }
    }
  }

  return {
    trackId,
    timescale,
    presentationShift,
    handler: fourcc(view, content(hdlr) + 8),
    widthFixed: view.getUint32(tkhd.end - 8),
    heightFixed: view.getUint32(tkhd.end - 4),
    stsd: new Uint8Array(buffer.slice(stsd.start, stsd.end)),
    defaultDuration,
    defaultSize,
    defaultFlags,
  };
}

function isSyncSample(flags: number): boolean {
  // sample_is_non_sync_sample is bit 16 of the sample flags.
  return (flags & 0x00010000) === 0;
}

function parseSegment(buffer: ArrayBuffer, init: TrackInit, samples: MediaSample[], nextDts: number): number {
  const view = new DataView(buffer);
  let dtsCursor = nextDts;

  for (const moof of readBoxes(view, 0, buffer.byteLength).filter((box) => box.type === 'moof')) {
    for (const traf of children(view, moof).filter((box) => box.type === 'traf')) {
      const tfhd = child(view, traf, 'tfhd');
      if (!tfhd) continue;
      const tfhdFlags = view.getUint32(content(tfhd)) & 0xffffff;
      if (view.getUint32(content(tfhd) + 4) !== init.trackId) continue;

      let cursor = content(tfhd) + 8;
      let base = moof.start;
      if (tfhdFlags & 0x01) {
        base = Number(view.getBigUint64(cursor));
        cursor += 8;
      }
      if (tfhdFlags & 0x02) cursor += 4;
      let defaultDuration = init.defaultDuration;
      let defaultSize = init.defaultSize;
      let defaultFlags = init.defaultFlags;
      if (tfhdFlags & 0x08) {
        defaultDuration = view.getUint32(cursor);
        cursor += 4;
      }
      if (tfhdFlags & 0x10) {
        defaultSize = view.getUint32(cursor);
        cursor += 4;
      }
      if (tfhdFlags & 0x20) defaultFlags = view.getUint32(cursor);

      const tfdt = child(view, traf, 'tfdt');
      if (tfdt) {
        const version = view.getUint8(content(tfdt));
        dtsCursor =
          version === 1
            ? Number(view.getBigUint64(content(tfdt) + 4))
            : view.getUint32(content(tfdt) + 4);
      }

      let dataPointer = base;
      for (const trun of children(view, traf).filter((box) => box.type === 'trun')) {
        const c = content(trun);
        const version = view.getUint8(c);
        const flags = view.getUint32(c) & 0xffffff;
        const count = view.getUint32(c + 4);
        let p = c + 8;
        if (flags & 0x001) {
          dataPointer = base + view.getInt32(p);
          p += 4;
        }
        let firstFlags: number | null = null;
        if (flags & 0x004) {
          firstFlags = view.getUint32(p);
          p += 4;
        }

        for (let index = 0; index < count; index += 1) {
          let duration = defaultDuration;
          let size = defaultSize;
          let sampleFlags = index === 0 && firstFlags !== null ? firstFlags : defaultFlags;
          let compositionOffset = 0;
          if (flags & 0x100) {
            duration = view.getUint32(p);
            p += 4;
          }
          if (flags & 0x200) {
            size = view.getUint32(p);
            p += 4;
          }
          if (flags & 0x400) {
            const explicitFlags = view.getUint32(p);
            p += 4;
            if (!(index === 0 && firstFlags !== null)) sampleFlags = explicitFlags;
          }
          if (flags & 0x800) {
            compositionOffset = version === 0 ? view.getUint32(p) : view.getInt32(p);
            p += 4;
          }
          if (dataPointer + size > buffer.byteLength) {
            throw new Error('An HLS segment is truncated.');
          }
          samples.push({
            data: new Uint8Array(buffer, dataPointer, size),
            duration,
            dts: dtsCursor,
            cts: dtsCursor + compositionOffset,
            isSync: isSyncSample(sampleFlags),
          });
          dataPointer += size;
          dtsCursor += duration;
        }
      }
    }
  }
  return dtsCursor;
}

function parseTrack(parts: ArrayBuffer[]): ParsedTrack {
  const [initBuffer, ...segments] = parts;
  const init = parseInit(initBuffer);
  const samples: MediaSample[] = [];
  let nextDts = 0;
  for (const segment of segments) nextDts = parseSegment(segment, init, samples, nextDts);
  if (samples.length === 0) throw new Error('No media samples could be extracted.');
  return { init, samples };
}

class ByteWriter {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(4096);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, value);
    this.length += 2;
  }

  i16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.length, value);
    this.length += 2;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value >>> 0);
    this.length += 4;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, value);
    this.length += 4;
  }

  u64(value: number): void {
    this.u32(Math.floor(value / 2 ** 32));
    this.u32(value % 2 ** 32);
  }

  ascii(value: string): void {
    for (let index = 0; index < value.length; index += 1) this.u8(value.charCodeAt(index));
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  box(type: string, body: () => void): void {
    const start = this.length;
    this.u32(0);
    this.ascii(type);
    body();
    this.view.setUint32(start, this.length - start);
  }

  fullBox(type: string, version: number, flags: number, body: () => void): void {
    this.box(type, () => {
      this.u32(((version << 24) | flags) >>> 0);
      body();
    });
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }
}

interface TrackLayout {
  parsed: ParsedTrack;
  id: number;
  isVideo: boolean;
  mediaDuration: number;
  mediaTime: number;
  emptyEdit: number;
  movieDuration: number;
  chunkOffsets: number[];
  chunkCounts: number[];
}

function planTracks(tracks: ParsedTrack[]): TrackLayout[] {
  // Without an edit list, presentation starts at the earliest composition
  // time. With one, it starts at the edit's media time, which maps to zero.
  const timing = tracks.map(({ init, samples }) => {
    const minCts = samples.reduce((minimum, sample) => Math.min(minimum, sample.cts), Infinity);
    const firstPresented = Math.max(minCts, init.presentationShift);
    return {
      firstPresented,
      startSeconds: (firstPresented - init.presentationShift) / init.timescale,
    };
  });
  const timelineStart = Math.min(...timing.map(({ startSeconds }) => startSeconds));

  return tracks.map((parsed, index) => {
    const { init, samples } = parsed;
    const firstDts = samples[0].dts;
    const mediaDuration = samples.reduce((total, sample) => total + sample.duration, 0);
    // Media time is relative to the first decode time, which becomes zero in the output.
    const mediaTime = Math.min(Math.max(0, timing[index].firstPresented - firstDts), mediaDuration);
    const emptyEdit = Math.round((timing[index].startSeconds - timelineStart) * MOVIE_TIMESCALE);
    const presented = Math.round(((mediaDuration - mediaTime) * MOVIE_TIMESCALE) / init.timescale);
    return {
      parsed,
      id: index + 1,
      isVideo: init.handler === 'vide',
      mediaDuration,
      mediaTime,
      emptyEdit,
      movieDuration: emptyEdit + presented,
      chunkOffsets: [],
      chunkCounts: [],
    };
  });
}

function planChunks(layouts: TrackLayout[]): Chunk[] {
  // Interleave both tracks in short time windows so players reading the file
  // sequentially always have audio and video available together.
  const chunks: Chunk[] = [];
  const cursors = layouts.map(() => 0);
  const origin = Math.min(
    ...layouts.map(({ parsed }) => parsed.samples[0].dts / parsed.init.timescale),
  );
  for (let windowEnd = origin + CHUNK_SECONDS; ; windowEnd += CHUNK_SECONDS) {
    let remaining = false;
    layouts.forEach((layout, track) => {
      const { samples, init } = layout.parsed;
      const first = cursors[track];
      let size = 0;
      while (cursors[track] < samples.length && samples[cursors[track]].dts / init.timescale < windowEnd) {
        size += samples[cursors[track]].data.byteLength;
        cursors[track] += 1;
      }
      if (cursors[track] > first) chunks.push({ track, first, count: cursors[track] - first, size });
      if (cursors[track] < samples.length) remaining = true;
    });
    if (!remaining) break;
  }
  return chunks;
}

function runLength(values: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === value) last[0] += 1;
    else runs.push([1, value]);
  }
  return runs;
}

function writeTrak(writer: ByteWriter, layout: TrackLayout, useCo64: boolean): void {
  const { parsed, isVideo } = layout;
  const { init, samples } = parsed;

  writer.box('trak', () => {
    writer.fullBox('tkhd', 0, 0x000003, () => {
      writer.u32(0);
      writer.u32(0);
      writer.u32(layout.id);
      writer.u32(0);
      writer.u32(layout.movieDuration);
      writer.u32(0);
      writer.u32(0);
      writer.i16(0);
      writer.i16(0);
      writer.u16(isVideo ? 0 : 0x0100);
      writer.u16(0);
      IDENTITY_MATRIX.forEach((value) => writer.u32(value));
      writer.u32(isVideo ? init.widthFixed : 0);
      writer.u32(isVideo ? init.heightFixed : 0);
    });

    writer.box('edts', () => {
      const entries: Array<[number, number]> = [];
      if (layout.emptyEdit > 0) entries.push([layout.emptyEdit, -1]);
      entries.push([layout.movieDuration - layout.emptyEdit, layout.mediaTime]);
      writer.fullBox('elst', 0, 0, () => {
        writer.u32(entries.length);
        for (const [segmentDuration, mediaTime] of entries) {
          writer.u32(segmentDuration);
          writer.i32(mediaTime);
          writer.i16(1);
          writer.i16(0);
        }
      });
    });

    writer.box('mdia', () => {
      writer.fullBox('mdhd', 0, 0, () => {
        writer.u32(0);
        writer.u32(0);
        writer.u32(init.timescale);
        writer.u32(layout.mediaDuration);
        writer.u16(UND_LANGUAGE);
        writer.u16(0);
      });
      writer.fullBox('hdlr', 0, 0, () => {
        writer.u32(0);
        writer.ascii(isVideo ? 'vide' : 'soun');
        writer.u32(0);
        writer.u32(0);
        writer.u32(0);
        writer.ascii(isVideo ? 'VideoHandler' : 'SoundHandler');
        writer.u8(0);
      });
      writer.box('minf', () => {
        if (isVideo) {
          writer.fullBox('vmhd', 0, 1, () => {
            writer.u16(0);
            writer.u16(0);
            writer.u16(0);
            writer.u16(0);
          });
        } else {
          writer.fullBox('smhd', 0, 0, () => {
            writer.u16(0);
            writer.u16(0);
          });
        }
        writer.box('dinf', () => {
          writer.fullBox('dref', 0, 0, () => {
            writer.u32(1);
            writer.fullBox('url ', 0, 1, () => undefined);
          });
        });
        writer.box('stbl', () => {
          // The original sample description (avcC, esds, ...) is reused as is.
          writer.bytes(init.stsd);

          const durations = runLength(samples.map((sample) => sample.duration));
          writer.fullBox('stts', 0, 0, () => {
            writer.u32(durations.length);
            for (const [count, delta] of durations) {
              writer.u32(count);
              writer.u32(delta);
            }
          });

          const offsets = samples.map((sample) => sample.cts - sample.dts);
          if (offsets.some((offset) => offset !== 0)) {
            const signed = offsets.some((offset) => offset < 0);
            const runs = runLength(offsets);
            writer.fullBox('ctts', signed ? 1 : 0, 0, () => {
              writer.u32(runs.length);
              for (const [count, offset] of runs) {
                writer.u32(count);
                if (signed) writer.i32(offset);
                else writer.u32(offset);
              }
            });
          }

          if (samples.some((sample) => !sample.isSync)) {
            const syncNumbers = samples.flatMap((sample, index) => (sample.isSync ? [index + 1] : []));
            writer.fullBox('stss', 0, 0, () => {
              writer.u32(syncNumbers.length);
              syncNumbers.forEach((number) => writer.u32(number));
            });
          }

          const stsc = runLength(layout.chunkCounts);
          writer.fullBox('stsc', 0, 0, () => {
            writer.u32(stsc.length);
            let chunkNumber = 1;
            for (const [runCount, samplesPerChunk] of stsc) {
              writer.u32(chunkNumber);
              writer.u32(samplesPerChunk);
              writer.u32(1);
              chunkNumber += runCount;
            }
          });

          writer.fullBox('stsz', 0, 0, () => {
            writer.u32(0);
            writer.u32(samples.length);
            samples.forEach((sample) => writer.u32(sample.data.byteLength));
          });

          writer.fullBox(useCo64 ? 'co64' : 'stco', 0, 0, () => {
            writer.u32(layout.chunkOffsets.length);
            for (const offset of layout.chunkOffsets) {
              if (useCo64) writer.u64(offset);
              else writer.u32(offset);
            }
          });
        });
      });
    });
  });
}

function writeMoov(layouts: TrackLayout[], useCo64: boolean): Uint8Array<ArrayBuffer> {
  const writer = new ByteWriter();
  writer.box('moov', () => {
    writer.fullBox('mvhd', 0, 0, () => {
      writer.u32(0);
      writer.u32(0);
      writer.u32(MOVIE_TIMESCALE);
      writer.u32(Math.max(...layouts.map((layout) => layout.movieDuration)));
      writer.u32(0x00010000);
      writer.u16(0x0100);
      writer.u16(0);
      writer.u32(0);
      writer.u32(0);
      IDENTITY_MATRIX.forEach((value) => writer.u32(value));
      for (let index = 0; index < 6; index += 1) writer.u32(0);
      writer.u32(layouts.length + 1);
    });
    layouts.forEach((layout) => writeTrak(writer, layout, useCo64));
  });
  return writer.result();
}

function buildMp4(tracks: ParsedTrack[]): Blob {
  const layouts = planTracks(tracks);
  const chunks = planChunks(layouts);
  const mdatPayload = chunks.reduce((total, chunk) => total + chunk.size, 0);
  const useCo64 = mdatPayload > 0xffff0000;
  const largeMdat = mdatPayload + 8 > 0xffffffff;

  const ftypWriter = new ByteWriter();
  ftypWriter.box('ftyp', () => {
    ftypWriter.ascii('isom');
    ftypWriter.u32(0x200);
    ['isom', 'iso2', 'avc1', 'mp41'].forEach((brand) => ftypWriter.ascii(brand));
  });
  const ftyp = ftypWriter.result();

  const assignOffsets = (base: number) => {
    layouts.forEach((layout) => {
      layout.chunkOffsets = [];
      layout.chunkCounts = [];
    });
    let offset = base;
    for (const chunk of chunks) {
      layouts[chunk.track].chunkOffsets.push(offset);
      layouts[chunk.track].chunkCounts.push(chunk.count);
      offset += chunk.size;
    }
  };

  // The moov size does not depend on the offset values, so build it once to
  // measure it and again with the final chunk offsets.
  assignOffsets(0);
  const moovSize = writeMoov(layouts, useCo64).byteLength;
  const mdatHeaderSize = largeMdat ? 16 : 8;
  assignOffsets(ftyp.byteLength + moovSize + mdatHeaderSize);
  const moov = writeMoov(layouts, useCo64);

  const mdatHeader = new ByteWriter();
  if (largeMdat) {
    mdatHeader.u32(1);
    mdatHeader.ascii('mdat');
    mdatHeader.u64(mdatPayload + 16);
  } else {
    mdatHeader.u32(mdatPayload + 8);
    mdatHeader.ascii('mdat');
  }

  const parts: BlobPart[] = [ftyp, moov, mdatHeader.result()];
  for (const chunk of chunks) {
    const { samples } = layouts[chunk.track].parsed;
    for (let index = chunk.first; index < chunk.first + chunk.count; index += 1) {
      parts.push(samples[index].data);
    }
  }
  return new Blob(parts, { type: 'video/mp4' });
}

function absoluteUrl(value: string, base: string): string {
  return new URL(value.trim().replace(/^"|"$/g, ''), base).toString();
}

function attribute(line: string, name: string): string | null {
  return line.match(new RegExp(`${name}=(?:"([^"]+)"|([^,]+))`))?.slice(1).find(Boolean) ?? null;
}

function selectPlaylists(master: string, masterUrl: string): { video: string; audio: string } {
  const lines = master.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const videos: Array<{ url: string; area: number; bandwidth: number }> = [];
  const audios: Array<{ url: string; bandwidth: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines.slice(index + 1).find((entry) => !entry.startsWith('#'));
      if (!next) continue;
      const dimensions = attribute(line, 'RESOLUTION')?.match(/(\d+)x(\d+)/);
      videos.push({
        url: absoluteUrl(next, masterUrl),
        area: dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0,
        bandwidth: Number(attribute(line, 'BANDWIDTH') ?? 0),
      });
    } else if (line.startsWith('#EXT-X-MEDIA:') && attribute(line, 'TYPE') === 'AUDIO') {
      const uri = attribute(line, 'URI');
      if (!uri) continue;
      const url = absoluteUrl(uri, masterUrl);
      const pathBandwidth = Number(url.match(/\/mp4a\/(\d+)\//)?.[1] ?? 0);
      audios.push({ url, bandwidth: pathBandwidth });
    }
  }

  const video = videos.sort((a, b) => b.area - a.area || b.bandwidth - a.bandwidth)[0]?.url;
  const audio = audios.sort((a, b) => b.bandwidth - a.bandwidth)[0]?.url;
  if (!video || !audio) throw new Error('The HLS manifest has no usable video/audio tracks.');
  return { video, audio };
}

function playlistParts(playlist: string, playlistUrl: string): string[] {
  const lines = playlist.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  const mapUri = mapLine ? attribute(mapLine, 'URI') : null;
  const segments = lines.filter((line) => !line.startsWith('#'));
  if (!mapUri || segments.length === 0) throw new Error('The media playlist is incomplete.');
  return [absoluteUrl(mapUri, playlistUrl), ...segments.map((line) => absoluteUrl(line, playlistUrl))];
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Media request failed (${response.status}).`);
  return response.arrayBuffer();
}

async function fetchParts(urls: string[]): Promise<ArrayBuffer[]> {
  const output = new Array<ArrayBuffer>(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, async () => {
      while (next < urls.length) {
        const index = next++;
        output[index] = await fetchBuffer(urls[index]);
      }
    }),
  );
  return output;
}

export async function hlsToMp4(masterUrl: string): Promise<Blob> {
  let selected: { video: string; audio: string };
  if (masterUrl.startsWith('twx-hls:')) {
    selected = JSON.parse(decodeURIComponent(masterUrl.slice('twx-hls:'.length))) as {
      video: string;
      audio: string;
    };
  } else {
    const masterResponse = await fetch(masterUrl, { credentials: 'omit' });
    if (!masterResponse.ok) {
      throw new Error(`HLS manifest request failed (${masterResponse.status}).`);
    }
    selected = selectPlaylists(await masterResponse.text(), masterUrl);
  }
  const fetchText = async (url: string) => {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`HLS playlist request failed (${response.status}).`);
    return response.text();
  };
  const [videoPlaylist, audioPlaylist] = await Promise.all([
    fetchText(selected.video),
    fetchText(selected.audio),
  ]);
  const [videoParts, audioParts] = await Promise.all([
    fetchParts(playlistParts(videoPlaylist, selected.video)),
    fetchParts(playlistParts(audioPlaylist, selected.audio)),
  ]);
  return buildMp4([parseTrack(videoParts), parseTrack(audioParts)]);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
