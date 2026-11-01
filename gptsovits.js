/**
 * gptsovits.js —— 洛琪希音色（GPT-SoVITS v2ProPlus）的客户端
 *
 * 服务在 `E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604`，监听 127.0.0.1:9880。
 * 客户端负责：探活 → 没起就拉起（detached）→ 设权重 → 调 /tts 拿 wav。
 *
 * 为什么只有这一份：voice 扩展和 telegram 扩展都 import 它，同一进程里模块只加载一次，
 * 于是服务只起一次、权重只设一次。路径可用环境变量覆盖：
 *   VOICE_GSV_DIR / VOICE_GSV_URL / VOICE_GSV_REF / VOICE_GSV_REF_TEXT
 *
 * 三个必须知道的点：
 *   1. api_v2 启动只加载「基础 v2 模型」，不会记住上次的洛琪希权重 → 每次新进程都要重设。
 *   2. 冷启动实测约 45 秒，首次推理约 19 秒 → 上层要按 120 秒给超时。
 *   3. 这套 v2ProPlus 没有「指定调/音高」的接口（api_v2.py 里没有 pitch/key/f0_up_key），
 *      要变调只能在拿到 wav 之后做：pyworld 改 f0 重合成（见 pitch.js），保共振峰、时长不变。
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import * as pitch from './pitch.js'

export const GSV_DIR = process.env.VOICE_GSV_DIR || 'E:/GPT-SoVITS/GPT-SoVITS-v2pro-20250604'
export const API = (process.env.VOICE_GSV_URL || 'http://127.0.0.1:9880').replace(/\/$/, '')
const REF_WAV = process.env.VOICE_GSV_REF || 'E:/GPT-SoVITS/_downloads/roxy-ref-sajiao.wav'
const REF_TEXT = process.env.VOICE_GSV_REF_TEXT || 'ルディ、ちょっと背中を貸してもらっていいですか'
const GPT_WEIGHT = 'GPT_weights_v2ProPlus/Roxy3.0.ckpt'
const SOVITS_WEIGHT = 'SoVITS_weights_v2ProPlus/Roxy3.0.pth'
const LOG = 'E:/GPT-SoVITS/_downloads/api-v2pro.log'
/** 本地变速用的 ffmpeg（atempo，保音高） */
const FFMPEG = process.env.VOICE_GSV_FFMPEG || 'C:/Users/86188/coopanion-ext/tools/ffmpeg/ffmpeg.exe'
const PYTHON = join(GSV_DIR, 'runtime/python.exe')
const SCRIPT = join(GSV_DIR, 'api_v2.py')

/** 默认语速：0.85 是听感最像洛琪希的一档（1.0 偏赶） */
export const DEFAULT_SPEED = 0.85
/**
 * 默认采样参数。服务端 api_v2 的默认是 temperature 1.0 / top_k 15（偏发散），
 * 实测把它压到 0.6 / 10 之后：同一句话时长更短一点、音高起伏更小、名字念对的概率更高，
 * 所以这里覆盖服务端默认值。
 */
export const DEFAULT_TEMPERATURE = 0.6
export const DEFAULT_TOP_K = 10

/** 当前生效的默认采样参数（给启动日志和状态页用） */
export function ttsDefaults() {
  return { temperature: DEFAULT_TEMPERATURE, topK: DEFAULT_TOP_K, speed: DEFAULT_SPEED }
}

const START_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 120_000

let starting = null
let weightsReady = false
let lastError = ''
/** 所有合成排一条队：同时两个请求压 GPU 只会互相拖慢 */
let queue = Promise.resolve()

