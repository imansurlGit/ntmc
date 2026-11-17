# Serveur local du formulaire + suivi en direct des badges.
# Lancer :  powershell -ExecutionPolicy Bypass -File serve.ps1
#  - http://localhost:5500        -> ce PC
#  - https://<IP du PC>:5443      -> téléphones sur le même Wi-Fi (HTTPS obligatoire pour le GPS)
# Option : -PublicUrl "https://mon-domaine.example" pour mettre une adresse fixe dans les QR codes
#          (nom de domaine, tunnel, IP réservée…). Sinon l'adresse du PC est détectée en continu.
param([int]$Port = 5500, [int]$HttpsPort = 5443, [string]$PublicUrl = "")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$publicRoot = Join-Path $root "public"
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force $dataDir | Out-Null
$regFile = Join-Path $dataDir "inscriptions.json"
$posFile = Join-Path $dataDir "positions.ndjson"
$keyFile = Join-Path $dataDir "cle-organisateur.txt"
$utf8 = New-Object System.Text.UTF8Encoding $false

function New-Token([int]$n) {
  $alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $bytes = New-Object byte[] $n
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# ---------- Adresse sur le réseau local ----------
# Recalculée régulièrement : si le PC change de Wi-Fi, les nouveaux QR codes suivent.
function Get-LanIp {
  try {
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.OperationalStatus -ne "Up" -or $n.NetworkInterfaceType -eq "Loopback") { continue }
      $p = $n.GetIPProperties()
      $gw = @($p.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq "InterNetwork" -and $_.Address.ToString() -ne "0.0.0.0" })
      if (-not $gw.Count) { continue }
      $a = $p.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq "InterNetwork" } | Select-Object -First 1
      if ($a) { return $a.Address.ToString() }
    }
  } catch {}
  "127.0.0.1"
}
$ip = Get-LanIp
function Get-LanUrl { "https://${script:ip}:$HttpsPort" }

# Adresse à mettre dans le QR code : adresse fixe si fournie, sinon celle par laquelle
# l'appareil nous a joints (déjà valable pour lui), sinon l'adresse actuelle du PC.
function Get-BaseUrl($req) {
  if ($PublicUrl) { return $PublicUrl.TrimEnd("/") }
  $h = $req.Headers["host"]
  if ($req.Secure -and $h -and $h -notmatch "^(localhost|127\.|\[::1\])") { return "https://$h" }
  Get-LanUrl
}

# ---------- Certificat HTTPS auto-signé (créé une fois par adresse IP) ----------
$certName = "Formulaire Inscription $ip"
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
  $_.FriendlyName -eq $certName -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey
} | Select-Object -First 1
if (-not $cert) {
  Write-Host "Création du certificat HTTPS pour $ip..." -ForegroundColor Cyan
  $cert = New-SelfSignedCertificate -Subject "CN=$ip" -FriendlyName $certName `
    -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(1) `
    -TextExtension @("2.5.29.17={text}DNS=localhost&IPAddress=$ip&IPAddress=127.0.0.1", "2.5.29.37={text}1.3.6.1.5.5.7.3.1")
}

# ---------- Clé organisateur (accès à la carte) ----------
if (Test-Path $keyFile) { $adminKey = (Get-Content $keyFile -Raw).Trim() }
else { $adminKey = New-Token 24; [IO.File]::WriteAllText($keyFile, $adminKey, $utf8) }

# ---------- Données ----------
$regs = New-Object System.Collections.ArrayList
if ((Test-Path $regFile) -and (Get-Item $regFile).Length -gt 0) {
  foreach ($r in @([IO.File]::ReadAllText($regFile, $utf8) | ConvertFrom-Json)) { [void]$regs.Add($r) }
}
$trails = @{}
function Add-Point($p) {
  if (-not $trails.ContainsKey($p.id)) { $trails[$p.id] = New-Object System.Collections.ArrayList }
  [void]$trails[$p.id].Add($p)
  if ($trails[$p.id].Count -gt 2000) { $trails[$p.id].RemoveAt(0) }
}
if (Test-Path $posFile) {
  foreach ($line in [IO.File]::ReadAllLines($posFile, $utf8)) {
    if ($line.Trim()) { try { Add-Point ($line | ConvertFrom-Json) } catch {} }
  }
}
function Save-Regs { [IO.File]::WriteAllText($regFile, (ConvertTo-Json -InputObject @($regs) -Depth 8 -Compress), $utf8) }
function Find-Reg($id) { foreach ($r in $regs) { if ($r.id -eq $id) { return $r } }; return $null }

