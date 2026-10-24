// Download a whisper.cpp GGML model into ./models so local Whisper STT works.
//   node scripts/get-whisper-model.js            # base.en (~148 MB, good default)
//   node scripts/get-whisper-model.js tiny.en    # ~75 MB, fastest/lightest
//   node scripts/get-whisper-model.js small.en   # ~466 MB, more accurate
// Source: the official ggerganov/whisper.cpp HuggingFace repo.
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const name = (process.argv[2] || 'base.en').replace(/^ggml-|\.bin$/g, '');
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
const outDir = path.join(__dirname, '..', 'models');
const out = path.join(outDir, `ggml-${name}.bin`);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > 1024 * 1024) {
    console.log(`Model already present: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
    return;
  }
  console.log(`Downloading ggml-${name}.bin\n  from ${url}\n  to   ${out}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      const pct = total ? ((done / total) * 100).toFixed(1) : '?';
      process.stdout.write(`\r  ${pct}%  (${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(out));
  process.stdout.write('\n');
  console.log(`Done. Model saved to ${out}`);
  console.log('Now set this path in Settings > Speech (Whisper model), or point the');
  console.log('binary at it. You still need a whisper-cli executable (see README).');
})().catch((e) => {
  console.error('\n' + e.message);
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) {}
  process.exit(1);
});
