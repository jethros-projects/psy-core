import { createHash, randomBytes } from "node:crypto";

import { canonicalJson } from "./canonical.js";

export const SHA256_HEX_LENGTH = 64;
export const GENESIS_DOMAIN = "psy-genesis-v1";
export const EVENT_HASH_DOMAIN = "psy-event-v1";

export type HashInput = string | Buffer | Uint8Array;

export function sha256Hex(input: HashInput): string {
  return createHash("sha256").update(input).digest("hex");
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export function randomGenesisNonce(): string {
  return randomBytes(32).toString("hex");
}

export function genesisMaterial(nonce: string): string {
  return `${nonce.normalize("NFC")}${GENESIS_DOMAIN}`;
}

export function genesisHash(nonce: string): string {
  return sha256Hex(genesisMaterial(nonce));
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function canonicalJsonHash(value: unknown): string {
  return hashCanonical(value);
}

export function eventHash(material: unknown): string {
  return hashCanonical({
    domain: EVENT_HASH_DOMAIN,
    material,
  });
}

export function eventHashPayload(row: Record<string, unknown>): Record<string, unknown> {
  const { event_hash: _eventHash, hash: _hash, ...payload } = row;
  return payload;
}

export function computeEventHash(row: Record<string, unknown>): string {
  return hashCanonical(eventHashPayload(row));
}
