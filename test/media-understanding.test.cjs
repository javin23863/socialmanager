const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileHash, parseTimedText, parseTranscriptionResponse, parseVisionResponse, readAuthorizedTranscript, transcriptionEndpoint } = require('../src/core/media-understanding.cjs');

test('authorized timed text preserves timestamps and source hashes for every segment', () => {
  const sourceHash = 'caption-file-hash';
  const segments = parseTimedText(`WEBVTT\n\n00:00:01.000 --> 00:00:03.250\nRates hold the first move.\n\n00:00:04.000 --> 00:00:05.500\nBreadth is the confirmation.`, { sourceId: 'youtube_caption_track:track-1', sourceHash });
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => [segment.startMs, segment.endMs]), [[1000, 3250], [4000, 5500]]);
  assert.ok(segments.every((segment) => segment.sourceId === 'youtube_caption_track:track-1' && segment.sourceHash === sourceHash));
});

test('user-supplied transcript provenance is a file hash, not an untraceable text blob', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'social-engagement-studio-media-'));
  const transcriptPath = path.join(directory, 'captions.vtt');
  fs.writeFileSync(transcriptPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest the retest.\n');
  const file = fileHash(transcriptPath);
  const result = readAuthorizedTranscript(transcriptPath);
  assert.equal(result.provenance.sourceHash, file.sha256);
  assert.equal(result.segments[0].sourceHash, file.sha256);
  assert.equal(result.segments[0].timestamp, '0-1000');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('configured transcription preserves provider segments or falls back to the authorized media hash', () => {
  const result = parseTranscriptionResponse({ segments: [{ start: 1.25, end: 3.5, text: 'The retest is the confirmation.' }] }, { sourceId: 'provider_transcription:media-hash', sourceHash: 'media-hash', model: 'whisper-local' });
  assert.deepEqual(result[0], {
    id: 'provider_transcription:media-hash:1',
    text: 'The retest is the confirmation.',
    startMs: 1250,
    endMs: 3500,
    timestamp: '1250-3500',
    sourceId: 'provider_transcription:media-hash',
    sourceHash: 'media-hash',
    format: 'provider_transcription',
  });
  const fallback = parseTranscriptionResponse({ text: 'A transcript without segment timestamps.' }, { sourceId: 'provider_transcription:media-hash', sourceHash: 'media-hash', model: 'whisper-local' });
  assert.equal(fallback[0].timestamp, 'media-file-hash');
  assert.equal(fallback[0].sourceHash, 'media-hash');
  assert.equal(transcriptionEndpoint('https://provider.example/v1').pathname, '/v1/audio/transcriptions');
  assert.equal(transcriptionEndpoint('https://provider.example/v1/chat/completions').pathname, '/v1/audio/transcriptions');
});

test('vision observations bind to supplied frame indexes and inherit exact timestamps', () => {
  const frames = [
    { frameIndex: 0, timestampMs: 0, sourceHash: 'frame-zero' },
    { frameIndex: 1, timestampMs: 4200, sourceHash: 'frame-one' },
  ];
  const result = parseVisionResponse(JSON.stringify({ observations: [{ frameIndex: 1, text: 'A breadth panel is visible beside the yield chart.' }] }), frames);
  assert.deepEqual(result, [{
    frameIndex: 1,
    timestampMs: 4200,
    text: 'A breadth panel is visible beside the yield chart.',
    sourceHash: 'frame-one',
    sourceId: 'local_frame:frame-one',
  }]);
  assert.throws(() => parseVisionResponse(JSON.stringify({ observations: [{ frameIndex: 9, text: 'Not supplied' }] }), frames), /without a supplied frame/);
});
