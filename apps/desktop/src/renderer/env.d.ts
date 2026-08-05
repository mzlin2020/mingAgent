/**
 * 渲染层的环境声明。
 *
 * 刻意不写 `/// <reference types="vite/client" />`：那会把 `import.meta.env` 之类的
 * 一整套东西带进来，而渲染层的 `types` 是空数组正是为了让"这里没有 Node、
 * 也没有构建工具的全局"在编译期成立。只声明真正用到的那一样。
 */
declare module '*.css';
