// Some GGUF conversions (gemma4:31b here) hand Ollama byte-fallback tokens that
// never get reassembled, so a character outside the model's merged vocabulary
// arrives as its raw UTF-8 bytes spelled out in text:
//
//   핥  ->  <0xED><0x95><0xA5>
//
// Streaming makes it worse: each byte is its own chunk, so the run only becomes
// decodable once the last byte lands. This puts the characters back together.

const TOKEN = /<0x([0-9A-Fa-f]{2})>/g;
const RUN = /(?:<0x[0-9A-Fa-f]{2}>)+/g;

// How many bytes a UTF-8 sequence starting with this byte must have. 0 means the
// byte can never start one (a continuation byte, or an over-long/invalid lead).
const sequenceLength = (byte) => {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
};

const literal = (bytes) =>
  bytes.map(b => `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`).join('');

// `fatal` is what makes this safe: anything that is not genuine UTF-8 throws and
// is written back out untouched rather than turning into replacement characters.
const strict = typeof TextDecoder === 'undefined' ? null : new TextDecoder('utf-8', { fatal: true });

const decodeRun = (run) => {
  const bytes = [...run.matchAll(TOKEN)].map(m => parseInt(m[1], 16));
  const out = [];
  let pending = [];
  let need = 0;

  for (const byte of bytes) {
    if (pending.length === 0) {
      need = sequenceLength(byte);
      // A stray continuation byte cannot begin anything — pass it straight
      // through instead of swallowing the bytes that follow it.
      if (need === 0) { out.push(literal([byte])); continue; }
      pending = [byte];
    } else {
      pending.push(byte);
    }

    if (pending.length === need) {
      try {
        out.push(strict.decode(new Uint8Array(pending)));
      } catch (e) {
        out.push(literal(pending));   // right length, wrong bytes
      }
      pending = [];
    }
  }

  // Whatever is left is a sequence that has not finished arriving. Handing it
  // back verbatim keeps this idempotent: the next frame sees the whole run.
  if (pending.length) out.push(literal(pending));
  return out.join('');
};

export const decodeByteFallback = (text) => {
  if (typeof text !== 'string') return text;
  if (!strict || text.indexOf('<0x') === -1) return text;   // the usual case, free
  return text.replace(RUN, decodeRun);
};

export const hasByteFallback = (text) =>
  typeof text === 'string' && /<0x[0-9A-Fa-f]{2}>/.test(text);
