/**
 * The `snd` half of the ABI, the audio register block it writes, and the synth
 * that reads it.
 *
 * ONE-WAY STREET. The simulation writes registers; the mixer reads them. Nothing
 * flows back. An `AudioContext` runs on its own hardware clock, which drifts
 * against `requestAnimationFrame` and differs per device, so anything in the
 * simulation derived from audio would be nondeterministic — and worse,
 * nondeterministic only on some hardware.
 *
 * That is also why the specification leaves audio NON-NORMATIVE: mixing quality
 * may differ between a phone and a desktop without any replay diverging. The
 * registers are in RAM and therefore in every snapshot; the synth's phase
 * accumulators are not, because nothing reads them back.
 *
 * Read the consequence carefully, because it is the shape of this file:
 *
 *   - Everything the SIMULATION owns lives in RAM. Register writes, the sfx
 *     sequencer's position, the music sequencer's position. `snapshot()` is
 *     still a memcpy, and a rewind puts the music back where it was.
 *   - Everything the MIXER owns lives in `SynthState`, outside RAM, on the
 *     player side. Phase accumulators, the noise LFSR, envelope levels. Putting
 *     them in RAM would make the audio output normative, which it is not.
 *   - The mixer NEVER sees anything but the 80 register bytes. That single fact
 *     decides the layout below: if the mixer must read it, it is in
 *     0x2110..0x215F, and if only the simulation reads it, it is not.
 *
 * ===========================================================================
 * CHANNEL REGISTERS — 4 channels x 16 bytes at 0x2110 (ADDR.AUDIO_CH)
 * ===========================================================================
 * Channel `c` starts at 0x2110 + c * 16.
 *
 * | off | name      | meaning                                                  |
 * |-----|-----------|----------------------------------------------------------|
 * | 0x0 | CTRL      | b7 ENABLE, b6 GATE, b5..4 OWNER, b3..0 reserved (0)      |
 * | 0x1 | WAVE      | b3..0 waveform id, b7..4 reserved (0)                    |
 * | 0x2 | VOL       | u8 linear channel volume, 0..255                        |
 * | 0x3 | DUTY      | pulse duty as n/256. **0 reads as 0x80 (50%)**.          |
 * |     |           | noise: b0 selects the short (period 93) LFSR tap.       |
 * | 0x4 | PITCH_LO  | u16 LE, frequency in 1/16 Hz — 0 .. 4095.9375 Hz        |
 * | 0x5 | PITCH_HI  |                                                          |
 * | 0x6 | TRIG      | u8 retrigger counter. Any CHANGE restarts phase,         |
 * |     |           | LFSR and envelope. It is a counter and not a flag        |
 * |     |           | because the mixer may never write back to clear one.     |
 * | 0x7 | PAN       | 0 left .. 128 centre .. 255 right. The reference mixer   |
 * |     |           | is mono and ignores it; a stereo mixer may not.          |
 * | 0x8 | ENV_A     | attack  time, units of 4 ms (0..1020 ms). 0 = instant.   |
 * | 0x9 | ENV_D     | decay   time, units of 4 ms. **0 = no decay stage**.     |
 * | 0xA | ENV_S     | sustain level 0..255. Only used when ENV_D > 0.          |
 * | 0xB | ENV_R     | release time, units of 4 ms. 0 = instant.                |
 * | 0xC | SEQ_SFX   | sequencer: 0 = idle, else (sfx index + 1). Sim-only.     |
 * | 0xD | SEQ_STEP  | sequencer: next step index within that sfx. Sim-only.    |
 * | 0xE | SEQ_TICK  | sequencer: frames left in the current step. Sim-only.    |
 * | 0xF | SEQ_VOL   | sequencer: the step's volume before music fade. Sim-only.|
 *
 * OWNER (CTRL b5..4): 0 = the cart wrote this channel by hand, 1 = an `sfx()`
 * call owns it, 2 = the music sequencer owns it. It exists so `sfx(n)` with no
 * channel can pick one without stealing the song, and so `music()` never
 * silences a channel a cart is driving itself.
 *
 * A zeroed machine is a valid silent machine: ENABLE 0 everywhere, DUTY 0
 * meaning a square wave rather than a zero-width pulse, ENV_D 0 meaning "no
 * envelope, full level while gated". A cart can make a sound by writing four
 * bytes (CTRL, PITCH_LO, PITCH_HI, VOL) and nothing else.
 *
 * ===========================================================================
 * MASTER BLOCK — 16 bytes at 0x2150 (ADDR.AUDIO_MASTER)
 * ===========================================================================
 * The whole block is the **user wavetable**: 32 steps, 4 bits each, packed two
 * per byte with the EVEN step in the LOW nibble — the same convention the
 * framebuffer uses, so there is one packing rule in the machine and not two.
 *
 * | off       | meaning                                                       |
 * |-----------|---------------------------------------------------------------|
 * | 0x0..0xF  | wavetable step 2k = low nibble of byte k, step 2k+1 = high     |
 *
 * A step is a SIGNED 4-bit sample: 0..7 is 0..+7, 8..15 is -8..-1, and the
 * amplitude is that value over 8. A zeroed table is therefore silence rather
 * than a full-scale DC step, which is what you want from a machine that boots
 * with its RAM cleared.
 *
 * There is deliberately **no master volume register.** The user's volume knob
 * belongs to the host, not to the machine — a cart must not be able to observe
 * or fight it, and a music fade is done by the sequencer scaling the channel
 * volumes, which keeps the fade inside the deterministic simulation where it
 * can be replayed. The 16 bytes go to the wavetable instead, because the
 * wavetable is the one piece of global audio data the mixer has to be able to
 * read, and the register block is the only thing the mixer ever sees.
 *
 * ===========================================================================
 * SFX BANK — 32 effects x 104 bytes at 0x6300 (ADDR.SFX), exactly 3328 bytes
 * ===========================================================================
 * Effect `n` starts at 0x6300 + n * 104: an 8-byte header, then 32 steps of 3
 * bytes each.
 *
 * | off       | name       | meaning                                          |
 * |-----------|------------|--------------------------------------------------|
 * | 0x00      | SPEED      | frames per step. 0 reads as 1.                   |
 * | 0x01      | LENGTH     | steps used, 0..32. 0 = the effect is silent.     |
 * | 0x02      | LOOP_START | step index to jump back to                       |
 * | 0x03      | LOOP_END   | loop is active only when LOOP_END > LOOP_START   |
 * | 0x04      | ENV_A      | copied into the channel's ENV_A when the effect  |
 * | 0x05      | ENV_D      | starts, so an effect carries its own envelope    |
 * | 0x06      | ENV_S      | and a cart never has to set one up first         |
 * | 0x07      | ENV_R      |                                                  |
 * | 0x08+3k+0 | NOTE       | 0..95 semitones from C0. 255 = rest (gate off).  |
 * |           |            | 96..254 are reserved and read as a rest.         |
 * | 0x08+3k+1 | MIX        | b7..4 volume 0..15 (x17), b3..0 waveform id      |
 * | 0x08+3k+2 | FX         | b7..4 effect, b3..0 parameter                    |
 *
 * FX effects: 0 NONE (retrigger the envelope on this step), 1 LEGATO (change
 * pitch, volume and waveform without retriggering), 2 DUTY (also set the
 * channel's DUTY to (param << 4) | 8). 3..15 are reserved and read as NONE.
 *
 * ===========================================================================
 * MUSIC — 255 patterns x 8 bytes + 8 bytes of state at 0x7000 (ADDR.MUSIC)
 * ===========================================================================
 * Pattern `p` (0..254) starts at 0x7000 + p * 8. 255 * 8 = 2040 bytes, and the
 * last 8 bytes of the region, at 0x77F8, are the sequencer's live position.
 *
 * | off  | name      | meaning                                                 |
 * |------|-----------|---------------------------------------------------------|
 * | +0   | SFX_CH0   | 0 = this pattern leaves channel 0 alone, else id + 1    |
 * | +1   | SFX_CH1   |                                                          |
 * | +2   | SFX_CH2   |                                                          |
 * | +3   | SFX_CH3   |                                                          |
 * | +4   | FLAGS     | b0 LOOP_START, b1 LOOP_END, b2 STOP                     |
 * | +5.7 | reserved  | must be 0                                                |
 *
 * A pattern plays up to four effects at once and ends when every channel it
 * claimed has finished its effect. Then: STOP ends the song, LOOP_END returns
 * to the most recent LOOP_START, otherwise pattern p + 1 plays.
 *
 * SEQUENCER STATE at 0x77F8 — simulation-only, never read by the mixer:
 *
 * | off | name      | meaning                                                  |
 * |-----|-----------|----------------------------------------------------------|
 * | +0  | FLAGS     | b0 PLAYING, b1 FADING_OUT, b2 PENDING (start on next tick)|
 * | +1  | PATTERN   | the pattern index playing or about to play               |
 * | +2  | MASK      | which channels the song is allowed to use                |
 * | +3  | FADE_LEN  | fade length in frames, 0 = no fade                       |
 * | +4  | FADE_POS  | frames elapsed into the fade                             |
 * | +5  | LOOP_PAT  | the pattern LOOP_END returns to                          |
 * | +6.7| reserved  | must be 0                                                |
 *
 * It lives at the end of the MUSIC region rather than in the master block for
 * the reason given above: the master block is the only room the mixer can see,
 * and the sequencer runs in the simulation. Pattern data therefore occupies
 * 0x7000..0x77F7 and a cart's music payload is 2040 bytes, not 2048.
 *
 * ===========================================================================
 * THE SYNTH IS A PURE FUNCTION, AND IT IS CLOSURE-FREE ON PURPOSE
 * ===========================================================================
 * `createSynthState` and `renderAudio` reference NOTHING outside their own
 * bodies — no module constant, no helper, no import. They repeat their offsets
 * as local `const`s instead.
 *
 * That is not an oversight, it is the mechanism that keeps the AudioWorklet
 * honest. A worklet runs in its own realm and is loaded from a source string,
 * so the player builds that string from `renderAudio.toString()` rather than
 * from a transcription. There is one implementation of the synth in this
 * repository and the worklet is literally made of it. A function that reached
 * for a module-scope constant would serialise into a `ReferenceError` in the
 * worklet, so `audio.test.ts` reconstitutes both functions from their own
 * source text and asserts the reconstructed synth renders bit-identical
 * samples. Adding a free variable turns that test red immediately.
 *
 * `renderAudio` also allocates nothing: it runs inside an audio callback, where
 * a collection pause is an audible click. Every scratch array it needs was
 * allocated once by `createSynthState`.
 */

