// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 类型感知 lint 走 TS 6 的 JS 编译器 API（ADR-0010）。
 * 这是 CI 里最慢的一环，也是原则四（禁 any、严格校验）唯一的自动化执行手段。
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/fixtures/**/*.json'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // 测试不在各包的构建工程里（那里只 include src/），projectService 找不到它们。
  // 显式指到 tsconfig.tests.json —— 与 `pnpm typecheck` 用的是同一份配置，不会漂移。
  // evals/ 也在这里：它不属于任何包，但 evals/regression/schema.test.ts 一样是
  // 要类型检查的测试代码（ADR-0032 #4）。
  {
    files: ['packages/*/tests/**/*.ts', 'apps/*/tests/**/*.ts', 'evals/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // apps/desktop 的三段各有各的 lib 与 types，projectService 猜不出来，显式指过去。
  // 与 `pnpm typecheck` 用的是同一批配置文件，不会漂移。
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/desktop/tsconfig.main.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx', 'apps/desktop/src/shared/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/desktop/tsconfig.renderer.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── 全仓库通用（业务代码）──────────────────────────────────
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      // ADR-0007：平台差异一律收敛到 PlatformPort 之后。
      // 注意：docs/03 与 ADR-0007 原写"由 dependency-cruiser 拦截"，但 depcruise 只做
      // 依赖图分析、看不到标识符，这条只能由 ESLint 执行（见 ADR-0011 补白②）。
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'platform',
          message:
            '禁止在业务代码里判断平台。平台差异收敛到 PlatformPort 之后（ADR-0007）——' +
            '用 @xm/platform 的 nodePlatform()。唯一的例外是 packages/platform/src/detect.ts，' +
            '它在本文件下方按路径放行；不要用行内 eslint-disable 开新口子（ADR-0014）。',
        },
        {
          object: 'process',
          property: 'arch',
          message: '同 process.platform：走 PlatformPort（ADR-0007）。',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:os'],
              message:
                '平台/主机信息走 PlatformPort，不要直接读 node:os（ADR-0007）。' +
                '唯一的例外是 packages/platform/src/detect.ts，已在本文件下方按路径放行。',
            },
          ],
        },
      ],
      // 内核与契约不做输出，日志走事件流（docs/10 §4.3 的 notice 事件）
      'no-console': 'error',
    },
  },

  // ── 平台探测：全仓库唯一允许读 process.platform / node:os 的文件 ──────
  //
  // 按**路径**开口子，而不是让适配器自己写行内 eslint-disable。区别是扩散性：
  // 行内注释会跟着复制粘贴一路传染，路径白名单传染不了——多放行一个文件就要多改一次
  // 本文件，那次改动在 review 里看得见，而且它本身是被 red.self-modify 红线护住的。
  {
    files: ['packages/platform/src/detect.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // ── 主进程：窗口还没起来时，控制台与错误框是唯一能告诉用户"为什么起不来"的地方 ──
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // ── 渲染层：不许绕过 preload 拿 Node ────────────────────────
  {
    files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'require', message: '渲染层没有 Node。所有能力经 preload 暴露的四个具名调用（ADR-0015）。' },
        { name: 'process', message: '同上：渲染层里不存在 process。' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'require',
          message: 'nodeIntegration 是关的；出现这行说明有人打算把它打开（ADR-0015）。',
        },
      ],
    },
  },

  // ── Provider 包：开了 DOM lib，但只许用其中的网络那几样 ──────
  //
  // `packages/providers/tsconfig.json` 里 lib 加了 DOM，为的是 fetch / AbortController /
  // TextDecoder / ReadableStream。代价是 document / window / localStorage 也一起可见了。
  // 这条按包把它们拦回去——一个"顺手"在适配器里 localStorage.setItem('key', apiKey)
  // 在类型上是完全合法的。
  {
    files: ['packages/providers/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Provider 适配器不碰 DOM。lib 里的 DOM 只为 fetch 那几样而开。' },
        { name: 'window', message: '同上：这个包要能在 Worker 与 Node 里跑。' },
        { name: 'localStorage', message: '密钥与状态都不落在这里，唯一来源是调用方传入的 apiKey。' },
        { name: 'sessionStorage', message: '同 localStorage。' },
      ],
    },
  },

  // ── 契约包专属：只导出数据（docs/10 铁律 2）────────────────
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[async=true]',
          message: '契约包只导出数据与纯函数，不得含异步逻辑（docs/10 铁律 2）。',
        },
        {
          selector: 'AwaitExpression',
          message: '契约包只导出数据与纯函数，不得含异步逻辑（docs/10 铁律 2）。',
        },
        {
          selector: 'TSTypeReference > Identifier[name=/^(Promise|AsyncIterable|AsyncGenerator)$/]',
          message: '契约包不得出现异步类型：含 I/O 的东西属于 kernel/runtime（docs/10 铁律 2）。',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', '@xm/*'],
              message: '契约包依赖只允许 zod（docs/10 铁律 1）。',
            },
          ],
        },
      ],
    },
  },

  // ── 测试：放宽少量对测试无意义的规则 ────────────────────────
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // ── 仓库脚本与配置：不是业务代码，不做类型感知 lint ──────────
  {
    files: ['**/scripts/**/*.mjs', '*.js', '*.mjs', '*.cjs', '.*.cjs', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
      'no-undef': 'off',
    },
  },
);
