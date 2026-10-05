$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'node|electron|Health' } |
  ForEach-Object {
    $cmd = $_.CommandLine
    if ($null -ne $cmd -and $cmd.Length -gt 180) { $cmd = $cmd.Substring(0, 180) }
    '{0}  {1}  {2}' -f $_.ProcessId, $_.Name, $cmd
  }
