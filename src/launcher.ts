/**
 * 桌面端守护式签到（MiniMax 专用）。
 *
 * 背景：MiniMax Code 的 access token 只活约 1 小时，refresh_token 一次性轮换，
 * 代理绝不能自己刷新（会把桌面端挤下线）。因此本模块采用「拉起桌面端」策略：
 *
 *   检测未签到/token过期 → 启动 MiniMax Code 桌面端 →
 *   轮询等待它自动续期（实测约 15–25 秒）→ 调用签到接口 →
 *   签完退出我们启动的桌面端进程
 *
 * 安全约定：
 *  - 只在「确实需要」时启动（今天未签 或 token 已过期且当前未运行）；
 *  - 如果桌面端本来就在运行，不杀它（只签到，不退出，尊重用户正在使用）；
 *  - 只退出「本模块本次启动」的进程树；不碰用户先前打开的实例；
 *  - 默认关闭，通过 MINIMAX_AUTO_LAUNCH=on 开启，避免未经允许弹程序。
 *
 * @module minimax-proxy/launcher
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LauncherPaths {
  exe: string
}

/** 常见标准安装目录（不含任何用户特定路径）。 */
function standardInstallDirs(): string[] {
  const home = homedir()
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  const dirs = [
    join(localAppData, 'Programs', 'MiniMax Code'),
    join(programFiles, 'MiniMax Code'),
    join(programFilesX86, 'MiniMax Code'),
    join(programFiles, 'MiniMaxCode', 'MiniMax Code'),
  ]
  // 非系统盘安装很常见（如 D:\Software\MiniMaxCode\MiniMax Code）：
  // 逐个探测常见盘符，命中即用。existsSync 很廉价，比走注册表快得多。
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    dirs.push(join(`${drive}\\`, 'Software', 'MiniMaxCode', 'MiniMax Code'))
    dirs.push(join(`${drive}\\`, 'MiniMaxCode', 'MiniMax Code'))
    dirs.push(join(`${drive}\\`, 'Program Files', 'MiniMax Code'))
    dirs.push(join(`${drive}\\`, 'Programs', 'MiniMax Code'))
  }
  return dirs
}

/** 候选可执行文件路径（按优先级）。 */
export function candidateExePaths(): string[] {
  const envExe = process.env['MINIMAX_CODE_EXE']
  const exeName = 'MiniMax Code.exe'
  const candidates = [
    ...(envExe ? [envExe] : []),
    ...standardInstallDirs().map(d => join(d, exeName)),
  ]
  return candidates
}

export function findExe(): string | undefined {
  const fromCandidates = candidateExePaths().find(p => existsSync(p))
  if (fromCandidates !== undefined) return fromCandidates
  return undefined
}

/**
 * 从 Windows 卸载注册表探测安装位置（App Paths / Uninstall 键）。
 * 适用于装在非标准盘的情况；失败返回 undefined，绝不硬编码任何用户路径。
 */
export async function findExeFromRegistry(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const keys = [
    // Uninstall 键（用户级 + 机器级）
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const root of keys) {
    const exe = await queryUninstallRoot(root)
    if (exe) return exe
  }
  return undefined
}

function runReg(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('reg', ['query', ...args], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))
  })
}

/** 注册表输出的一个键块：键路径 + 值名→数据。 */
interface RegKeyBlock {
  path: string
  values: Map<string, string>
}

/** DisplayName 是否指向 MiniMax Code（排除 Uninstaller 自身等）。 */
function isMiniMaxDisplayName(name: string): boolean {
  return /MiniMax\s+Code/i.test(name)
}

/** 去掉首尾引号并压缩空白。 */
function unquote(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '')
}

/** InstallLocation 指向安装目录时的可执行文件路径。 */
function exeFromInstallLocation(loc: string): string | undefined {
  const dir = unquote(loc)
  if (dir === '') return undefined
  const candidate = join(dir, 'MiniMax Code.exe')
  return existsSync(candidate) ? candidate : undefined
}

/** 从 UninstallString / DisplayIcon 的所在目录推断可执行文件路径。 */
function exeFromInstallHint(raw0: string): string | undefined {
  if (raw0 === '') return undefined
  const raw = unquote(raw0).split(',')[0]!.replace(/\s+\/\S+\s*$/g, '').trim()
  const candidate = join(raw.replace(/[\\/][^\\/]+$/, ''), 'MiniMax Code.exe')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 把 `reg query <root> /s` 的整段输出拆成键块。
 *
 * 为什么可以按行硬解析：键路径（HKEY…）与值类型名（REG_SZ / REG_EXPAND_SZ 等）
 * 都由 reg.exe 直接输出，**不随系统显示语言本地化**，因此各语言版本格式一致。
 *
 * @returns 键块数组；若输出非空却解析不出任何键路径行，返回 null
 *          （表示格式与预期不符，交由调用方回退到逐键查询）。
 */
function parseRegBlocks(out: string): RegKeyBlock[] | null {
  const blocks: RegKeyBlock[] = []
  let current: RegKeyBlock | undefined
  let sawPathLine = false
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^(HKEY|HK)/i.test(trimmed)) {
      sawPathLine = true
      current = { path: trimmed, values: new Map<string, string>() }
      blocks.push(current)
      continue
    }
    if (current === undefined) continue
    // 形如 `    DisplayName    REG_SZ    MiniMax Code`（列间以空白分隔）
    const m = /^\s*(.+?)\s+REG_[A-Z_]+\s*(.*)$/i.exec(line)
    if (m !== null) current.values.set(m[1]!.trim(), m[2]!.trim())
  }
  if (!sawPathLine && out.trim() !== '') return null
  return blocks
}

