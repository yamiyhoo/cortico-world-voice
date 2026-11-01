# SAPI 合成（离线、零依赖）。参数：
#   -TextFile  待读的 UTF-8 文本（避免命令行里给中文加引号的坑）
#   -OutFile   输出 wav
#   -Voice     音色名（默认 Microsoft Huihui Desktop），找不到就退回第一个中文音色
#   -Rate      -10..10，0 正常
param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$Voice = 'Microsoft Huihui Desktop',
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -Encoding UTF8 -Path $TextFile
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
  $want = $voices | Where-Object { $_.Name -eq $Voice } | Select-Object -First 1
  if (-not $want) { $want = $voices | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1 }
  if ($want) { $synth.SelectVoice($want.Name) }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
if (Test-Path $OutFile) {
  $len = (Get-Item $OutFile).Length
  $name = ''
  Write-Output ('ok|' + $len)
} else {
  Write-Output 'fail|no output'
}