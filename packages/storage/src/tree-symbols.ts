import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { IndexedSymbol } from '@xm/kernel';

/**
 * WASM 资产的解析与初始化**惰性做**（ADR-0047 补记）。
 *
 * 原来这三件事写在模块顶层，也就是 `@xm/storage` 的导入副作用：`import.meta.resolve`
 * 解析不到就同步抛。而 `tree-symbols` ← `workspace-index` ← `open-store` 是链式导入，
 * 于是"WASM 没被 electron-builder 打进包"这一件事会让**整个 storage 包（含事件存储）
 * 导入失败，应用根本起不来**——一个可选的代码智能特性，撑着整个应用的启动。
 *
 * 现在初始化只在真正要解析符号时发生，失败就降级：符号提取返回空，FTS 全文与事件存储
 * 照常。降级只告警一次，不在每个文件上刷屏。
 */
let runtime: Promise<{ readonly grammarDir: string } | undefined> | undefined;
let degradation: string | undefined;
const languages = new Map<string, Promise<Language> | undefined>();

/**
 * 符号能力当前的降级原因；`undefined` 表示正常。
 *
 * 降级要**说出来**而不是无声返回空数组，但这个包不许 `console`（日志走事件流）。
 * 所以把原因挂在这里，由 `workspace-index` 在每次 refresh 时取一次，放进
 * `WorkspaceIndexRefresh.errors` —— 已有的、面向调用方的那条通道。
 */
export const symbolDegradation = (): string | undefined => degradation;

function initRuntime(): Promise<{ readonly grammarDir: string } | undefined> {
  runtime ??= (async () => {
    try {
      const wasm = fileURLToPath(import.meta.resolve('web-tree-sitter/web-tree-sitter.wasm'));
      const grammarDir = dirname(fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm')));
      await Parser.init({ locateFile: () => wasm });
      return { grammarDir };
    } catch (error) {
      noteDegradation('tree-sitter WASM 运行时不可用，符号索引降级为空', error);
      return undefined;
    }
  })();
  return runtime;
}

function noteDegradation(message: string, error: unknown): void {
  degradation ??= `${message}：${error instanceof Error ? error.message : String(error)}`;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};

const SYMBOL_KINDS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  method_definition: 'method',
  method_signature: 'method',
  function_signature: 'function',
};

export function supportsSymbols(path: string): boolean {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] !== undefined;
}

export async function extractSymbols(
  path: string,
  content: string,
): Promise<readonly IndexedSymbol[]> {
  const languageName = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
  if (languageName === undefined) return [];
  const ready = await initRuntime();
  if (ready === undefined) return [];
  const language = await loadLanguage(ready.grammarDir, languageName);
  if (language === undefined) return [];
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (tree === null) {
    parser.delete();
    return [];
  }
  try {
    const symbols: IndexedSymbol[] = [];
    const nodes = [tree.rootNode];
    while (nodes.length > 0) {
      const node = nodes.pop();
      if (node === undefined) continue;
      const symbol = symbolOf(path, node);
      if (symbol !== undefined) symbols.push(symbol);
      for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
        const child = node.namedChildren[index];
        if (child !== undefined) nodes.push(child);
      }
    }
    return symbols;
  } finally {
    tree.delete();
    parser.delete();
  }
}

function symbolOf(path: string, node: Node): IndexedSymbol | undefined {
  let kind = SYMBOL_KINDS[node.type];
  let nameNode = node.childForFieldName('name');
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    if (value?.type !== 'arrow_function' && value?.type !== 'function_expression') return undefined;
    kind = 'function';
    nameNode = node.childForFieldName('name');
  }
  if (kind === undefined || nameNode === null) return undefined;
  const name = nameNode.text.trim();
  if (name === '') return undefined;
  return {
    path,
    name,
    kind,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    signature: oneLine(node.text),
  };
}

/** 单个 grammar 加载失败只让该语言降级，不影响其它语言与整库索引。 */
async function loadLanguage(grammarDir: string, name: string): Promise<Language | undefined> {
  if (!languages.has(name)) {
    languages.set(
      name,
      Language.load(join(grammarDir, `tree-sitter-${name}.wasm`)).catch((error: unknown) => {
        noteDegradation(`tree-sitter grammar ${name} 加载失败，该语言的符号索引降级为空`, error);
        languages.set(name, undefined);
        throw error;
      }),
    );
  }
  try {
    return await languages.get(name);
  } catch {
    return undefined;
  }
}

function oneLine(text: string): string {
  const beforeBody = text.split('{', 1)[0] ?? text;
  const line = beforeBody.replace(/\s+/gu, ' ').trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}
