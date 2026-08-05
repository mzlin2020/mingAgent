import { mkdir } from 'node:fs/promises';
import type { BlobStore, EventStore, XmDataLayout, XmPaths } from '@xm/kernel';
import { xmDataLayout } from '@xm/kernel';
import { FileBlobStore } from './file-blob-store.js';
import { SqliteEventStore } from './sqlite-event-store.js';

export interface OpenedStores {
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly layout: XmDataLayout;
  close(): Promise<void>;
}

/**
 * 按平台解析出来的目录打开全部存储。
 *
 * 存在的理由只有一个，但很硬：**落盘位置必须与红线规则出自同一份定义**。
 * 两边都走 `xmDataLayout()`，所以不可能出现"红线护着 audit.db、代码打开的是
 * audit.sqlite"这种失效——那种失效 lint、类型检查、depcruise 全都发现不了，
 * 而它的表现是审计文件根本没被保护，却一直显示"规则已配置"（ADR-0012 ①、ADR-0014）。
 *
 * 所以：**不要自己拼路径去 new SqliteEventStore**，走这里。
 */
export async function openStores(paths: XmPaths): Promise<OpenedStores> {
  const layout = xmDataLayout(paths.data);
  await mkdir(layout.dataDir, { recursive: true });

  const events = new SqliteEventStore({ path: layout.eventsDb });
  const blobs = await FileBlobStore.open(layout.blobsDir);

  return {
    events,
    blobs,
    layout,
    async close() {
      await events.close();
      await blobs.close();
    },
  };
}
