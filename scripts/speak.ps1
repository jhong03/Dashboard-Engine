# System-voice fallback for Windows (SAPI via System.Speech).
#
# Security rule (CLAUDE.md): user text NEVER appears on a command line. This
# script is invoked with a FIXED argv (-File scripts/speak.ps1 [voiceHint])
# and reads the text to speak from stdin only.
#
# $args[0], if present, is a substring hint for voice selection (e.g.
# "United Kingdom") taken from the profile's base.fallback.match — it comes
# from a sanitized profile, but is still only ever used as a match string.

Add-Type -AssemblyName System.Speech
$text = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($text)) { exit 0 }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($args.Count -ge 1 -and $args[0]) {
    $hint = [string]$args[0]
    $match = $synth.GetInstalledVoices() |
        Where-Object { $_.Enabled -and ($_.VoiceInfo.Name -like "*$hint*" -or $_.VoiceInfo.Culture.DisplayName -like "*$hint*") } |
        Select-Object -First 1
    if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }
}
$synth.Speak($text)
