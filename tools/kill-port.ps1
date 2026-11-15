#Requires -Version 5.1
<#
.SYNOPSIS
    释放被占用的 TCP 端口（Windows）。

.DESCRIPTION
    专治「进程杀不掉 / 端口一直 EADDRINUSE」。按从轻到重的顺序逐级升级：

      ① 先看清楚谁占着（PID / 进程名 / 命令行 / 父进程 / 是否孤儿）
      ② 温和请求退出（CloseMainWindow → 给 GUI 进程）
      ③ taskkill 不带 /F（WM_CLOSE）
      ④ taskkill /F（强杀）
      ⑤ 杀不掉就找真正的原因并报出来，而不是假装成功

    ⛔ 本脚本**不信任 taskkill 的退出码**。Windows 上 taskkill 返回 0 但进程
       还在的情况非常常见（尤其 node、被调试器挂住的进程、服务托管的进程）。
       唯一的成功判据是：**重新枚举端口，确认没人监听了**。

.PARAMETER Port
    要释放的端口号，可传多个。默认 1420（本项目 dev server）。

.PARAMETER Force
    跳过确认提示，直接动手。

.PARAMETER DryRun
    只看谁占着，不做任何终止动作。

.PARAMETER KeepParent
    只杀叶子进程。默认会把「命令行相关的父进程链」一起清掉 ——
      因为 dev server 常见形态是 npm run dev → node serve.js，
      只杀子进程，父进程（npm）会立刻把它重新拉起来，表现为「杀了又活了」。

.PARAMETER IncludeOrphans
    额外清理「同名进程但已经不占端口」的孤儿残留（默认关闭，避免误杀）。

.EXAMPLE
    .\kill-port.ps1
    # 释放 1420

.EXAMPLE
    .\kill-port.ps1 -Port 1420,5173 -Force
    # 一次释放多个端口，不询问

.EXAMPLE
    .\kill-port.ps1 -DryRun
    # 只看谁占着，不动手

.NOTES
    退出码：
      0  端口已全部空闲（或本来就没被占）
      1  仍有端口被占（脚本已尽力，附带诊断原因）
      2  参数错误
#>
[CmdletBinding()]
param(
    [int[]]$Port = @(1420),
    [switch]$Force,
    [switch]$DryRun,
    [switch]$KeepParent,
    [switch]$IncludeOrphans
)

$ErrorActionPreference = 'Continue'
$script:Failures = @()

# ─────────────────────────────────────────────────────────────
# 输出helper
# ─────────────────────────────────────────────────────────────
function Write-Head([string]$t) { Write-Host ""; Write-Host "── $t " -NoNewline -ForegroundColor Cyan; Write-Host ("─" * [Math]::Max(0, 60 - $t.Length)) -ForegroundColor DarkGray }
function Write-Ok([string]$t)   { Write-Host "  ✓ $t" -ForegroundColor Green }
function Write-Bad([string]$t)  { Write-Host "  ✗ $t" -ForegroundColor Red }
function Write-Warn2([string]$t){ Write-Host "  ⚠ $t" -ForegroundColor Yellow }
function Write-Info([string]$t) { Write-Host "    $t" -ForegroundColor DarkGray }

# ─────────────────────────────────────────────────────────────
# 端口占用枚举
#
# ⛔ 用 Get-NetTCPConnection 而不是 netstat 解析：
#    netstat 的输出列宽会随地址族/状态变化，中文系统还可能被本地化，
#    解析正则一改版就崩。Get-NetTCPConnection 是结构化对象。
# ⛔ 但要**同时看 IPv4 和 IPv6**：node 默认 listen 在 :: 上，
#    只查 127.0.0.1 会漏掉（本机实测 1420 就是只出现在 [::] 上）。
# ─────────────────────────────────────────────────────────────
function Get-PortOwners([int]$p) {
    $conns = @()
    try {
        $conns = Get-NetTCPConnection -LocalPort $p -ErrorAction Stop |
                 Where-Object { $_.State -eq 'Listen' -or $_.State -eq 'Established' }
    } catch {
        # 老系统没有该 cmdlet 时回落 netstat
        $raw = & netstat -ano 2>$null | Select-String ":$p\s"
        foreach ($line in $raw) {
            $f = ($line.ToString().Trim() -split '\s+')
            if ($f.Length -ge 5 -and $f[0] -eq 'TCP') {
                $conns += [pscustomobject]@{
                    LocalAddress  = ($f[1] -split ':')[-2]
                    LocalPort     = $p
                    State         = $f[3]
                    OwningProcess = [int]$f[4]
                }
            }
        }
    }
    return $conns
}

