/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 精简版 MPEG-TS 解封装器
 *
 * 目标：从 MPEG-TS 流中提取 H.264 Annex-B 字节流，供 Broadway.js Decoder 软解。
 *
 * 仅做最小必要的解析：
 *   1. 解析 188B TS 包（支持 0x304 / 0x192 同步）
 *   2. 解析 PAT (PID=0) 找到 PMT PID
 *   3. 解析 PMT 找到 H.264 (stream_type=0x1B) 视频 PID
 *   4. 重组视频 PES，去掉 PES header，输出纯 H.264 Annex-B 字节流
 *
 * 不处理：
 *   - 音频（特斯拉播放场景只关心视频，音频解码需要单独的 AAC 解码器，不在本次范围）
 *   - 加密流（HLS key 由 hls-broadway-engine 在 demux 前处理）
 *   - H.265（Broadway.js 仅支持 H.264）
 */

export interface TSDemuxResult {
  /** 拼接后的 H.264 Annex-B 字节流，可直接喂给 Broadway.js Decoder.decode() */
  h264Stream: Uint8Array;
  /** 自动检测到的视频 PID */
  videoPid: number;
  /** 检测到的音频 PID 列表（不输出，仅做诊断） */
  audioPids: number[];
  /** 第一帧 PTS（90kHz 时钟，单位 1/90000 秒） */
  firstPts: number | null;
  /** 最后一个 PTS */
  lastPts: number | null;
}

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_H265 = 0x24;
const STREAM_TYPE_AAC = 0x0f;
const STREAM_TYPE_MP3 = 0x03;

const PAT_PID = 0;
const NO_PID = -1;

