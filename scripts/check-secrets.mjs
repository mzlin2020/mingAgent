#!/usr/bin/env node
/**
 * 提交前密钥扫描。
 *
 * 由来：参考项目 manusAgent 把含**真实 API key** 的 config.yaml 提交进了 git
 * （见 docs/02 §2.6）。密钥一旦进入 git 历史就等于泄露——改文件不够，要重写历史。
 * 所以这道闸门放在提交前，不放在提交后。
 *
 * 定位是**尽力而为**（docs/10 §8 的原话），不是保证：
 *   - 只扫暂存区的新增行，不扫历史
 *   - 只认已知形态的密钥前缀 + 明显的明文赋值
 *   - 高熵检测不做——误报率太高，会被人 --no-verify 绕过，等于不存在
 *
 * 绕过方式是 git 自带的 `--no-verify`。刻意不去堵：真正的防线是 CI 与代码审查，
 * 本地钩子的价值是"让手滑不至于变成事故"。
 */
import { execFileSync } from 'node:child_process';

/** 已知的密钥形态。命中即拒绝。 */
const SIGNATURES = [
  { name: 'Anthropic API key', re: /sk-ant-[a-z0-9]{3,}-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: '私钥 PEM', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/**
 * **配置文件**里的明文赋值。契约要求密钥只能以 SecretRef（{ "$secret": "..." }）出现。
 *
 * 只对数据文件生效，不扫源码：源码里 `apiKey: SecretRef.optional(),` 这类写法会被
 * 无差别命中，误报几次之后这道闸门就会被整体关掉。源码仍受上面的 SIGNATURES 保护。
 */
const PLAINTEXT_ASSIGN =
  /\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*["']?([^"'\s,}]{12,})["']?/i;

const CONFIG_FILE = /\.(json|jsonc|ya?ml|toml|ini|properties|env|conf|cfg)$|(^|\/)\.env/i;

/**
 * 逐行豁免标记。用于**必须**包含密钥形态的地方——脱敏函数的测试样本、文档示例。
 * 刻意做成逐行而不是整文件豁免：整文件豁免一旦加上就没人会再取消，
 * 而那个文件里后来贴进去的真密钥就再也扫不出来了。
 */
const ALLOW_MARKER = 'xm-secret-scan:allow';

/** 明显的占位符/示例，不算泄露 */
const PLACEHOLDER =
  /^(?:\$\{|<|\{\{|\$\(|process\.env|os\.environ|xxx|your|example|placeholder|changeme|redacted|dummy|test|fake|sample|null|none|true|false|\*+$)/i;

function isPlaceholder(value) {
  if (PLACEHOLDER.test(value)) return true;
  if (/x{4,}/i.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  if (value.includes('$secret')) return true;
  return false;
}

function stagedAddedLines() {
  const diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color', '-M'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const results = [];
  let file = null;
  let lineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (file !== null) results.push({ file, lineNo, text: line.slice(1) });
      lineNo += 1;
    }
  }
  return results;
}

/** 只截断展示，绝不把命中的密钥整段打进终端/CI 日志 */
function mask(text) {
  return text.length <= 12 ? '***' : `${text.slice(0, 6)}…${'*'.repeat(6)}`;
}

const findings = [];

for (const { file, lineNo, text } of stagedAddedLines()) {
  if (file === 'scripts/check-secrets.mjs') continue; // 本文件自身含全部特征正则
  if (text.includes(ALLOW_MARKER)) continue;

  for (const sig of SIGNATURES) {
    const m = sig.re.exec(text);
    if (m && !isPlaceholder(m[0])) {
      findings.push({ file, lineNo, kind: sig.name, sample: mask(m[0]) });
    }
  }

  if (!CONFIG_FILE.test(file)) continue;

  const assign = PLAINTEXT_ASSIGN.exec(text);
  if (assign && !isPlaceholder(assign[2])) {
    findings.push({
      file,
      lineNo,
      kind: `明文密钥赋值（${assign[1]}）—— 契约要求只能写 SecretRef { "$secret": "..." }`,
      sample: mask(assign[2]),
    });
  }
}

if (findings.length > 0) {
  console.error('\n✗ 提交被拒绝：暂存内容里疑似包含密钥\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.lineNo}`);
    console.error(`    ${f.kind}`);
    console.error(`    命中片段：${f.sample}\n`);
  }
  console.error('  处理方式：');
  console.error('    · 密钥移出代码，配置里只写 { "$secret": "provider.apiKey" }');
  console.error('    · 真值交给 SecretStore（OS 钥匙串）');
  console.error(`    · 确实需要密钥形态的样本（如脱敏函数的测试），在该行加注释 ${ALLOW_MARKER}`);
  console.error('    · 确认是误报时可用 git commit --no-verify 跳过，但请先确认\n');
  process.exit(1);
}

process.exit(0);