function Get-ProcInfo([int]$procId) {
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if (-not $ci) { return $null }
    $parentAlive = $false
    if ($ci.ParentProcessId -gt 0) {
        $parentAlive = [bool](Get-Process -Id $ci.ParentProcessId -ErrorAction SilentlyContinue)
    }
    return [pscustomobject]@{
        Pid           = $ci.ProcessId
        Name          = $ci.Name
        CommandLine   = $ci.CommandLine
        ParentPid     = $ci.ParentProcessId
        ParentAlive   = $parentAlive
        IsOrphan      = (-not $parentAlive) -and ($ci.ParentProcessId -gt 0)
        CreationDate  = $ci.CreationDate
        ExecutablePath= $ci.ExecutablePath
    }
}

# ─────────────────────────────────────────────────────────────
# 「这个 PID 是不是我自己 / 我的祖先」
#
# ⛔ 为什么必须有这层：清理父进程时，很容易顺着链走到「启动本脚本的那个终端」。
#    把终端杀掉 = 脚本自己被 Ctrl+C，输出戛然而止、退出码 3221225786，
#    用户看到的是「脚本跑一半就没了」，而端口其实没处理完。
#    沿 ParentProcessId 一路向上走到根（或 30 层封顶，防环），任何一环命中都算祖先。
# ─────────────────────────────────────────────────────────────
$script:SelfChain = $null
function Get-SelfAncestorChain {
    if ($script:SelfChain) { return $script:SelfChain }
    $chain = New-Object System.Collections.Generic.HashSet[int]
    $cur = $PID
    for ($i = 0; $i -lt 30 -and $cur -gt 0; $i++) {
        if (-not $chain.Add($cur)) { break }   # 环
        $ci = Get-CimInstance Win32_Process -Filter "ProcessId = $cur" -ErrorAction SilentlyContinue
        if (-not $ci) { break }
        $cur = [int]$ci.ParentProcessId
    }
    $script:SelfChain = $chain
    return $chain
}
function Test-IsSelfOrAncestor([int]$procId) {
    if ($procId -le 0) { return $false }
    return (Get-SelfAncestorChain).Contains($procId)
}

# ─────────────────────────────────────────────────────────────
# 端口是否真的空闲 —— 这是唯一成功判据
# ─────────────────────────────────────────────────────────────
function Test-PortFree([int]$p) {
    # ① 没有监听者
    $owners = Get-PortOwners $p | Where-Object { $_.State -eq 'Listen' }
    if ($owners) { return $false }
    # ② 真去 bind 一次，确认能拿到（防 TIME_WAIT / 半开 / 防火墙层占用）
    $ok4 = $false; $ok6 = $false
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p)
        $l.Start(); $l.Stop(); $ok4 = $true
    } catch { $ok4 = $false }
    try {
        $l6 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Any, $p)
        $l6.Start(); $l6.Stop(); $ok6 = $true
    } catch { $ok6 = $false }
    # IPv6Any 在部分系统上对同一端口会失败但实际可用，以 IPv4 为准
    return $ok4
}

