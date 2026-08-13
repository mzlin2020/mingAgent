import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { IndexedSymbol } from '@xm/kernel';

const RUNTIME_WASM = fileURLToPath(import.meta.resolve('web-tree-sitter/web-tree-sitter.wasm'));
const GRAMMAR_DIR = dirname(fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm')));
const initialized = Parser.init({ locateFile: () => RUNTIME_WASM });
const languages = new Map<string, Promise<Language>>();

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
  await initialized;
  const parser = new Parser();
  const language = await loadLanguage(languageName);
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

async function loadLanguage(name: string): Promise<Language> {
  let pending = languages.get(name);
  if (pending === undefined) {
    pending = Language.load(join(GRAMMAR_DIR, `tree-sitter-${name}.wasm`));
    languages.set(name, pending);
  }
  return pending;
}

function oneLine(text: string): string {
  const beforeBody = text.split('{', 1)[0] ?? text;
  const line = beforeBody.replace(/\s+/gu, ' ').trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}
