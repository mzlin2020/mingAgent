import { redact } from '@xm/contracts';
import type { Profile } from './types.js';

export const dumpProfile = (profile: Profile): string =>
  JSON.stringify(redact(profile), null, 2);