import { ADDR, LEN } from "./memory";

/** What a cart can ask of the sound hardware. */
export interface SndApi {
  /** Play effect `n`. `ch` picks a channel; omitted means "any free one". */
  sfx(n: number, ch?: number): void;
  /** Start pattern `n`. `fade` in frames, `mask` selects channels. */
  music(n: number, fade?: number, mask?: number): void;
}

/** The bytes the mixer reads: the four channel blocks plus the master block. */
export const AUDIO_REGS_START = ADDR.AUDIO_CH;
export const AUDIO_REGS_BYTES = LEN.AUDIO_CH + LEN.AUDIO_MASTER;

/** Channels, and the stride between their register blocks. */
export const AUDIO_CHANNELS = 4;
export const CH_STRIDE = 16;

/** Byte offsets inside one channel's 16-byte block. */
export const CH = {
  CTRL: 0x0,
  WAVE: 0x1,
  VOL: 0x2,
  DUTY: 0x3,
  PITCH_LO: 0x4,
  PITCH_HI: 0x5,
  TRIG: 0x6,
  PAN: 0x7,
  ENV_A: 0x8,
  ENV_D: 0x9,
  ENV_S: 0xa,
  ENV_R: 0xb,
  SEQ_SFX: 0xc,
  SEQ_STEP: 0xd,
  SEQ_TICK: 0xe,
  SEQ_VOL: 0xf,
} as const;