# ---------- HTTP minimal ----------
$types = @{
  ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"
  ".png" = "image/png"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"; ".svg" = "image/svg+xml"
  ".ico" = "image/x-icon"; ".webp" = "image/webp"; ".woff2" = "font/woff2"
}
$reasons = @{ 200 = "OK"; 201 = "Created"; 400 = "Bad Request"; 401 = "Unauthorized"; 404 = "Not Found"; 409 = "Conflict"; 413 = "Payload Too Large"; 500 = "Internal Server Error" }

function Read-Request($stream) {
  $buf = New-Object byte[] 65536
  $ms = New-Object IO.MemoryStream
  $headerEnd = -1
  while ($headerEnd -lt 0) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { return $null }
    $ms.Write($buf, 0, $n)
    $headerEnd = [Text.Encoding]::ASCII.GetString($ms.GetBuffer(), 0, [int]$ms.Length).IndexOf("`r`n`r`n")
    if ($headerEnd -lt 0 -and $ms.Length -gt 65536) { return $null }
  }
  $head = [Text.Encoding]::ASCII.GetString($ms.GetBuffer(), 0, $headerEnd).Split("`n")
  $first = $head[0].Trim().Split(" ")
  $headers = @{}
  foreach ($h in $head[1..($head.Length - 1)]) {
    $i = $h.IndexOf(":"); if ($i -gt 0) { $headers[$h.Substring(0, $i).Trim().ToLower()] = $h.Substring($i + 1).Trim() }
  }
  $len = 0; if ($headers["content-length"]) { $len = [int]$headers["content-length"] }
  if ($len -gt 8MB) { return @{ TooLarge = $true } }
  $start = $headerEnd + 4
  while ($ms.Length -lt $start + $len) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
  }
  $body = ""
  if ($len -gt 0) { $body = $utf8.GetString($ms.GetBuffer(), $start, [Math]::Min($len, [int]$ms.Length - $start)) }
  $target = $first[1]
  $path = $target; $query = @{}
  $q = $target.IndexOf("?")
  if ($q -ge 0) {
    $path = $target.Substring(0, $q)
    foreach ($pair in $target.Substring($q + 1).Split("&")) {
      $kv = $pair.Split("=", 2)
      if ($kv[0]) { $query[[Uri]::UnescapeDataString($kv[0])] = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1].Replace("+", " ")) } else { "" } }
    }
  }
  @{ Method = $first[0]; Path = [Uri]::UnescapeDataString($path); Query = $query; Body = $body; Headers = $headers }
}

function Send($stream, [int]$status, [string]$type, [byte[]]$body) {
  if (-not $body) { $body = New-Object byte[] 0 }
  $h = "HTTP/1.1 $status $($reasons[$status])`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`n" +
       "Cache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($h)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}
function Send-Json($stream, [int]$status, $obj) {
  Send $stream $status "application/json; charset=utf-8" $utf8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 8 -Compress))
}

