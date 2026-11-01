/**
 * pitch.js —— 音高分析与变调（Node 这侧的封装）
 *
 * 真正的活儿在 pitch.py（librosa pyin 分析 / pyworld 变调），用的 python 是 GPT-SoVITS
 * 自带的那个 3.9 环境：librosa、pyworld、soundfile 都已经在里面，不额外装任何东西。
 *
 * 为什么常驻一个 python：librosa 光 import 就要 5 秒，pyin 本身 4 秒（12 秒音频）。
 * 常驻进程把那 5 秒摊掉，闲置 5 分钟自动退出。常驻起不来就退回"每次起一个进程"。
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GSV_DIR = process.env.VOICE_GSV_DIR || 'E:/GPT-SoVITS/GPT-SoVITS-v2pro-20250604'
export const PYTHON = join(GSV_DIR, 'runtime/python.exe')
export const SCRIPT = join(HERE, 'pitch.py')
/** 变调上限：±6 半音以外音色会垮，直接拒，不硬做 */
export const MAX_SEMITONES = 6
const WORKER_IDLE_MS = 300_000
const ANALYZE_TIMEOUT_MS = 180_000

/** 依赖齐不齐；缺什么返回什么 */
export function available() {
  const missing = []
  if (!existsSync(PYTHON)) missing.push(PYTHON)
  if (!existsSync(SCRIPT)) missing.push(SCRIPT)
  return { ok: missing.length === 0, missing }
}

const ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' }

/* ---------------- 常驻进程 ---------------- */

let worker = null
let workerSeq = 0
let idleTimer = null
/** 第一次失败过就别再每回都试（省 1 次 spawn 的等待），进程重启后自然重试 */
let workerBroken = false

function killWorker(reason = '') {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const w = worker
  worker = null
  if (!w) return
  try {
    w.child.stdin.end()
  } catch {
    /* 已经断了 */
  }
  try {
    w.child.kill()
  } catch {
    /* 已经退了 */
  }
  for (const [, pending] of w.pending) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, error: 'pitch 服务停了' + (reason ? '：' + reason : '') })
  }
  w.pending.clear()
}

function armsIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => killWorker('闲置太久'), WORKER_IDLE_MS)
  idleTimer.unref?.()
}

function startWorker() {
  if (worker) return worker
  if (workerBroken) return null
  if (!available().ok) return null
  let child
  try {
    child = spawn(PYTHON, [SCRIPT, 'serve'], { windowsHide: true, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    workerBroken = true
    return null
  }
  const state = { child, pending: new Map(), ready: false, stderr: '' }
  worker = state

  child.on('error', () => {
    workerBroken = true
    killWorker('起不来')
  })
  child.stderr?.on('data', (b) => {
    state.stderr = (state.stderr + b.toString()).slice(-2000)
  })
  child.on('exit', () => {
    if (worker === state) killWorker('进程退出')
  })

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && msg.id === undefined && msg.ready) return // 就绪提示，不用等
    if (!msg || msg.id === undefined || !state.pending.has(msg.id)) return
    const pending = state.pending.get(msg.id)
    state.pending.delete(msg.id)
    clearTimeout(pending.timer)
    pending.resolve(msg)
  })
  armsIdle()
  return state
}

