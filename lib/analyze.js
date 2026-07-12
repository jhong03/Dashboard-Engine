'use strict';

// Post-synthesis measurement: median F0 and durations, computed directly on
// the PCM with a compact YIN-style pitch tracker. No DSP dependency on
// purpose (CLAUDE.md: dependency-light) — this is ~100 lines and good enough
// for a tuning readout, which needs to be honest, not laboratory-grade.
//
// This powers a headline UI feature: after every synthesis the user sees the
// MEASURED F0 and rate next to their targets, so they tune toward a number.

// Human speech fundamentals live comfortably in this window; anything the
// pitch shifter drags outside it is clamped by the profile ranges anyway
// (±12 st on ~60–260 Hz voices stays inside 50–400).
const F0_MIN_HZ = 50;
const F0_MAX_HZ = 400;

// 40 ms frames: at least two full periods of the lowest F0 we search for.
const FRAME_MS = 40;
const HOP_MS = 10;

// YIN threshold — the first CMNDF dip below this is taken as the period.
// 0.15 is the standard "clean speech" setting.
const YIN_THRESHOLD = 0.15;

// Frames quieter than this fraction of the clip's peak RMS are treated as
// silence and excluded from pitch tracking.
const VOICED_RMS_FLOOR = 0.1;

// Sample amplitude below which we call it silence when trimming edges.
// Piper output has a near-digital-black noise floor, so this can be low.
const TRIM_THRESHOLD = 0.005;

function pcmToFloats(pcm) {
  // s16le mono → Float32 in [-1, 1)
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

function rms(samples, start, length) {
  let sum = 0;
  for (let i = start; i < start + length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / length);
}

// YIN cumulative-mean-normalized difference over one frame. Returns the best
// period in samples, or 0 if the frame doesn't look periodic (unvoiced).
function detectPeriod(samples, start, frameLen, minLag, maxLag) {
  const half = Math.floor(frameLen / 2);
  const searchMax = Math.min(maxLag, half);
  if (minLag >= searchMax) return 0;

  // Difference function d(tau)
  const diff = new Float32Array(searchMax + 1);
  for (let tau = minLag; tau <= searchMax; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const delta = samples[start + i] - samples[start + i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalisation, computed over the full lag range so the
  // normaliser is meaningful at the low lags too.
  let runningSum = 0;
  const cmndf = new Float32Array(searchMax + 1);
  cmndf[0] = 1;
  for (let tau = 1; tau <= searchMax; tau++) {
    runningSum += diff[tau] || 0;
    cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  // First dip under threshold wins; walk to the local minimum of that dip.
  for (let tau = minLag; tau <= searchMax; tau++) {
    if (cmndf[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= searchMax && cmndf[tau + 1] < cmndf[tau]) tau++;
      // Parabolic interpolation around the minimum for sub-sample precision —
      // worth ~1 Hz of accuracy at typical speech F0, basically free.
      if (tau > minLag && tau < searchMax) {
        const a = cmndf[tau - 1], b = cmndf[tau], c = cmndf[tau + 1];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) > 1e-9) {
          return tau + (a - c) / (2 * denom); // vertex offset, always in (-1, 1)
        }
      }
      return tau;
    }
  }
  return 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Leading/trailing silence (e.g. Piper's --sentence-silence tail) would
// inflate the words-per-minute figure, so rate is computed over the speech
// span only.
function trimmedSpanSeconds(samples, sampleRate) {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < TRIM_THRESHOLD) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < TRIM_THRESHOLD) last--;
  return first >= last ? 0 : (last - first + 1) / sampleRate;
}

/**
 * Measure a synthesized clip.
 * @param {Buffer} pcm s16le mono
 * @param {number} sampleRate
 * @returns {{ durationSeconds, speechSeconds, medianF0Hz, voicedFraction }}
 *   medianF0Hz is 0 when nothing voiced was found (e.g. silence).
 */
function analyzePcm(pcm, sampleRate) {
  const samples = pcmToFloats(pcm);
  const durationSeconds = samples.length / sampleRate;
  const speechSeconds = trimmedSpanSeconds(samples, sampleRate);

  const frameLen = Math.floor((FRAME_MS / 1000) * sampleRate);
  const hop = Math.floor((HOP_MS / 1000) * sampleRate);
  const minLag = Math.floor(sampleRate / F0_MAX_HZ);
  const maxLag = Math.ceil(sampleRate / F0_MIN_HZ);

  // Voicing gate is relative to this clip's own level, so it survives the
  // loudness the DSP chain applied.
  let peakRms = 0;
  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    peakRms = Math.max(peakRms, rms(samples, start, frameLen));
  }

  const f0s = [];
  let framesTotal = 0;
  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    framesTotal++;
    if (rms(samples, start, frameLen) < peakRms * VOICED_RMS_FLOOR) continue;
    const period = detectPeriod(samples, start, frameLen, minLag, maxLag);
    if (period > 0) {
      f0s.push(sampleRate / period);
    }
  }

  return {
    durationSeconds,
    speechSeconds,
    medianF0Hz: median(f0s),
    voicedFraction: framesTotal > 0 ? f0s.length / framesTotal : 0,
  };
}

/**
 * Measured speaking rate for the clip, given the text that was spoken.
 * Uses the trimmed speech span so trailing sentence-silence doesn't dilute it.
 */
function wordsPerMinute(text, speechSeconds) {
  if (speechSeconds <= 0) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (words / speechSeconds) * 60;
}

module.exports = {
  analyzePcm,
  wordsPerMinute,
};