function enqueue(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/** 依赖是否齐；缺什么返回什么 */
export function available() {
  const missing = []
  if (!existsSync(PYTHON)) missing.push(PYTHON)
  if (!existsSync(SCRIPT)) missing.push(SCRIPT)
  if (!existsSync(REF_WAV)) missing.push(REF_WAV)
  for (const w of [GPT_WEIGHT, SOVITS_WEIGHT]) {
    if (!existsSync(join(GSV_DIR, w))) missing.push(join(GSV_DIR, w))
  }
  return { ok: missing.length === 0, missing }
}

/** 9880 上有没有人在听（任何 HTTP 响应都算活着） */
export async function probe(timeoutMs = 1500) {
  try {
    const r = await fetch(`${API}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    await r.text().catch(() => '')
    return true
  } catch {
    return false
  }
}

/** 找监听这个端口的进程（Windows 用 netstat -ano 解析，纯 node 实现） */
function pidOnPort(port) {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (b) => (out += b.toString()))
    child.on('error', () => resolve(0))
    child.on('close', () => {
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts[parts.length - 1])
        if (pid > 0) return resolve(pid)
      }
      resolve(0)
    })
  })
}

/** 起服务：detached，日志追加到 api-v2pro.log */
function spawnServer() {
  let logFd = null
  try {
    appendFileSync(LOG, '\n=== auto-start ' + new Date().toISOString() + ' ===\n', 'utf8')
    logFd = openSync(LOG, 'a')
  } catch {
    logFd = null
  }
  const child = spawn(PYTHON, ['api_v2.py', '-a', '127.0.0.1', '-p', new URL(API).port || '9880'], {
    cwd: GSV_DIR,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    env: process.env,
  })
  child.unref()
  if (logFd !== null) {
    try {
      closeSync(logFd)
    } catch {
      /* 子进程已继承句柄 */
    }
  }
  return child.pid
}

/** 保证服务在跑；并发调用共用同一个 Promise */
export async function ensureServer() {
  const dep = available()
  if (!dep.ok) return { ok: false, started: false, error: 'GPT-SoVITS 依赖不全：' + dep.missing.join(', ') }
  if (await probe()) {
    weightsReady = weightsReady || false
    return { ok: true, started: false }
  }
  if (starting) return starting
  starting = (async () => {
    try {
      const pid = spawnServer()
      const begin = Date.now()
      while (Date.now() - begin < START_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 2000))
        if (await probe(2000)) {
          weightsReady = false
          return { ok: true, started: true, pid, ms: Date.now() - begin }
        }
      }
      lastError = `服务 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内没起来（日志 ${LOG}）`
      return { ok: false, started: true, pid, error: lastError }
    } catch (error) {
      lastError = String(error.message ?? error).slice(0, 160)
      return { ok: false, started: false, error: lastError }
    } finally {
      starting = null
    }
  })()
  return starting
}

/** GET 一个接口，返回 { ok, status, text } */
async function get(path, timeoutMs = 30_000) {
  try {
    const r = await fetch(API + path, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await r.text().catch(() => '')
    return { ok: r.ok, status: r.status, text }
  } catch (error) {
    return { ok: false, status: 0, text: String(error.message ?? error).slice(0, 160) }
  }
}

/** 设权重；端口上若是别的（比如老 v2 服务），杀掉重启一次再试 */
export async function ensureWeights() {
  if (weightsReady) return { ok: true, cached: true }
  const set = async () => {
    const g = await get('/set_gpt_weights?weights_path=' + encodeURIComponent(GPT_WEIGHT))
    if (!g.ok) return { ok: false, error: `set_gpt_weights ${g.status} ${g.text.slice(0, 120)}` }
    const s = await get('/set_sovits_weights?weights_path=' + encodeURIComponent(SOVITS_WEIGHT), 60_000)
    if (!s.ok) return { ok: false, error: `set_sovits_weights ${s.status} ${s.text.slice(0, 120)}` }
    weightsReady = true
    return { ok: true }
  }
  const first = await set()
  if (first.ok) return first
  // 端口被别的服务占着：杀掉再来一次
  const pid = await pidOnPort(new URL(API).port || 9880)
  if (pid) {
    try {
      process.kill(pid)
    } catch {
      /* 没权限或已退出 */
    }
    await new Promise((r) => setTimeout(r, 1500))
    const again = await ensureServer()
    if (!again.ok) return { ok: false, error: again.error }
    const second = await set()
    if (second.ok) return second
    return { ok: false, error: second.error }
  }
  return { ok: false, error: first.error }
}

/** 正文语言：有假名就按日语，否则中文 */
function detectLang(text) {
  return /[\u3040-\u30ff]/.test(String(text)) ? 'ja' : 'zh'
}

/**
 * 合成一句话到 wav。
 * opts: { speed, pitch } —— pitch 是半音（-6..6），0 表示不动。
 * 返回 { ok, seconds, ms, started, speed, pitch, pitchOk, pitchError, error }
 */
export function sayToWav(text, outWav, opts = {}) {
  // speed_factor：GPT-SoVITS 的语速倍率（1.0 原速；默认 0.85，慢一点更像她说话）
  const speed = Number(opts.speed) > 0 ? Math.min(2, Math.max(0.5, Number(opts.speed))) : DEFAULT_SPEED
  // 采样参数：温度越低越稳（越不像即兴发挥），top_k 越小候选越少
  const temperature = Number(opts.temperature) > 0
    ? Math.min(2, Math.max(0.1, Number(opts.temperature)))
    : DEFAULT_TEMPERATURE
  const topK = Number(opts.top_k) > 0 ? Math.min(50, Math.max(1, Math.round(Number(opts.top_k)))) : DEFAULT_TOP_K
  const wantPitch = pitch.parsePitch(opts.pitch)
  if (!wantPitch.ok) return Promise.resolve({ ok: false, error: wantPitch.error })
  const semitones = wantPitch.value
  return enqueue(async () => {
    const t0 = Date.now()
    let started = false
    try {
      const server = await ensureServer()
      if (!server.ok) return { ok: false, error: server.error }
      started = Boolean(server.started)
      const w = await ensureWeights()
      if (!w.ok) return { ok: false, error: w.error, started }
      const body = {
        text: String(text),
        text_lang: detectLang(text),
        ref_audio_path: REF_WAV.replace(/\//g, '\\'),
        prompt_text: REF_TEXT,
        prompt_lang: 'ja',
        text_split_method: 'cut5',
        batch_size: 1,
        media_type: 'wav',
        streaming_mode: false,
        parallel_infer: true,
        repetition_penalty: 1.35,
        top_k: topK,
        top_p: 1,
        temperature,
      }
      const r = await fetch(`${API}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!r.ok) {
        const txt = await r.text().catch(() => '')
        return { ok: false, error: `/tts ${r.status} ${txt.slice(0, 160)}`, started }
      }
      const bytes = Buffer.from(await r.arrayBuffer())
      if (bytes.length < 1000) return { ok: false, error: '接口返回的音频太小', started }
      writeFileSync(outWav, bytes)
      // 变调在前、变速在后：pyworld 的 f0 提取在原始时长上最准，atempo 之后 f0 不再需要。
      let pitchOk = true
      let pitchError = ''
      let pitchMs = 0
      if (semitones !== 0) {
        const sh = await pitch.shiftInPlace(outWav, semitones)
        pitchMs = sh.ms ?? 0
        if (!sh.ok) {
          // 说好的退路：变调失败就用原调出声，别让整句话没声音
          pitchOk = false
          pitchError = String(sh.error ?? '未知原因')
        }
      }
      // 服务端的 speed_factor 对 v2ProPlus 权重几乎不敏感（实测 0.6 vs 1.5 只差 14%），
      // 所以语速在拿到 wav 之后用 ffmpeg atempo 施加：保音高，缩放比例精确可预测。
      const tempo = await applySpeed(outWav, speed)
      if (!tempo.ok) return { ok: false, error: tempo.error, started }
      return {
        ok: true,
        seconds: wavSeconds(outWav),
        ms: Date.now() - t0,
        started,
        speed,
        temperature,
        topK,
        pitch: semitones,
        pitchOk,
        pitchError,
        pitchMs,
        bytes: bytes.length,
      }
    } catch (error) {
      return { ok: false, error: String(error.message ?? error).slice(0, 180), started }
    }
  })
}