# ─────────────────────────────────────────────────────────────
# 终止一个进程：逐级升级，每级都复核
# ─────────────────────────────────────────────────────────────
function Stop-ProcHard([int]$procId, [string]$name) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { Write-Ok "PID $procId ($name) 已不存在"; return $true }

    # ① 温和：先请 GUI 关窗（对 node 这种控制台进程无效，但无害）
    try {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
            $null = $p.CloseMainWindow()
            if ($p.WaitForExit(2000)) { Write-Ok "PID $procId ($name) 已正常退出"; return $true }
        }
    } catch { }

    # ② taskkill 不带 /F（发 WM_CLOSE）
    try { $null = & taskkill.exe /PID $procId 2>&1 } catch { }
    Start-Sleep -Milliseconds 400
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        Write-Ok "PID $procId ($name) 已退出（taskkill）"; return $true
    }

    # ③ 强杀
    try { $null = & taskkill.exe /PID $procId /F /T 2>&1 } catch { }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
            Write-Ok "PID $procId ($name) 已强制结束"; return $true
        }
        Start-Sleep -Milliseconds 150
    }

    # ④ Stop-Process 兜底（与 taskkill 走不同路径，偶尔能成）
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
    Start-Sleep -Milliseconds 400
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        Write-Ok "PID $procId ($name) 已结束（Stop-Process）"; return $true
    }
    Write-Bad "PID $procId ($name) 杀不掉"
    return $false
}

# ─────────────────────────────────────────────────────────────
# 诊断「为什么杀不掉」
#
# ⛔ $procId = 0 是合法入参，表示「没有进程在监听，但端口就是 bind 不上」。
#    这条路径下最可能的原因是系统保留段（Hyper-V/winnat/Docker），
#    所以**不能**因为拿不到进程信息就提前 return —— 那会让最有价值的
#    那条诊断永远不打印（曾有过这个 bug：保留段提示一次都没出现过）。
# ─────────────────────────────────────────────────────────────
function Show-Diagnosis([int]$procId, [int]$port) {
    if ($procId -gt 0) { Write-Head "为什么 PID $procId 占着 $port 杀不掉" }
    else               { Write-Head "端口 $port 无监听者却 bind 不上，为什么" }

    $info = $null
    if ($procId -gt 0) {
        $info = Get-ProcInfo $procId
        if (-not $info) { Write-Info "进程已消失，可能刚被别的动作清掉了 —— 重试一次即可" }
    }

    if ($info) {
        # ① 权限
        try {
            $null = Get-Process -Id $procId -ErrorAction Stop
            $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if (-not $isAdmin) {
                Write-Warn2 "当前不是管理员。若该进程由管理员/系统启动，普通权限杀不掉"
                Write-Info "用管理员重开终端，或：Start-Process powershell -Verb RunAs -ArgumentList '-File','$PSCommandPath'"
            }
        } catch {
            Write-Warn2 "拿不到进程句柄（权限不足或进程已受保护）"
        }

        # ② 服务托管 —— 服务会自动重启，杀进程等于没杀
        try {
            $svc = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
                   Where-Object { $_.ProcessId -eq $procId }
            if ($svc) {
                Write-Warn2 "该进程是 Windows 服务「$($svc.Name)」的宿主，杀掉会被服务管理器立刻拉起"
                Write-Info "正确做法：Stop-Service '$($svc.Name)' -Force   （必要时 Set-Service -StartupType Disabled）"
            }
        } catch { }

        # ③ 父进程还活着且会重启子进程（npm/yarn/pnpm 的典型行为）
        if ($info.ParentAlive) {
            $par = Get-ProcInfo $info.ParentPid
            if ($par) {
                Write-Warn2 "父进程还活着：PID $($par.Pid) $($par.Name)"
                if ($par.CommandLine) { Write-Info "父命令行：$($par.CommandLine)" }
                Write-Info "如果父进程是 npm/yarn/pnpm/start.mjs 之类，杀掉子进程它会立刻重启一个 —— 必须连父进程一起杀（去掉 -KeepParent）"
            }
        } elseif ($info.IsOrphan) {
            Write-Info "孤儿进程（父 PID $($info.ParentPid) 已退出）—— 这类进程没人管，通常能直接强杀"
        }
    }

    # ④ 端口被系统保留段占住（Hyper-V / winnat / Docker）—— 这种杀进程毫无意义
    #    这条对「无监听者却 bind 不上」是**首要嫌疑**，必须无条件执行。
    try {
        $ex = & netsh int ipv4 show excludedportrange protocol=tcp 2>$null
        $ranges = @()
        foreach ($line in $ex) {
            if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
                $ranges += [pscustomobject]@{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
            }
        }
        $hit = $ranges | Where-Object { $port -ge $_.Start -and $port -le $_.End }
        if ($hit) {
            Write-Warn2 "端口 $port 落在系统保留段 $($hit.Start)-$($hit.End) 内"
            Write-Info "这是 Hyper-V / winnat / Docker 保留的端口，**没有任何进程在监听也 bind 不上**，杀进程无效"
            Write-Info "解法一：换一个不在保留段内的端口"
            Write-Info "解法二：net stop winnat && net start winnat   （需管理员；会短暂影响 Docker/WSL 网络）"
        } else {
            Write-Info "端口 $port 不在系统保留段内（已查 netsh excludedportrange）"
        }
    } catch {
        Write-Info "查不到系统保留段（netsh 调用失败）"
    }

    if ($info) {
        # ⑤ 进程详情，便于人肉判断
        Write-Info ""
        Write-Info "进程详情："
        Write-Info "  名称    : $($info.Name)"
        Write-Info "  PID     : $($info.Pid)"
        Write-Info "  父 PID  : $($info.ParentPid) $(if($info.IsOrphan){'(已退出)'}else{'(存活)'})"
        if ($info.CommandLine)   { Write-Info "  命令行  : $($info.CommandLine)" }
        if ($info.ExecutablePath){ Write-Info "  路径    : $($info.ExecutablePath)" }
        if ($info.CreationDate)  { Write-Info "  启动于  : $($info.CreationDate)" }
    }
}

