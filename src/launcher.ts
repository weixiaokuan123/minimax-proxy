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
  return dirs
}

/** 候选可执行文件路径（按优先级）。 */
export function candidateExePaths(): string[] {
  const envExe = process.env['MINIMAZ_CODE_EXE'] ?? process.env['MINIMAX_CODE_EXE']
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

async function queryUninstallRoot(root: string): Promise<string | undefined> {
  // 列出所有子键（键名常是 GUID，不含产品名，不能按键名过滤）
  const list = await runReg([root])
  const subKeys = list.split(/\r?\n/)
    .map(l => l.trim())
    // 仅保留看起来像注册表键路径的行（含 HKEY/HK）
    .filter(l => /^(HKEY|HK)/i.test(l) && l !== root)
  for (const key of subKeys) {
    // 先读 DisplayName 判断是不是 MiniMax Code（排除 Uninstaller 自身等）
    const nameOut = await runReg([key, '/v', 'DisplayName'])
    const nameMatch = /DisplayName\s+REG_SZ\s+(.+)/i.exec(nameOut)
    if (!nameMatch || !/MiniMax\s+Code/i.test(nameMatch[1] ?? '')) continue

    const details = await runReg([key, '/v', 'InstallLocation'])
    const m = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(details)
    if (m) {
      const loc = (m[1] ?? '').trim().replace(/^"|"$/g, '')
      if (loc !== '') {
        const candidate = join(loc, 'MiniMax Code.exe')
        if (existsSync(candidate)) return candidate
      }
    }
    // InstallLocation 常为空：从 UninstallString / DisplayIcon 所在目录推断
    const probe = [
      await valueAt(key, 'UninstallString'),
      await valueAt(key, 'DisplayIcon'),
    ]
    for (const raw0 of probe) {
      if (!raw0) continue
      const raw = raw0.replace(/^"|"$/g, '').split(',')[0]!.replace(/\s+\/\S+\s*$/g, '').trim()
      const dir = raw.replace(/[\\/][^\\/]+$/, '')
      const candidate = join(dir, 'MiniMax Code.exe')
      if (existsSync(candidate)) return candidate
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
    await new Promise(r => setTimeout(r, 1000))
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
