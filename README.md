# 语音（cortico-world-voice）

Coopanion 的 World 插件：让桌宠**在本机出声**。用 Windows 自带的 SAPI 语音合成，**离线、不要 key、不下模型**。

## 四个工具

| 工具 | 参数 | 干什么 |
| --- | --- | --- |
| `voice_say` | `text`(≤800 字)、`voice`(音色)、`rate`(-10..10)、`play`(默认 true)、`speed`、`pitch`、`temperature`、`top_k` | 合成并出声；`play:false` 只存文件；后四个只对 `roxy` 生效 |
| `voice_pitch` | `file`(工作区里)、`maxSeconds`(默认 30)、`maxNotes`(默认 24)、`notes`、`fmin`、`fmax` | 量音高：每个音的音名+时间+音分，再加音域和跑调判断 |
| `voice_list` | 无 | 列出本机音色（名字 · 语言 · 性别） |
| `voice_transcribe` | `file`(工作区里) | 把音频转成文字（本地 SenseVoice） |

```
voice_list → Microsoft Huihui Desktop · zh-CN · Female
             Microsoft Zira Desktop · en-US · Female
```

## 怎么实现的

PowerShell + `System.Speech.Synthesis`：

- 文本走**临时文件**（UTF-8），命令走 `-EncodedCommand`（UTF-16LE base64）——
  中文、引号、换行都不会被命令行解析搞坏
- 没指定音色时自动挑一个 `zh-*` 的
- `play:true` 用 `System.Media.SoundPlayer` 后台播放（`detached`，不阻塞工具调用）
- 文件落在 `workspace\voice\<YYYY-MM-DD>\<HHMMSS>.wav`；工具不接受路径参数

实测：一句话 **约 1.1 秒**合成完；6.6 秒音频 = 237KB wav。

## 和 TG 语音的关系

TG 那边的 `tg_voice` 用同一套合成（代码在 telegram 扩展里各留一份，让两个扩展都自包含），
再由 **ffmpeg 转成 ogg/opus** 发语音气泡。所以两处都能用，互不依赖。

## 已知边界

- 音色就是 Windows 自带的（Huihui），机械感明显；要好听得换 Edge TTS（在线）
- 只能在装了中文音色的 Windows 上出中文；没有中文音色时会退回任意一个
- 一次 800 字上限：SAPI 长文本会念好几分钟，工具调用会一直等着（超时 30 秒）
- 出声是"在这台电脑的扬声器上"，不是发给别人；要发出去用 `tg_voice`
## 听（SenseVoice，本地）

```
voice_transcribe { file: "…\\workspace\\voice\\incoming\\2026-10-31\\231718-600.ogg" }
  → 你好，我是小鱼，这是离线合成的语音互联网。
    （zh，6.6 秒）
```

- 模型：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（int8，**228MB**），放在
  `C:\Users\86188\coopanion-ext\tools\asr\`；可用 `VOICE_ASR_DIR` 覆盖
- 运行时：复用 Coop 自带的 `sherpa-onnx-node`（不额外装东西），可用 `VOICE_SHERPA` 覆盖
- 首次调用加载模型 **约 2.3 秒**、占 228MB 内存，之后同一个实例复用（一次转写约 **0.2–0.4 秒**）
- 非 wav（ogg/mp3）先用 ffmpeg 转 16k 单声道 wav
- **只读工作区里的文件**：路径不在 `workspace` 下直接拒（不接受任意路径）
- 完全离线：音频不出这台电脑

TG 那边收到语音会自动走同一条链路（telegram 扩展里 `import` 本扩展的 `asr.js`，
同一个进程里只加载一次模型），事件文本变成 `[语音 6.6秒] 转写内容`，`meta.voice` 里带
`{ ok, text, lang, seconds, saved }`。


## 洛琪希音色（GPT-SoVITS）

`voice_say` 的 `voice` 传 `roxy`（或 `洛琪希`）就走本地 GPT-SoVITS：

```
voice_say { text: "…", voice: "roxy" }
  → 9880 没起就自动拉起（detached，约 45 秒）
  → 自动切到 v2ProPlus 的 Roxy3.0 权重（api_v2 每次新进程都要重设）
  → 参考音 _downloads\roxy-ref-sajiao.wav（撒娇），prompt_text 为那句日语
  → 出 wav 落 workspace\voice\<日期>\，再出声
