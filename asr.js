/**
 * asr.js —— 本地语音识别（sherpa-onnx + SenseVoice，离线、不要 key）
 *
 * 模型：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（int8，228MB）
 * 位置：`C:/Users/86188/coopanion-ext/tools/asr/…`，可用 VOICE_ASR_DIR 覆盖。
 * 运行时：复用 Coop 自带的 `sherpa-onnx-node`，可用 VOICE_SHERPA 覆盖。
 *
 * ⚠️ 不用 `sherpa.readWave()`：它用 napi 的外部 ArrayBuffer 返回采样，
 * 而 Electron 的 Node 禁掉了外部 buffer —— 在 Coop 里会抛
 * `External buffers are not allowed`（普通 node 不会，所以本地测是通的、线上全挂）。
 * 这里自己解析 WAV，数组是自己 new 出来的普通 ArrayBuffer，再交给 acceptWaveform。
 *
 * 只做一件事：给一个 wav 路径，回 { ok, text, lang, emotion, seconds }。
 * 模型第一次用才加载（约 2.3 秒、吃 228MB 内存），之后复用同一个实例。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

export const ASR_DIR =
  process.env.VOICE_ASR_DIR ||
  'C:/Users/86188/coopanion-ext/tools/asr/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const SHERPA = process.env.VOICE_SHERPA || 'C:/Users/86188/Coopanion/resources/app/node_modules/sherpa-onnx-node'
const TARGET_RATE = 16000

let sherpa = null
let recognizer = null
let loading = null

export function available() {
  return existsSync(join(ASR_DIR, 'model.int8.onnx')) && existsSync(join(ASR_DIR, 'tokens.txt'))
}

/**
 * 自己解析 WAV：返回 { sampleRate, samples }，samples 是**我们自己造的** Float32Array。
 * 支持 PCM 8/16/24/32 位与 32 位 float；多声道下混成单声道。
 */
export function readWav(file) {
  const buf = readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data 块')
  const channels = fmt.channels || 1
  const bits = fmt.bits || 16
  const width = Math.max(1, Math.floor(bits / 8))
  const frames = Math.floor(data.length / (width * channels))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * width
      let v = 0
      if (bits === 8) v = (data.readUInt8(at) - 128) / 128
      else if (bits === 16) v = data.readInt16LE(at) / 32768
      else if (bits === 24) v = ((data.readUInt8(at) | (data.readUInt8(at + 1) << 8) | (data.readInt8(at + 2) << 16)) << 8) / 2147483648
      else if (bits === 32 && fmt.format === 3) v = data.readFloatLE(at)
      else if (bits === 32) v = data.readInt32LE(at) / 2147483648
      else throw new Error(`不支持的位深 ${bits}`)
      sum += v
    }
    out[i] = sum / channels
  }
  return { sampleRate: fmt.sampleRate || TARGET_RATE, samples: out }
}

/** 线性重采样到 16k（sherpa 内的重采样在这些宿主上不保证可用，自己来更稳） */
export function resampleTo16k(samples, sampleRate) {
  if (!sampleRate || sampleRate === TARGET_RATE) return { samples, sampleRate: TARGET_RATE }
  const ratio = sampleRate / TARGET_RATE
  const n = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const t = pos - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return { samples: out, sampleRate: TARGET_RATE }
}

function load() {
  if (recognizer) return recognizer
  if (!available()) throw new Error(`找不到 SenseVoice 模型：${ASR_DIR}`)
  sherpa = sherpa ?? require(SHERPA)
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(ASR_DIR, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: join(ASR_DIR, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  })
  return recognizer
}

/** 幂等预热：第一次调用会加载模型，之后立刻返回。 */
export async function warmup() {
  if (recognizer) return { ok: true, cached: true }
  if (!loading) {
    loading = (async () => {
      try {
        const t0 = Date.now()
        load()
        return { ok: true, ms: Date.now() - t0 }
      } catch (error) {
        loading = null
        return { ok: false, error: String(error.message ?? error).slice(0, 200) }
      }
    })()
  }
  return loading
}

/** 转写一个 wav（自己解析 + 重采样到 16k） */
export async function transcribe(wavPath) {
  if (!existsSync(wavPath)) return { ok: false, error: '文件不存在' }
  if (statSync(wavPath).size < 1000) return { ok: false, error: '文件太小，像空音频' }
  try {
    const rec = load()
    const parsed = readWav(wavPath)
    const { samples, sampleRate } = resampleTo16k(parsed.samples, parsed.sampleRate)
    const seconds = samples.length / sampleRate
    const t0 = Date.now()
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    rec.decode(stream)
    const r = rec.getResult(stream)
    const text = String(r.text ?? '').trim()
    return {
      ok: true,
      text,
      lang: String(r.lang ?? '').replace(/[<>|]/g, ''),
      emotion: String(r.emotion ?? '').replace(/[<>|]/g, ''),
      event: String(r.event ?? '').replace(/[<>|]/g, ''),
      seconds: Math.round(seconds * 10) / 10,
      ms: Date.now() - t0,
    }
  } catch (error) {
    return { ok: false, error: String(error.message ?? error).slice(0, 200) }
  }
}

/** 给状态灯用：模型在不在、多大 */
export function info() {
  const model = join(ASR_DIR, 'model.int8.onnx')
  const has = existsSync(model)
  return {
    ready: has,
    dir: ASR_DIR,
    mb: has ? Math.round(statSync(model).size / 1048576) : 0,
    loaded: Boolean(recognizer),
  }
}
