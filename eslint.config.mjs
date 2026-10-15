import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '.npm-cache/**',
    '_scratch/**', '_abi_probe/**', '_upstream_tmp/**', 'upstream/**', '.selfcheck/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    rules: {
      ...js.configs.recommended.rules,
      // TS/宿主环境分别提供类型及全局；此处只检查语法和控制流错误。
      'no-undef': 'off', 'no-unused-vars': 'off', 'no-empty': ['error', { allowEmptyCatch: true }],
      // 输入边界刻意筛除控制字符；初始化值与探针流程不作为风格门禁。
      'no-control-regex': 'off', 'no-useless-assignment': 'off',
    },
  },
  { files: ['**/*.ts'], languageOptions: { parser: ts.parser } },
  ...vue.configs['flat/essential'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } } },
  { files: ['**/tests/probes/**/*.mjs'], rules: { 'no-prototype-builtins': 'off' } },
];
