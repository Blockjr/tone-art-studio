/**
 * QR codes for the tablet link, drawn on this machine.
 *
 * The tablet link carries the bridge token, so it must never be sent to a web
 * service that returns QR images. This is a small byte-mode encoder at error
 * correction level L, versions 1-10, which covers any bridge URL plus a token
 * of a few hundred characters. It returns a module matrix; the panel draws it
 * as SVG, so the code is sharp on any screen and nothing leaves the computer.
 */

interface BlockGroup {
  count: number;
  data: number;
  ecc: number;
}

/**
 * Block layout at level L. Versions 1-5 are a single block, which keeps the
 * Reed-Solomon pass short; 6-10 split into two blocks, as the spec does. Each
 * row adds up to the total codeword count for its version (26-346).
 */
const BLOCKS_L: BlockGroup[][] = [
  [{ count: 1, data: 19, ecc: 7 }],
  [{ count: 1, data: 34, ecc: 10 }],
  [{ count: 1, data: 55, ecc: 15 }],
  [{ count: 1, data: 80, ecc: 20 }],
  [{ count: 1, data: 108, ecc: 26 }],
  [{ count: 2, data: 68, ecc: 18 }],
  [{ count: 2, data: 78, ecc: 20 }],
  [{ count: 2, data: 97, ecc: 24 }],
  [{ count: 2, data: 116, ecc: 30 }],
  [
    { count: 2, data: 68, ecc: 18 },
    { count: 2, data: 69, ecc: 18 },
  ],
];

const MAX_VERSION = BLOCKS_L.length;