/** CTRL bits. */
export const CTRL_ENABLE = 0x80;
export const CTRL_GATE = 0x40;
export const CTRL_OWNER_MASK = 0x30;
export const CTRL_OWNER_SHIFT = 4;

/** Who is driving a channel. */
export const OWNER = { CART: 0, SFX: 1, MUSIC: 2 } as const;

/** Waveform ids in the low nibble of WAVE. Ids 5..15 are reserved: silence. */
export const WAVE = { PULSE: 0, TRIANGLE: 1, SAW: 2, NOISE: 3, WAVETABLE: 4 } as const;

/** The user wavetable: the whole master block, 32 steps at 4 bits. */
export const WAVETABLE_ADDR = ADDR.AUDIO_MASTER;
export const WAVETABLE_STEPS = 32;
/** The wavetable's offset inside the 80-byte register block the mixer sees. */
export const WAVETABLE_REG_OFFSET = LEN.AUDIO_CH;

/** The SFX bank: 32 effects of 104 bytes each is exactly LEN.SFX. */
export const SFX_COUNT = 32;
export const SFX_STRIDE = 104;
export const SFX_STEPS = 32;
export const SFX_STEP_BYTES = 3;
export const SFX_STEPS_OFFSET = 8;

/** Byte offsets inside an effect's 8-byte header. */
export const SFX_HDR = {
  SPEED: 0,
  LENGTH: 1,
  LOOP_START: 2,
  LOOP_END: 3,
  ENV_A: 4,
  ENV_D: 5,
  ENV_S: 6,
  ENV_R: 7,
} as const;

/** Byte offsets inside one 3-byte step. */
export const SFX_STEP = { NOTE: 0, MIX: 1, FX: 2 } as const;

/** Step effects, in the high nibble of FX. */
export const SFX_FX = { NONE: 0, LEGATO: 1, DUTY: 2 } as const;

/** The note value that means "rest": release the gate and hold the pitch. */
export const SFX_REST = 255;

/** Music: 255 patterns of 8 bytes, then 8 bytes of sequencer state. */
export const MUSIC_PATTERNS = 255;
export const MUSIC_PATTERN_BYTES = 8;
export const MUSIC_STATE_ADDR = ADDR.MUSIC + MUSIC_PATTERNS * MUSIC_PATTERN_BYTES;

/** Byte offsets inside a pattern record. */
export const PAT = { SFX0: 0, SFX1: 1, SFX2: 2, SFX3: 3, FLAGS: 4 } as const;
export const PAT_LOOP_START = 0x01;
export const PAT_LOOP_END = 0x02;
export const PAT_STOP = 0x04;

/** Byte offsets inside the 8-byte sequencer state block. */
export const MUS = {
  FLAGS: 0,
  PATTERN: 1,
  MASK: 2,
  FADE_LEN: 3,
  FADE_POS: 4,
  LOOP_PAT: 5,
} as const;
export const MUS_PLAYING = 0x01;
export const MUS_FADING_OUT = 0x02;
export const MUS_PENDING = 0x04;

/**
 * Semitone index -> frequency in 1/16 Hz, 96 entries, note 0 = C0 and note 57 =
 * A4 = 440 Hz.
 *
 * A TABLE, not `Math.pow`. This value is written into PITCH, PITCH is in RAM,
 * and RAM is hashed — so the conversion has to produce the same integer on
 * every engine. `Math.pow` is not specified to, and the whole determinism story
 * of this project is that we do not find out the hard way. B7 is 63217, which
 * fits u16 with room to spare.
 */