/** 一个请求：{ id, cmd, ... } → 回复对象；失败返回 { ok:false, error }（绝不再抛） */
function callWorker(payload, timeoutMs) {
  const state = startWorker()
  if (!state) return Promise.resolve(null)
  const id = ++workerSeq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (state.pending.has(id)) state.pending.delete(id)
      killWorker('超时')
      resolve({ ok: false, error: `音高服务超时（${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)
    timer.unref?.()
    state.pending.set(id, { resolve, timer })
    try {
      state.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n')
    } catch {
      clearTimeout(timer)
      state.pending.delete(id)
      killWorker('写不进去')
      resolve({ ok: false, error: '音高服务没接住请求' })
    }
    armsIdle()
  })
}

/** 起一个一次性进程跑子命令（常驻不可用时的退路） */
function once(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PYTHON, [SCRIPT, ...args], { windowsHide: true, env: ENV })
    } catch (error) {
      resolve({ ok: false, error: String(error.message ?? error).slice(0, 160) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: `音高服务超时（${Math.round(timeoutMs / 1000)} 秒）` })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (b) => {
      out += b.toString()
      if (out.length > 4_000_000) out = out.slice(-4_000_000)
    })
    child.stderr.on('data', (b) => {
      err = (err + b.toString()).slice(-2000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: (line || err || '没有输出').replace(/\s+/g, ' ').slice(0, 200) })
      }
    })
  })
}

/* ---------------- ① 分析 ---------------- */

/**
 * 分析一个音频文件的音高。
 * 返回 { ok, data, ms, error }；data 见 pitch.py 的输出。
 */
export async function analyze(file, { maxSeconds = 30, fmin, fmax, maxNotes = 24 } = {}) {
  const dep = available()
  if (!dep.ok) return { ok: false, error: '没有 GPT-SoVITS 的 python：' + dep.missing.join(', ') }
  if (!existsSync(file)) return { ok: false, error: '找不到文件：' + file }
  const payload = { cmd: 'analyze', file, max_seconds: maxSeconds, max_notes: maxNotes }
  if (fmin) payload.fmin = fmin
  if (fmax) payload.fmax = fmax
  const t0 = Date.now()
  let r = await callWorker(payload, ANALYZE_TIMEOUT_MS)
  if (r === null || (r.ok === false && /pitch 服务停了|起不来|没接住/.test(String(r.error ?? '')))) {
    r = await once(
      ['analyze', file, '--max-seconds', String(maxSeconds), '--max-notes', String(maxNotes)]
        .concat(fmin ? ['--fmin', String(fmin)] : [])
        .concat(fmax ? ['--fmax', String(fmax)] : []),
      ANALYZE_TIMEOUT_MS,
    )
  }
  if (!r || r.ok !== true) return { ok: false, error: explain(r?.error), ms: Date.now() - t0 }
  return { ok: true, data: r, ms: Date.now() - t0 }
}

/** 把 python 那边抛上来的异常名翻成一句人话 */
function explain(error) {
  const raw = String(error ?? '').trim()
  if (!raw) return '没分析出来（python 没给出原因）'
  if (/NoBackendError/i.test(raw)) return '这个文件解不出音频：不是 wav / ogg / mp3 / flac，或者文件坏了'
  if (/No such file/i.test(raw)) return '找不到文件'
  if (/No alignment/i.test(raw)) return '这个文件解不出音频：不是 wav / ogg / mp3 / flac，或者文件坏了'
  return raw
}

/* ---------------- ② 变调 ---------------- */

/**
 * 就地把一个 wav 变调（pyworld：改 f0 重合成，共振峰不动，时长不变）。
 * 只有 |semitones| > 0 才动；失败时原文件保持不变，由调用方决定怎么交代。
 */
export async function shiftInPlace(file, semitones) {
  const n = Number(semitones)
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return { ok: true, skipped: true, semitones: 0 }
  if (Math.abs(n) > MAX_SEMITONES) {
    return { ok: false, error: `变调最多 ±${MAX_SEMITONES} 半音（要的是 ${n}）` }
  }
  const dep = available()
  if (!dep.ok) return { ok: false, error: '没有 GPT-SoVITS 的 python：' + dep.missing.join(', ') }
  const ext = /\.wav$/i.test(file) ? '.wav' : ''
  const tmp = file.replace(/\.wav$/i, '') + '.pitch' + (ext || '.wav')
  const args = ['shift', file, tmp, '--semitones', String(Math.round(n * 100) / 100)]
  const t0 = Date.now()
  let r = await callWorker({ cmd: 'shift', inp: file, out: tmp, semitones: Math.round(n * 100) / 100 }, ANALYZE_TIMEOUT_MS)
  if (r === null || (r.ok === false && /pitch 服务停了|起不来|没接住/.test(String(r.error ?? '')))) {
    r = await once(args, ANALYZE_TIMEOUT_MS)
  }
  if (!r || r.ok !== true) {
    rmQuiet(tmp)
    return { ok: false, error: String(r?.error ?? '没变调成功'), ms: Date.now() - t0 }
  }
  let size = 0
  try {
    size = statSync(tmp).size
  } catch {
    size = 0
  }
  if (size < 1000) {
    rmQuiet(tmp)
    return { ok: false, error: '变调后没有生成有效音频' }
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmQuiet(tmp)
    return { ok: false, error: '替换变调文件失败：' + String(error.message ?? error).slice(0, 100) }
  }
  return { ok: true, semitones: Math.round(n * 100) / 100, seconds: r.secondsOut, ms: Date.now() - t0 }
}

function rmQuiet(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* 留给系统 */
  }
}

/** 工具参数里的 pitch：只认 -6..6，别的一律拒绝（返回要回给模型的那句话） */
export function parsePitch(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0 }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false, error: 'pitch 要给数字（半音，例如 2 或 -1.5）。' }
  if (Math.abs(n) < 0.05) return { ok: true, value: 0 }
  if (Math.abs(n) > MAX_SEMITONES) {
    return { ok: false, error: `pitch 最多 ±${MAX_SEMITONES} 半音（再大音色就垮了），现在要的是 ${n}。` }
  }
  return { ok: true, value: Math.round(n * 100) / 100 }
}

/* ---------------- 排版 ---------------- */

const sgn = (n) => (n > 0 ? `+${n}` : `${n}`)

/**
 * 把 analyze 的结果排成给人看的中文：每音「音名+时间+音分」，末尾一句判断。
 */
export function formatReport(data, { maxNotes = 24, skipNotes = false } = {}) {
  if (!data) return '没分析出来。'
  const lines = []
  const name = basename(String(data.file ?? ''))
  const voiced = Math.round(Number(data.voicedRatio ?? 0) * 100)
  const covered = Number(data.analyzed ?? 0)
  const total = Number(data.seconds ?? 0)
  const head = `音高分析：${name}，${total} 秒`
  lines.push(data.truncated ? `${head}（只看了前 ${covered} 秒）` : head)

  const notes = Array.isArray(data.notes) ? data.notes : []
  const range = Array.isArray(data.rangeHz) ? data.rangeHz : null
  const rangeNote = Array.isArray(data.rangeNote) ? data.rangeNote : null
  if (range && rangeNote) {
    lines.push(
      `音域 ${rangeNote[0]}～${rangeNote[1]}（${range[0]}～${range[1]}Hz），${data.noteCount} 个音，有音帧 ${voiced}%`,
    )
  } else {
    lines.push(`没测到稳定的音高（有音帧 ${voiced}%）：可能是气声、纯噪声，或者音量太小。`)
    return lines.join('\n')
  }

  // 每行 4 个音，别把工具结果撑得太长
  if (!skipNotes) {
    const cells = notes.slice(0, maxNotes).map((n) => `[${Number(n.t).toFixed(2)}s] ${n.note} ${sgn(n.cents)}¢`)
    for (let i = 0; i < cells.length; i += 4) lines.push(cells.slice(i, i + 4).join('   '))
    const hidden = Number(data.notesMissing ?? 0)
    if (hidden > 0) lines.push(`（还有 ${hidden} 个音没列出来）`)
  }

  const cents = data.cents ?? {}
  const median = Number(cents.median ?? 0)
  const mean = Number(cents.mean ?? 0)
  const over25 = Number(cents.over25 ?? 0)
  lines.push(
    `平均 ${sgn(mean)} 音分，中位 ${sgn(median)}，超过 25 音分的音占 ${Math.round(over25 * 100)}%（波动 ${Number(
      cents.std ?? 0,
    ).toFixed(0)} 音分）`,
  )

  let verdict
  if (over25 > 0.35) verdict = `偏离十二平均律很明显（${Math.round(over25 * 100)}% 的音超过 25 音分）`
  else if (over25 > 0.15) verdict = `轻微偏离（${Math.round(over25 * 100)}% 的音超过 25 音分）`
  else verdict = `基本踩在音上（只有 ${Math.round(over25 * 100)}% 的音超过 25 音分）`
  if (Math.abs(median) >= 20) {
    verdict += `；整体${median > 0 ? '偏高' : '偏低'} ${Math.abs(median)} 音分，想掰回来的话 pitch ${sgn(
      Math.round((-median / 100) * 10) / 10,
    )}`
  }
  lines.push('判断：' + verdict)
  if (Number(cents.std ?? 0) > 20) {
    lines.push('（说话本来就不会踩在音上，音分抖得大是正常的；这个数更适合比较同一句的两个版本，或者听唱的时候用。）')
  }
  return lines.join('\n')
}

/** 停掉常驻进程（World 卸载/退出时调；不调也会自己闲置退出） */
export function shutdown() {
  killWorker('主动停')
}