/** GF(256) tables for Reed-Solomon, primitive polynomial 0x11d. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < GF_EXP.length; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `degree` error correction codewords. */
function rsDivisor(degree: number): Uint8Array {
  const divisor = new Uint8Array(degree);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMultiply(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return divisor;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/** Data codewords for a version at level L. */
function dataCodewords(version: number): number {
  return BLOCKS_L[version - 1].reduce((sum, group) => sum + group.count * group.data, 0);
}

/** Bytes of payload a version can carry, including the mode and count header. */
export function qrCapacityBytes(version: number): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

/** Centre coordinates of the alignment patterns, per the standard. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const positions = new Array<number>(count);
  positions[0] = 6;
  for (let i = count - 1, position = size - 7; i >= 1; i--, position -= step) {
    positions[i] = position;
  }
  return positions;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Picks the smallest version that fits, or throws. */
function chooseVersion(length: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (qrCapacityBytes(version) >= length) return version;
  }
  throw new Error(`The link is too long for a QR code (${length} bytes).`);
}

/** Mode indicator, character count, payload, terminator and padding. */
function buildCodewords(payload: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(payload.length, version < 10 ? 8 : 16);
  for (const byte of payload) push(byte, 8);

  const capacityBits = dataCodewords(version) * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // Alternating pads keep the symbol balanced so it scans evenly.
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Splits into blocks, adds Reed-Solomon bytes and interleaves the result. */
function interleave(codewords: number[], version: number): number[] {
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;

  for (const group of BLOCKS_L[version - 1]) {
    const divisor = rsDivisor(group.ecc);
    for (let i = 0; i < group.count; i++) {
      const block = Uint8Array.from(codewords.slice(offset, offset + group.data));
      offset += group.data;
      blocks.push([...block]);
      eccBlocks.push([...rsRemainder(block, divisor)]);
    }
  }

  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  const eccLength = eccBlocks[0]?.length ?? 0;
  for (let i = 0; i < eccLength; i++) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return out;
}

interface Symbol {
  version: number;
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function blankSymbol(version: number): Symbol {
  const size = version * 4 + 17;
  return {
    version,
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(symbol: Symbol, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= symbol.size || y >= symbol.size) return;
  symbol.modules[y][x] = dark;
  symbol.reserved[y][x] = true;
}

/** 7x7 finder, its light separator, and the timing patterns. */
function drawFunctionPatterns(symbol: Symbol): void {
  const { size } = symbol;

  for (const [originX, originY] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const ring = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const core = inside && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        setFunction(symbol, originX + dx, originY + dy, ring || core);
      }
    }
  }

  for (let i = 8; i <= size - 9; i++) {
    const dark = i % 2 === 0;
    setFunction(symbol, i, 6, dark);
    setFunction(symbol, 6, i, dark);
  }

  const positions = alignmentPositions(symbol.version);
  for (const cy of positions) {
    for (const cx of positions) {
      const corner =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(symbol, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // The module that is always dark, above the bottom-left finder.
  setFunction(symbol, 8, size - 8, true);

  // Reserve the two format stripes before any data is placed; the real bits
  // are written once the mask is chosen. Without this the codewords would run
  // through the format area and every later bit would land in the wrong cell.
  drawFormatBits(symbol, 0);

  if (symbol.version >= 7) {
    let remainder = symbol.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (symbol.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(symbol, a, b, dark);
      setFunction(symbol, b, a, dark);
    }
  }
}

/** Zigzag placement of the interleaved codewords, skipping function modules. */
function drawCodewords(symbol: Symbol, codewords: number[]): void {
  const { size } = symbol;
  const bits = codewords.length * 8;
  let index = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        const y = upward ? size - 1 - vertical : vertical;
        if (symbol.reserved[y][x]) continue;
        if (index < bits) {
          symbol.modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(symbol: Symbol, mask: number): void {
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (symbol.reserved[y][x]) continue;
      if (maskApplies(mask, x, y)) symbol.modules[y][x] = !symbol.modules[y][x];
    }
  }
}

/** Format information: error correction level L plus the mask number. */
function drawFormatBits(symbol: Symbol, mask: number): void {
  const { size } = symbol;
  const data = (0b01 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFunction(symbol, 8, i, bit(i));
  setFunction(symbol, 8, 7, bit(6));
  setFunction(symbol, 8, 8, bit(7));
  setFunction(symbol, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(symbol, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) setFunction(symbol, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(symbol, 8, size - 15 + i, bit(i));
  setFunction(symbol, 8, size - 8, true);
}

/** Penalty scoring, so the chosen mask scans cleanly. */
function penaltyScore(symbol: Symbol): number {
  const { size, modules } = symbol;
  const n1 = 3;
  const n2 = 3;
  const n3 = 40;
  const n4 = 10;
  let score = 0;

  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColour = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (length: number): void => {
        // The first run also sees the light border that surrounds the symbol.
        const head = history[0];
        history.pop();
        history.unshift(head === 0 ? length + size : length);
      };

      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? modules[a][b] : modules[b][a];
        if (dark === runColour) {
          runLength++;
          if (runLength === 5) score += n1;
          else if (runLength > 5) score++;
        } else {
          addHistory(runLength);
          if (!runColour) score += countFinderLike(history) * n3;
          runColour = dark;
          runLength = 1;
        }
      }

      if (runColour) {
        addHistory(runLength);
        runLength = 0;
      }
      addHistory(runLength + size);
      score += countFinderLike(history) * n3;
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const dark = modules[y][x];
      if (dark === modules[y][x + 1] && dark === modules[y + 1][x] && dark === modules[y + 1][x + 1]) {
        score += n2;
      }
    }
  }

  let darkModules = 0;
  for (const row of modules) for (const dark of row) if (dark) darkModules++;
  const total = size * size;
  const ratio = Math.abs(darkModules * 20 - total * 10) / total;
  score += Math.ceil(ratio) * n4;
  return score;
}

/** A 1:1:3:1:1 dark run with four light modules on either side. */
function countFinderLike(history: number[]): number {
  const unit = history[1];
  const core = unit > 0 && history[2] === unit && history[3] === unit * 3 && history[4] === unit && history[5] === unit;
  if (!core) return 0;
  const left = history[0] >= unit * 4;
  const right = history[6] >= unit * 4;
  return (left ? 1 : 0) + (right ? 1 : 0);
}

/**
 * Encodes `text` and returns the module matrix, `true` meaning dark. The first
 * row is the top of the code and the caller adds the quiet zone.
 */
export function qrMatrix(text: string): boolean[][] {
  const payload = utf8(text);
  if (payload.length === 0) throw new Error('Nothing to encode.');
  const version = chooseVersion(payload.length);
  const symbol = blankSymbol(version);
  drawFunctionPatterns(symbol);
  drawCodewords(symbol, interleave(buildCodewords(payload, version), version));

  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(symbol, mask);
    drawFormatBits(symbol, mask);
    const score = penaltyScore(symbol);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(symbol, mask); // XOR again to undo
  }

  applyMask(symbol, best);
  drawFormatBits(symbol, best);
  return symbol.modules;
}

/**
 * SVG path data for a matrix: one sub-path per horizontal run of dark modules,
 * which keeps the markup small even for the largest version here.
 */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    const width = matrix[y].length;
    let x = 0;
    while (x < width) {
      if (!matrix[y][x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && matrix[y][x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join('');
}