export const NOTE_HZ16: Uint16Array = new Uint16Array([
  262, 277, 294, 311, 330, 349, 370, 392, 415, 440, 466, 494,
  523, 554, 587, 622, 659, 698, 740, 784, 831, 880, 932, 988,
  1047, 1109, 1175, 1245, 1319, 1397, 1480, 1568, 1661, 1760, 1865, 1976,
  2093, 2217, 2349, 2489, 2637, 2794, 2960, 3136, 3322, 3520, 3729, 3951,
  4186, 4435, 4699, 4978, 5274, 5588, 5920, 6272, 6645, 7040, 7459, 7902,
  8372, 8870, 9397, 9956, 10548, 11175, 11840, 12544, 13290, 14080, 14917, 15804,
  16744, 17740, 18795, 19912, 21096, 22351, 23680, 25088, 26580, 28160, 29834, 31609,
  33488, 35479, 37589, 39824, 42192, 44701, 47359, 50175, 53159, 56320, 59669, 63217,
]);

/**
 * Copy the audio register block out of RAM.
 *
 * This is what crosses to the main thread each frame. It is a copy rather than a
 * view because the frame message hands ownership across a thread boundary, and
 * because the mixer must never be able to write to the machine.
 */
export function readAudioRegs(ram: Uint8Array, out: Uint8Array): void {
  out.set(ram.subarray(AUDIO_REGS_START, AUDIO_REGS_START + AUDIO_REGS_BYTES));
}

// ---------------------------------------------------------------------------
// The synth. Closure-free by contract — see the header.
// ---------------------------------------------------------------------------

/**
 * Everything the mixer remembers between buffers, and none of it is machine
 * state. It is not in RAM, it is not in a snapshot, and nothing can read it
 * back into the simulation.
 *
 * Every field is a preallocated typed array so that `renderAudio` can decode a
 * frame's registers into per-channel scratch without allocating. The `c*`
 * fields are that scratch: they are rewritten at the top of every call and
 * carry nothing between calls.
 */
export interface SynthState {
  /** Oscillator phase in [0, 1) per channel. */
  readonly phase: Float64Array;
  /** Noise clock phase per channel. */
  readonly noisePhase: Float64Array;
  /** 15-bit LFSR per channel, never zero. */
  readonly lfsr: Uint16Array;
  /** Envelope level in [0, 1] per channel. */
  readonly envLevel: Float64Array;
  /** 0 idle, 1 attack, 2 decay, 3 sustain, 4 release. */
  readonly envStage: Uint8Array;
  /** The TRIG byte as it was last seen, to detect a change. */
  readonly lastTrig: Uint8Array;
  /** The 32 unpacked signed wavetable steps. */
  readonly wave: Int8Array;
  /** Decoded per-channel scratch, valid only within one `renderAudio` call. */
  readonly cEnable: Uint8Array;
  readonly cWave: Uint8Array;
  readonly cShort: Uint8Array;
  readonly cHasDecay: Uint8Array;
  readonly cInc: Float64Array;
  readonly cNoiseInc: Float64Array;
  readonly cVol: Float64Array;
  readonly cDuty: Float64Array;
  readonly cAttack: Float64Array;
  readonly cDecay: Float64Array;
  readonly cSustain: Float64Array;
  readonly cRelease: Float64Array;
}

/**
 * Allocate a mixer's worth of state. Called once per audio graph, never in a
 * callback.
 *
 * CLOSURE-FREE: this function's source text is serialised into the AudioWorklet
 * realm verbatim, so it may not name anything outside itself.
 */
export function createSynthState(): SynthState {
  const lfsr = new Uint16Array(4);
  lfsr.fill(1);
  return {
    phase: new Float64Array(4),
    noisePhase: new Float64Array(4),
    lfsr,
    envLevel: new Float64Array(4),
    envStage: new Uint8Array(4),
    lastTrig: new Uint8Array(4),
    wave: new Int8Array(32),
    cEnable: new Uint8Array(4),
    cWave: new Uint8Array(4),
    cShort: new Uint8Array(4),
    cHasDecay: new Uint8Array(4),
    cInc: new Float64Array(4),
    cNoiseInc: new Float64Array(4),
    cVol: new Float64Array(4),
    cDuty: new Float64Array(4),
    cAttack: new Float64Array(4),
    cDecay: new Float64Array(4),
    cSustain: new Float64Array(4),
    cRelease: new Float64Array(4),
  };
}

/**
 * Fill `out` with `out.length` mono samples in [-1, 1], advancing `state`.
 *
 * `regs` is one frame's 80 register bytes and is constant for the whole buffer,
 * so it is decoded once up front and the sample loop touches only numbers.
 *
 * ALLOCATES NOTHING. CLOSURE-FREE: this function's source text is serialised
 * into the AudioWorklet realm verbatim, so it may not name anything outside
 * itself — that is why the offsets below are repeated as local constants
 * instead of imported from `CH`. `audio.test.ts` pins both properties.
 */