/** 从单个键块推断 MiniMax Code.exe 路径。 */
function exeFromBlock(block: RegKeyBlock): string | undefined {
  // InstallLocation 常为空：再从 UninstallString / DisplayIcon 所在目录推断
  return exeFromInstallLocation(block.values.get('InstallLocation') ?? '')
    ?? exeFromInstallHint(block.values.get('UninstallString') ?? '')
    ?? exeFromInstallHint(block.values.get('DisplayIcon') ?? '')
}

/**
 * 在某个 Uninstall 根下查找 MiniMax Code 的安装目录。
 *
 * 性能：改为**一次** `reg query <root> /s` 批量取出该根下所有子键的所有值，
 * 再在内存里按 DisplayName 过滤；原实现对每个子键各 spawn 一次 reg
 * （先列子键，再逐个查值），子键多时可达数百次进程启动。
 *
 * 正确性：批解析仅依赖不随语言变化的 HKEY 路径与 REG_* 类型名；
 * 万一某系统输出格式异常（解析结果为空但输出非空），回退到原逐键查询，
 * 宁可慢也不漏。
 */
async function queryUninstallRoot(root: string): Promise<string | undefined> {
  const out = await runReg([root, '/s'])
  const blocks = parseRegBlocks(out)
  if (blocks === null) return await queryUninstallRootPerKey(root)
  for (const block of blocks) {
    const displayName = block.values.get('DisplayName')
    if (displayName === undefined || !isMiniMaxDisplayName(displayName)) continue
    const hit = exeFromBlock(block)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 回退路径：逐个查询子键的 DisplayName 与安装线索（批解析失败时使用）。 */
async function queryUninstallRootPerKey(root: string): Promise<string | undefined> {
  const list = await runReg([root])
  const subKeys = list.split(/\r?\n/)
    .map(l => l.trim())
    // 仅保留看起来像注册表键路径的行（含 HKEY/HK）
    .filter(l => /^(HKEY|HK)/i.test(l) && l !== root)
  for (const key of subKeys) {
    // 先读 DisplayName 判断是不是 MiniMax Code（排除 Uninstaller 自身等）
    const displayName = await valueAt(key, 'DisplayName')
    if (displayName === undefined || !isMiniMaxDisplayName(displayName)) continue

    const fromLocation = exeFromInstallLocation(await valueAt(key, 'InstallLocation') ?? '')
    if (fromLocation !== undefined) return fromLocation
    for (const value of ['UninstallString', 'DisplayIcon']) {
      const hit = exeFromInstallHint(await valueAt(key, value) ?? '')
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** 读取某键下某个 REG_SZ 值（返回原始字符串，缺失为 undefined）。 */
async function valueAt(key: string, value: string): Promise<string | undefined> {
  const out = await runReg([key, '/v', value])
  const m = new RegExp(value + '\\s+REG_SZ\\s+(.+)', 'i').exec(out)
  return m?.[1]?.trim()
}

export interface LaunchResult {
  /** 是否真的启动了一个新进程（false=已在运行或未找到 exe）*/
  startedByUs: boolean
  /** 进程是否原本就在运行（此时不应退出它）*/
  wasAlreadyRunning: boolean
  exe?: string
  error?: string
}

/** 用进程名探测桌面端是否在运行（只数真正存活、未退出的进程）。 */
export async function isRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await aliveCount()) > 0
}

/** 统计真正存活（未退出）的桌面端进程数。 */
async function aliveCount(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-Command',
        "(Get-Process 'MiniMax Code' -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited }).Count"],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.on('error', () => resolve(0))
    child.on('close', () => resolve(Number.parseInt(out.trim(), 10) || 0))
  })
}