```

- 正文含假名 → `text_lang=ja`，否则 `zh`（跨语言，参考音固定 `ja`）
- 起不来 / 依赖缺失 / 合成失败 → **自动退回 SAPI**，回执末尾会写「洛琪希没用上：原因」
- 服务常驻（省下次 45 秒，占约 3–4GB 显存）：`Stop-Process -Id <pid>` 或调 `stopServer()`
- 路径可用环境变量覆盖：`VOICE_GSV_DIR` / `VOICE_GSV_URL` / `VOICE_GSV_REF` / `VOICE_GSV_REF_TEXT`
- 采样参数默认 temperature **0.6** / top_k **10**（见下节），启动日志会打一行确认


### 语速（speed）

`voice_say` / `tg_voice` 都多了一个 `speed`（0.5–2.0，**默认 0.85**）。

**一个实测结论**：GPT-SoVITS 服务端的 `speed_factor` 对 v2ProPlus 权重**几乎不敏感** ——
同一句话 0.6 出来 6.0 秒、1.5 出来 5.25 秒（只差 14%，理论上该差 2.5 倍）。所以：

- 发给 API 的 `speed_factor` 固定 `1.0`
- 真正的语速在拿到 wav 之后用 **ffmpeg `atempo`** 施加（保音高、比例精确）

实测同句、同 seed：0.8 → 12.56 秒 / 0.85 → 12.15 秒 / 0.9 → 11.25 秒（单调递减，符合 1/speed）。

### 采样参数（temperature / top_k）

默认 **temperature 0.6 / top_k 10**（服务端 `api_v2.py` 自己的默认是 1.0 / 15，这里覆盖掉了）。
实测同一句话四条对比（speed 0.9、同一句）：

| 设置 | 时长 | 中位音高 | 音域 | 音分波动 |
| --- | --- | --- | --- | --- |
| t0.6 / k10（现在默认） | 3.58s | 296.2Hz | A#3～F#4 | 28.2¢ |
| t0.5 / k5 | 3.63s | 307.5Hz | A#3～G#4 | 28.3¢ |
| t1.0 / k15（服务端默认） | 3.90s | 318.4Hz | B3～D5 | 31.0¢ |

温度低一点：句子更短、音高跨度更小、更"稳"，名字念对的概率也更高（本地 ASR 只有 t0.5/k5 那条把
「ルディ」听对了，其余三条都听成「トディ」——不过 SenseVoice 对这个非日语人名本来就弱，别当铁证）。

改了默认值以后想临时另调，两个工具上都有开关（不传就吃默认 0.6 / 10；传了越界直接拒，不会被悄悄钳掉）：

```
voice_say { text: "…", voice: "roxy", temperature: 0.4, top_k: 5 }
tg_voice  { text: "…", voice: "roxy", temperature: 1.0 }
```

回执里会写实际生效的那组值（`（洛琪希，speed 0.85，t0.4/k5）`），所以试参数时不用猜。
范围：`temperature` 0.1–2、`top_k` 1–50。本机 SAPI 音色不吃这四个参数（会回一句说明）。

### 变调（pitch）

```
voice_say { text: "…", voice: "roxy", pitch: 2 }      // 升 2 个半音
tg_voice  { text: "…", voice: "roxy", pitch: -1.5 }   // 降 1.5 个半音
```

**GPT-SoVITS 这套 v2ProPlus 不能指定调**：`api_v2.py` 里没有 pitch / key / transpose / f0_up_key
之类的参数（`aux_ref_audio_paths` 是音色融合，不是变调），调子由参考音和文本决定。所以变调只能
在拿到 wav 之后做，用的是 `pitch.py shift`：

```
harvest 提 f0 → cheaptrick 谱包络 → d4c 非周期 → f0 × 2^(n/12) → synthesize
```

- **共振峰不动**（谱包络没改），所以是"同一个人换了个调"，不会像 `asetrate` 那样变成花栗鼠
- **时长不变**：实测 3.46 秒 → 3.47 秒
- 只改浊音帧（harvest 对清音给 0，乘上去还是 0），气声不会被改坏
- 顺序：**先变调，后变速**（pyworld 的 f0 提取在原始时长上最准）
- 每次多 **约 1.0 秒**（3 秒音频；12 秒音频约 3.5 秒）
- 范围 **±6 半音**，超了直接拒；`pitch: 0` 完全不调用 pyworld
- **变调失败就退回原调出声**，回执末尾会写「这次没能变调，用的是原调：原因」
- 本机 SAPI 音色不支持变调：带了 `pitch` 会回一句「本机 SAPI 音色不能变调，pitch 这次没生效」

实测（同一段 3.46 秒音频，只做变调不重新合成）：

| pitch | 实测偏移 | 时长 | 中位频率 |
| --- | --- | --- | --- |
| 0 | 0.00 | 3.46s | 308.4Hz |
| +2 | +1.85 | 3.47s | 343.2Hz |
| −2 | −2.30 | 3.47s | 270.1Hz |
| +4 | +3.85 | 3.47s | 385.2Hz |
| −4 | −4.35 | 3.47s | 239.9Hz |
| +6 | +6.05 | 3.47s | 437.4Hz |

（实测值与名义值差 0.2 半音以内，这就是 pyin 自己的估计误差量级。）

## 量音高（voice_pitch）

```
voice_pitch { file: "…\\workspace\\voice\\2026-11-01\\005608.wav" }
  → 音高分析：005608.wav，2.39 秒
    音域 D#4～F#4（304～380.8Hz），8 个音，有音帧 54%
    [0.19s] F4 +29.8¢   [0.42s] E4 -20.2¢   [0.49s] D#4 -0.2¢   [1.32s] F#4 -40.2¢
    平均 +2.9 音分，中位 +4.8，超过 25 音分的音占 46%（波动 27 音分）
    判断：偏离十二平均律很明显（46% 的音超过 25 音分）
