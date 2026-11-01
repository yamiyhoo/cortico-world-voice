/**
 * voice World —— 让小鱼在电脑上出声，也能听懂语音文件。
 *
 * 说：PowerShell 的 System.Speech（Windows 自带 SAPI），离线、不要 key、不下模型。
 * 听：sherpa-onnx + SenseVoice int8（本地模型，228MB），见 asr.js。
 *
 * 四个工具：
 *   voice_say        念一段话（可选只存文件不出声；roxy 音色还能变速、变调）
 *   voice_pitch      量一段音频的音高：每个音的音名+时间+音分，再给一句总结
 *   voice_list       列出本机音色
 *   voice_transcribe 把工作区里的音频转成文字
 *
 * 文件落在 `workspace\voice\`；路径由扩展内部拼，工具不接受任意路径。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as asr from './asr.js'
import * as gsv from './gptsovits.js'
import * as pitch from './pitch.js'

const WORLD_ID = 'voice'
const MAX_TEXT = 800
const VOICE_DIR = 'C:/Users/86188/AppData/Local/Programs/Coopanion/data/home/companion/workspace/voice'
const WORKSPACE_ROOT = 'C:/Users/86188/AppData/Local/Programs/Coopanion/data/home/companion/workspace'
const FFMPEG = process.env.VOICE_FFMPEG || 'C:/Users/86188/coopanion-ext/tools/ffmpeg/ffmpeg.exe'

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const clockOf = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** 读 WAV 头的 byteRate，算出时长（秒） */
export function wavSeconds(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0
    const byteRate = buf.readUInt32LE(28)
    if (!byteRate) return 0
    return Math.round(((buf.length - 44) / byteRate) * 10) / 10
  } catch {
    return 0
  }
}

/**
 * 采样参数：不传（或空）就返回 undefined，交给 gptsovits 的默认值（temperature 0.6 / top_k 10）。
 * 传了就越界拒绝，别让它悄悄被钳掉——用户要试参数，得知道自己传的到底生不生效。
 */
function samplingValue(raw, name, min, max, integer = false) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false, error: `${name} 要给数字（${min}–${max}），现在是 ${JSON.stringify(raw)}。` }
  if (n < min || n > max) return { ok: false, error: `${name} 只能是 ${min}–${max}，现在是 ${n}。` }
  return { ok: true, value: integer ? Math.round(n) : Math.round(n * 100) / 100 }
}

/**
 * 把一个 file 参数落到工作区里的真实路径。
 * 同时接受绝对路径和相对 workspace 的路径 —— 实测桌宠更爱传 `voice/2026-11-01/003103.wav`，
 * 一开始只认绝对路径，她第一次调用就被拒了。
 * 落到工作区外面一律拒（工具不接受任意路径）。
 */
function workspaceFile(raw) {
  const given = String(raw ?? '').trim()
  if (!given) return { ok: false, error: '要给 file：音频文件路径。' }
  const slashed = given.replace(/\\/g, '/')
  const absolute = /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith('/')
  const full = (absolute ? slashed : join(WORKSPACE_ROOT, slashed)).replace(/\\/g, '/')
  if (!full.toLowerCase().startsWith(WORKSPACE_ROOT.toLowerCase() + '/') && full.toLowerCase() !== WORKSPACE_ROOT.toLowerCase()) {
    return { ok: false, error: '只能读工作区里的文件（workspace 下）：给绝对路径，或相对 workspace 的路径。' }
  }
  if (!existsSync(full)) return { ok: false, error: `找不到文件：${full}` }
  return { ok: true, path: full }
}

/**
 * 用 SAPI 合成到 wav。文本走临时文件，命令走 -EncodedCommand ——
 * 中文、引号、换行都不会被 PowerShell 的命令行解析搞坏。
 */
