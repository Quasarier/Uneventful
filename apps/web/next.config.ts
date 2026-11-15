import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const workspaceEnv = resolve(process.cwd(), '../../.env');
if (existsSync(workspaceEnv)) {
  loadEnvFile(workspaceEnv);
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
