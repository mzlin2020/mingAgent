import { describe, expect, it } from 'vitest';
import { projectRedLines, redLineRules } from '@xm/kernel';

const ENV = {
  home: '/home/ming',
  appRoot: '/repo',
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

describe('projectRedLines', () => {
  it('只收 immutable deny，按 target + why 归并能力', () => {
    const views = projectRedLines(redLineRules(ENV));
    const selfPolicy = views.find((row) => row.target.includes('packages/kernel/src/policy/**'));
    expect(selfPolicy).toBeDefined();
    expect(selfPolicy!.capabilities).toEqual(['fs.delete', 'fs.write', 'self.modify']);
    expect(selfPolicy!.why).toContain('权限判定逻辑与红线清单自身');
  });

  it('非红线（普通 deny / allow）不进投影', () => {
    const views = projectRedLines([
      {
        id: 'user.deny',
        effect: 'deny',
        capability: 'fs.write',
        reason: '用户自己加的',
        immutable: false,
      },
      {
        id: 'user.allow',
        effect: 'allow',
        capability: 'fs.read',
        reason: '放行',
        immutable: false,
      },
    ]);
    expect(views).toEqual([]);
  });
});
