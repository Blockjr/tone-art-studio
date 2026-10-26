import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { qrCapacityBytes, qrMatrix, qrPath } from '../src/remote/qr';

/** Renders a matrix into the RGBA bitmap jsQR expects, with a quiet zone. */
function decode(matrix: boolean[][]): string | null {
  const quiet = 4;
  const scale = 4;
  const size = matrix.length;
  const dimension = (size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(dimension * dimension * 4).fill(255);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix[y][x]) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = (x + quiet) * scale + sx;
          const py = (y + quiet) * scale + sy;
          const offset = (py * dimension + px) * 4;
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
          pixels[offset + 3] = 255;
        }
      }
    }
  }

  const result = jsQR(pixels, dimension, dimension, { inversionAttempts: 'dontInvert' });
  return result ? result.data : null;
}

describe('tablet link QR codes', () => {
  it('round-trips the addresses the remote panel produces', () => {
    const links = [
      'http://192.168.1.20:8787',
      'http://192.168.1.20:8787/?token=6a1f0c2d9b7e4f83a5c6d1e2b3a4c5d6',
      'http://localhost:8787/?token=abc',
      'https://studio.example.com/?token=a-long-random-secret-that-keeps-the-bridge-closed',
      'http://10.0.0.5:8787/?token=hotspot',
    ];

    for (const link of links) {
      const matrix = qrMatrix(link);
      expect(decode(matrix)).toBe(link);
    }
  });

  it('fills the largest version it supports', () => {
    const longest = qrCapacityBytes(10);
    expect(longest).toBeGreaterThan(250);
    const link = `http://192.168.1.20:8787/?token=${'a'.repeat(longest - 39)}`;
    expect(link.length).toBeLessThanOrEqual(longest);

    const matrix = qrMatrix(link);
    expect(matrix.length).toBe(57);
    expect(decode(matrix)).toBe(link);
  });

  it('reports the byte capacity of each version', () => {
    const capacities = Array.from({ length: 10 }, (_, index) => qrCapacityBytes(index + 1));
    expect(capacities).toEqual([17, 32, 53, 78, 106, 134, 154, 192, 230, 271]);
  });

  it('refuses a link that will not fit', () => {
    const tooLong = 'x'.repeat(qrCapacityBytes(10) + 1);
    expect(() => qrMatrix(tooLong)).toThrow(/too long/i);
  });

  it('draws square modules from the top-left finder', () => {
    const matrix = qrMatrix('http://192.168.1.20:8787/?token=abcdef');
    const size = matrix.length;
    expect(size % 4).toBe(1);
    expect(matrix.every((row) => row.length === size)).toBe(true);

    const corner = [
      [true, true, true, true, true, true, true],
      [true, false, false, false, false, false, true],
      [true, false, true, true, true, false, true],
      [true, false, true, true, true, false, true],
      [true, false, true, true, true, false, true],
      [true, false, false, false, false, false, true],
      [true, true, true, true, true, true, true],
    ];
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) expect(matrix[y][x]).toBe(corner[y][x]);
    }

    // Separators stay light so the finder can be located.
    for (let i = 0; i < 8; i++) {
      expect(matrix[7][i]).toBe(false);
      expect(matrix[i][7]).toBe(false);
    }
  });

  it('builds a path with one square per run of dark modules', () => {
    const path = qrPath([
      [true, true, false],
      [false, true, true],
    ]);
    expect(path).toBe('M0 0h2v1h-2zM1 1h2v1h-2z');
  });
});
