import { expect, it } from 'vitest';
import { branchFor } from './git-worktree.ts';
it('does not alias two durable operations that share the first eight characters', () => {
  const left = '4e535315-0000-4000-8000-000000000001';
  const right = '4e535315-0000-4000-8000-000000000002';
  expect(left.slice(0, 8)).toBe(right.slice(0, 8));
  expect(branchFor(left)).not.toBe(branchFor(right));
});
