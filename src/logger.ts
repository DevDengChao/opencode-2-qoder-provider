/**
 * logger.ts — 文件日志（避免 console.log 破坏 opencode TUI 渲染）
 *
 * 日志写入 ~/.local/state/opencode/qoder-provider.log
 * 设置 QODER_DEBUG=1 环境变量启用 debug 级别。
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".local", "state", "opencode");
// 允许覆盖日志路径：单元测试用 QODER_LOG_FILE 指到临时文件，
// 避免测试输出污染真实的 ~/.local/state/opencode/qoder-provider.log（曾导致验证时误读）
const LOG_FILE = process.env.QODER_LOG_FILE || join(LOG_DIR, "qoder-provider.log");

// 确保日志目录存在
try {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
} catch { /* ignore */ }

export const DEBUG = !!(process.env.DEBUG || process.env.QODER_DEBUG);

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, args: unknown[]): void {
  const line = `[${timestamp()}] [${level}] ${args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, line, "utf8");
  } catch { /* ignore */ }
}

/** debug 级别日志（需 QODER_DEBUG=1） */
export function log(...args: unknown[]): void {
  if (DEBUG) write("DEBUG", args);
}

/** 错误日志（始终写入） */
export function logError(...args: unknown[]): void {
  write("ERROR", args);
}

/** 信息日志（始终写入） */
export function logInfo(...args: unknown[]): void {
  write("INFO", args);
}