export function renderAudio(
  regs: Uint8Array,
  state: SynthState,
  out: Float32Array,
  sampleRate: number,
): void {
  const NCH = 4;
  const STRIDE = 16;
  const O_CTRL = 0;
  const O_WAVE = 1;
  const O_VOL = 2;
  const O_DUTY = 3;
  const O_PITCH_LO = 4;
  const O_PITCH_HI = 5;
  const O_TRIG = 6;
  const O_ENV_A = 8;
  const O_ENV_D = 9;
  const O_ENV_S = 10;
  const O_ENV_R = 11;
  const WT_OFFSET = 64;
  const ENV_UNIT = 0.004; // ENV_A/D/R are in units of 4 ms

  const n = out.length;
  const sr = sampleRate > 0 ? sampleRate : 44100;
  const dt = 1 / sr;

  // A short register block is not a thing the machine produces; if one ever
  // arrives, the honest answer is silence rather than NaN in the speakers.
  if (regs.length < NCH * STRIDE + 16) {
    for (let i = 0; i < n; i++) out[i] = 0;
    return;
  }

  const phase = state.phase;
  const noisePhase = state.noisePhase;
  const lfsr = state.lfsr;
  const envLevel = state.envLevel;
  const envStage = state.envStage;
  const lastTrig = state.lastTrig;
  const wave = state.wave;
  const cEnable = state.cEnable;
  const cWave = state.cWave;
  const cShort = state.cShort;
  const cHasDecay = state.cHasDecay;
  const cInc = state.cInc;
  const cNoiseInc = state.cNoiseInc;
  const cVol = state.cVol;
  const cDuty = state.cDuty;
  const cAttack = state.cAttack;
  const cDecay = state.cDecay;
  const cSustain = state.cSustain;
  const cRelease = state.cRelease;

  // The user wavetable: 32 steps at 4 bits, even step in the low nibble, each
  // step a signed nibble so a zeroed table is silence rather than DC.
  for (let k = 0; k < 16; k++) {
    const b = regs[WT_OFFSET + k] as number;
    const lo = b & 0x0f;
    const hi = (b >> 4) & 0x0f;
    wave[k * 2] = lo >= 8 ? lo - 16 : lo;
    wave[k * 2 + 1] = hi >= 8 ? hi - 16 : hi;
  }

  // Decode the frame's registers once, and settle every envelope transition
  // here: the registers do not change while this buffer is rendered.
  for (let c = 0; c < NCH; c++) {
    const base = c * STRIDE;
    const ctrl = regs[base + O_CTRL] as number;
    const enabled = (ctrl & 0x80) !== 0;
    const gated = (ctrl & 0x40) !== 0;
    const trig = (regs[base + O_TRIG] as number) | 0;

    if (!enabled) {
      // A disabled channel is EXACTLY silent, and it forgets where it was.
      envStage[c] = 0;
      envLevel[c] = 0;
      cEnable[c] = 0;
    } else {
      cEnable[c] = 1;
      if (trig !== (lastTrig[c] as number)) {
        phase[c] = 0;
        noisePhase[c] = 0;
        lfsr[c] = 1;
        envLevel[c] = 0;
        envStage[c] = gated ? 1 : 0;
      } else if (gated) {
        if ((envStage[c] as number) === 0) {
          envLevel[c] = 0;
          envStage[c] = 1;
        }
      } else {
        const st = envStage[c] as number;
        if (st !== 0 && st !== 4) envStage[c] = 4;
      }
    }
    lastTrig[c] = trig;

    const pitch = ((regs[base + O_PITCH_LO] as number) | ((regs[base + O_PITCH_HI] as number) << 8)) >>> 0;
    const freq = pitch / 16;
    cInc[c] = freq * dt;
    // The LFSR is clocked at 16x the channel pitch, so PITCH still means "how
    // bright is this noise" and the useful range lands in the audible band.
    cNoiseInc[c] = freq * 16 * dt;
    cWave[c] = (regs[base + O_WAVE] as number) & 0x0f;
    cVol[c] = (regs[base + O_VOL] as number) / 255;
    const duty = (regs[base + O_DUTY] as number) & 0xff;
    cDuty[c] = (duty === 0 ? 128 : duty) / 256; // DUTY 0 is a square, not silence
    cShort[c] = duty & 1;

    const a = regs[base + O_ENV_A] as number;
    const d = regs[base + O_ENV_D] as number;
    const s = regs[base + O_ENV_S] as number;
    const r = regs[base + O_ENV_R] as number;
    cAttack[c] = a === 0 ? 0 : dt / (a * ENV_UNIT);
    cDecay[c] = d === 0 ? 0 : dt / (d * ENV_UNIT);
    cHasDecay[c] = d === 0 ? 0 : 1;
    cSustain[c] = s / 255;
    cRelease[c] = r === 0 ? 0 : dt / (r * ENV_UNIT);
  }

  for (let i = 0; i < n; i++) {
    let acc = 0;

    for (let c = 0; c < NCH; c++) {
      if ((cEnable[c] as number) === 0) continue;

      // --- envelope ------------------------------------------------------
      let lv = envLevel[c] as number;
      let st = envStage[c] as number;
      if (st === 1) {
        const inc = cAttack[c] as number;
        if (inc === 0) {
          lv = 1;
          st = 2;
        } else {
          lv += inc;
          if (lv >= 1) {
            lv = 1;
            st = 2;
          }
        }
      }
      if (st === 2) {
        if ((cHasDecay[c] as number) === 0) {
          // ENV_D 0 means there is no decay stage at all: hold at full.
          lv = 1;
          st = 3;
        } else {
          const target = cSustain[c] as number;
          lv -= (1 - target) * (cDecay[c] as number);
          if (lv <= target) {
            lv = target;
            st = 3;
          }
        }
      } else if (st === 4) {
        const dec = cRelease[c] as number;
        if (dec === 0) {
          lv = 0;
          st = 0;
        } else {
          lv -= dec;
          if (lv <= 0) {
            lv = 0;
            st = 0;
          }
        }
      }
      envLevel[c] = lv;
      envStage[c] = st;

      // --- oscillator ----------------------------------------------------
      let p = (phase[c] as number) + (cInc[c] as number);
      if (p >= 1 || p < 0) p -= Math.floor(p);
      phase[c] = p;

      const w = cWave[c] as number;
      let sample = 0;
      if (w === 0) {
        sample = p < (cDuty[c] as number) ? 1 : -1;
      } else if (w === 1) {
        // -1 at phase 0, +1 at phase 0.5: two zero crossings per period.
        sample = 4 * (p < 0.5 ? p : 1 - p) - 1;
      } else if (w === 2) {
        sample = 2 * p - 1;
      } else if (w === 3) {
        let np = (noisePhase[c] as number) + (cNoiseInc[c] as number);
        let reg = lfsr[c] as number;
        while (np >= 1) {
          np -= 1;
          const tap = (cShort[c] as number) === 1 ? (reg >> 6) & 1 : (reg >> 1) & 1;
          const fb = (reg & 1) ^ tap;
          reg = ((reg >> 1) | (fb << 14)) & 0x7fff;
          if (reg === 0) reg = 1;
        }
        noisePhase[c] = np;
        lfsr[c] = reg;
        sample = (reg & 1) === 1 ? 1 : -1;
      } else if (w === 4) {
        let idx = (p * 32) | 0;
        if (idx > 31) idx = 31;
        else if (idx < 0) idx = 0;
        sample = (wave[idx] as number) / 8;
      }

      acc += sample * (cVol[c] as number) * lv;
    }

    // Four channels at full scale sum to 4; a quarter keeps the mix inside the
    // rail without a limiter, and the clamp catches nothing in practice.
    acc *= 0.25;
    out[i] = acc > 1 ? 1 : acc < -1 ? -1 : acc;
  }
}