/** 用 ffmpeg atempo 变速（保音高）。speed≈1 或没有 ffmpeg 就原样返回 */
async function applySpeed(file, speed) {
  if (Math.abs(speed - 1) < 0.01) return { ok: true }
  if (!existsSync(FFMPEG)) return { ok: false, error: '没有 ffmpeg，改不了语速' }
  const tmp = file.replace(/\.wav$/i, '.tempo.wav')
  const done = await new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-filter:a', `atempo=${speed}`, '-c:a', 'pcm_s16le', tmp], {
      windowsHide: true,
    })
    let err = ''
    child.stderr.on('data', (b) => (err += b.toString()))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 160) }))
  })
  if (!done.ok) return done
  try {
    renameSync(tmp, file)
  } catch (error) {
    return { ok: false, error: '替换变速文件失败：' + String(error.message ?? error).slice(0, 100) }
  }
  return { ok: true }
}

/** wav 时长（读头部 byteRate） */
function wavSeconds(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length < 44) return 0
    const byteRate = buf.readUInt32LE(28)
    if (!byteRate) return 0
    return Math.round(((buf.length - 44) / byteRate) * 10) / 10
  } catch {
    return 0
  }
}

/** 状态：服务在不在、权重设了没 */
export async function status() {
  const running = await probe()
  return {
    ok: running,
    running,
    weightsReady,
    api: API,
    dir: GSV_DIR,
    ref: REF_WAV,
    lastError,
  }
}

/** 停服务（README 里让人手动停时给个提示用，不自动调用） */
export async function stopServer() {
  const pid = await pidOnPort(new URL(API).port || 9880)
  if (!pid) return { ok: false, error: '没找到监听该端口的进程' }
  try {
    process.kill(pid)
    weightsReady = false
    return { ok: true, pid }
  } catch (error) {
    return { ok: false, error: String(error.message ?? error).slice(0, 120) }
  }
}
