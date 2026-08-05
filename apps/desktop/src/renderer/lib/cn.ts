import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn 的惯例：条件拼接 + Tailwind 冲突消解（后者胜） */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