export function synthToWav(text, outWav, { voice = '', rate = 0 } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'voice-'))
  const txt = join(work, 'in.txt')
  writeFileSync(txt, String(text), 'utf8')
  const q = (s) => String(s).replace(/'/g, "''")
  const ps = [
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Speech',
    `$t = [IO.File]::ReadAllText('${q(txt)}', [Text.Encoding]::UTF8)`,
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    '  $all = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }',
    voice ? `  $want = $all | Where-Object { $_.Name -eq '${q(voice)}' } | Select-Object -First 1` : '  $want = $null',
    "  if (-not $want) { $want = $all | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1 }",
    '  if ($want) { $s.SelectVoice($want.Name) }',
    `  $s.Rate = [Math]::Max(-10, [Math]::Min(10, ${Number(rate) || 0}))`,
    `  $s.SetOutputToWaveFile('${q(outWav)}')`,
    '  $s.Speak($t)',
    '} finally { $s.Dispose() }',
    `if (Test-Path '${q(outWav)}') { 'ok' } else { 'fail' }`,
  ].join('\r\n')
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      windowsHide: true,
    })
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: '合成超时（30s）' })
    }, 30000)
    child.stdout.on('data', (b) => (out += b.toString()))
    child.stderr.on('data', (b) => (out += b.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 })
      } catch {
        /* 留给系统 */
      }
      const ok = existsSync(outWav) && statSync(outWav).size > 1000
      resolve(ok ? { ok: true } : { ok: false, error: out.replace(/\s+/g, ' ').slice(0, 160) })
    })
  })
}

/** 后台播 wav（不阻塞工具调用） */
function playDetached(wav) {
  const ps = `$ProgressPreference = 'SilentlyContinue'; (New-Object System.Media.SoundPlayer '${String(wav).replace(/'/g, "''")}').PlaySync()`
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

/** 跑一次 ffmpeg */
function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: 'ffmpeg 超时' })
    }, timeoutMs)
    child.stderr.on('data', (b) => {
      err += b.toString()
      if (err.length > 3000) err = err.slice(-3000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, error: code === 0 ? '' : err.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 160) })
    })
  })
}

/** 列出本机音色 */
export function listVoices() {
  const ps = [
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try { $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | ForEach-Object { $_.Name + "\t" + $_.Culture.Name + "\t" + $_.Gender } } finally { $s.Dispose() }',
  ].join('\r\n')
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (b) => (out += b.toString()))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      resolve(
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes('\t'))
          .map((l) => {
            const [name, culture, gender] = l.split('\t')
            return { name, culture, gender }
          }),
      )
    })
  })
}

class VoiceWorld {
  constructor() {
    this.id = WORLD_ID
    this.host = null
  }

  async start(host) {
    this.host = host
    const voices = await listVoices()
    const zh = voices.filter((v) => v.culture.startsWith('zh'))
    host?.log?.info?.(
      `voice: SAPI 就绪（${voices.length} 个音色，中文 ${zh.length} 个${zh.length ? '：' + zh.map((v) => v.name).join('、') : ''}）`,
    )
    const info = asr.info()
    host?.log?.info?.(
      info.ready
        ? `voice: 听就绪（SenseVoice int8，${info.mb}MB，首次转写约 2.3 秒）`
        : `voice: 没找到 ASR 模型：${info.dir}`,
    )
    if (gsv.available().ok) {
      const d = gsv.ttsDefaults()
      host?.log?.info?.(`voice: 洛琪希默认参数 temperature ${d.temperature} / top_k ${d.topK} / speed ${d.speed}`)
    }
  }

  async stop() {}

