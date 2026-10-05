# TASK-105 дожим: фиксированный test-cert для CI-подписи (release-окружение).
# DN обязан совпадать с publisherName из apps/desktop/electron-builder.yml —
# updater сравнивает DN как множество (certificates.md §3).
# Повторный запуск переиспользует существующий сертификат с тем же Subject.
param(
  [Parameter(Mandatory = $true)][string]$PfxPassword,
  [Parameter(Mandatory = $true)][string]$PfxPath
)
$ErrorActionPreference = 'Stop'

$subject = 'CN=Health Log, O=Health Log, C=RU'
$existing = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending | Select-Object -First 1

if ($existing) {
  $cert = $existing
  Write-Output 'cert=reused (existing with same Subject)'
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject $subject `
    -KeyUsage DigitalSignature -KeySpec Signature -KeyExportPolicy Exportable `
    -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation Cert:\CurrentUser\My
  Write-Output 'cert=created'
}

$secure = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath ($PfxPath -replace '\.pfx$', '.cer') -Type CERT | Out-Null

Write-Output ("thumbprint=" + $cert.Thumbprint)
Write-Output ("subject=" + $cert.Subject)
Write-Output ("notAfter=" + $cert.NotAfter.ToString('o'))
Write-Output ("eku=" + (($cert.Extensions | Where-Object { $_.Oid.FriendlyName -like '*Enhanced Key Usage*' }).EnhancedKeyUsageList.FriendlyName -join ','))