# ---------- API ----------
function Handle-Api($stream, $req) {
  $q = $req.Query
  switch ($req.Path) {
    "/api/info" { return Send-Json $stream 200 @{ lanUrl = (Get-BaseUrl $req) } }

    "/api/register" {
      if ($req.Method -ne "POST") { return Send-Json $stream 400 @{ error = "POST attendu" } }
      $b = $req.Body | ConvertFrom-Json
      $d = $b.data
      if (-not $d -or -not $d.nom -or -not $d.prenom -or -not $d.telephone -or -not $d.email) {
        return Send-Json $stream 400 @{ error = "Champs manquants" }
      }
      if ($d.photo -and $d.photo.Length -gt 3MB) { return Send-Json $stream 413 @{ error = "Photo trop lourde" } }
      foreach ($r in $regs) {
        if ($r.data.telephone -eq $d.telephone -or $r.data.email -eq $d.email) {
          return Send-Json $stream 409 @{ error = "Une demande existe déjà avec ce numéro ou cet e-mail." }
        }
      }
      $code = ("" + $b.code).ToUpper() -creplace "[^A-Z0-9]", ""; if (-not $code) { $code = "BADGE" }
      $reg = [pscustomobject]@{
        id = "$code-$(New-Token 6)"; token = New-Token 20
        createdAt = (Get-Date).ToUniversalTime().ToString("o"); data = $d
      }
      [void]$regs.Add($reg); Save-Regs
      Write-Host "  + Inscription $($reg.id) : $($d.prenom) $($d.nom)" -ForegroundColor Green
      return Send-Json $stream 201 @{
        id = $reg.id; createdAt = $reg.createdAt
        trackUrl = "$(Get-BaseUrl $req)/suivi.html?b=$($reg.id)&t=$($reg.token)"
      }
    }

    "/api/badge" {
      $r = Find-Reg $q["b"]
      if (-not $r -or $r.token -ne $q["t"]) { return Send-Json $stream 404 @{ error = "Badge inconnu" } }
      return Send-Json $stream 200 @{ id = $r.id; prenom = $r.data.prenom; nom = $r.data.nom; type_label = $r.data.type_label; organisation = $r.data.organisation }
    }

    "/api/photo" {
      $r = Find-Reg $q["b"]
      $ok = $r -and (($q["t"] -and $r.token -eq $q["t"]) -or ($q["key"] -eq $adminKey))
      if (-not $ok -or -not $r.data.photo) { return Send $stream 404 "text/plain" $null }
      $raw = "" + $r.data.photo
      $comma = $raw.IndexOf(",")
      return Send $stream 200 "image/jpeg" ([Convert]::FromBase64String($raw.Substring($comma + 1)))
    }

    "/api/position" {
      if ($req.Method -ne "POST") { return Send-Json $stream 400 @{ error = "POST attendu" } }
      $b = $req.Body | ConvertFrom-Json
      $r = Find-Reg $b.b
      if (-not $r -or $r.token -ne $b.t) { return Send-Json $stream 401 @{ error = "Badge inconnu" } }
      $now = Now-Ms; $count = 0
      $sb = New-Object System.Text.StringBuilder
      foreach ($p in @($b.points | Select-Object -First 100)) {
        $lat = [double]$p.lat; $lng = [double]$p.lng
        if ([Math]::Abs($lat) -gt 90 -or [Math]::Abs($lng) -gt 180) { continue }
        $ts = [double]$p.ts; if ([Math]::Abs($ts - $now) -gt 86400000) { $ts = $now }
        $pt = [pscustomobject]@{ id = $r.id; lat = $lat; lng = $lng; acc = [Math]::Round([double]$p.acc); ts = $ts; rx = $now }
        Add-Point $pt
        [void]$sb.AppendLine((ConvertTo-Json -InputObject $pt -Compress))
        $count++
      }
      if ($count) { [IO.File]::AppendAllText($posFile, $sb.ToString(), $utf8) }
      return Send-Json $stream 200 @{ ok = $true; count = $count }
    }

    "/api/live" {
      if ($q["key"] -ne $adminKey) { return Send-Json $stream 401 @{ error = "Clé organisateur invalide" } }
      $list = New-Object System.Collections.ArrayList
      foreach ($r in $regs) {
        $t = $trails[$r.id]
        $last = $null; $trail = @()
        if ($t -and $t.Count) {
          $l = $t[$t.Count - 1]
          $last = @{ lat = $l.lat; lng = $l.lng; acc = $l.acc; ts = $l.ts }
          $trail = @($t | Select-Object -Last 120 | ForEach-Object { @{ lat = $_.lat; lng = $_.lng; ts = $_.ts } })
        }
        [void]$list.Add(@{
          id = $r.id; prenom = $r.data.prenom; nom = $r.data.nom; type_label = $r.data.type_label
          organisation = $r.data.organisation; telephone = $r.data.telephone; zones = $r.data.zones
          hasPhoto = [bool]$r.data.photo; last = $last; trail = $trail
        })
      }
      return Send-Json $stream 200 @{ now = (Now-Ms); people = $list }
    }

    default { return Send-Json $stream 404 @{ error = "Route inconnue" } }
  }
}