# ─────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  释放端口  " -NoNewline -ForegroundColor White
Write-Host ($Port -join ', ') -ForegroundColor Yellow
if ($DryRun) { Write-Host "  （DryRun：只看不动手）" -ForegroundColor DarkYellow }

foreach ($p in $Port) {
    Write-Head "端口 $p"

    # ── 阶段 1：先看清楚
    $conns = Get-PortOwners $p
    $listen = @($conns | Where-Object { $_.State -eq 'Listen' })

    if (-not $listen) {
        if (Test-PortFree $p) {
            Write-Ok "端口 $p 本来就是空闲的"
            continue
        }
        Write-Warn2 "端口 $p 没有监听者，但 bind 不上（可能是保留段 / TIME_WAIT）"
        Show-Diagnosis 0 $p
        $script:Failures += $p
        continue
    }

    $pids = @($listen | Select-Object -ExpandProperty OwningProcess -Unique)
    Write-Info "监听地址：$(($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique) -join ', ')"
    Write-Info "占用 PID：$($pids -join ', ')"

    $targets = @()
    foreach ($procId in $pids) {
        $info = Get-ProcInfo $procId
        if (-not $info) { Write-Info "PID $procId 已不存在"; continue }
        Write-Info ""
        Write-Info "  PID $($info.Pid)  $($info.Name)"
        if ($info.CommandLine) { Write-Info "      命令行：$($info.CommandLine)" }
        Write-Info "      父进程：$($info.ParentPid) $(if($info.IsOrphan){'（已退出 → 孤儿）'}else{'(存活)'})"
        $targets += $info
    }

    if (-not $targets.Count) {
        Write-Warn2 "拿不到占用者信息"
        $script:Failures += $p
        continue
    }

    # ── 阶段 2：确认
    if (-not $DryRun -and -not $Force) {
        Write-Host ""
        Write-Host "  将结束上述 $($targets.Count) 个进程" -NoNewline -ForegroundColor Yellow
        Write-Host "（含子进程树）" -ForegroundColor DarkGray
        $ans = Read-Host "  继续？[y/N]"
        if ($ans -notmatch '^[yY]') { Write-Info "已跳过端口 $p"; continue }
    }
    if ($DryRun) { Write-Info "DryRun：不执行终止"; continue }

    # ── 阶段 3：按「先叶子、后父进程」的顺序杀
    #
    # ⛔ 顺序很关键：先杀父（npm）会让子进程变孤儿继续占端口；
    #    先杀子，父进程会重启它。所以两个都要杀，且先子后父。
    $killList = @($targets | Select-Object -ExpandProperty Pid)
    if (-not $KeepParent) {
        # ⛔ 白名单必须**只含真正的开发工具链**，绝不能含 shell / 终端：
        #    实测把 powershell.exe 算进来，会把「启动本脚本的那个终端」一起杀掉 ——
        #    表现为脚本输出突然中断、退出码 3221225786（Ctrl+C）。
        #    npm/yarn/pnpm 会重启子进程，必须一起杀；而 cmd/powershell
        #    通常只是「你手工开的窗口」，杀了等于砍自己坐的树枝。
        $parentWhitelist = '^(node|npm|npm-cli|npx|yarn|pnpm|pnpx)\.exe$|^node\.exe$'
        foreach ($t in $targets) {
            if ($t.ParentAlive -and $t.ParentPid -gt 0) {
                $par = Get-ProcInfo $t.ParentPid
                if (-not $par) { continue }
                if ($par.Name -notmatch $parentWhitelist) {
                    Write-Info "父进程 $($par.Pid) $($par.Name) 不在工具链白名单内，保留不动"
                    continue
                }
                # ⛔ 双保险：绝不杀自己、自己的祖先、以及本脚本所在的控制台宿主
                if (Test-IsSelfOrAncestor $par.Pid) {
                    Write-Info "父进程 $($par.Pid) $($par.Name) 是本脚本的祖先，跳过"
                    continue
                }
                if ($killList -notcontains $par.Pid) { $killList += $par.Pid }
                Write-Info "父进程 $($par.Pid) $($par.Name) 也一起结束（否则会把子进程重新拉起）"
            }
        }
    }

    Write-Head "终止"
    $allKilled = $true
    foreach ($procId in $killList) {
        # 逐个复核：前面的动作可能已经把后面的连带干掉了
        if (Test-IsSelfOrAncestor $procId) { Write-Info "PID $procId 是本脚本的祖先，跳过"; continue }
        $info = Get-ProcInfo $procId
        $nm = if ($info) { $info.Name } else { '?' }
        if (-not (Stop-ProcHard $procId $nm)) { $allKilled = $false }
    }

    # ── 阶段 4：复核（唯一成功判据）
    Start-Sleep -Milliseconds 600
    if (Test-PortFree $p) {
        Write-Ok "端口 $p 已释放"
    } else {
        $left = Get-PortOwners $p | Where-Object { $_.State -eq 'Listen' }
        $leftPids = @($left | Select-Object -ExpandProperty OwningProcess -Unique)
        Write-Bad "端口 $p 仍被占用（PID $($leftPids -join ', ')）"
        if ($leftPids.Count) { Show-Diagnosis $leftPids[0] $p }
        else { Show-Diagnosis 0 $p }
        $script:Failures += $p
    }
}

# ─────────────────────────────────────────────────────────────
# 汇总
# ─────────────────────────────────────────────────────────────
Write-Host ""
if ($script:Failures.Count -eq 0) {
    Write-Host "  全部释放完成" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  以下端口仍被占用：$($script:Failures -join ', ')" -ForegroundColor Red
    Write-Host "  上面已列出原因，按提示处理（多半是父进程重启 / 权限 / 系统保留段）" -ForegroundColor DarkGray
    exit 1
}