  tools() {
    return [
      {
        name: 'voice_say',
        description: [
          'Say something out loud on this computer, with the built-in Windows voice (offline, no key, no download).',
          'text is what to say (max 800 chars). play: false only writes the audio file without making sound.',
          "voice overrides the voice (see voice_list); rate is -10..10, 0 is normal. With voice 'roxy' you can also pass",
          'speed (0.5-2.0, default 0.85), pitch (semitones, -6..6, 0 means unchanged; the formants are kept so it still sounds like her),',
          'and the sampling knobs temperature (0.1-2, default 0.6) and top_k (1-50, default 10) — lower temperature is steadier, higher is more varied.',
          'Returns the file path, its length, and the sampling values actually used.',
        ].join(' '),
        tags: ['speak'],
        summary: {
          zh: '在本机用 Windows 自带语音念一段话；洛琪希音色可变速、变调、调采样温度。',
          en: 'Say a line out loud on this computer; with the roxy voice you can also shift speed, pitch and sampling.',
        },
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: MAX_TEXT, description: 'What to say out loud.' },
            voice: { type: 'string', maxLength: 80, description: "Voice name (Microsoft Huihui Desktop), or 'roxy' for the GPT-SoVITS 洛琪希 voice." },
            rate: { type: 'number', description: '-10..10, 0 is normal speed.' },
            play: { type: 'boolean', description: 'Whether to actually make sound (default true).' },
            speed: { type: 'number', description: 'Speaking speed 0.5-2.0 (default 0.85, only used for roxy).' },
            pitch: { type: 'number', description: 'Pitch shift in semitones, -6..6 (0 = unchanged, only used for roxy).' },
            temperature: { type: 'number', description: 'Sampling temperature 0.1-2 (default 0.6, only used for roxy). Higher = more varied.' },
            top_k: { type: 'number', description: 'Sampling top_k 1-50 (default 10, only used for roxy).' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          const text = String(args?.text ?? '').trim()
          if (!text) return '没内容可说：给 text。'
          if (text.length > MAX_TEXT) return `太长了（${text.length} 字，上限 ${MAX_TEXT}）。`
          const wantPitch = pitch.parsePitch(args?.pitch)
          if (!wantPitch.ok) return wantPitch.error
          const semitones = wantPitch.value
          const wantTemperature = samplingValue(args?.temperature, 'temperature', 0.1, 2)
          if (!wantTemperature.ok) return wantTemperature.error
          const wantTopK = samplingValue(args?.top_k, 'top_k', 1, 50, true)
          if (!wantTopK.ok) return wantTopK.error
          const day = dayOf()
          const dir = join(VOICE_DIR, day)
          try {
            mkdirSync(dir, { recursive: true })
          } catch (error) {
            return `建不了语音目录：${error.message}`
          }
          const out = join(dir, `${clockOf()}.wav`)
          const wanted = String(args?.voice ?? '').trim()
          const play = args?.play !== false
          let fallbackNote = ''
          if (/^(roxy|洛琪希)$/i.test(wanted)) {
            const g = await gsv.sayToWav(text, out, {
              speed: Number(args?.speed),
              pitch: semitones,
              temperature: wantTemperature.value,
              top_k: wantTopK.value,
            })
            if (g.ok) {
              if (play) playDetached(out)
              const tone = `${g.pitch ? `，pitch ${g.pitch > 0 ? '+' : ''}${g.pitch}` : ''}`
              const sampling = `，t${g.temperature}/k${g.topK}`
              const missed = g.pitchOk ? '' : `\n（这次没能变调，用的是原调：${String(g.pitchError || '').slice(0, 80)}）`
              this.host?.log?.info?.(
                `voice: 洛琪希说了 ${g.seconds} 秒（speed ${g.speed}${tone}${sampling}）${g.started ? '（本次拉起服务）' : ''} ${g.ms}ms ${out}`,
              )
              return `${play ? '说了' : '存好了'}（洛琪希，speed ${g.speed}${tone}${sampling}）：${g.seconds} 秒\n路径：${out}${missed}`
            }
            this.host?.log?.warn?.(`voice: 洛琪希不可用（${g.error}），改用本机音色`)
            fallbackNote = `\n（洛琪希没用上：${String(g.error || '未知原因').slice(0, 90)}）`
          } else {
            const ignored = []
            if (semitones !== 0) ignored.push('pitch')
            if (wantTemperature.value !== undefined) ignored.push('temperature')
            if (wantTopK.value !== undefined) ignored.push('top_k')
            if (ignored.length) fallbackNote = `\n（本机 SAPI 音色不吃 ${ignored.join('、')}，这次没生效；这些只对 roxy 有用）`
          }
          const syn = await synthToWav(text, out, { voice: /^(roxy|洛琪希)$/i.test(wanted) ? '' : wanted, rate: Number(args?.rate) || 0 })
          if (!syn.ok) return `合成失败：${syn.error || 'SAPI 没给出原因（看看本机有没有中文音色）'}`
          const secs = wavSeconds(out)
          if (play) playDetached(out)
          this.host?.log?.info?.(`voice: 说了 ${secs} 秒（${play ? '已出声' : '只存文件'}）${out}`)
          return `${play ? '说了' : '存好了'}：${secs} 秒\n路径：${out}${fallbackNote}`
        },
      },
      {
        name: 'voice_list',
        description: 'List the voices this computer has for speaking. Read-only.',
        tags: ['read'],
        summary: {
          zh: '列出本机可用音色，以及洛琪希服务起没起、权重切没切。',
          en: 'List installed voices, plus whether the roxy service is up and its weights are loaded.',
        },
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const voices = await listVoices()
          const g = await gsv.status()
          const roxy = g.running
            ? `roxy · ja/zh · 洛琪希（GPT-SoVITS v2ProPlus）—— 服务：跑着${g.weightsReady ? '，权重已切' : '，权重未切（下次调用会切）'}`
            : `roxy · ja/zh · 洛琪希（GPT-SoVITS v2ProPlus）—— 服务：没起（首次调用会自动拉，约 45 秒）`
          const lines = voices.map((v) => `${v.name} · ${v.culture} · ${v.gender}`)
          if (!lines.length) lines.push('（System.Speech 没读到本机音色）')
          return [...lines, roxy].join('\n')
        },
      },
      {
        name: 'voice_transcribe',
        description: [
          'Transcribe an audio file into text, locally (SenseVoice int8, offline). No key, no upload — the audio never leaves this computer.',
          'file is a path inside the companion workspace (for example the voice messages Telegram saved under workspace\\voice\\incoming).',
          'You get back the words, the language, and how long the audio was.',
        ].join(' '),
        tags: ['read'],
        summary: {
          zh: '把工作区里的音频转成文字（本地 SenseVoice，离线）。',
          en: 'Transcribe an audio file inside the workspace into text, locally.',
        },
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', maxLength: 400, description: 'Path of a wav/ogg/mp3 file inside the workspace; relative to the workspace is fine (voice/2026-11-01/003103.wav).' },
          },
          required: ['file'],
        },
        handler: async (args) => {
          const picked = workspaceFile(args?.file)
          if (!picked.ok) return picked.error
          const norm = picked.path
          let file = norm
          const ext = (file.split('.').pop() || '').toLowerCase()
          if (!['wav', 'wave'].includes(ext)) {
            if (!existsSync(FFMPEG)) return '这个格式要先转 wav，但没找到 ffmpeg。'
            const wav = file.replace(/\.[^.]+$/, '') + '.asr.wav'
            const conv = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
            if (!conv.ok) return `转 wav 失败：${conv.error || 'ffmpeg 没给出原因'}`
            file = wav
          }
          const r = await asr.transcribe(file)
          if (!r.ok) return `没转写出来：${r.error || '未知原因'}`
          this.host?.log?.info?.(`voice: 转写 ${r.seconds} 秒 → ${String(r.text).slice(0, 40)}`)
          const tail = r.lang ? `\n（${r.lang}，${r.seconds} 秒）` : ''
          return String(r.text || '（听不出内容）') + tail
        },
      },
      {
        name: 'voice_pitch',
        description: [
          'Measure the pitch of an audio file, locally (librosa pyin, offline, no key, no upload).',
          'file is a path inside the companion workspace — wav / ogg / mp3 / flac (for example the voice messages Telegram saved).',
          'You get one line per note: note name, when it starts, and how many cents off it is; then a summary with the range,',
          'how far it drifts, and whether it wanders off. Only the first 30 seconds are measured by default (maxSeconds up to 120);',
          'notes:false leaves the per-note lines out and gives just the summary.',
        ].join(' '),
        tags: ['read'],
        summary: {
          zh: '量一段音频的音高：每个音的音名+时间+音分，再给音域和跑调判断（本地 librosa）。',
          en: 'Measure the pitch of an audio file: note name, time and cents per note, then the range and whether it drifts.',
        },
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', maxLength: 400, description: 'Path of an audio file inside the workspace; relative to the workspace is fine (voice/2026-11-01/003103.wav).' },
            maxSeconds: { type: 'number', description: 'Only measure the first N seconds (default 30, up to 120).' },
            maxNotes: { type: 'number', description: 'How many notes to list (default 24, up to 40).' },
            notes: { type: 'boolean', description: 'false = summary only, no per-note lines.' },
            fmin: { type: 'number', description: 'Lowest pitch to look for, in Hz (default 65.4 = C2; for a male voice try 80).' },
            fmax: { type: 'number', description: 'Highest pitch to look for, in Hz (default 2093 = C7).' },
          },
          required: ['file'],
        },
        handler: async (args) => {
          const picked = workspaceFile(args?.file)
          if (!picked.ok) return picked.error
          const norm = picked.path
          const maxSeconds = Math.min(120, Math.max(3, Number(args?.maxSeconds) || 30))
          const skipNotes = args?.notes === false
          const maxNotes = Math.min(40, Math.max(1, Number(args?.maxNotes) || 24))
          const r = await pitch.analyze(norm, {
            maxSeconds,
            maxNotes,
            fmin: Number(args?.fmin) || undefined,
            fmax: Number(args?.fmax) || undefined,
          })
          if (!r.ok) return `没量出来：${r.error}`
          this.host?.log?.info?.(`voice: 量了 ${basename(norm)} 的调（${r.data.noteCount} 个音，${r.ms}ms）`)
          return `${pitch.formatReport(r.data, { maxNotes, skipNotes })}\n（用时 ${(r.ms / 1000).toFixed(1)} 秒）`
        },
      },
    ]
  }

  envPromptVars() {
    return {}
  }

  webUi() {
    let count = 0
    try {
      const dir = join(VOICE_DIR, dayOf())
      count = existsSync(dir) ? readdirSync(dir).length : 0
    } catch {
      count = 0
    }
    const info = asr.info()
    return {
      label: '语音',
      lamps: [
        { label: '说', state: 'online', hint: 'Windows SAPI（中文音色）' },
        { label: '听', state: info.ready ? 'online' : 'error', hint: info.ready ? `SenseVoice ${info.mb}MB` : '缺模型' },
        { label: '洛琪希', state: gsv.available().ok ? 'online' : 'error', hint: gsv.available().ok ? 'GPT-SoVITS v2ProPlus（9880）' : '缺 GPT-SoVITS 路径' },
      ],
      badges: [
        { label: '今日', value: count, tone: 'plain' },
        { label: 'ffmpeg', value: existsSync(FFMPEG) ? '有' : '缺', tone: existsSync(FFMPEG) ? 'plain' : 'bad' },
      ],
    }
  }
}

/**
 * `describe.tools` 直接从 tools() 的声明里取 —— 两处各写一份必然会漂：改了运行时的参数
 * 忘了改 describe，`check:extension` 会报「实例给出的工具与声明不一致」，扩展市场也会显示旧的。
 * 这份声明不 start、不碰磁盘，只构造一次实例读它的工具表。
 */
const DECLARED_TOOLS = new VoiceWorld()
  .tools()
  .map(({ name, description, parameters, tags, summary }) => ({ name, description, parameters, tags, summary }))

export const definition = {
  id: WORLD_ID,
  label: '语音',
  // 框架的语义：一个 World 开没开由部署（config.json 的 worlds.<id>.enabled）和 bot 的 declares 决定，
  // 定义里一律给 false。本机 config.json 里显式写了 enabled=true，所以这里改默认值不影响这台机器。
  defaults: () => ({ enabled: false }),
  describe: {
    tools: DECLARED_TOOLS,
    events: [],
  },
  create: () => new VoiceWorld(),
}

export default definition
