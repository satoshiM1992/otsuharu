# Minimal static file server for local testing (no Node/Python needed).
# Usage:  powershell -ExecutionPolicy Bypass -File tools/serve.ps1 [-Port 8080]
# Then open http://localhost:8080/  (test page: http://localhost:8080/test/)
param([int]$Port = 8080)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'
  '.vrm' = 'application/octet-stream'; '.glb' = 'model/gltf-binary'; '.vrma' = 'application/octet-stream'
  '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'; '.md' = 'text/plain; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($path -eq '' -or $path.EndsWith('/')) { $path += 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    $res.Headers.Add('Cache-Control', 'no-store')
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.Close()
    Write-Host "$($res.StatusCode) /$path"
  }
} finally {
  $listener.Stop()
}
