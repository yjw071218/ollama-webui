// Just enough CBOR to read what WebAuthn sends.
//
// An attestation object and a COSE public key are both CBOR, and the whole of
// what appears in them is: unsigned integers, negative integers, byte strings,
// text strings, arrays, maps, and the three simple values. Pulling in a full
// CBOR library for that is a dependency that has to be trusted with the bytes
// an unauthenticated caller supplies, which is the last place to want one.
//
// Everything here is bounds-checked and refuses indefinite-length items, which
// WebAuthn does not use and which are the usual source of decoder trouble.

const MAJOR = {
  UNSIGNED: 0, NEGATIVE: 1, BYTES: 2, TEXT: 3, ARRAY: 4, MAP: 5, TAG: 6, SIMPLE: 7,
};

class Reader {
  constructor(buffer) {
    this.view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.offset = 0;
  }

  need(count) {
    if (this.offset + count > this.view.length) throw new Error('Truncated CBOR.');
  }

  byte() {
    this.need(1);
    return this.view[this.offset++];
  }

  bytes(count) {
    this.need(count);
    const out = this.view.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** The argument encoded in the low five bits, following the CBOR rules. */
  argument(info) {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) { const b = this.bytes(2); return b.readUInt16BE(0); }
    if (info === 26) { const b = this.bytes(4); return b.readUInt32BE(0); }
    if (info === 27) {
      const b = this.bytes(8);
      const value = b.readBigUInt64BE(0);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer out of range.');
      return Number(value);
    }
    // 28-30 are reserved; 31 is indefinite length, which WebAuthn never uses.
    throw new Error('Unsupported CBOR length encoding.');
  }

  value() {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case MAJOR.UNSIGNED:
        return this.argument(info);
      case MAJOR.NEGATIVE:
        return -1 - this.argument(info);
      case MAJOR.BYTES:
        return Buffer.from(this.bytes(this.argument(info)));
      case MAJOR.TEXT:
        return this.bytes(this.argument(info)).toString('utf8');
      case MAJOR.ARRAY: {
        const length = this.argument(info);
        const out = [];
        for (let i = 0; i < length; i++) out.push(this.value());
        return out;
      }
      case MAJOR.MAP: {
        const length = this.argument(info);
        // A Map, not an object: COSE keys are integers, and integer keys turn
        // into strings on a plain object where -1 and "-1" then collide.
        const out = new Map();
        for (let i = 0; i < length; i++) {
          const key = this.value();
          out.set(key, this.value());
        }
        return out;
      }
      case MAJOR.TAG:
        // Tags decorate the item that follows; none of them change how the
        // structures here are read, so the tag itself is dropped.
        this.argument(info);
        return this.value();
      case MAJOR.SIMPLE:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error('Unsupported CBOR simple value.');
      default:
        throw new Error('Unsupported CBOR major type.');
    }
  }
}

/** Decode one CBOR item, and report how many bytes followed it. */
export const decodeFirst = (buffer) => {
  const reader = new Reader(buffer);
  const value = reader.value();
  return { value, bytesRead: reader.offset, rest: reader.view.subarray(reader.offset) };
};

export const decode = (buffer) => {
  const { value, rest } = decodeFirst(buffer);
  if (rest.length) throw new Error('Trailing bytes after CBOR item.');
  return value;
};