function Handle-Request($stream, $req) {
  if ($req.TooLarge) { return Send-Json $stream 413 @{ error = "Requête trop lourde" } }
  if ($req.Path.StartsWith("/api/")) { return Handle-Api $stream $req }

  $rel = $req.Path.TrimStart("/"); if (-not $rel) { $rel = "index.html" }
  $first = $rel.Split("/")[0]
  $file = [IO.Path]::GetFullPath((Join-Path $publicRoot $rel))
  $ext = [IO.Path]::GetExtension($file).ToLower()
  $allowed = $file.StartsWith($publicRoot + [IO.Path]::DirectorySeparatorChar) -and $types.ContainsKey($ext) -and
             $first -ne "data" -and -not $first.StartsWith(".")
  if ($allowed -and (Test-Path $file -PathType Leaf)) {
    return Send $stream 200 $types[$ext] ([IO.File]::ReadAllBytes($file))
  }
  Send $stream 404 "text/plain; charset=utf-8" $utf8.GetBytes("Introuvable")
}

function Serve-Client($client, [bool]$secure) {
  try {
    $client.ReceiveTimeout = 4000; $client.SendTimeout = 8000
    $stream = $client.GetStream()
    if ($secure) {
      $ssl = New-Object System.Net.Security.SslStream($stream, $false)
      $ssl.AuthenticateAsServer($cert, $false, [Security.Authentication.SslProtocols]::Tls12, $false)
      $stream = $ssl
    }
    $req = Read-Request $stream
    if ($req) {
      $req.Secure = $secure
      try { Handle-Request $stream $req }
      catch {
        Write-Host "  ! $($req.Path) : $($_.Exception.Message)" -ForegroundColor Red
        try { Send-Json $stream 500 @{ error = "Erreur serveur" } } catch {}
      }
    }
  } catch {
    # Connexion interrompue, certificat refusé par le navigateur, etc. : sans gravité
  } finally { $client.Close() }
}

# ---------- Démarrage ----------
try {
  $http = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port); $http.Start()
  $https = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Any, $HttpsPort); $https.Start()
} catch {
  Write-Host "Port $Port ou $HttpsPort déjà utilisé. Fermez l'autre serveur ou lancez : serve.ps1 -Port 5600 -HttpsPort 5643" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  Serveur lancé (Ctrl+C pour arrêter)" -ForegroundColor Green
Write-Host "  Formulaire, sur ce PC     : http://localhost:$Port/"
Write-Host "  Formulaire, téléphones    : $(Get-LanUrl)/"
if ($PublicUrl) { Write-Host "  Adresse fixe des QR codes : $PublicUrl" -ForegroundColor Cyan }
Write-Host "  Carte de suivi (organis.) : http://localhost:$Port/carte.html?key=$adminKey" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Les téléphones doivent être sur le même Wi-Fi. Au premier accès, ils affichent un"
Write-Host "  avertissement de certificat : choisir « Paramètres avancés » puis « Continuer »."
Write-Host "  Si Windows demande d'autoriser PowerShell dans le pare-feu : cocher « Réseaux privés »."
Write-Host ""
Start-Process "http://localhost:$Port/"

$waiting = New-Object System.Collections.ArrayList
$lastIpCheck = [DateTime]::UtcNow
try {
  while ($true) {
    if (([DateTime]::UtcNow - $lastIpCheck).TotalSeconds -ge 10) {
      $lastIpCheck = [DateTime]::UtcNow
      $cur = Get-LanIp
      if ($cur -ne $ip) {
        $ip = $cur
        Write-Host "  Réseau changé : téléphones -> $(Get-LanUrl)/" -ForegroundColor Cyan
      }
    }
    while ($http.Pending()) { [void]$waiting.Add(@{ c = $http.AcceptTcpClient(); s = $false; t = [DateTime]::UtcNow }) }
    while ($https.Pending()) { [void]$waiting.Add(@{ c = $https.AcceptTcpClient(); s = $true; t = [DateTime]::UtcNow }) }
    $busy = $false
    # On ne sert que les connexions qui ont déjà envoyé des données : une connexion ouverte
    # « au cas où » par le navigateur ne bloque pas les autres.
    for ($i = $waiting.Count - 1; $i -ge 0; $i--) {
      $w = $waiting[$i]
      if ($w.c.Available -gt 0) { $waiting.RemoveAt($i); Serve-Client $w.c $w.s; $busy = $true }
      elseif (([DateTime]::UtcNow - $w.t).TotalSeconds -gt 15) { $waiting.RemoveAt($i); $w.c.Close() }
    }
    if (-not $busy) { Start-Sleep -Milliseconds 8 }
  }
} finally {
  $http.Stop(); $https.Stop()
}
