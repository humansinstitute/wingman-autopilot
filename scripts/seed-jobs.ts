#!/usr/bin/env bun

/**
 * Seed script — populates default job definitions.
 * Idempotent: skips definitions that already exist.
 */

import { getJob, createJob } from '../src/jobs-db';

const DEFAULT_DIR = '~/code/wingmen';

const seeds = [
  {
    id: 'architect',
    name: 'Architect',
    worker_prompt: [
      'You are a design architect agent.',
      'Analyze the task requirements and write a comprehensive design document.',
      'The design doc should include: problem statement, proposed solution, data models,',
      'API contracts, component interactions, edge cases, and open questions.',
      'Write the design doc to Flight Deck so it can be reviewed.',
      'Be thorough but concise — focus on decisions that affect implementation.',
    ].join(' '),
    manager_prompt: [
      'You are a design review manager.',
      'Review the architect\'s design document for completeness and quality.',
      'Check that the doc covers: problem statement, proposed solution, data models,',
      'API contracts, component interactions, and edge cases.',
      'Flag any missing sections, unclear decisions, or potential issues.',
      'Approve the design when it is complete and sound, or request revisions with specific feedback.',
    ].join(' '),
    manager_goal: 'Ensure the design document is complete, sound, and ready for implementation.',
    manager_dir: DEFAULT_DIR,
    check_interval: 300,
  },
  {
    id: 'software-dev',
    name: 'Software Dev',
    worker_prompt: [
      'You are a software development agent.',
      'Implement the requested code changes following the project\'s coding standards.',
      'Write clean, well-structured code. Commit each logical change with a descriptive message.',
      'Report back with a summary of what was implemented, files changed, and any decisions made.',
      'If you encounter blockers or ambiguity, document them clearly in your output.',
    ].join(' '),
    manager_prompt: [
      'You are a development manager agent.',
      'Review the developer\'s commits and code changes for quality and correctness.',
      'Check that: code follows project conventions, commits are well-scoped with clear messages,',
      'tests pass, no regressions are introduced, and the implementation matches the goal.',
      'Approve when the work meets quality standards, or request specific fixes.',
    ].join(' '),
    manager_goal: 'Ensure code quality, correctness, and adherence to project standards.',
    manager_dir: DEFAULT_DIR,
    check_interval: 300,
  },
];

let created = 0;
let skipped = 0;

for (const seed of seeds) {
  const existing = getJob(seed.id);
  if (existing) {
    console.log(`SKIP  ${seed.id} — already exists`);
    skipped++;
    continue;
  }
  createJob(seed);
  console.log(`CREATE  ${seed.id} — ${seed.name}`);
  created++;
}

console.log(`\nDone: ${created} created, ${skipped} skipped.`);
