import tseslint from 'typescript-eslint'
import stylisticTs from '@stylistic/eslint-plugin-ts'

// eslint.config.js
export default {
    languageOptions: {
        ecmaVersion: 6,
        sourceType: 'module',
        parser: tseslint.parser,
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        }
    },
    plugins: {
        '@typescript-eslint': tseslint.plugin,
        '@stylistic/ts': stylisticTs
    },
    rules: {
        '@typescript-eslint/naming-convention': [
            'warn',
            {
                selector: 'import',
                format: [ 'camelCase', 'PascalCase' ]
            }
        ],
        '@stylistic/ts/semi': 'warn',
        curly: 'warn',
        eqeqeq: 'warn',
        'no-throw-literal': 'warn',
        semi: 'off'
    },
    files: [
        'src/**/*.ts'
    ],
    ignores: [
        'out',
        'dist',
        '**/*.d.ts'
    ]
}