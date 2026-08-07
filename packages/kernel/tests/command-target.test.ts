import { describe, expect, it } from 'vitest';
import {
  canonicalizeArgv,
  commandBasename,
  normalizeCommandTarget,
  parseShellSource,
  quoteArg,
} from '@xm/kernel';

/**
 * ── 命令行的规范化契约（ADR-0026）──
 *
 * 这个文件钉住三件事：
 *
 *   一、**同一条命令的不同写法得到同一个串** —— 归一存在的全部意义
 *   二、**幂等** —— 规范形式再解析一次必须还原成同一个东西。
 *       不幂等的后果很具体：事件里记的串、授权里存的串、规则里匹配的串会是三个东西，
 *       「本会话都允许」下一次照样弹框，而没有任何地方看得出为什么（ADR-0024 同款）
 *   三、**判不了的构造一律拒**，不降级 ask —— 拒的那一批全是"展开结果取决于
 *       执行那一刻的环境"的东西，放过它们等于判定看到的和执行的是两个东西
 */

const canonical = (raw: string): string => {
  const r = normalizeCommandTarget(raw);
  if (!r.ok) throw new Error(`本该解析得开：${raw} —— ${r.reason}`);
  return r.value;
};

describe('归一：不同写法同一个串', () => {
  it.each([
    ['多余空格被吃掉', 'rm  -rf   /', 'rm -rf /'],
    ['绝对路径的 bin 取 basename', '/bin/rm -rf /', 'rm -rf /'],
    ['更深的路径同样', '/usr/local/bin/rm -rf /', 'rm -rf /'],
    ['引号在归一后消失（值不含特殊字符）', "rm -rf '/tmp/x'", 'rm -rf /tmp/x'],
    ['双引号同理', 'rm -rf "/tmp/x"', 'rm -rf /tmp/x'],
    ['转义空格保留成一个词', 'cat a\\ b', "cat 'a b'"],
    ['管道用统一的连接符', 'grep x a.txt|head -3', 'grep x a.txt | head -3'],
    ['分号与管道归到同一种连接符', 'rm a; rm b', 'rm a | rm b'],
    ['&& 同理', 'rm a && rm b', 'rm a | rm b'],
    ['重定向归一到 > 与目标', 'echo hi >> out.txt', "echo hi > out.txt"],
  ])('%s', (_label, raw, want) => {
    expect(canonical(raw)).toBe(want);
  });

  /**
   * argv 数组走的是另一条路：那里每个元素都是**字面量**，反斜杠不是转义符。
   * 同一个串在两条路上含义不同，这不是矛盾——shell 源码里 `C:\x` 本来就是 `C:x`，
   * 而 `shell.exec` 收到的 argv 从来不经过 shell。
   */
  it('Windows 路径的 bin：走 argv 数组时按分隔符取 basename', () => {
    expect(canonicalizeArgv(['C:\\Windows\\System32\\where.exe', 'x'])).toBe('where.exe x');
  });

  it('🔴 DoD：四种写法里能静态归一的那三种，归到同一个串', () => {
    const one = canonical('rm -rf /');
    expect(canonical('rm  -rf /')).toBe(one);
    expect(canonical('/bin/rm -rf /')).toBe(one);
    // 第四种（sh -c）归的不是同一个串，它靠拆出来的 claims 判定一致，见 command-claims 用例
  });
});

describe('🔴 幂等', () => {
  it.each([
    ['普通命令', ['rm', '-rf', '/tmp/x']],
    ['带空格的参数', ['cat', 'my file.txt']],
    ['带单引号的参数', ['echo', "it's"]],
    ['带双引号的参数', ['echo', 'say "hi"']],
    ['字面量的管道符', ['echo', '|']],
    ['字面量的重定向符', ['echo', 'hi', '>', 'not-a-redirect']],
    ['字面量的通配符', ['find', '.', '-name', '*.ts']],
    ['字面量的美元符', ['echo', '$HOME']],
    ['空参数', ['echo', '']],
    ['反斜杠', ['echo', 'a\\b']],
    ['未展开的家目录', ['rm', '~/x']],
  ])('%s：canonical 再解析一次不变', (_label, argv) => {
    const once = canonicalizeArgv(argv);
    expect(canonical(once)).toBe(once);
  });

  it('🔴 引号里的特殊字符不会在下一轮被当成语法', () => {
    // 这是幂等真正在防的东西：`echo |` 里那个竖线是数据，不是管道
    const once = canonicalizeArgv(['echo', '|', ';', '&&']);
    const parsed = parseShellSource(once);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.argv).toEqual(['echo', '|', ';', '&&']);
  });
});

describe('🔴 判不了的构造一律拒', () => {
  it.each([
    ['命令替换 $()', 'rm -rf $(cat target.txt)'],
    ['命令替换（反引号）', 'rm -rf `cat target.txt`'],
    ['变量替换', 'rm -rf $HOME'],
    ['花括号里的变量', 'rm -rf ${HOME}'],
    ['双引号里的变量', 'rm -rf "$HOME"'],
    ['通配符 *', 'rm -rf /tmp/*'],
    ['通配符 ?', 'rm -rf /tmp/a?'],
    ['字符类', 'rm -rf /tmp/[ab]'],
    ['子 shell', '(rm -rf /)'],
    ['花括号展开', 'rm -rf /tmp/{a,b}'],
    ['后台运行', 'sleep 100 &'],
    ['heredoc', 'cat <<EOF'],
    ['文件描述符重定向', 'ls >&2'],
    ['别人的家目录', 'cat ~root/.ssh/id_rsa'],
    ['没闭合的单引号', "rm 'a"],
    ['没闭合的双引号', 'rm "a'],
    ['空段', 'rm a | | rm b'],
    ['悬空的重定向', 'echo hi >'],
  ])('%s → 判不了', (_label, raw) => {
    expect(normalizeCommandTarget(raw).ok).toBe(false);
  });

  it('拒绝的理由要说清楚是"判不了"，不是"不许"', () => {
    const r = normalizeCommandTarget('rm -rf $(cat x)');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('执行');
  });

  it('空 target 照旧放行 —— 它表示"这次请求没有 target"', () => {
    expect(normalizeCommandTarget('')).toEqual({ ok: true, value: '' });
  });

  it('空字节', () => {
    expect(normalizeCommandTarget('rm \0 x').ok).toBe(false);
  });
});

describe('零件', () => {
  it.each([
    ['/bin/rm', 'rm'],
    ['rm', 'rm'],
    ['C:\\Windows\\cmd.exe', 'cmd.exe'],
    ['./x/y/z.sh', 'z.sh'],
    ['/', '/'],
  ])('basename(%s) = %s', (bin, want) => {
    expect(commandBasename(bin)).toBe(want);
  });

  it.each([
    ['plain', 'plain'],
    ['/abs/path', '/abs/path'],
    ['a b', "'a b'"],
    ['', "''"],
    ["it's", '"it\'s"'],
    ['$HOME', "'$HOME'"],
  ])('quoteArg(%s) = %s', (raw, want) => {
    expect(quoteArg(raw)).toBe(want);
  });
});