// ---------------------------------------------------------------------------
// The sequencer. Runs in the simulation, once per tick, and touches only RAM.
// ---------------------------------------------------------------------------

/** Silence a channel and hand it back to the cart, keeping its release. */
function releaseChannel(ram: Uint8Array, base: number): void {
  ram[base + CH.SEQ_SFX] = 0;
  ram[base + CH.SEQ_STEP] = 0;
  ram[base + CH.SEQ_TICK] = 0;
  const ctrl = ram[base + CH.CTRL] as number;
  ram[base + CH.CTRL] = (ctrl & ~CTRL_GATE & ~CTRL_OWNER_MASK) & 0xff;
}

/** Apply one step of an effect to a channel's registers. */
function applyStep(ram: Uint8Array, base: number, sfxBase: number, step: number): void {
  const so = sfxBase + SFX_STEPS_OFFSET + step * SFX_STEP_BYTES;
  const note = ram[so + SFX_STEP.NOTE] as number;
  const mix = ram[so + SFX_STEP.MIX] as number;
  const fx = ram[so + SFX_STEP.FX] as number;
  const effect = (fx >> 4) & 0x0f;

  if (note > 95) {
    // A rest releases the gate. It does not stop the effect: the envelope's
    // release is part of the sound and the next step may retrigger.
    ram[base + CH.CTRL] = ((ram[base + CH.CTRL] as number) & ~CTRL_GATE) & 0xff;
    ram[base + CH.SEQ_VOL] = 0;
    return;
  }

  const hz16 = NOTE_HZ16[note] as number;
  ram[base + CH.PITCH_LO] = hz16 & 0xff;
  ram[base + CH.PITCH_HI] = (hz16 >> 8) & 0xff;

  const vol = ((mix >> 4) & 0x0f) * 17;
  ram[base + CH.SEQ_VOL] = vol;
  ram[base + CH.VOL] = vol;
  ram[base + CH.WAVE] = mix & 0x0f;
  if (effect === SFX_FX.DUTY) ram[base + CH.DUTY] = (((fx & 0x0f) << 4) | 8) & 0xff;

  ram[base + CH.CTRL] = ((ram[base + CH.CTRL] as number) | CTRL_ENABLE | CTRL_GATE) & 0xff;
  if (effect !== SFX_FX.LEGATO) {
    ram[base + CH.TRIG] = (((ram[base + CH.TRIG] as number) + 1) & 0xff);
  }
}

/** Advance one channel's effect by a frame. */
function sfxTick(ram: Uint8Array, ch: number): void {
  const base = ADDR.AUDIO_CH + ch * CH_STRIDE;
  const id = ram[base + CH.SEQ_SFX] as number;
  if (id === 0) return;
  if (id > SFX_COUNT) {
    releaseChannel(ram, base);
    return;
  }
  const sfxBase = ADDR.SFX + (id - 1) * SFX_STRIDE;

  let tick = ram[base + CH.SEQ_TICK] as number;
  if (tick === 0) {
    let step = ram[base + CH.SEQ_STEP] as number;
    let length = ram[sfxBase + SFX_HDR.LENGTH] as number;
    if (length > SFX_STEPS) length = SFX_STEPS;
    const loopStart = ram[sfxBase + SFX_HDR.LOOP_START] as number;
    const loopEnd = ram[sfxBase + SFX_HDR.LOOP_END] as number;
    const looping = loopEnd > loopStart && loopEnd <= length;

    if (looping && step >= loopEnd) step = loopStart;
    if (step >= length) {
      releaseChannel(ram, base);
      return;
    }

    applyStep(ram, base, sfxBase, step);
    ram[base + CH.SEQ_STEP] = (step + 1) & 0xff;
    const speed = ram[sfxBase + SFX_HDR.SPEED] as number;
    tick = speed === 0 ? 1 : speed;
  }
  ram[base + CH.SEQ_TICK] = (tick - 1) & 0xff;
}

