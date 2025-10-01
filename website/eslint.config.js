import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              importNames: ['FC', 'FunctionComponent'],
              message:
                'Use function declarations instead of React.FC or React.FunctionComponent',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSTypeReference[typeName.type="TSQualifiedName"][typeName.left.name="React"][typeName.right.name="FC"]',
          message: 'Use function declarations instead of React.FC',
        },
        {
          selector:
            'TSTypeReference[typeName.type="TSQualifiedName"][typeName.left.name="React"][typeName.right.name="FunctionComponent"]',
          message:
            'Use function declarations instead of React.FunctionComponent',
        },
        {
          selector: 'TSTypeReference[typeName.name="FC"]',
          message: 'Use function declarations instead of FC',
        },
        {
          selector: 'TSTypeReference[typeName.name="FunctionComponent"]',
          message: 'Use function declarations instead of FunctionComponent',
        },
      ],
      'func-style': ['error', 'declaration'],
    },
  },
);
