import md5 from 'md5';

export const normalizePath = (path: string) => path.replace(/\\/g, '/');

export const generateId = (path: string) => md5(normalizePath(path)).substring(0, 9);
