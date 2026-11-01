#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pitch.py —— 音高分析与变调（给 Coopanion 的 voice World 用）

两个子命令，都只往 stdout 写一行 JSON（Node 那边解析），错误也走 JSON（ok:false），
这样调用方永远不用猜 stderr 里是什么。

  analyze <file> [--max-seconds 30] [--fmin 65.4] [--fmax 2093] [--notes]
      用 librosa.pyin 提帧级 f0，合并成音符，给出音域/音分/跑调判断要的原始数字。
      直接能读 wav/ogg/flac/mp3（libsndfile / audioread）。

  shift <in.wav> <out.wav> --semitones 2
      pyworld：harvest 提 f0 → cheaptrick 谱包络 → d4c 非周期 → 只把 f0 乘上
      2^(n/12) → 重合成。谱包络不动，所以共振峰保住（不像 asetrate 那样花栗鼠），
      时长为帧数决定，基本不变。

为什么用这个 python：它是 GPT-SoVITS 自带的 3.9 环境，librosa/pyworld/soundfile 都已装好，
不额外装任何东西。
"""

import argparse
import json
import sys

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# 合并音符的规则
MIN_NOTE_SEC = 0.06      # 短于 60ms 的当噪声丢掉
MAX_GAP_SEC = 0.12       # 中间空这么久以内还算同一个音
PITCH_JUMP_SEMI = 0.75   # 偏离当前音超过 3/4 个半音就切一个新音


def note_name(midi_value):
    """midi（可以是小数）→ 最近的音名，比如 62.03 → C#4"""
    midi = int(round(midi_value))
    return '%s%d' % (NOTE_NAMES[midi % 12], midi // 12 - 1)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True))
    sys.stdout.write('\n')
    sys.stdout.flush()


def cmd_analyze(args):
    import numpy as np
    import librosa

    y, sr = librosa.load(args.file, sr=22050, mono=True, duration=float(args.max_seconds))
    if y.size == 0:
        return {'ok': False, 'error': 'empty audio'}
    seconds = float(y.size) / float(sr)

    hop = 512
    frame_length = 2048
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=float(args.fmin),
        fmax=float(args.fmax),
        sr=sr,
        frame_length=frame_length,
        hop_length=hop,
        fill_na=np.nan,
    )

    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    voiced = np.isfinite(f0)
    n_frames = int(f0.size)
    n_voiced = int(voiced.sum())

    midi_all = np.full(n_frames, np.nan)
    if n_voiced:
        midi_all[voiced] = librosa.hz_to_midi(f0[voiced])

    # 音分偏差：相对最近的十二平均律音
    cents_all = np.full(n_frames, np.nan)
    if n_voiced:
        cents_all[voiced] = 100.0 * (midi_all[voiced] - np.round(midi_all[voiced]))

    hop_sec = float(hop) / float(sr)

    # 把帧合并成“音符”
    notes = []
    if n_voiced:
        idx = np.flatnonzero(voiced)
        group = [int(idx[0])]
        run = [float(midi_all[idx[0]])]
        for raw_i in idx[1:]:
            i = int(raw_i)
            gap = (i - group[-1]) * hop_sec
            ref = float(np.median(run))
            if gap > MAX_GAP_SEC or abs(float(midi_all[i]) - ref) > PITCH_JUMP_SEMI:
                notes.append((group, run))
                group, run = [i], [float(midi_all[i])]
            else:
                group.append(i)
                run.append(float(midi_all[i]))
        notes.append((group, run))

        parsed = []
        for group, run in notes:
            dur = len(group) * hop_sec
            if dur < MIN_NOTE_SEC:
                continue
            midi_med = float(np.median(run))
            parsed.append(
                {
                    't': round(float(times[group[0]]), 3),
                    'dur': round(dur, 3),
                    'hz': round(float(np.median(f0[group])), 1),
                    'midi': round(midi_med, 3),
                    'note': note_name(midi_med),
                    'cents': round(100.0 * (midi_med - round(midi_med)), 1),
                }
            )
    else:
        parsed = []

    # 限制返回的音符数（Node 那边还会再排版一次），多的只给数量
    max_notes = int(args.max_notes) if args.max_notes else 0
    missing = 0
    listed = parsed
    if max_notes and len(parsed) > max_notes:
        missing = len(parsed) - max_notes
        listed = parsed[:max_notes]

    voiced_hz = f0[voiced] if n_voiced else np.array([])
    out = {
        'ok': True,
        'file': args.file,
        'seconds': round(seconds, 2),
        'analyzed': round(seconds, 2),
        'truncated': bool(args.max_seconds and seconds >= float(args.max_seconds) - 0.05),
        'sr': sr,
        'fmin': float(args.fmin),
        'fmax': float(args.fmax),
        'frames': n_frames,
        'hopSec': round(hop_sec, 4),
        'voicedFrames': n_voiced,
        'voicedRatio': round(n_voiced / n_frames, 3) if n_frames else 0.0,
        'noteCount': len(parsed),
        'notesMissing': missing,
        'notes': listed,
    }
    if n_voiced:
        out['rangeHz'] = [round(float(voiced_hz.min()), 1), round(float(voiced_hz.max()), 1)]
        out['rangeNote'] = [note_name(float(midi_all[voiced][np.argmin(voiced_hz)])),
                            note_name(float(midi_all[voiced][np.argmax(voiced_hz)]))]
        cents = cents_all[voiced]
        out['cents'] = {
            'mean': round(float(cents.mean()), 1),
            'median': round(float(np.median(cents)), 1),
            'std': round(float(cents.std()), 1),
            'over25': round(float((np.abs(cents) > 25).mean()), 3),
            'over50': round(float((np.abs(cents) > 45).mean()), 3),
            'n': int(cents.size),
        }
        out['meanHz'] = round(float(voiced_hz.mean()), 1)
        out['medianHz'] = round(float(np.median(voiced_hz)), 1)
    return out


