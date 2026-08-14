#!/usr/bin/env node

import process from 'node:process';
import { dumpProfile, isBuiltinProfileName, loadPatchedProfile } from '../packages/compose/dist/index.js';

const valueOf = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const name = valueOf('--profile') ?? 'desktop';
const configDir = valueOf('--config-dir');

if (!isBuiltinProfileName(name)) {
  throw new Error(`未知 profile：${name}（可选 desktop/headless/cli/test）`);
}
if (configDir === undefined || configDir.trim() === '') {
  throw new Error('必须显式传入 --config-dir；不会从当前项目目录隐式读取 patch');
}

const profile = await loadPatchedProfile({ name, configDir });
process.stdout.write(`${dumpProfile(profile)}\n`);