interface TSPacketHeader {
  pid: number;
  payloadUnitStart: boolean;
  adaptationFieldControl: number; // 01 payload only, 10 adaptation only, 11 both
  continuityCounter: number;
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function parseHeader(data: Uint8Array, offset: number): TSPacketHeader | null {
  if (data[offset] !== TS_SYNC_BYTE) return null;
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const b3 = data[offset + 3];
  // transport_error_indicator = (b1 & 0x80) >>> 7
  const payloadUnitStart = (b1 & 0x40) !== 0;
  // transport_priority = (b1 & 0x20) !== 0
  const pid = ((b1 & 0x1f) << 8) | b2;
  const adaptationFieldControl = (b3 & 0xc0) >>> 6;
  const continuityCounter = b3 & 0x0f;
  return { pid, payloadUnitStart, adaptationFieldControl, continuityCounter };
}

/** 计算每个 TS 包的有效负载起始位置（跳过 adaptation field） */
function getPayloadOffset(data: Uint8Array, packetOffset: number): number {
  const b3 = data[packetOffset + 3];
  const adaptationFieldControl = (b3 & 0xc0) >>> 6;
  let payloadStart = packetOffset + 4;
  // adaptation field present
  if (adaptationFieldControl === 0x02 || adaptationFieldControl === 0x03) {
    const adaptationLength = data[packetOffset + 4];
    payloadStart += 1 + adaptationLength;
  }
  return payloadStart;
}

function hasPayload(adaptationFieldControl: number): boolean {
  return adaptationFieldControl === 0x01 || adaptationFieldControl === 0x03;
}

/**
 * 解析 PES header，返回 PES payload 在 TS 包内的偏移和 PTS（如果有）
 * 参考 ISO/IEC 13818-1 2.4.3.6
 */
function parsePESHeader(
  data: Uint8Array,
  start: number,
  end: number
): { payloadOffset: number; pts: number | null } {
  // 起始码应该是 00 00 01
  if (end - start < 9) {
    return { payloadOffset: end, pts: null };
  }
  // start + 0..2: start code prefix (00 00 01)
  // start + 3: stream_id
  // start + 4..5: PES_packet_length (may be 0 for video)
  // start + 6: flags1 (10 xxxx xx)
  // start + 7: flags2 (PTS_DTS_flags, ESCR_flag, etc.)
  // start + 8: PES_header_data_length
  const flags2 = data[start + 7];
  const pesHeaderDataLength = data[start + 8];
  const ptsDtsFlags = (flags2 & 0xc0) >>> 6;
  let pts: number | null = null;
  let offset = start + 9;
  if (ptsDtsFlags === 0x02 || ptsDtsFlags === 0x03) {
    // PTS present
    if (end - offset >= 5) {
      const b0 = data[offset];
      const b1 = data[offset + 1];
      const b2 = data[offset + 2];
      const b3 = data[offset + 3];
      const b4 = data[offset + 4];
      // 0010 PTS[32..30] 1 PTS[29..15] 1 PTS[14..0] 1
      pts =
        (((b0 & 0x0e) >>> 1) * 1 << 30) |
        (b1 << 22) |
        (((b2 & 0xfe) >>> 1) << 15) |
        (b3 << 7) |
        ((b4 & 0xfe) >>> 1);
      pts = pts >>> 0;
    }
    offset += 5;
    if (ptsDtsFlags === 0x03) {
      // DTS present, skip 5 bytes
      offset += 5;
    }
  }
  offset += pesHeaderDataLength;
  return { payloadOffset: offset, pts };
}

/**
 * 解封装一段完整的 MPEG-TS 字节流
 * @param data TS 节段数据（通常是 m3u8 中一个 .ts 分片的完整内容）
 */
export function demuxTS(data: Uint8Array): TSDemuxResult {
  const len = data.length;
  let pmtPid = NO_PID;
  let videoPid = NO_PID;
  const audioPids: number[] = [];
  const h264Chunks: Uint8Array[] = [];

  // 缓存每个 PID 当前正在重组的 PES 数据
  const pesBuffers = new Map<number, number[]>();
  const pesStartPts = new Map<number, number | null>();
  let firstPts: number | null = null;
  let lastPts: number | null = null;

  const flushPES = (pid: number) => {
    if (pid !== videoPid || videoPid === NO_PID) {
      pesBuffers.delete(pid);
      pesStartPts.delete(pid);
      return;
    }
    const buf = pesBuffers.get(pid);
    if (!buf || buf.length === 0) {
      pesBuffers.delete(pid);
      pesStartPts.delete(pid);
      return;
    }
    // 拼接 PES
    const pesData = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) pesData[i] = buf[i];
    pesBuffers.delete(pid);
    const pts = pesStartPts.get(pid) ?? null;
    pesStartPts.delete(pid);
    if (pts != null) {
      if (firstPts == null) firstPts = pts;
      lastPts = pts;
    }
    // 解析 PES header，取出 payload
    if (pesData.length >= 4 && pesData[0] === 0x00 && pesData[1] === 0x00 && pesData[2] === 0x01) {
      const { payloadOffset, pts: pesPts } = parsePESHeader(
        pesData,
        0,
        pesData.length
      );
      if (payloadOffset < pesData.length) {
        h264Chunks.push(pesData.subarray(payloadOffset));
      }
      if (pesPts != null) {
        if (firstPts == null) firstPts = pesPts;
        lastPts = pesPts;
      }
    }
  };

  let offset = 0;
  // 自动跳过可能的 4-byte timestamp 前缀（一些 IPTV TS 流有）
  // 但通常 0x47 间隔就是 188，这里直接尝试
  if (data[0] !== TS_SYNC_BYTE) {
    // 尝试找到第一个同步字节
    for (let i = 0; i < TS_PACKET_SIZE; i++) {
      if (data[i] === TS_SYNC_BYTE && data[i + TS_PACKET_SIZE] === TS_SYNC_BYTE) {
        offset = i;
        break;
      }
    }
  }