/**
 * 把桌面端主窗口最小化（不影响它继续在后台跑、继续续期 token）。
 *
 * 背景：桌面端自己写死了「启动即 show()+focus()」（`createArchonChatWindow` 里
 * `window.once('ready-to-show', () => { window.show(); window.focus() })`），
 * 代理无法改变它启动时的形态，只能在它起来后把窗口收起来，
 * 免得续期时突然弹一个 1400×900 的大窗口盖住你的桌面。
 *
 * 只作用于**有主窗口**的进程；进程还在但窗口未创建时静默跳过
 * （调用方可稍后重试）。返回是否成功找到并最小化了窗口。
 */
export async function minimizeDesktopWindow(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return await new Promise<boolean>((resolve) => {
    // 用 PowerShell + user32 的 ShowWindow(SW_MINIMIZE=6)。
    // 优先挑 MainWindowHandle 非 0 的进程（Electron 主窗口所在进程）。
    const script = [
      "Add-Type -Namespace Mm -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);' -ErrorAction SilentlyContinue",
      "$w = Get-Process 'MiniMax Code' -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
      "if ($w) { [Mm.Win]::ShowWindow($w.MainWindowHandle, 6) | Out-Null; 'OK' } else { 'NOWIN' }",
    ].join('; ')
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(out.includes('OK')))
  })
}

/**
 * 反复尝试最小化，直到成功或超时。
 *
 * 桌面端启动后要过几秒才创建出主窗口，过早调用会拿到「无窗口」，
 * 因此需要轮询；一旦最小化成功就停止（避免把用户后来点开的窗口又收起来）。
 *
 * @param timeoutMs 最长等待；默认 30 秒
 * @param intervalMs 轮询间隔；默认 3000 毫秒（探测成本高，放宽间隔；总超时窗口不变）
 */
export async function minimizeDesktopWindowWhenReady(
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 3000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await minimizeDesktopWindow()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

/** 启动桌面端，返回子进程引用与「是否由我们启动」。 */
export async function launchDesktop(): Promise<LaunchResult> {
  const running = await isRunning()
  if (running) {
    return { startedByUs: false, wasAlreadyRunning: true }
  }
  const exe = findExe() ?? await findExeFromRegistry()
  if (exe === undefined) {
    return {
      startedByUs: false,
      wasAlreadyRunning: false,
      error: '未找到 MiniMax Code.exe（可用 MINIMAX_CODE_EXE 指定路径）',
    }
  }
  return await new Promise<LaunchResult>((resolve) => {
    let child: ChildProcess
    try {
      // detached 让它独立运行，签完再用 taskkill 精确结束
      child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    } catch (error) {
      resolve({ startedByUs: false, wasAlreadyRunning: false, exe, error: String((error as Error)?.message ?? error) })
      return
    }
    child.on('error', error => {
      resolve({ startedByUs: false, wasAlreadyRunning: false, exe, error: String(error?.message ?? error) })
    })
    // 给启动一点时间确认没立刻退出
    setTimeout(() => {
      resolve({ startedByUs: true, wasAlreadyRunning: false, exe })
    }, 3000)
  })
}

/**
 * 结束桌面端进程树并**等待真正退出**。只在「由我们启动」时调用。
 * Electron 多进程树关闭较慢（实测 10–15 秒），且偶发某个子进程没被一次杀掉，
 * 因此在超时窗口内「复查存活数 → 还有就补杀」循环，直到真正清零。
 * 返回最终存活进程数（0=彻底退出）。
 */
export async function terminateDesktop(options: { timeoutMs?: number } = {}): Promise<number> {
  if (process.platform !== 'win32') return 0
  const timeoutMs = options.timeoutMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  let lastCount = -1
  while (Date.now() < deadline) {
    const n = await aliveCount()
    if (n === 0) return 0
    // 仍有存活进程就补杀一次（taskkill 是幂等的，多打几次无副作用）
    if (n !== lastCount) {
      await new Promise<void>((resolve) => {
        const child = spawn('taskkill', ['/F', '/T', '/IM', 'MiniMax Code.exe'], { windowsHide: true, stdio: 'ignore' })
        child.on('error', () => resolve())
        child.on('close', () => resolve())
      })
      lastCount = n
    }
    // 探测成本高（每次都要 spawn powershell）：放宽到 5s，但总超时窗口仍为 30s
    await new Promise(r => setTimeout(r, 5000))
  }
  return await aliveCount()
}

export interface WaitForTokenOptions {
  /** 轮询间隔 ms */
  intervalMs?: number
  /** 最长等待 ms */
  timeoutMs?: number
  /** 返回 true 表示 token 已可用 */
  check: () => Promise<boolean>
}

/**
 * 轮询等待「token 已就绪」。桌面端启动后通常 15–25 秒自动续期写盘。
 */
export async function waitForTokenReady(options: WaitForTokenOptions): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 3000
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  // 启动本身先等一会，避免立刻读到旧状态
  await new Promise(r => setTimeout(r, 8000))
  while (Date.now() < deadline) {
    try {
      if (await options.check()) return true
    } catch {
      // 读取瞬时失败则继续等
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}
