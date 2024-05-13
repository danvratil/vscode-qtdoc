import { defineConfig } from '@vscode/test-cli';

if (!process.env.NODE_ENV) {
	Object.defineProperty(process.env, 'NODE_ENV', { value: 'test', writable: true, configurable: true, enumerable: true });
}

export default defineConfig({
	files: 'out/test/**/*.test.js',
});