  while (offset + TS_PACKET_SIZE <= len) {
    if (data[offset] !== TS_SYNC_BYTE) break;
    const header = parseHeader(data, offset);
    if (!header) {
      offset += TS_PACKET_SIZE;
      continue;
    }
    const packetEnd = offset + TS_PACKET_SIZE;
    const payloadStart = getPayloadOffset(data, offset);
    if (!hasPayload(header.adaptationFieldControl) || payloadStart >= packetEnd) {
      offset += TS_PACKET_SIZE;
      continue;
    }

    const { pid, payloadUnitStart } = header;

    if (payloadUnitStart && pesBuffers.has(pid)) {
      // 上一个 PES 结束
      flushPES(pid);
    }

    if (pid === PAT_PID) {
      // PAT
      const pointer = data[payloadStart];
      const patOffset = payloadStart + 1 + pointer;
      // table_id
      // section_length at patOffset+1..patOffset+2
      const sectionLength = readU16(data, patOffset + 1) & 0x0fff;
      const sectionEnd = patOffset + 3 + sectionLength;
      // Skip transport_stream_id (2), version (1), section_number (1), last_section_number (1) = 5 bytes
      let p = patOffset + 8;
      // Each program entry is 4 bytes: program_number (2), reserved (3 bits), PMT_PID (13 bits)
      while (p + 4 <= sectionEnd - 4 /* CRC32 */) {
        const programNumber = readU16(data, p);
        const pidEntry = readU16(data, p + 2) & 0x1fff;
        if (programNumber > 0) {
          pmtPid = pidEntry;
          break;
        }
        p += 4;
      }
    } else if (pid === pmtPid && pmtPid !== NO_PID && videoPid === NO_PID) {
      // PMT
      const pointer = data[payloadStart];
      const pmtOffset = payloadStart + 1 + pointer;
      const sectionLength = readU16(data, pmtOffset + 1) & 0x0fff;
      const sectionEnd = pmtOffset + 3 + sectionLength;
      // Skip program_number (2), version (1), section_number (1), last_section_number (1)
      // PCR_PID (2), program_info_length (2)
      let p = pmtOffset + 8 + 2;
      const programInfoLength = readU16(data, pmtOffset + 10) & 0x0fff;
      p += programInfoLength;
      // Each ES entry: stream_type (1), reserved (3 bits), ES_PID (13 bits), reserved (4 bits), ES_info_length (12 bits)
      while (p + 5 <= sectionEnd - 4) {
        const streamType = data[p];
        const esPid = readU16(data, p + 1) & 0x1fff;
        const esInfoLength = readU16(data, p + 3) & 0x0fff;
        if (streamType === STREAM_TYPE_H264) {
          videoPid = esPid;
        } else if (
          streamType === STREAM_TYPE_AAC ||
          streamType === STREAM_TYPE_MP3
        ) {
          if (!audioPids.includes(esPid)) audioPids.push(esPid);
        } else if (streamType === STREAM_TYPE_H265) {
          // H.265 not supported by Broadway.js; mark but skip
          // eslint-disable-next-line no-console
          console.warn('[TeslaPlayer] TS 流为 H.265，Broadway.js 仅支持 H.264，将无法解码');
        }
        p += 5 + esInfoLength;
      }
    } else if (pid === videoPid && videoPid !== NO_PID) {
      // 视频 PES 数据
      if (payloadUnitStart) {
        // 新 PES 开始
        pesBuffers.set(pid, []);
        // PTS 暂存，稍后由 parsePESHeader 解析
        pesStartPts.set(pid, null);
      }
      const buf = pesBuffers.get(pid);
      if (buf) {
        for (let i = payloadStart; i < packetEnd; i++) buf.push(data[i]);
      }
    }

    offset += TS_PACKET_SIZE;
  }

  // 最后一个 PES
  if (videoPid !== NO_PID) {
    flushPES(videoPid);
  }

  // 拼接所有 H.264 chunks
  let totalLen = 0;
  for (const c of h264Chunks) totalLen += c.length;
  const h264Stream = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of h264Chunks) {
    h264Stream.set(c, pos);
    pos += c.length;
  }

  return {
    h264Stream,
    videoPid,
    audioPids,
    firstPts,
    lastPts,
  };
}

/**
 * 将 H.264 Annex-B 字节流按 start code (00 00 00 01 / 00 00 01) 切分为 NAL 单元数组
 * 仅在需要按 NAL 喂入时使用；Broadway.js Decoder.decode() 可直接接受整段 Annex-B 流。
 */
export function splitNALUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  const len = data.length;
  let i = 0;
  let lastStart = -1;
  while (i < len - 3) {
    if (
      data[i] === 0x00 &&
      data[i + 1] === 0x00 &&
      data[i + 2] === 0x01
    ) {
      if (lastStart >= 0) {
        units.push(data.subarray(lastStart, i));
      }
      lastStart = i + 3;
      i += 3;
      continue;
    }
    if (
      data[i] === 0x00 &&
      data[i + 1] === 0x00 &&
      data[i + 2] === 0x00 &&
      data[i + 3] === 0x01
    ) {
      if (lastStart >= 0) {
        units.push(data.subarray(lastStart, i));
      }
      lastStart = i + 4;
      i += 4;
      continue;
    }
    i++;
  }
  if (lastStart >= 0 && lastStart < len) {
    units.push(data.subarray(lastStart, len));
  }
  return units;
}
