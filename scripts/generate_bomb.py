#!/usr/bin/env python3
import struct
import zlib
import sys

def make_png_bomb(width=40000, height=40000, out_path="decompression_bomb.png"):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    # PNG Signature
    png = b"\x89PNG\r\n\x1a\n"

    # IHDR: width, height, bit_depth=8, color_type=0 (grayscale), comp=0, filter=0, interlace=0
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    png += chunk(b"IHDR", ihdr_data)

    # IDAT: Scanlines for grayscale: 1 filter byte + width bytes of pixels per row
    # To keep the file tiny, compress a sequence of zeroes
    compressor = zlib.compressobj(level=9)
    scanline = b"\x00" * (1 + width)
    
    # We can write just enough compressed IDAT chunks
    # Even a partial scanline stream is valid enough to test dimension probe and decode safety
    compressed = b""
    for _ in range(min(height, 100)):
        compressed += compressor.compress(scanline)
    compressed += compressor.flush()

    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")

    with open(out_path, "wb") as f:
        f.write(png)
    print(f"Generated {out_path} ({width}x{height}, {len(png)} bytes)")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/decompression_bomb.png"
    make_png_bomb(40000, 40000, out)
