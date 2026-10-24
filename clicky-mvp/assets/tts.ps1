param([string]$Text = '', [string]$Voice = '')

# Windows-native text-to-speech using System.Speech (SAPI). Free, no API key.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) {
  try { $synth.SelectVoice($Voice) } catch {}
}

$synth.Speak($Text)