/** Load an effect's envelope into a channel and arm the sequencer on it. */
function startSfxOnChannel(ram: Uint8Array, ch: number, id: number, owner: number): void {
  const base = ADDR.AUDIO_CH + ch * CH_STRIDE;
  const sfxBase = ADDR.SFX + id * SFX_STRIDE;
  ram[base + CH.ENV_A] = ram[sfxBase + SFX_HDR.ENV_A] as number;
  ram[base + CH.ENV_D] = ram[sfxBase + SFX_HDR.ENV_D] as number;
  ram[base + CH.ENV_S] = ram[sfxBase + SFX_HDR.ENV_S] as number;
  ram[base + CH.ENV_R] = ram[sfxBase + SFX_HDR.ENV_R] as number;
  ram[base + CH.SEQ_SFX] = id + 1;
  ram[base + CH.SEQ_STEP] = 0;
  ram[base + CH.SEQ_TICK] = 0;
  const ctrl = ram[base + CH.CTRL] as number;
  ram[base + CH.CTRL] =
    ((ctrl & ~CTRL_OWNER_MASK) | (owner << CTRL_OWNER_SHIFT) | CTRL_ENABLE) & 0xff;
}

/** Stop the song and hand every channel it held back to the cart. */
function stopMusic(ram: Uint8Array): void {
  const st = MUSIC_STATE_ADDR;
  ram[st + MUS.FLAGS] = 0;
  ram[st + MUS.FADE_POS] = 0;
  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const owner = ((ram[base + CH.CTRL] as number) & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    if (owner === OWNER.MUSIC) releaseChannel(ram, base);
  }
}

/** Put the four effects of `pattern` onto the masked channels. */
function startPattern(ram: Uint8Array, pattern: number): void {
  const st = MUSIC_STATE_ADDR;
  const mask = ram[st + MUS.MASK] as number;
  const patBase = ADDR.MUSIC + pattern * MUSIC_PATTERN_BYTES;
  const flags = ram[patBase + PAT.FLAGS] as number;
  if ((flags & PAT_LOOP_START) !== 0) ram[st + MUS.LOOP_PAT] = pattern & 0xff;

  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    if (((mask >> c) & 1) === 0) continue;
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const owner = ((ram[base + CH.CTRL] as number) & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    // Never take a channel the cart or an sfx is using. The song simply drops
    // that voice for this pattern, which is quieter than a stolen note.
    if (owner !== OWNER.CART && owner !== OWNER.MUSIC) continue;
    const v = ram[patBase + c] as number;
    if (v === 0 || v > SFX_COUNT) {
      if (owner === OWNER.MUSIC) releaseChannel(ram, base);
      continue;
    }
    startSfxOnChannel(ram, c, v - 1, OWNER.MUSIC);
  }
}

/** Start, advance or end the song. Runs before the per-channel steppers. */
function musicAdvance(ram: Uint8Array): void {
  const st = MUSIC_STATE_ADDR;
  const flags = ram[st + MUS.FLAGS] as number;
  if ((flags & MUS_PLAYING) === 0) return;

  const pattern = ram[st + MUS.PATTERN] as number;
  if ((flags & MUS_PENDING) !== 0) {
    ram[st + MUS.FLAGS] = (flags & ~MUS_PENDING) & 0xff;
    startPattern(ram, pattern);
    return;
  }

  const mask = ram[st + MUS.MASK] as number;
  let busy = false;
  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    if (((mask >> c) & 1) === 0) continue;
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const owner = ((ram[base + CH.CTRL] as number) & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    if (owner === OWNER.MUSIC && (ram[base + CH.SEQ_SFX] as number) !== 0) {
      busy = true;
      break;
    }
  }
  if (busy) return;

  const patFlags = ram[ADDR.MUSIC + pattern * MUSIC_PATTERN_BYTES + PAT.FLAGS] as number;
  if ((patFlags & PAT_STOP) !== 0) {
    stopMusic(ram);
    return;
  }
  let next: number;
  if ((patFlags & PAT_LOOP_END) !== 0) next = ram[st + MUS.LOOP_PAT] as number;
  else next = pattern + 1;
  if (next >= MUSIC_PATTERNS) {
    stopMusic(ram);
    return;
  }
  ram[st + MUS.PATTERN] = next & 0xff;
  startPattern(ram, next);
}

/**
 * Scale the music channels by the fade, after the steppers have written VOL.
 *
 * The fade is integer arithmetic on SEQ_VOL, in the simulation, so a replay
 * fades identically. It is not a gain node on the mixer, because a gain node is
 * on the wrong side of the one-way street.
 */
