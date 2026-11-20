/* ============================================================
   FILE STORAGE
   One interface, selected by STORAGE_DRIVER. The point of this file
   is that uploads are no longer hard-wired to a path inside the
   container.

   WHY THIS EXISTS: multer previously wrote straight to ./uploads,
   which on Railway is the container's own filesystem. That is wiped
   on every redeploy, so profile photos were being lost silently.
   UPLOAD_DIR now decides where bytes land, so mounting a Railway
   volume there makes them durable without a code change.

   Adding object storage later means implementing one more driver with
   the same four methods and setting STORAGE_DRIVER=s3 — no caller
   changes. It is deliberately NOT implemented here: shipping untested
   request-signing code would be worse than a clear error.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES) || 5 * 1024 * 1024;   // 5 MB
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES) || 40 * 1024 * 1024;  // 40 MB

// Allow-lists are on the sniffed bytes, not the client-supplied name, because a
// filename is attacker-controlled and tells us nothing about the content.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'
};
const VIDEO_TYPES = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};

// Magic-number sniffing. Cheap, and it stops an .html or a script being stored
// and then served back from our own origin.
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'video/webm';
  return null;
}

function validate(buffer, kind) {
  if (!buffer || !buffer.length) return { error: 'The file was empty.' };
  const detected = sniff(buffer);
  if (!detected) return { error: 'That file type is not supported.' };
  const table = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
  const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!table[detected]) {
    return { error: kind === 'video' ? 'Upload an MP4, WebM or MOV video.' : 'Upload a JPEG, PNG, WebP or GIF image.' };
  }
  if (buffer.length > limit) {
    return { error: `That file is too large. The limit is ${Math.round(limit / (1024 * 1024))} MB.` };
  }
  return { contentType: detected, ext: table[detected] };
}

/* ---------- local driver ---------- */
// Writes under UPLOAD_DIR. Keys are namespaced by owner so one user's upload can
// never overwrite another's, and the filename is random rather than
// client-supplied (a client-supplied name is a path-traversal invitation).
function localDriver() {
  const root = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  fs.mkdirSync(root, { recursive: true });
  const resolveKey = key => {
    const full = path.resolve(root, key);
    // Defence in depth: never write or delete outside the root.
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Refusing a path outside the upload root');
    return full;
  };
  return {
    name: 'local',
    root,
    async put(buffer, { kind, ownerId, scope }) {
      const v = validate(buffer, kind);
      if (v.error) return { error: v.error };
      const key = path.posix.join(
        String(scope || 'misc'),
        String(Number(ownerId) || 0),
        crypto.randomBytes(16).toString('hex') + v.ext
      );
      const full = resolveKey(key);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, buffer);
      return { key, url: '/uploads/' + key, contentType: v.contentType, bytes: buffer.length };
    },
    async remove(key) {
      if (!key) return;
      try { await fs.promises.unlink(resolveKey(key)); } catch { /* already gone */ }
    },
    urlFor(key) { return key ? '/uploads/' + key : null; },
    // Resolve a public /uploads/... URL back to a storage key, so a delete can
    // be authorised against the row that owns it.
    keyFromUrl(url) {
      const m = String(url || '').match(/^\/uploads\/(.+)$/);
      return m ? m[1] : null;
    }
  };
}

function createDriver() {
  const name = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (name === 'local') return localDriver();
  // Fail loudly and early. A misconfigured driver that silently fell back to
  // local would lose files on the next redeploy, which is the exact bug this
  // module exists to fix.
  throw new Error(
    `STORAGE_DRIVER="${name}" is not implemented. Only "local" ships today.\n` +
    `To use object storage, implement a driver with put/remove/urlFor/keyFromUrl in src/storage.js ` +
    `(S3 or Cloudflare R2 need S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY ` +
    `plus the @aws-sdk/client-s3 dependency), then set STORAGE_DRIVER to it. ` +
    `Unset STORAGE_DRIVER to keep using the local directory.`
  );
}

const storage = createDriver();
module.exports = { storage, validate, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, IMAGE_TYPES, VIDEO_TYPES };
