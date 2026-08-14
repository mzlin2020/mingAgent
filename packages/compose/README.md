# @xm/compose

应用入口共享的组合根：定义 `desktop`、`headless`、`cli`、`test` 四份内建 profile，合并用户配置目录中的 patch，并把 profile 行解析成 `@xm/kernel` 插件树。

边界：

- 不依赖 Electron，也不承载业务工具实现。
- `baseline.*` 行不可被 patch 更新、替换、插入或重排。
- 插件实际声明的 `inject` / `provide` 必须与 profile 元数据逐项一致。
- patch 只读取显式 `configDir/profiles/<name>.patch.json`，不读取项目目录。
- 配置导出必须走 `dumpProfile()`，其输出统一经过 `redact()`。

生成式接缝图见 [`docs/generated/M3-b-接缝图.md`](../../docs/generated/M3-b-接缝图.md)。