```

- 引擎：`librosa.pyin`（概率模型，能分清"没出声"和"跑调"），跑在 **GPT-SoVITS 自带的 python 3.9**
  里（librosa 0.9.2 / pyworld 0.3.2 / soundfile 0.12.1 都已装好，**不额外装任何东西**）
- `pitch.py` 常驻（一行一个 JSON 请求），因为 librosa 光 import 要 4.8 秒：第一次 10 秒，之后 **约 4.5 秒**
  （12 秒音频）；闲置 5 分钟自动退出，常驻起不来就退回"每次一个进程"
- 默认只量**前 30 秒**（`maxSeconds` 可到 120），最多列 24 个音；`notes:false` 只要摘要
- 直接读 **wav / ogg / mp3 / flac**（ogg 是 librosa 自己解，不用先转 wav）
- **只读工作区里的文件**，路径不在 `workspace` 下直接拒
- 合并音符的规则：连续 ≥60ms、偏离当前音 ≤3/4 个半音算同一个音
- 判断口径：`|音分| > 25` 的帧占比 >35% 算"偏离很明显"、>15% 算"轻微偏离"；另外给整体偏移，
  超过 20 音分会建议用哪个 `pitch` 掰回来

**一句实在话**：说话本来就不会踩在十二平均律上，一句普通日语/中文念出来的音分抖动 20–30 是正常的
（上面 46% 超过 25 音分就是这么来的）。这个工具真正好用的地方是**比较同一句话的两个版本**
（比如变调前后、两版参数），或者量唱歌、量音域；单看一句"跑没跑调"要留个心眼。
