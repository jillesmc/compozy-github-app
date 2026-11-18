// Login file reads the host side trusts (R-21): never through a symlink, bounded. Shared by the core and the provider adapters.
import fs from "node:fs";

// Reads a regular file up to max bytes; null otherwise. Race-free: the type and size checks and the read
// all use one descriptor opened with O_NOFOLLOW (a symlink fails to open, it is never resolved against the
// host filesystem) and O_NONBLOCK (a FIFO cannot block the wrapper).
export function readRegular(file: string, max: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
