param([Parameter(Mandatory = $true)][string]$Path)

# Windows-native dictation from a recorded WAV using System.Speech (SAPI).
# Free, no API key. $Path must be a PCM 16-bit mono WAV (16 kHz recommended).
# Prints each recognized phrase to stdout.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToWaveFile($Path)
# Call Recognize(RecognizeMode) via reflection: PowerShell otherwise mis-resolves
# the overload and tries to bind "Multiple" to a TimeSpan parameter.
$mode = [System.Speech.Recognition.RecognizeMode]::Multiple
$mi = $rec.GetType().GetMethod('Recognize', [Type[]]@([System.Speech.Recognition.RecognizeMode]))
[void]$mi.Invoke($rec, [object[]]@($mode))

foreach ($r in $rec.Results) {
  if ($r.Text) { [Console]::Out.WriteLine($r.Text) }
}
[Console]::Out.Flush()