function musicFade(ram: Uint8Array): void {
  const st = MUSIC_STATE_ADDR;
  const flags = ram[st + MUS.FLAGS] as number;
  if ((flags & MUS_PLAYING) === 0) return;

  const len = ram[st + MUS.FADE_LEN] as number;
  let pos = ram[st + MUS.FADE_POS] as number;
  const out = (flags & MUS_FADING_OUT) !== 0;

  let gain = 256;
  if (len !== 0) {
    if (pos < len) pos = (pos + 1) & 0xff;
    ram[st + MUS.FADE_POS] = pos;
    const done = (pos * 256 / len) | 0;
    gain = out ? 256 - done : done;
    if (gain > 256) gain = 256;
    if (gain < 0) gain = 0;
  } else if (out) {
    gain = 0;
  }

  const mask = ram[st + MUS.MASK] as number;
  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    if (((mask >> c) & 1) === 0) continue;
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const owner = ((ram[base + CH.CTRL] as number) & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    if (owner !== OWNER.MUSIC) continue;
    ram[base + CH.VOL] = (((ram[base + CH.SEQ_VOL] as number) * gain) >> 8) & 0xff;
  }

  if (out && gain === 0) stopMusic(ram);
}

/**
 * One frame of audio sequencing.
 *
 * The machine must call this ONCE PER TICK, after the cart's `tick` has run and
 * before FRAME is incremented, so that an `sfx()` or `music()` issued this tick
 * is heard on this tick rather than the next one.
 *
 * It writes RAM and nothing else, allocates nothing, and does nothing at all on
 * a machine whose audio registers are still zero — which is why a silent cart's
 * frame hashes cannot move because this exists.
 */
export function tickAudio(ram: Uint8Array): void {
  musicAdvance(ram);
  for (let c = 0; c < AUDIO_CHANNELS; c++) sfxTick(ram, c);
  musicFade(ram);
}

// ---------------------------------------------------------------------------
// The ABI.
// ---------------------------------------------------------------------------

/**
 * Pick a channel for an `sfx()` that did not name one.
 *
 * Deterministic and dull: the lowest idle channel, else the lowest channel the
 * song is not using, else channel 3. It never reports "no channel", because a
 * cart that drops a sound on a busy frame and plays it on the next would be a
 * cart whose audio depended on how many sounds were already playing — true, but
 * a surprise that belongs in the layout, not in a scheduler.
 */
function pickChannel(ram: Uint8Array): number {
  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const ctrl = ram[base + CH.CTRL] as number;
    const owner = (ctrl & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    if (owner !== OWNER.MUSIC && (ram[base + CH.SEQ_SFX] as number) === 0 && (ctrl & CTRL_GATE) === 0) {
      return c;
    }
  }
  for (let c = 0; c < AUDIO_CHANNELS; c++) {
    const base = ADDR.AUDIO_CH + c * CH_STRIDE;
    const owner = ((ram[base + CH.CTRL] as number) & CTRL_OWNER_MASK) >> CTRL_OWNER_SHIFT;
    if (owner !== OWNER.MUSIC) return c;
  }
  return AUDIO_CHANNELS - 1;
}

/**
 * Build the `snd` namespace over a machine's RAM.
 *
 * Every write lands in RAM, so it is captured by `snapshot()` and restored by
 * `restore()` like everything else. Nothing is stored on the returned object:
 * the API is frozen and stateless, and the sequencer's position is four bytes
 * per channel in the register block.
 */
export function createSndApi(ram: Uint8Array): SndApi {
  return Object.freeze({
    sfx(n: number, ch?: number): void {
      const id = n | 0;
      const named = ch !== undefined;
      const slot = named ? ch | 0 : pickChannel(ram);
      if (slot < 0 || slot >= AUDIO_CHANNELS) return;

      // A negative id stops the channel. It is the only way a cart can cut a
      // sound short, and `sfx(-1)` with no channel stops all four.
      if (id < 0) {
        if (named) releaseChannel(ram, ADDR.AUDIO_CH + slot * CH_STRIDE);
        else for (let c = 0; c < AUDIO_CHANNELS; c++) releaseChannel(ram, ADDR.AUDIO_CH + c * CH_STRIDE);
        return;
      }
      if (id >= SFX_COUNT) return;

      startSfxOnChannel(ram, slot, id, OWNER.SFX);
    },

    music(n: number, fade?: number, mask?: number): void {
      const st = MUSIC_STATE_ADDR;
      const id = n | 0;
      const frames = ((fade ?? 0) | 0) & 0xff;

      if (id < 0 || id >= MUSIC_PATTERNS) {
        if (frames > 0 && ((ram[st + MUS.FLAGS] as number) & MUS_PLAYING) !== 0) {
          ram[st + MUS.FLAGS] = (MUS_PLAYING | MUS_FADING_OUT) & 0xff;
          ram[st + MUS.FADE_LEN] = frames;
          ram[st + MUS.FADE_POS] = 0;
        } else {
          stopMusic(ram);
        }
        return;
      }

      ram[st + MUS.FLAGS] = (MUS_PLAYING | MUS_PENDING) & 0xff;
      ram[st + MUS.PATTERN] = id & 0xff;
      ram[st + MUS.MASK] = ((mask ?? 0x0f) | 0) & 0x0f;
      ram[st + MUS.FADE_LEN] = frames;
      ram[st + MUS.FADE_POS] = 0;
      ram[st + MUS.LOOP_PAT] = id & 0xff;
    },
  });
}
