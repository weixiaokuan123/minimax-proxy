# 查询 minimax-proxy 两个区域的运行状态（只读）。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot

$regions = @(
  @{ name = 'cn'; port = 39305; keyFile = Join-Path $Root 'keys\cn.key' },
  @{ name = 'en'; port = 39306; keyFile = Join-Path $Root 'keys\en.key' }
)

foreach ($r in $regions) {
  Write-Host ("== {0}  http://127.0.0.1:{1} ==" -f $r.name, $r.port)
  if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $r.port -WarningAction SilentlyContinue -InformationLevel Quiet)) {
    Write-Host "  端口未监听（服务未启动或该区域未就绪）`n"
    continue
  }
  if (-not (Test-Path $r.keyFile)) { Write-Host "  缺少 key 文件`n"; continue }
  $key = (Get-Content $r.keyFile -Raw).Trim()
  try {
    $st = Invoke-RestMethod -Uri "http://127.0.0.1:$($r.port)/status" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    if ($st.auth.state -eq 'signed-in') {
      $min = [math]::Round($st.auth.remainingSec / 60)
      Write-Host ("  账号: {0}  token剩余: {1} 分钟  模型数: {2}" -f $st.auth.account, $min, $st.models.Count)
    } elseif ($st.auth.state -eq 'expired') {
      Write-Host "  token 已过期：请打开 MiniMax Code 桌面端让其自动续期"
    } else {
      Write-Host "  未登录（未安装该区域 MiniMax Code 或未登录）"
    }
  } catch {
    Write-Host "  查询失败: $($_.Exception.Message)"
  }
  Write-Host ''
}