def cmd_shift(args):
    import numpy as np
    import pyworld as pw
    import soundfile as sf

    x, sr = sf.read(args.inp, dtype='float64', always_2d=True)
    if x.size == 0:
        return {'ok': False, 'error': 'empty audio'}
    x = np.ascontiguousarray(x.mean(axis=1))
    seconds_in = float(x.size) / float(sr)

    frame_period = 5.0
    f0, t = pw.harvest(x, sr, f0_floor=float(args.f0_floor), f0_ceil=float(args.f0_ceil), frame_period=frame_period)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)

    # 只改浊音帧：harvest 对清音/静音给 0，乘上去还是 0
    ratio = 2.0 ** (float(args.semitones) / 12.0)
    y = pw.synthesize(f0 * ratio, sp, ap, sr, frame_period=frame_period)

    peak = float(np.max(np.abs(y))) or 1.0
    if peak > 0.999:
        y = y * (0.98 / peak)
    sf.write(args.out, y.astype(np.float32), sr, subtype='PCM_16')
    seconds_out = float(y.size) / float(sr)

    voiced = f0 > 0
    return {
        'ok': True,
        'in': args.inp,
        'out': args.out,
        'semitones': float(args.semitones),
        'sr': int(sr),
        'secondsIn': round(seconds_in, 2),
        'secondsOut': round(seconds_out, 2),
        'voicedRatio': round(float(voiced.mean()), 3) if f0.size else 0.0,
    }


SERVE_DEFAULTS = {
    'analyze': {'max_seconds': 30.0, 'fmin': 65.4, 'fmax': 2093.0, 'max_notes': 24},
    'shift': {'f0_floor': 60.0, 'f0_ceil': 800.0},
}


def cmd_serve(_args):
    """长驻模式：一行一个 JSON 请求，一行一个 JSON 回复（id 原样带回）。

    librosa 的 import 要 5 秒，pyin 本身只要 4 秒（12 秒音频）—— 常驻就能把那 5 秒省掉。
    """
    log('ready')
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        cmd = req.get('cmd')
        rid = req.get('id')
        if cmd == 'quit':
            return {'ok': True, 'quit': True}
        params = dict(SERVE_DEFAULTS.get(cmd, {}))
        params.update({k: v for k, v in req.items() if k not in ('id', 'cmd')})
        ns = argparse.Namespace(**params)
        try:
            if cmd == 'analyze':
                result = cmd_analyze(ns)
            elif cmd == 'shift':
                result = cmd_shift(ns)
            else:
                result = {'ok': False, 'error': 'unknown cmd: %s' % cmd}
        except Exception as error:  # noqa: BLE001
            result = {'ok': False, 'error': '%s: %s' % (type(error).__name__, error)}
        out = {'id': rid}
        out.update(result)
        log(out)
    return {'ok': True}


def log(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True))
    sys.stdout.write('\n')
    sys.stdout.flush()


def main(argv):
    try:  # 控制台是 GBK 时也不至于在写 JSON 时炸掉
        sys.stdout.reconfigure(encoding='utf-8', newline='\n')
        sys.stdin.reconfigure(encoding='utf-8')
    except Exception:
        pass

    if argv and argv[0] == 'serve':
        cmd_serve(None)
        return 0

    parser = argparse.ArgumentParser(add_help=True)
    sub = parser.add_subparsers(dest='cmd')

    a = sub.add_parser('analyze')
    a.add_argument('file')
    a.add_argument('--max-seconds', type=float, default=30.0)
    a.add_argument('--fmin', type=float, default=65.4)     # C2
    a.add_argument('--fmax', type=float, default=2093.0)   # C7
    a.add_argument('--max-notes', type=int, default=24)
    a.set_defaults(func=cmd_analyze)

    s = sub.add_parser('shift')
    s.add_argument('inp')
    s.add_argument('out')
    s.add_argument('--semitones', type=float, required=True)
    s.add_argument('--f0-floor', type=float, default=60.0)
    s.add_argument('--f0-ceil', type=float, default=800.0)
    s.set_defaults(func=cmd_shift)

    args = parser.parse_args(argv)
    if not getattr(args, 'func', None):
        emit({'ok': False, 'error': 'usage: pitch.py analyze|shift ...'})
        return 2
    try:
        result = args.func(args)
    except Exception as error:  # noqa: BLE001 - 所有异常都翻成 JSON 给上层
        result = {'ok': False, 'error': '%s: %s' % (type(error).__name__, error)}
    if result.get('ok'):
        emit(result)
        return 0
    emit(result)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
