import { createHash } from "node:crypto";

/** An IR node: a tag-first S-expression. Arrays and strings only, so serialization is canonical. */
export type IR = string | IR[];

/** The hash format. Every hash depends on it (through DOMAIN). */
export const IR_VERSION = 1;
const DOMAIN = `tcm-ir-v${IR_VERSION}\0`;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function serializeIR(ir: IR): string {
  return JSON.stringify(ir);
}

export function hashIR(ir: IR): string {
  return base32(createHash("sha256").update(DOMAIN + serializeIR(ir)).digest());
}

export const HASH_RE = /^[a-z2-7]{52}$/;

/** Identifier used as the export name of a definition in generated modules. */
export function exportId(hash: string): string {
  return `h_${hash}`;
}

export function hashFromExportId(id: string): string | undefined {
  const m = /^h_([a-z2-7]{52})$/.exec(id);
  return m?.[1];
}

export function shortHash(hash: string, len = 8): string {
  return `#${hash.slice(0, len)}`;
}
