import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
// TerminalPanel（ADR-0031）用的是 xterm.js 自带样式，全局引入一次即可
import '@xterm/xterm/css/xterm.css';

const root = document.getElementById('root');
if (root === null) throw new Error('找不到 #root：index.html 与入口对不上。');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
